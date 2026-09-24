import dns from 'node:dns'
import net from 'node:net'
import type { FetchLike } from '@ci/core'
import { type Database, schema } from '@ci/db'
import { eq } from 'drizzle-orm'
import { pinnedRequest } from './pinned-transport'

/**
 * Restricted egress for every URL a tenant can type.
 *
 * Tools, model providers and external retrieval all qualify: since tenants have their own
 * admins, none of them is operator-controlled any more. A tenant who can type a URL has a
 * request origin inside our network. The worker shares a
 * Docker network with Postgres, Redis and MinIO, and the model gateway answers on a private
 * address, so a tool aimed at an internal host would be fetched and its answer read out to
 * a customer. See decision 20 in docs/REQUIREMENTS.md and ADR 0004.
 *
 * Checking the hostname string is not enough: a name can resolve inward, and a redirect can
 * point anywhere. So the name is resolved, every address it answers with is checked, and the
 * check is repeated on each hop.
 */

export class EgressRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EgressRefusedError'
  }
}

const MAX_REDIRECTS = 3

/** Ranges nothing on the public internet answers on, and everything internal does. */
function isPrivateV4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true
  const [a = 0, b = 0] = parts
  if (a === 0) return true // "this network"
  if (a === 10) return true
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local, and the cloud metadata service
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a >= 224) return true // multicast and reserved
  return false
}

/**
 * Expand an IPv6 address into its eight groups, or null if it cannot be read.
 *
 * Written out rather than pattern-matched on the text because the same address has many
 * spellings. `::ffff:127.0.0.1` and `::ffff:7f00:1` are the same host, and a check that
 * only recognised the dotted one let the hex one reach loopback.
 */
function expandV6(address: string): number[] | null {
  let text = address
  const groups: number[] = []

  // A trailing dotted quad, as in ::ffff:127.0.0.1, is two more groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  let tail: number[] = []
  if (dotted?.[1]) {
    const parts = dotted[1].split('.').map(Number)
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null
    tail = [((parts[0] ?? 0) << 8) | (parts[1] ?? 0), ((parts[2] ?? 0) << 8) | (parts[3] ?? 0)]
    text = text.slice(0, dotted.index)
    // Leave the separator off so the halves below split cleanly.
    if (text.endsWith(':') && !text.endsWith('::')) text = text.slice(0, -1)
  }

  const halves = text.split('::')
  if (halves.length > 2) return null

  const parse = (part: string): number[] | null => {
    if (part === '') return []
    const out: number[] = []
    for (const piece of part.split(':')) {
      if (piece === '' || piece.length > 4 || !/^[0-9a-f]+$/.test(piece)) return null
      out.push(Number.parseInt(piece, 16))
    }
    return out
  }

  const head = parse(halves[0] ?? '')
  if (!head) return null

  if (halves.length === 1) {
    groups.push(...head, ...tail)
    return groups.length === 8 ? groups : null
  }

  const rest = parse(halves[1] ?? '')
  if (!rest) return null
  const filled = [...rest, ...tail]
  const zeros = 8 - head.length - filled.length
  if (zeros < 0) return null
  return [...head, ...new Array(zeros).fill(0), ...filled]
}

function isPrivateV6(address: string): boolean {
  const lower = (address.toLowerCase().split('%')[0] ?? '').replace(/^\[|\]$/g, '')
  const groups = expandV6(lower)
  // Unreadable means refused: this decides whether to send a request, so the safe answer
  // to "I do not understand this address" is no.
  if (!groups) return true

  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups
  const embeddedV4 = () => `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`

  // :: and ::1
  if (g0 + g1 + g2 + g3 + g4 + g5 + g6 === 0 && (g7 === 0 || g7 === 1)) return true

  // A v4 address wearing a hat, in any of its spellings: judge it as a v4 address.
  const zeroLead = g0 + g1 + g2 + g3 === 0
  if (zeroLead && g4 === 0 && g5 === 0xffff) return isPrivateV4(embeddedV4()) // ::ffff:a.b.c.d
  if (zeroLead && g4 === 0xffff && g5 === 0) return isPrivateV4(embeddedV4()) // ::ffff:0:a.b.c.d
  if (zeroLead && g4 === 0 && g5 === 0) return isPrivateV4(embeddedV4()) // deprecated ::a.b.c.d
  if (g0 === 0x64 && g1 === 0xff9b) return isPrivateV4(embeddedV4()) // NAT64 64:ff9b::/96

  if ((g0 & 0xfe00) === 0xfc00) return true // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true // link-local fe80::/10
  return false
}

export function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address)
  if (family === 4) return isPrivateV4(address)
  if (family === 6) return isPrivateV6(address)
  return true
}

export type LookupFn = (hostname: string) => Promise<{ address: string; family: number }[]>

/**
 * The default resolver.
 *
 * `{ all: true }` matters: without it Node returns a single record, and a check that only
 * ever sees the first address passes for a name that also answers with a private one.
 */
const defaultLookup: LookupFn = async (hostname) => {
  const result = await dns.promises.lookup(hostname, { all: true, verbatim: true })
  return result.map((r) => ({ address: r.address, family: r.family }))
}

/**
 * The only headers that may follow a redirect to another origin.
 *
 * An allowlist, not a list of credential headers to strip. A tool's credential can travel
 * in any header its tenant names — `x-api-key`, `x-auth-token`, something invented — and a
 * denylist of `authorization` and `cookie` handed all of those to whatever host the endpoint
 * redirected to. Nothing here can identify or authorise the caller.
 */
const CROSS_ORIGIN_SAFE_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'content-type',
  'user-agent',
])

function crossOriginHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [name, value] of new Headers(headers ?? {}).entries()) {
    if (CROSS_ORIGIN_SAFE_HEADERS.has(name.toLowerCase())) kept[name] = value
  }
  return kept
}

export type RestrictedFetchOptions = {
  /** Local development and tests only; `createRuntime` refuses it in production. */
  allowPrivate?: boolean
  lookup?: LookupFn
  /**
   * Origins a platform admin has approved for one tenant, reached even on a private address
   * or over plain http. A model gateway on the operator's own network is the case this
   * exists for. Matched on the whole origin — scheme, host and port — so approving a
   * gateway approves nothing else on that machine.
   */
  allowedOrigins?: readonly string[]
  /**
   * The underlying fetch. Injected so a test can assert what happens between hops without
   * depending on a real server or on DNS answering the way the test needs.
   */
  transport?: FetchLike
}

async function assertAllowed(
  url: URL,
  allowPrivate: boolean,
  allowedOrigins: ReadonlySet<string>,
  lookup: LookupFn,
): Promise<{ address: string; family: number }[] | null> {
  if (url.username || url.password) {
    throw new EgressRefusedError('credentials in the URL are not allowed')
  }
  // Approved by a platform admin, not by the tenant: it may be private, and it may be http.
  if (allowedOrigins.has(url.origin)) return null

  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) {
    throw new EgressRefusedError(`only https is allowed, and ${url.protocol}// was requested`)
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (allowPrivate) return null

  // A literal address never reaches the resolver, so check it directly.
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new EgressRefusedError(`${hostname} is not a public address`)
    }
    return [{ address: hostname, family: net.isIP(hostname) }]
  }

  let addresses: { address: string; family: number }[]
  try {
    addresses = await lookup(hostname)
  } catch (error) {
    throw new EgressRefusedError(
      `${hostname} could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (addresses.length === 0) {
    throw new EgressRefusedError(`${hostname} resolved to nothing`)
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new EgressRefusedError(`${hostname} resolves to ${address}, which is not public`)
    }
  }
  // Handed to the connection, so it reaches exactly what was checked; see pinned-transport.
  return addresses
}

/**
 * A `fetch` that refuses to reach inward.
 *
 * Redirects are followed by hand, because the automatic follow would take the second hop
 * without asking us and that hop is the easiest one to point at localhost.
 *
 * The connection goes to the address the check approved, not to a second resolution of the
 * name, so a name that changes its answer between the two cannot slip inward (ADR 0004).
 */
export function createRestrictedFetch(options: RestrictedFetchOptions = {}): FetchLike {
  const allowPrivate = options.allowPrivate ?? false
  const allowedOrigins = new Set(options.allowedOrigins ?? [])
  const lookup = options.lookup ?? defaultLookup
  /**
   * How a checked request is sent. By default it connects to the addresses the check
   * approved (`pinnedRequest`), which closes the gap between checking a name and connecting
   * to it. Where nothing was resolved — an origin a platform admin approved, or private
   * egress allowed for development — the plain fetch is used. Tests inject their own.
   */
  const send = async (
    url: URL,
    init: RequestInit,
    addresses: { address: string; family: number }[] | null,
  ): Promise<Response> => {
    if (options.transport) return options.transport(url.toString(), init)
    if (addresses) return pinnedRequest(url, init, addresses)
    return fetch(url, init)
  }

  return async function restrictedFetch(input, init) {
    // A Request carries its own method, headers and body. Reading only its URL would send
    // a POST as a bare GET, so they are lifted into the init, which then wins as it would
    // in `fetch` itself.
    let request: RequestInit = { ...init }
    if (input instanceof Request) {
      request = {
        method: input.method,
        headers: input.headers,
        ...(input.body ? { body: await input.arrayBuffer() } : {}),
        signal: input.signal,
        ...init,
      }
    }

    let url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    const origin = url.origin
    let current = request
    let remaining = MAX_REDIRECTS

    for (;;) {
      const addresses = await assertAllowed(url, allowPrivate, allowedOrigins, lookup)

      const response = await send(url, { ...current, redirect: 'manual' }, addresses)
      const location = response.headers.get('location')
      const isRedirect = response.status >= 300 && response.status < 400 && location

      if (!isRedirect) return response

      if (remaining === 0) {
        throw new EgressRefusedError(`too many redirects (more than ${MAX_REDIRECTS})`)
      }
      remaining -= 1
      await response.body?.cancel().catch(() => {})

      const next = new URL(location, url)

      // Following a redirect by hand means doing by hand what `fetch` would otherwise do
      // for us, and the two things it does are the two things that matter here.
      //
      // 303 means "go and GET this instead", and 301 and 302 are treated the same way by
      // every client in practice. Replaying a write's body to the new location is how one
      // request becomes two applied operations.
      const becomesGet =
        response.status === 303 || response.status === 301 || response.status === 302
      if (becomesGet) {
        current = { ...current, method: 'GET', body: undefined }
      }

      // A credential is scoped to the host it was configured for, and so is the body. Only
      // headers that identify nobody travel to another origin, and a 307 or 308 — which
      // replays the body by definition — is refused rather than handing an account's data
      // to an expired domain or somebody else's server.
      if (next.origin !== origin) {
        if (!becomesGet && current.body != null) {
          throw new EgressRefusedError(
            `refusing to resend a request body to another origin (${next.origin}) on a ${response.status}`,
          )
        }
        current = { ...current, headers: crossOriginHeaders(current.headers) }
      }

      url = next
    }
  }
}

/**
 * The client a tenant's model providers and external retrieval go through.
 *
 * Reads the origins a platform admin approved for this workspace, and nothing a tenant
 * wrote: the list lives on `workspaces.private_egress_origins`, which no tenant route
 * touches. Everything else a provider URL names is held to the same rule as a tool's.
 */
export async function workspaceProviderFetch(
  runtime: { db: Database; providerFetch: (allowedOrigins: readonly string[]) => FetchLike },
  workspaceId: string,
): Promise<FetchLike> {
  const rows = await runtime.db
    .select({ origins: schema.workspaces.privateEgressOrigins })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1)
  return runtime.providerFetch(rows[0]?.origins ?? [])
}
