import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FetchLike } from '@ci/core'
import { type Database, decryptSecret, type Executor, encryptSecret, schema } from '@ci/db'
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js'
import { auth, refreshAuthorization } from '@modelcontextprotocol/sdk/client/auth.js'
import {
  InvalidClientError,
  InvalidGrantError,
  UnauthorizedClientError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { and, eq, sql } from 'drizzle-orm'
import { boundedFetch } from './bounded-fetch'

/**
 * Signing in to an MCP server with OAuth (ADR 0011, addendum).
 *
 * An admin signs in once, from Settings; the tokens are stored encrypted on the server's row
 * and the AI's calls carry them from then on. The SDK's `auth()` runs only in the two API
 * routes that start and finish that sign-in, where a person is there to be redirected. A
 * turn never calls it: on a refresh failure `auth()` falls through to "start a new sign-in",
 * which in a worker would turn a passing 5xx into a server needing an admin. The worker
 * refreshes with `refreshAuthorization` directly, under a row lock, and only a refused
 * refresh token (`invalid_grant`) marks the server as needing to be connected again.
 */

/** Everything the sign-in leaves behind, encrypted into `credential_encrypted`. */
export type McpOAuthState = {
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  /** When the access token stops working, from `expires_in` at the moment it was saved. */
  expiresAt?: number
  codeVerifier?: string
  discovery?: OAuthDiscoveryState
}

export async function readOAuthState(
  encrypted: string | null,
  secretKey: string,
): Promise<McpOAuthState> {
  if (!encrypted) return {}
  try {
    return JSON.parse(await decryptSecret(encrypted, secretKey)) as McpOAuthState
  } catch {
    return {}
  }
}

/** Raised where a person would have to be redirected and none is there to be. */
export class McpNeedsReconnectError extends Error {
  constructor() {
    super('the sign-in to this server has expired; an admin has to connect it again')
    this.name = 'McpNeedsReconnectError'
  }
}

const CLIENT_NAME = 'AI Chat Desk'

/** Where the server sends the admin back to. Built from configuration, never a request. */
export function mcpRedirectUrl(publicWebUrl: string): string {
  return new URL('/api/mcp/oauth/callback', publicWebUrl).toString()
}

/** A change to the stored state: keys to set, and keys to remove. */
type StatePatch = { set?: Partial<McpOAuthState>; remove?: (keyof McpOAuthState)[] }

/**
 * An `OAuthClientProvider` over one row. Every change is written back at once as a patch,
 * merged into whatever the row holds by then: an admin starting a sign-in must not write
 * back the token set it read a moment before, over the one a turn has just refreshed.
 *
 * In the route that starts a sign-in it reports no tokens, so `auth()` always goes to the
 * server's page: "Sign in again" means signing in, perhaps as another account, and must not
 * quietly refresh a token a turn may be refreshing at the same moment.
 */
export class StoredOAuthProvider implements OAuthClientProvider {
  readonly captured: { url: URL | null } = { url: null }

  constructor(
    private stored: McpOAuthState,
    private readonly options: {
      redirectUrl: string
      persist: (patch: StatePatch) => Promise<void>
      /** The signed `state` parameter for a sign-in an admin is starting. */
      stateParam?: string
      /** True in the route that starts a sign-in: capture the URL rather than refuse. */
      interactive: boolean
    },
  ) {}

  get redirectUrl(): string {
    return this.options.redirectUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: CLIENT_NAME,
      redirect_uris: [this.options.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }

  state(): string {
    return this.options.stateParam ?? ''
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.stored.clientInformation
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    this.stored = { ...this.stored, clientInformation: info }
    await this.options.persist({ set: { clientInformation: info } })
  }

  tokens(): OAuthTokens | undefined {
    return this.options.interactive ? undefined : this.stored.tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const expiresAt = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined
    this.stored = { ...this.stored, tokens, expiresAt, codeVerifier: undefined }
    await this.options.persist({
      set: { tokens, ...(expiresAt ? { expiresAt } : {}) },
      remove: expiresAt ? ['codeVerifier'] : ['codeVerifier', 'expiresAt'],
    })
  }

  redirectToAuthorization(url: URL): void {
    if (!this.options.interactive) throw new McpNeedsReconnectError()
    this.captured.url = url
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.stored = { ...this.stored, codeVerifier }
    await this.options.persist({ set: { codeVerifier } })
  }

  codeVerifier(): string {
    if (!this.stored.codeVerifier) throw new Error('no sign-in is in progress for this server')
    return this.stored.codeVerifier
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.stored.discovery
  }

  async saveDiscoveryState(discovery: OAuthDiscoveryState): Promise<void> {
    this.stored = { ...this.stored, discovery }
    await this.options.persist({ set: { discovery } })
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    const remove: (keyof McpOAuthState)[] = []
    if (scope === 'all' || scope === 'client') remove.push('clientInformation')
    if (scope === 'all' || scope === 'tokens') remove.push('tokens', 'expiresAt')
    if (scope === 'all' || scope === 'verifier') remove.push('codeVerifier')
    if (scope === 'all' || scope === 'discovery') remove.push('discovery')
    const next = { ...this.stored }
    for (const key of remove) delete next[key]
    this.stored = next
    await this.options.persist({ remove })
  }
}

/**
 * Merge a patch into a server's stored OAuth state, under the row lock, encrypted, scoped by
 * workspace. Inside a transaction that already holds the lock, taking it again is free.
 */
function persister(
  executor: Executor,
  workspaceId: string,
  serverId: string,
  secretKey: string,
): (patch: StatePatch) => Promise<void> {
  return (patch) =>
    executor.transaction(async (tx) => {
      const where = and(
        eq(schema.mcpServers.id, serverId),
        eq(schema.mcpServers.workspaceId, workspaceId),
      )
      const [row] = await tx
        .select({ credentialEncrypted: schema.mcpServers.credentialEncrypted })
        .from(schema.mcpServers)
        .where(where)
        .for('update')
      if (!row) return
      const next: McpOAuthState = {
        ...(await readOAuthState(row.credentialEncrypted, secretKey)),
        ...patch.set,
      }
      for (const key of patch.remove ?? []) delete next[key]
      await tx
        .update(schema.mcpServers)
        .set({
          credentialEncrypted: await encryptSecret(JSON.stringify(next), secretKey),
          updatedAt: new Date(),
        })
        .where(where)
    })
}

// ---------------------------------------------------------------------------
// The `state` parameter: who started this sign-in, for which server, until when.

const STATE_TTL_MS = 10 * 60 * 1000

export type SignInClaims = { workspaceId: string; serverId: string; userId: string; exp: number }

export function signSignInState(claims: Omit<SignInClaims, 'exp'>, secretKey: string): string {
  const body = Buffer.from(JSON.stringify({ ...claims, exp: Date.now() + STATE_TTL_MS })).toString(
    'base64url',
  )
  const mac = createHmac('sha256', `mcp-oauth-state:${secretKey}`).update(body).digest('base64url')
  return `${body}.${mac}`
}

/** The claims, or null when the signature is wrong or the ten minutes are up. */
export function verifySignInState(value: string, secretKey: string): SignInClaims | null {
  const [body, mac] = value.split('.')
  if (!body || !mac) return null
  const expected = createHmac('sha256', `mcp-oauth-state:${secretKey}`).update(body).digest()
  const given = Buffer.from(mac, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SignInClaims
    return claims.exp > Date.now() ? claims : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The two steps an admin takes.

/**
 * Start a sign-in: discover the server's authorization server, register with it if needed,
 * and return the URL to send the admin to. 'connected' when the stored tokens already work.
 */
export async function startMcpSignIn(
  db: Database,
  input: {
    workspaceId: string
    serverId: string
    serverUrl: string
    encrypted: string | null
    secretKey: string
    publicWebUrl: string
    stateParam: string
    fetch: FetchLike
  },
): Promise<{ status: 'redirect'; url: URL } | { status: 'connected' }> {
  const provider = new StoredOAuthProvider(await readOAuthState(input.encrypted, input.secretKey), {
    redirectUrl: mcpRedirectUrl(input.publicWebUrl),
    persist: persister(db, input.workspaceId, input.serverId, input.secretKey),
    stateParam: input.stateParam,
    interactive: true,
  })
  const result = await auth(provider, {
    serverUrl: input.serverUrl,
    fetchFn: oauthFetch(input.fetch),
  })
  if (result === 'AUTHORIZED') return { status: 'connected' }
  if (!provider.captured.url) throw new Error('the server did not offer a sign-in')
  return { status: 'redirect', url: provider.captured.url }
}

/** Finish a sign-in: swap the code the server sent back for tokens. */
export async function finishMcpSignIn(
  db: Database,
  input: {
    workspaceId: string
    serverId: string
    serverUrl: string
    encrypted: string | null
    secretKey: string
    publicWebUrl: string
    code: string
    fetch: FetchLike
  },
): Promise<void> {
  const provider = new StoredOAuthProvider(await readOAuthState(input.encrypted, input.secretKey), {
    redirectUrl: mcpRedirectUrl(input.publicWebUrl),
    persist: persister(db, input.workspaceId, input.serverId, input.secretKey),
    interactive: false,
  })
  await auth(provider, {
    serverUrl: input.serverUrl,
    authorizationCode: input.code,
    fetchFn: oauthFetch(input.fetch),
  })
  await db
    .update(schema.mcpServers)
    .set({ status: 'ok', lastError: null, updatedAt: new Date() })
    .where(
      and(
        eq(schema.mcpServers.id, input.serverId),
        eq(schema.mcpServers.workspaceId, input.workspaceId),
      ),
    )
}

// ---------------------------------------------------------------------------
// What a turn does.

/** Refresh this long before the access token expires, so a call does not race it. */
const REFRESH_MARGIN_MS = 60_000

/**
 * Every OAuth request has a deadline and a small ceiling: a token endpoint that hangs would
 * otherwise hold a refresh, its row lock and a pooled connection for as long as it liked.
 */
const OAUTH_LIMITS = { maxBytes: 64 * 1024, timeoutMs: 10_000 }
function oauthFetch(fetch: FetchLike): FetchLike {
  return boundedFetch(fetch, OAUTH_LIMITS)
}

/** The sign-in is gone for good and only an admin can bring it back. */
function lostForGood(error: unknown): boolean {
  return (
    error instanceof InvalidGrantError ||
    error instanceof InvalidClientError ||
    error instanceof UnauthorizedClientError
  )
}

function isStale(state: McpOAuthState, force: boolean, rejectedToken?: string): boolean {
  const token = state.tokens?.access_token
  if (!token) return false
  if (force && token === rejectedToken) return true
  return state.expiresAt !== undefined && state.expiresAt - Date.now() < REFRESH_MARGIN_MS
}

async function markServer(
  db: Database,
  input: { workspaceId: string; serverId: string },
  set: { status?: 'ok' | 'needs_reconnect'; lastError: string | null },
): Promise<void> {
  await db
    .update(schema.mcpServers)
    .set({ ...set, updatedAt: new Date() })
    .where(
      and(
        eq(schema.mcpServers.id, input.serverId),
        eq(schema.mcpServers.workspaceId, input.workspaceId),
      ),
    )
}

/**
 * The `Authorization` header for an OAuth server, refreshing first when the token is about
 * to expire or `force` says the server refused it.
 *
 * A fresh token is read without a lock: every turn asks, and a turn must not queue behind
 * another for nothing. A refresh takes the row lock and re-reads after taking it, so two
 * turns cannot both spend a single-use refresh token (the second finds the first one's), and
 * waits at most five seconds for it. Null when there is no sign-in to use. A refusal that
 * only an admin can fix marks the server and throws; anything else is an ordinary failure,
 * written to `last_error` so the card can say why.
 */
export async function oauthHeaders(
  db: Database,
  input: {
    workspaceId: string
    serverId: string
    secretKey: string
    fetch: FetchLike
    force?: boolean
    /** The token the caller already tried, so a forced refresh another turn did first counts. */
    rejectedToken?: string
  },
): Promise<Record<string, string> | null> {
  const where = and(
    eq(schema.mcpServers.id, input.serverId),
    eq(schema.mcpServers.workspaceId, input.workspaceId),
  )
  const [peek] = await db.select().from(schema.mcpServers).where(where).limit(1)
  if (peek?.auth !== 'oauth' || peek.status !== 'ok') return null
  const seen = await readOAuthState(peek.credentialEncrypted, input.secretKey)
  if (!seen.tokens?.access_token) return null
  if (!isStale(seen, input.force ?? false, input.rejectedToken)) {
    return { Authorization: `Bearer ${seen.tokens.access_token}` }
  }

  let reconnect = false
  try {
    const headers = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '5s'`)
      const [row] = await tx.select().from(schema.mcpServers).where(where).for('update')
      if (row?.auth !== 'oauth' || row.status !== 'ok') return null
      const state = await readOAuthState(row.credentialEncrypted, input.secretKey)
      const token = state.tokens?.access_token
      if (!token) return null
      if (!isStale(state, input.force ?? false, input.rejectedToken)) {
        return { Authorization: `Bearer ${token}` }
      }

      const refreshToken = state.tokens?.refresh_token
      const discovery = state.discovery
      if (!refreshToken || !discovery?.authorizationServerUrl || !state.clientInformation) {
        reconnect = true
        return null
      }
      const resource = discovery.resourceMetadata?.resource
      const fresh = await refreshAuthorization(discovery.authorizationServerUrl, {
        metadata: discovery.authorizationServerMetadata,
        clientInformation: state.clientInformation,
        refreshToken,
        ...(resource ? { resource: new URL(resource) } : {}),
        fetchFn: oauthFetch(input.fetch),
      })
      const provider = new StoredOAuthProvider(state, {
        redirectUrl: '',
        persist: persister(tx, input.workspaceId, input.serverId, input.secretKey),
        interactive: false,
      })
      // A server that does not rotate refresh tokens sends none back: keep the one we had.
      await provider.saveTokens({ refresh_token: refreshToken, ...fresh })
      return { Authorization: `Bearer ${fresh.access_token}` }
    })
    if (!reconnect) {
      if (peek.lastError) await markServer(db, input, { lastError: null })
      return headers
    }
  } catch (error) {
    if (!lostForGood(error)) {
      const message = error instanceof Error ? error.message : String(error)
      await markServer(db, input, {
        lastError: `refreshing the sign-in failed: ${message}`.slice(0, 300),
      })
      throw error
    }
    reconnect = true
  }

  await markServer(db, input, {
    status: 'needs_reconnect',
    lastError: new McpNeedsReconnectError().message,
  })
  throw new McpNeedsReconnectError()
}

/**
 * Tell the server to forget our tokens, where it offers a revocation endpoint (RFC 7009).
 * Best effort: the tokens are deleted here whatever it answers.
 */
async function revoke(state: McpOAuthState, fetch: FetchLike): Promise<void> {
  const endpoint = (
    state.discovery?.authorizationServerMetadata as { revocation_endpoint?: string } | undefined
  )?.revocation_endpoint
  const clientId = state.clientInformation?.client_id
  if (!endpoint || !clientId) return
  const bounded = oauthFetch(fetch)
  for (const [token, hint] of [
    [state.tokens?.refresh_token, 'refresh_token'],
    [state.tokens?.access_token, 'access_token'],
  ] as const) {
    if (!token) continue
    await bounded(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, token_type_hint: hint, client_id: clientId }).toString(),
    }).catch(() => {})
  }
}

/** Sign out: revoke at the server where it can, then forget everything stored. */
export async function disconnectMcpSignIn(
  db: Database,
  input: { workspaceId: string; serverId: string; secretKey: string; fetch: FetchLike },
): Promise<void> {
  const where = and(
    eq(schema.mcpServers.id, input.serverId),
    eq(schema.mcpServers.workspaceId, input.workspaceId),
  )
  const [row] = await db.select().from(schema.mcpServers).where(where).limit(1)
  if (!row) return
  if (row.auth === 'oauth') {
    await revoke(await readOAuthState(row.credentialEncrypted, input.secretKey), input.fetch)
  }
  await db
    .update(schema.mcpServers)
    .set({ credentialEncrypted: null, status: 'ok', lastError: null, updatedAt: new Date() })
    .where(where)
}
