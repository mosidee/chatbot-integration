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

function isPrivateV6(address: string): boolean {
  const lower = address.toLowerCase().split('%')[0] ?? ''
  if (lower === '::1' || lower === '::' || lower === '') return true

  // A v4-mapped address is a v4 address wearing a hat; judge it as one.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (mapped?.[1]) return isPrivateV4(mapped[1])

  const head = Number.parseInt(lower.split(':')[0] || '0', 16)
  if ((head & 0xfe00) === 0xfc00) return true // unique local fc00::/7
  if ((head & 0xffc0) === 0xfe80) return true // link-local fe80::/10
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
    let remaining = MAX_REDIRECTS

    for (;;) {
      await assertAllowed(url, allowPrivate, lookup)

      const response = await transport(url.toString(), { ...init, redirect: 'manual' })
      const location = response.headers.get('location')
      const isRedirect = response.status >= 300 && response.status < 400 && location

      if (!isRedirect) return response

      if (remaining === 0) {
        throw new EgressRefusedError(`too many redirects (more than ${MAX_REDIRECTS})`)
      }
      remaining -= 1
      await response.body?.cancel().catch(() => {})
      url = new URL(location, url)
    }
  }
}
