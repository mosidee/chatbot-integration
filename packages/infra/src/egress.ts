import dns from 'node:dns'
import net from 'node:net'
import type { FetchLike } from '@ci/core'

/**
 * Restricted egress for tenant-defined tools.
 *
 * A tenant who can type a URL has a request origin inside our network. The worker shares a
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

/** Headers that authenticate us to one host and must not travel to another. */
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization'])

function strippedHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [name, value] of new Headers(headers ?? {}).entries()) {
    if (!CREDENTIAL_HEADERS.has(name.toLowerCase())) kept[name] = value
  }
  return kept
}

export type RestrictedFetchOptions = {
  /** Local development and tests only; `createRuntime` refuses it in production. */
  allowPrivate?: boolean
  lookup?: LookupFn
  /**
   * The underlying fetch. Injected so a test can assert what happens between hops without
   * depending on a real server or on DNS answering the way the test needs.
   */
  transport?: FetchLike
}

async function assertAllowed(url: URL, allowPrivate: boolean, lookup: LookupFn): Promise<void> {
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) {
    throw new EgressRefusedError(`only https is allowed, and ${url.protocol}// was requested`)
  }
  if (url.username || url.password) {
    throw new EgressRefusedError('credentials in the URL are not allowed')
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (allowPrivate) return

  // A literal address never reaches the resolver, so check it directly.
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new EgressRefusedError(`${hostname} is not a public address`)
    }
    return
  }

  let addresses: { address: string }[]
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
}

/**
 * A `fetch` that refuses to reach inward.
 *
 * Redirects are followed by hand, because the automatic follow would take the second hop
 * without asking us and that hop is the easiest one to point at localhost.
 *
 * Residual risk, accepted and recorded in ADR 0004: between the check and the connection,
 * the name can change its answer. Closing that window means connecting to the address we
 * resolved, which breaks TLS certificate verification for the hostname.
 */
export function createRestrictedFetch(options: RestrictedFetchOptions = {}): FetchLike {
  const allowPrivate = options.allowPrivate ?? false
  const lookup = options.lookup ?? defaultLookup
  const transport: FetchLike = options.transport ?? ((input, init) => fetch(input, init))

  return async function restrictedFetch(input, init) {
    let url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    const origin = url.origin
    let current: RequestInit = { ...init }
    let remaining = MAX_REDIRECTS

    for (;;) {
      await assertAllowed(url, allowPrivate, lookup)

      const response = await transport(url.toString(), { ...current, redirect: 'manual' })
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
      // A credential is scoped to the host it was configured for. Replaying the headers
      // verbatim would hand a tenant's API key to whatever their endpoint redirected to,
      // which may be an expired domain or somebody else's server.
      if (next.origin !== origin) {
        current = { ...current, headers: strippedHeaders(current.headers) }
      }

      // 303 means "go and GET this instead", and 301 and 302 are treated the same way by
      // every client in practice. Replaying a write's body to the new location is how one
      // request becomes two applied operations.
      if (response.status === 303 || response.status === 301 || response.status === 302) {
        current = { ...current, method: 'GET', body: undefined }
      }

      url = next
    }
  }
}
