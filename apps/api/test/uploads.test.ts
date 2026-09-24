import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { loadEnv } from '@ci/config'
import { signMediaUrl } from '@ci/infra'
import { createApp } from '../src/app'
import { createApiContext } from '../src/context'
import { type ApiFixture, createApiFixture } from './helpers/session'

/**
 * Recommendation #3: stored files are served on the console's own origin, so a file a
 * sender chose must never run there with an agent's session.
 */

const env = loadEnv()
const ctx = createApiContext(env)
const app = createApp(ctx)

let fixture: ApiFixture

beforeAll(async () => {
  fixture = await createApiFixture(ctx, app)
})

afterAll(async () => {
  await fixture.cleanup()
  await ctx.runtime.close()
})

/** A multipart body with its boundary, which the fixture would otherwise label as JSON. */
async function upload(name: string, type: string, content: string) {
  const form = new FormData()
  form.set('file', new File([content], name, { type }))
  const encoded = new Request('http://localhost/', { method: 'POST', body: form })
  return fixture.as(fixture.agent, '/api/v1/uploads', {
    method: 'POST',
    headers: { 'content-type': encoded.headers.get('content-type') ?? '' },
    body: await encoded.arrayBuffer(),
  })
}

const SCRIPT =
  '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/v1/admin")</script></svg>'

describe('uploads', () => {
  test('refuses SVG and HTML, which are documents that can carry script', async () => {
    expect((await upload('x.svg', 'image/svg+xml', SCRIPT)).status).toBe(415)
    expect((await upload('x.html', 'text/html', '<script>1</script>')).status).toBe(415)
  })

  test('keeps the storage key inside the workspace whatever the name says', async () => {
    const response = await upload('../../other/evil.png', 'image/png', 'png-bytes')
    expect(response.status).toBe(200)
    const { storageKey } = await response.json()
    expect(storageKey).toMatch(new RegExp(`^${fixture.workspaceId}/[^/]+\\.png$`))
  })

  test('a stored active document is served as a sandboxed download', async () => {
    // As if it arrived by another path — inbound media, a knowledge file, an older upload.
    const key = `${fixture.workspaceId}/stored-before.svg`
    await ctx.runtime.blob.put(key, new TextEncoder().encode(SCRIPT), 'image/svg+xml')

    const response = await fixture.as(fixture.viewer, `/api/v1/uploads/${key}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toBe('attachment')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toContain('sandbox')
  })

  test('an image is still shown inline', async () => {
    const { storageKey } = await (await upload('photo.png', 'image/png', 'png-bytes')).json()
    const response = await fixture.as(fixture.viewer, `/api/v1/uploads/${storageKey}`)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('content-disposition')).toBe('inline')
  })

  test('the signed public link serves it the same way', async () => {
    // What LINE and Messenger fetch, and what a customer opens: public, on our origin.
    const key = `${fixture.workspaceId}/signed-before.svg`
    await ctx.runtime.blob.put(key, new TextEncoder().encode(SCRIPT), 'image/svg+xml')
    const url = await signMediaUrl({
      workspaceId: fixture.workspaceId,
      storageKey: key,
      secret: env.APP_SECRET_KEY,
      baseUrl: 'http://localhost',
      ttlDays: 1,
    })

    const response = await fixture.as(null, new URL(url).pathname)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toBe('attachment')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toContain('sandbox')
  })
})
