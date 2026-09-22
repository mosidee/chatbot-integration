import { newId } from '@ci/db'
import Elysia from 'elysia'
import { z } from 'zod'
import { authPlugin } from '../auth-plugin'
import type { ApiContext } from '../context'

/**
 * Media upload.
 *
 * Files land in object storage and callers receive a storage key. The key, not a URL, is
 * what goes into a message: the worker reads the object back as bytes for the vision model,
 * so the bucket never has to be reachable from a model provider (ADR 0001).
 */

const MAX_BYTES = 20 * 1024 * 1024

/**
 * What an agent may put in front of a customer.
 *
 * Images and documents: a receipt, a price list, a screenshot, an invoice. Deliberately not
 * "anything the channel accepts" — an archive or an installer relayed through us is a thing
 * we would rather not be the courier for, and a customer's phone would likely refuse it
 * anyway. Audio and video stay because inbound media lands here too.
 */
const ALLOWED_PREFIXES = [
  'image/',
  'audio/',
  'video/',
  'text/',
  'application/pdf',
  // The office formats, old and new, by their exact types rather than a prefix: the
  // `application/` space is mostly things that should not be relayed.
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/rtf',
]

export function uploadRoutes(ctx: ApiContext) {
  const { runtime } = ctx

  return (
    new Elysia({ prefix: '/uploads' })
      .use(authPlugin(ctx))

      .post(
        '/',
        async ({ workspaceId, request, status }) => {
          const form = await request.formData()
          const file = form.get('file')

          if (!(file instanceof File)) {
            return status(422, { error: 'Expected a file field' })
          }
          if (file.size > MAX_BYTES) {
            return status(413, { error: `File exceeds ${MAX_BYTES / 1024 / 1024}MB` })
          }

          const mime = file.type || 'application/octet-stream'
          if (!ALLOWED_PREFIXES.some((prefix) => mime.startsWith(prefix))) {
            return status(415, { error: `Unsupported media type ${mime}` })
          }

          // Keyed by workspace so a leaked key from one tenant cannot name another's object.
          const extension = file.name.includes('.') ? `.${file.name.split('.').pop()}` : ''
          const storageKey = `${workspaceId}/${newId()}${extension}`

          const bytes = new Uint8Array(await file.arrayBuffer())
          await runtime.blob.put(storageKey, bytes, mime)

          return {
            storageKey,
            url: runtime.blob.urlFor(storageKey),
            mime,
            sizeBytes: file.size,
            fileName: file.name,
          }
        },
        { auth: 'agent' },
      )

      /**
       * Stream an object back to the browser.
       * Proxied through the API so the bucket stays private and access follows the session.
       */
      .get(
        '/*',
        async ({ workspaceId, params, status }) => {
          const key = (params as Record<string, string>)['*'] ?? ''
          if (!key.startsWith(`${workspaceId}/`)) {
            return status(404, { error: 'Not found' })
          }
          try {
            const object = await runtime.blob.get(key)
            // Wrapped in a Blob so the body type is concrete regardless of the buffer the
            // storage client handed back.
            return new Response(new Blob([object.data], { type: object.mime }), {
              headers: {
                'content-type': object.mime,
                'cache-control': 'private, max-age=3600',
              },
            })
          } catch {
            return status(404, { error: 'Not found' })
          }
        },
        { auth: 'viewer', params: z.object({ '*': z.string() }) },
      )
  )
}
