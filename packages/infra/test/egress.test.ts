import { describe, expect, test } from 'bun:test'
import { createRestrictedFetch, EgressRefusedError, isPrivateAddress } from '../src/egress'

/**
 * The resolver is injected so these tests assert the rule, not the state of DNS.
 *
 * The default resolver passes `{ all: true }`, which the last test pins: without it Node
 * answers with one record and a host that also resolves to a private address would slip
 * through a check that only ever saw the first.
 */
function resolvesTo(map: Record<string, string[]>) {
  return async (hostname: string) => {
    const addresses = map[hostname]
    if (!addresses) throw new Error(`no such host ${hostname}`)
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
}

const PUBLIC = resolvesTo({ 'api.example.com': ['93.184.216.34'] })

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return '(no refusal)'
  } catch (error) {
    if (error instanceof EgressRefusedError) return error.message
    throw error
  }
}

describe('isPrivateAddress', () => {
  const privateOnes = [
    '0.0.0.0',
    '10.0.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '100.64.0.1',
    '224.0.0.1',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:10.0.0.1',
    '::ffff:127.0.0.1',
  ]
  for (const address of privateOnes) {
    test(`refuses ${address}`, () => {
      expect(isPrivateAddress(address)).toBe(true)
    })
  }

  const publicOnes = ['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111']
  for (const address of publicOnes) {
    test(`allows ${address}`, () => {
      expect(isPrivateAddress(address)).toBe(false)
    })
  }

  test('refuses anything that is not an address at all', () => {
    expect(isPrivateAddress('not-an-address')).toBe(true)
  })
})

describe('createRestrictedFetch', () => {
  test('refuses plain http', async () => {
    const fetcher = createRestrictedFetch({ lookup: PUBLIC })
    expect(await refusal(fetcher('http://api.example.com/v1'))).toContain('only https')
  })

  test('refuses credentials embedded in the URL', async () => {
    const fetcher = createRestrictedFetch({ lookup: PUBLIC })
    expect(await refusal(fetcher('https://user:pw@api.example.com/v1'))).toContain('credentials')
  })

  test('refuses a literal private address without resolving anything', async () => {
    const fetcher = createRestrictedFetch({
      lookup: async () => {
        throw new Error('the resolver should not have been called')
      },
    })
    for (const host of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254', '[::1]']) {
      expect(await refusal(fetcher(`https://${host}/v1`))).toContain('not a public address')
    }
  })

  test('refuses a public name that resolves to a private address', async () => {
    // The attack the string check misses entirely.
    const fetcher = createRestrictedFetch({
      lookup: resolvesTo({ 'inside.example.com': ['127.0.0.1'] }),
    })
    expect(await refusal(fetcher('https://inside.example.com/v1'))).toContain('which is not public')
  })

  test('refuses when any one of several addresses is private', async () => {
    const fetcher = createRestrictedFetch({
      lookup: resolvesTo({ 'mixed.example.com': ['93.184.216.34', '10.1.2.3'] }),
    })
    expect(await refusal(fetcher('https://mixed.example.com/v1'))).toContain('10.1.2.3')
  })

  test('refuses a name that resolves to nothing', async () => {
    const fetcher = createRestrictedFetch({ lookup: async () => [] })
    expect(await refusal(fetcher('https://empty.example.com/v1'))).toContain('resolved to nothing')
  })

  test('allowPrivate opens loopback, for tests and local development', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('ok') })
    try {
      const fetcher = createRestrictedFetch({ allowPrivate: true })
      const response = await fetcher(`http://127.0.0.1:${server.port}/`)
      expect(await response.text()).toBe('ok')
    } finally {
      server.stop(true)
    }
  })

  test('the real resolver is used when none is injected', async () => {
    // Exercises the default `dns.promises.lookup({ all: true })` path rather than a fake:
    // localhost resolves inward on every machine this will ever run on.
    const fetcher = createRestrictedFetch({})
    expect(await refusal(fetcher('https://localhost/v1'))).toContain('which is not public')
  })

  test('rechecks each redirect hop, so a public host cannot bounce us inward', async () => {
    const seen: string[] = []
    const fetcher = createRestrictedFetch({
      lookup: resolvesTo({
        'start.example.com': ['93.184.216.34'],
        'inside.example.com': ['10.0.0.9'],
      }),
      transport: async (input) => {
        seen.push(String(input))
        return new Response(null, {
          status: 302,
          headers: { location: 'https://inside.example.com/secret' },
        })
      },
    })

    expect(await refusal(fetcher('https://start.example.com/'))).toContain('which is not public')
    // The first hop was made and the second never was, which is the whole point.
    expect(seen).toEqual(['https://start.example.com/'])
  })

  test('follows a redirect that stays public', async () => {
    const fetcher = createRestrictedFetch({
      lookup: resolvesTo({
        'start.example.com': ['93.184.216.34'],
        'elsewhere.example.com': ['93.184.216.35'],
      }),
      transport: async (input) =>
        String(input).includes('start.example.com')
          ? new Response(null, {
              status: 302,
              headers: { location: 'https://elsewhere.example.com/v1' },
            })
          : new Response('arrived'),
    })

    const response = await fetcher('https://start.example.com/')
    expect(await response.text()).toBe('arrived')
  })

  test('gives up rather than following a redirect loop', async () => {
    const fetcher = createRestrictedFetch({
      lookup: resolvesTo({ 'loop.example.com': ['93.184.216.34'] }),
      transport: async () =>
        new Response(null, { status: 302, headers: { location: 'https://loop.example.com/next' } }),
    })
    expect(await refusal(fetcher('https://loop.example.com/'))).toContain('too many redirects')
  })
})
