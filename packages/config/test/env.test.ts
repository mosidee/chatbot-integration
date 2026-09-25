import { afterEach, describe, expect, test } from 'bun:test'
import { loadEnv, resetEnvCache } from '../src/index'

const BASE = {
  APP_SECRET_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  DATABASE_URL: 'postgres://x',
  REDIS_URL: 'redis://x',
  S3_ENDPOINT: 'file://./.data/media',
  S3_ACCESS_KEY_ID: 'unused',
  S3_SECRET_ACCESS_KEY: 'unused',
  BETTER_AUTH_SECRET: 'b'.repeat(32),
}

afterEach(() => resetEnvCache())

describe('the LINE media proxy settings', () => {
  test('are accepted together, over https', () => {
    resetEnvCache()
    const env = loadEnv({
      ...BASE,
      LINE_MEDIA_PROXY_URL: 'https://proxy.example.workers.dev',
      LINE_MEDIA_PROXY_SECRET: 's'.repeat(40),
    })
    expect(env.LINE_MEDIA_PROXY_URL).toBe('https://proxy.example.workers.dev')
  })

  test('refuse half a configuration, which would silently switch the proxy off', () => {
    resetEnvCache()
    expect(() =>
      loadEnv({ ...BASE, LINE_MEDIA_PROXY_URL: 'https://proxy.example.workers.dev' }),
    ).toThrow('set together')
  })

  test('refuse plain http, since the request carries the secret and a channel token', () => {
    resetEnvCache()
    expect(() =>
      loadEnv({
        ...BASE,
        LINE_MEDIA_PROXY_URL: 'http://proxy.example.workers.dev',
        LINE_MEDIA_PROXY_SECRET: 's'.repeat(40),
      }),
    ).toThrow('https')
  })
})

describe('the VAPID keys', () => {
  test('refuse half a pair, which would switch push off without saying so', () => {
    resetEnvCache()
    expect(() => loadEnv({ ...BASE, VAPID_PUBLIC_KEY: 'B'.repeat(87) })).toThrow('set together')
  })

  test('accept a pair', () => {
    resetEnvCache()
    const env = loadEnv({
      ...BASE,
      VAPID_PUBLIC_KEY: 'B'.repeat(87),
      VAPID_PRIVATE_KEY: 'k'.repeat(43),
    })
    expect(env.VAPID_PUBLIC_KEY).toHaveLength(87)
    resetEnvCache()
  })
})
