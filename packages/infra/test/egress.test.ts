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

  /**
   * The same host has many spellings, and a check that only recognised one of them let the
   * others through. `::ffff:7f00:1` is `127.0.0.1`; so is `::ffff:127.0.0.1`.
   */
  const disguisedLoopback = [
    '::ffff:7f00:1',
    '::ffff:127.0.0.1',
    '0:0:0:0:0:ffff:7f00:1',
    '::ffff:0:7f00:1',
    '::7f00:1',
    '64:ff9b::7f00:1',
  ]
  for (const address of disguisedLoopback) {
    test(`refuses ${address}, which is 127.0.0.1 in another spelling`, () => {
      expect(isPrivateAddress(address)).toBe(true)
    })
  }

  const disguisedPrivate = ['::ffff:a00:1', '::ffff:a9fe:a9fe', '::ffff:c0a8:1']
  for (const address of disguisedPrivate) {
    test(`refuses ${address}, a private v4 address in v6 clothing`, () => {
      expect(isPrivateAddress(address)).toBe(true)
    })
  }

  test('refuses an address it cannot parse rather than guessing', () => {
    for (const address of ['::ffff:zzzz:1', '1:2:3::4::5', 'not:an:address']) {
      expect(isPrivateAddress(address)).toBe(true)
    }
  })

  const publicOnes = [
    '93.184.216.34',
    '8.8.8.8',
    '172.32.0.1',
    '100.128.0.1',
    '2606:4700::1111',
    '2001:4860:4860::8888',
    // A public v4 address in v6 clothing is still public; the rule must not over-block.
    '::ffff:93.184.216.34',
    '::ffff:5db8:d822',
  ]
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

  test('does not carry the credential to a host the redirect chose', async () => {
    // The tenant's key is configured for their host. A redirect to anywhere else must not
    // receive it: their endpoint could redirect to an expired domain, or to a server
    // somebody else now controls.
    const seen: { url: string; auth: string | null }[] = []
    const fetcher = createRestrictedFetch({
      lookup: resolvesTo({
        'api.example.com': ['93.184.216.34'],
        'elsewhere.example.com': ['93.184.216.35'],
      }),
      transport: async (input, init) => {
        const headers = new Headers(init?.headers ?? {})
        seen.push({ url: String(input), auth: headers.get('authorization') })
        return String(input).includes('api.example.com')
          ? new Response(null, {
              status: 302,
              headers: { location: 'https://elsewhere.example.com/v1' },
            })
          : new Response('arrived')
      },
    })

    await fetcher('https://api.example.com/v1', {
      headers: { authorization: 'Bearer tenant-secret', accept: 'application/json' },
    })

    expect(seen[0]?.auth).toBe('Bearer tenant-secret')
    expect(seen[1]?.auth).toBeNull()
  })

  test('keeps the credential across a redirect that stays on the same host', async () => {
    const seen: (string | null)[] = []
    const fetcher = createRestrictedFetch({
      lookup: resolvesTo({ 'api.example.com': ['93.184.216.34'] }),
      transport: async (input, init) => {
        seen.push(new Headers(init?.headers ?? {}).get('authorization'))
        return String(input).endsWith('/v1')
          ? new Response(null, {
              status: 302,
              headers: { location: 'https://api.example.com/v2' },
            })
          : new Response('arrived')
      },
    })

    await fetcher('https://api.example.com/v1', {
      headers: { authorization: 'Bearer tenant-secret' },
    })
    expect(seen).toEqual(['Bearer tenant-secret', 'Bearer tenant-secret'])
  })

  test('does not replay a write body to the redirect target', async () => {
    // Replaying it is how one cancellation becomes two.
    const seen: { method?: string; body: unknown }[] = []
    const fetcher = createRestrictedFetch({
      lookup: resolvesTo({
        'api.example.com': ['93.184.216.34'],
        'elsewhere.example.com': ['93.184.216.35'],
      }),
      transport: async (input, init) => {
        seen.push({ method: init?.method, body: init?.body })
        return String(input).includes('api.example.com')
          ? new Response(null, {
              status: 303,
              headers: { location: 'https://elsewhere.example.com/done' },
            })
          : new Response('arrived')
      },
    })

    await fetcher('https://api.example.com/cancel', {
      method: 'POST',
      body: JSON.stringify({ booking_id: 'B-12' }),
    })

    expect(seen[0]?.method).toBe('POST')
    expect(seen[1]?.method).toBe('GET')
    expect(seen[1]?.body).toBeUndefined()
  })

  test('gives up rather than following a redirect loop', async () => {
    const fetcher = createRestrictedFetch({
      lookup: resolvesTo({ 'loop.example.com': ['93.184.216.34'] }),
      transport: async () =>
        new Response(null, { status: 302, headers: { location: 'https://loop.example.com/next' } }),
    })
    expect(await refusal(fetcher('https://loop.example.com/'))).toContain('too many redirects')
  })

  /**
   * Recommendation #5: every redirect status, crossing origins and not.
   *
   * A tool's credential can travel in any header its tenant names, so the rule is which
   * headers may cross, not which may not. And a 307 or 308 replays the body by definition,
   * so across origins it is refused rather than handing account data to another host.
   */
  const TWO_HOSTS = resolvesTo({
    'api.example.com': ['93.184.216.34'],
    'elsewhere.example.com': ['93.184.216.35'],
  })

  for (const code of [301, 302, 303, 307, 308]) {
    test(`a cross-origin ${code} carries no custom credential and no body`, async () => {
      const seen: { url: string; headers: Headers; body: unknown }[] = []
      const fetcher = createRestrictedFetch({
        lookup: TWO_HOSTS,
        transport: async (input, init) => {
          seen.push({ url: String(input), headers: new Headers(init?.headers), body: init?.body })
          return String(input).includes('api.example.com')
            ? new Response(null, {
                status: code,
                headers: { location: 'https://elsewhere.example.com/next' },
              })
            : new Response('arrived')
        },
      })

      const request = fetcher('https://api.example.com/v1', {
        method: 'POST',
        headers: {
          'x-api-key': 'tenant-secret',
          'x-custom-token': 'another-secret',
          authorization: 'Bearer third-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ account: 'A-1' }),
      })

      if (code === 307 || code === 308) {
        expect(await refusal(request)).toContain('another origin')
        expect(seen).toHaveLength(1)
        return
      }

      await request
      expect(seen).toHaveLength(2)
      const second = seen[1]
      expect(second?.headers.get('x-api-key')).toBeNull()
      expect(second?.headers.get('x-custom-token')).toBeNull()
      expect(second?.headers.get('authorization')).toBeNull()
      expect(second?.headers.get('content-type')).toBe('application/json')
      expect(second?.body).toBeUndefined()
    })

    test(`a same-origin ${code} keeps the credential${code >= 307 ? ' and the body' : ''}`, async () => {
      const seen: { headers: Headers; body: unknown; method?: string }[] = []
      const fetcher = createRestrictedFetch({
        lookup: TWO_HOSTS,
        transport: async (input, init) => {
          seen.push({ headers: new Headers(init?.headers), body: init?.body, method: init?.method })
          return String(input).endsWith('/v1')
            ? new Response(null, { status: code, headers: { location: '/v2' } })
            : new Response('arrived')
        },
      })

      await fetcher('https://api.example.com/v1', {
        method: 'POST',
        headers: { 'x-api-key': 'tenant-secret' },
        body: 'payload',
      })

      expect(seen[1]?.headers.get('x-api-key')).toBe('tenant-secret')
      if (code >= 307) {
        expect(seen[1]?.method).toBe('POST')
        expect(seen[1]?.body).toBe('payload')
      } else {
        expect(seen[1]?.method).toBe('GET')
        expect(seen[1]?.body).toBeUndefined()
      }
    })
  }

  test('a Request object keeps its method, headers and body', async () => {
    // The AI SDK may hand over a Request; reading only its URL sent a POST as a bare GET.
    const seen: { method?: string; auth: string | null; body: string }[] = []
    const fetcher = createRestrictedFetch({
      lookup: PUBLIC,
      transport: async (_input, init) => {
        seen.push({
          method: init?.method,
          auth: new Headers(init?.headers).get('authorization'),
          body: new TextDecoder().decode(init?.body as ArrayBuffer),
        })
        return new Response('ok')
      },
    })
    await fetcher(
      new Request('https://api.example.com/v1/chat', {
        method: 'POST',
        headers: { authorization: 'Bearer k' },
        body: '{"model":"m"}',
      }),
    )
    expect(seen).toEqual([{ method: 'POST', auth: 'Bearer k', body: '{"model":"m"}' }])
  })
})

/**
 * Recommendation #4: a tenant's provider URL is held to the same rule, except for origins a
 * platform admin approved for that tenant.
 */
describe('approved origins', () => {
  const GATEWAY = 'http://10.0.0.5:8080'

  test('an approved private origin is reached, over http', async () => {
    const fetcher = createRestrictedFetch({
      allowedOrigins: [GATEWAY],
      lookup: PUBLIC,
      transport: async () => new Response('ok'),
    })
    const response = await fetcher(`${GATEWAY}/v1/models`)
    expect(await response.text()).toBe('ok')
  })

  test('approval is the whole origin: another port or scheme on that host is refused', async () => {
    const fetcher = createRestrictedFetch({
      allowedOrigins: [GATEWAY],
      lookup: PUBLIC,
      transport: async () => new Response('ok'),
    })
    expect(await refusal(fetcher('http://10.0.0.5:5432/'))).toContain('only https')
    expect(await refusal(fetcher('https://10.0.0.5:8080/'))).toContain('not a public address')
    expect(await refusal(fetcher('http://127.0.0.1:20128/'))).toContain('only https')
  })

  test('an approved origin cannot redirect somewhere unapproved', async () => {
    const fetcher = createRestrictedFetch({
      allowedOrigins: [GATEWAY],
      lookup: PUBLIC,
      transport: async () =>
        new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/' } }),
    })
    expect(await refusal(fetcher(`${GATEWAY}/v1/models`))).toContain('not a public address')
  })

  test('without approval the same gateway is refused', async () => {
    const fetcher = createRestrictedFetch({
      lookup: PUBLIC,
      transport: async () => new Response('ok'),
    })
    expect(await refusal(fetcher(`${GATEWAY}/v1/models`))).toContain('only https')
  })
})
