import { afterAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { loadEnv } from '@ci/config'
import { createBlobStore } from '../src/blob'
import { createFilesystemBlobStore } from '../src/blob-fs'

/**
 * Storage is exercised through whichever implementation the environment selects, so CI
 * proves the S3 path against MinIO while a macOS developer proves the filesystem one.
 * The filesystem store is always tested, because its behaviour must match the port.
 */

const env = loadEnv()
const usingS3 = !env.S3_ENDPOINT.startsWith('file://')

function bytes(values: number[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(values.length))
  out.set(values)
  return out
}

describe('filesystem blob store', () => {
  const root = `/tmp/ci-blob-test-${crypto.randomUUID()}`
  const store = createFilesystemBlobStore(root, '/api/v1/uploads')

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test('round-trips an object with its media type', async () => {
    await store.put('ws-1/a.png', bytes([1, 2, 3, 4]), 'image/png')
    const got = await store.get('ws-1/a.png')
    expect([...got.data]).toEqual([1, 2, 3, 4])
    expect(got.mime).toBe('image/png')
  })

  test('creates nested directories as needed', async () => {
    await store.put('ws-1/deep/nested/b.bin', bytes([9]), 'application/octet-stream')
    expect((await store.get('ws-1/deep/nested/b.bin')).data.length).toBe(1)
  })

  test('overwrites an existing key', async () => {
    await store.put('ws-1/c.txt', bytes([1]), 'text/plain')
    await store.put('ws-1/c.txt', bytes([2, 2]), 'text/plain')
    expect([...(await store.get('ws-1/c.txt')).data]).toEqual([2, 2])
  })

  test('rejects a key that escapes the root', async () => {
    await expect(store.put('../escape.txt', bytes([1]), 'text/plain')).rejects.toThrow(
      /escapes the root/,
    )
    await expect(store.get('ws-1/../../etc/passwd')).rejects.toThrow(/escapes the root/)
  })

  test('fails on a missing key', async () => {
    await expect(store.get('ws-1/missing.bin')).rejects.toThrow()
  })

  test('builds a url from the public prefix', () => {
    expect(store.urlFor('ws-1/a.png')).toBe('/api/v1/uploads/ws-1/a.png')
  })

  test('returns ArrayBuffer-backed bytes that Response accepts', async () => {
    await store.put('ws-1/d.bin', bytes([7, 7]), 'application/octet-stream')
    const got = await store.get('ws-1/d.bin')
    // Would not compile, and would throw at runtime, for a SharedArrayBuffer-backed view.
    expect(new Response(new Blob([got.data])).body).toBeTruthy()
  })
})

describe.if(usingS3)('S3-compatible blob store', () => {
  const store = createBlobStore({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    publicUrl: env.S3_PUBLIC_URL,
  })

  test('round-trips an object with its media type', async () => {
    const key = `test/${crypto.randomUUID()}.png`
    await store.put(key, bytes([1, 2, 3, 4]), 'image/png')
    const got = await store.get(key)
    expect([...got.data]).toEqual([1, 2, 3, 4])
    expect(got.mime).toBe('image/png')
  })

  test('fails on a missing key', async () => {
    await expect(store.get(`test/${crypto.randomUUID()}.missing`)).rejects.toThrow()
  })
})
