import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FetchLike } from '@ci/core'
import { type Database, decryptSecret, type Executor, encryptSecret, schema } from '@ci/db'
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js'
import { auth, refreshAuthorization } from '@modelcontextprotocol/sdk/client/auth.js'
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { and, eq } from 'drizzle-orm'

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

/**
 * An `OAuthClientProvider` over one row. Every change is written back at once, through the
 * executor it was given, so a refresh under a row lock writes inside that transaction.
 */
export class StoredOAuthProvider implements OAuthClientProvider {
  readonly captured: { url: URL | null } = { url: null }

  constructor(
    private stored: McpOAuthState,
    private readonly options: {
      redirectUrl: string
      persist: (state: McpOAuthState) => Promise<void>
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
    await this.options.persist(this.stored)
  }

  tokens(): OAuthTokens | undefined {
    return this.stored.tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.stored = {
      ...this.stored,
      tokens,
      ...(tokens.expires_in ? { expiresAt: Date.now() + tokens.expires_in * 1000 } : {}),
      codeVerifier: undefined,
    }
    if (!tokens.expires_in) delete this.stored.expiresAt
    await this.options.persist(this.stored)
  }

  redirectToAuthorization(url: URL): void {
    if (!this.options.interactive) throw new McpNeedsReconnectError()
    this.captured.url = url
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.stored = { ...this.stored, codeVerifier }
    await this.options.persist(this.stored)
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
    await this.options.persist(this.stored)
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    const next = { ...this.stored }
    if (scope === 'all' || scope === 'client') delete next.clientInformation
    if (scope === 'all' || scope === 'tokens') {
      delete next.tokens
      delete next.expiresAt
    }
    if (scope === 'all' || scope === 'verifier') delete next.codeVerifier
    if (scope === 'all' || scope === 'discovery') delete next.discovery
    this.stored = next
    await this.options.persist(this.stored)
  }
}

/** Write a server's OAuth state back, encrypted, scoped by workspace. */
function persister(
  executor: Executor,
  workspaceId: string,
  serverId: string,
  secretKey: string,
): (state: McpOAuthState) => Promise<void> {
  return async (state) => {
    await executor
      .update(schema.mcpServers)
      .set({
        credentialEncrypted: await encryptSecret(JSON.stringify(state), secretKey),
        updatedAt: new Date(),
      })
      .where(
        and(eq(schema.mcpServers.id, serverId), eq(schema.mcpServers.workspaceId, workspaceId)),
      )
  }
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
  const result = await auth(provider, { serverUrl: input.serverUrl, fetchFn: input.fetch })
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
    fetchFn: input.fetch,
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
 * The `Authorization` header for an OAuth server, refreshing first when the token is about
 * to expire or `force` says the server refused it.
 *
 * Under a row lock, and re-reading after taking it: two turns at once must not both spend
 * a single-use refresh token, and the second finds the first one's fresh token instead.
 * Null when there is no sign-in to use; a refused refresh token marks the server and throws.
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
  let reconnect = false
  const headers = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.mcpServers)
      .where(
        and(
          eq(schema.mcpServers.id, input.serverId),
          eq(schema.mcpServers.workspaceId, input.workspaceId),
        ),
      )
      .for('update')
    if (row?.auth !== 'oauth' || row.status !== 'ok') return null
    const state = await readOAuthState(row.credentialEncrypted, input.secretKey)
    const token = state.tokens?.access_token
    if (!token) return null

    const stale =
      (input.force && token === input.rejectedToken) ||
      (state.expiresAt !== undefined && state.expiresAt - Date.now() < REFRESH_MARGIN_MS)
    if (!stale) return { Authorization: `Bearer ${token}` }

    const refreshToken = state.tokens?.refresh_token
    const discovery = state.discovery
    if (!refreshToken || !discovery?.authorizationServerUrl || !state.clientInformation) {
      reconnect = true
      return null
    }
    try {
      const resource = discovery.resourceMetadata?.resource
      const fresh = await refreshAuthorization(discovery.authorizationServerUrl, {
        metadata: discovery.authorizationServerMetadata,
        clientInformation: state.clientInformation,
        refreshToken,
        ...(resource ? { resource: new URL(resource) } : {}),
        fetchFn: input.fetch,
      })
      const provider = new StoredOAuthProvider(state, {
        redirectUrl: '',
        persist: persister(tx, input.workspaceId, input.serverId, input.secretKey),
        interactive: false,
      })
      // A server that does not rotate refresh tokens sends none back: keep the one we had.
      await provider.saveTokens({ refresh_token: refreshToken, ...fresh })
      return { Authorization: `Bearer ${fresh.access_token}` }
    } catch (error) {
      if (error instanceof InvalidGrantError) {
        reconnect = true
        return null
      }
      throw error
    }
  })

  if (reconnect) {
    await db
      .update(schema.mcpServers)
      .set({
        status: 'needs_reconnect',
        lastError: new McpNeedsReconnectError().message,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.mcpServers.id, input.serverId),
          eq(schema.mcpServers.workspaceId, input.workspaceId),
        ),
      )
    throw new McpNeedsReconnectError()
  }
  return headers
}

/** Forget the sign-in. The server's own revocation, where it has one, is best effort. */
export async function disconnectMcpSignIn(
  db: Database,
  input: { workspaceId: string; serverId: string },
): Promise<void> {
  await db
    .update(schema.mcpServers)
    .set({ credentialEncrypted: null, status: 'ok', lastError: null, updatedAt: new Date() })
    .where(
      and(
        eq(schema.mcpServers.id, input.serverId),
        eq(schema.mcpServers.workspaceId, input.workspaceId),
      ),
    )
}
