import { describe, expect, test } from 'bun:test'
import { resolveWebVisitor, webChannelAdapter } from '../src/adapters/web-channel'
import { signVisitorToken, VisitorTokenError, verifyVisitorToken } from '../src/jwt'

const SECRET = 'a-shared-secret-at-least-16-chars'

describe('visitor tokens', () => {
  test('round-trips claims', async () => {
    const token = await signVisitorToken({ sub: 'acct_1', name: 'Nok' }, SECRET)
    const claims = await verifyVisitorToken(token, SECRET)
    expect(claims.sub).toBe('acct_1')
    expect(claims.name).toBe('Nok')
  })

  test('rejects a token signed with a different secret', async () => {
    const token = await signVisitorToken({ sub: 'acct_1' }, SECRET)
    await expect(verifyVisitorToken(token, 'another-secret-at-least-16')).rejects.toThrow(
      VisitorTokenError,
    )
  })

  test('rejects a tampered payload', async () => {
    const token = await signVisitorToken({ sub: 'acct_1' }, SECRET)
    const [header, , signature] = token.split('.')
    const forged = btoa(JSON.stringify({ sub: 'acct_999' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    await expect(verifyVisitorToken(`${header}.${forged}.${signature}`, SECRET)).rejects.toThrow(
      /signature mismatch/,
    )
  })

  test('rejects an expired token', async () => {
    const token = await signVisitorToken(
      { sub: 'acct_1', exp: Math.floor(Date.now() / 1000) - 60 },
      SECRET,
    )
    await expect(verifyVisitorToken(token, SECRET)).rejects.toThrow(/expired/)
  })

  test('accepts a token that has not yet expired', async () => {
    const token = await signVisitorToken(
      { sub: 'acct_1', exp: Math.floor(Date.now() / 1000) + 600 },
      SECRET,
    )
    expect((await verifyVisitorToken(token, SECRET)).sub).toBe('acct_1')
  })

  test('rejects an algorithm other than HS256', async () => {
    const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' })).replace(/=+$/, '')
    const payload = btoa(JSON.stringify({ sub: 'x' })).replace(/=+$/, '')
    await expect(verifyVisitorToken(`${header}.${payload}.`, SECRET)).rejects.toThrow(
      /unsupported algorithm/,
    )
  })

  test('rejects a malformed token', async () => {
    await expect(verifyVisitorToken('not-a-token', SECRET)).rejects.toThrow(/three segments/)
  })

  test('rejects a payload missing the subject', async () => {
    const token = await signVisitorToken({ sub: '' } as never, SECRET)
    await expect(verifyVisitorToken(token, SECRET)).rejects.toThrow(/required claims/)
  })
})

describe('resolveWebVisitor', () => {
  const config = webChannelAdapter.parseConfig({ visitorTokenSecret: SECRET })

  test('identifies a visitor holding a valid token', async () => {
    const token = await signVisitorToken(
      { sub: 'acct_7', name: 'Nok', email: 'nok@example.com', attributes: { plan: 'pro' } },
      SECRET,
    )
    const result = await resolveWebVisitor({ visitorId: 'browser-1', token }, config)
    expect(result).toEqual({
      externalId: 'host:acct_7',
      identified: true,
      displayName: 'Nok',
      attributes: { plan: 'pro', email: 'nok@example.com' },
    })
  })

  test('gives the same identity across browsers for one account', async () => {
    const token = await signVisitorToken({ sub: 'acct_7' }, SECRET)
    const a = await resolveWebVisitor({ visitorId: 'browser-1', token }, config)
    const b = await resolveWebVisitor({ visitorId: 'browser-2', token }, config)
    expect(a.externalId).toBe(b.externalId)
  })

  test('falls back to anonymous without a token', async () => {
    const result = await resolveWebVisitor({ visitorId: 'browser-1' }, config)
    expect(result.externalId).toBe('anon:browser-1')
    expect(result.identified).toBe(false)
  })

  test('degrades to anonymous rather than failing on an expired token', async () => {
    const token = await signVisitorToken(
      { sub: 'acct_7', exp: Math.floor(Date.now() / 1000) - 10 },
      SECRET,
    )
    const result = await resolveWebVisitor({ visitorId: 'browser-1', token }, config)
    expect(result.identified).toBe(false)
    expect(result.externalId).toBe('anon:browser-1')
  })

  test('ignores tokens when no secret is configured', async () => {
    const noSecret = webChannelAdapter.parseConfig({})
    const token = await signVisitorToken({ sub: 'acct_7' }, SECRET)
    const result = await resolveWebVisitor({ visitorId: 'browser-1', token }, noSecret)
    expect(result.identified).toBe(false)
  })

  test('anonymous and identified ids cannot collide', async () => {
    const token = await signVisitorToken({ sub: 'browser-1' }, SECRET)
    const identified = await resolveWebVisitor({ visitorId: 'x', token }, config)
    const anonymous = await resolveWebVisitor({ visitorId: 'browser-1' }, config)
    expect(identified.externalId).not.toBe(anonymous.externalId)
  })
})
