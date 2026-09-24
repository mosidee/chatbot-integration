import { isWorkspaceKey, mediaServingHeaders, verifyMediaToken } from '@ci/infra'
import Elysia from 'elysia'
import type { ApiContext } from '../context'

/**
 * Where a chat platform fetches a file we sent.
 *
 * Public by necessity, like the widget's own API and the identity confirmation: the caller
 * is LINE's or Meta's fetcher, which has no session with us and never will. What stands in
 * is the signature on the link. It names one storage key and an expiry, so a link cannot be
 * edited into a link for another file, and it stops working on its own.
 *
 * Deliberately outside `/api/v1`: its contract is with somebody else's infrastructure
 * rather than with our console, and versioning the two together would tie a platform's
 * cached URLs to our internal changes.
 */
export function mediaRoutes(ctx: ApiContext) {
  const { env, runtime } = ctx

  return new Elysia({ name: 'media-routes' }).get('/*', async ({ params, status }) => {
    /**
     * The path is `<token>/<file name>`. Only the token is read: the name is decoration, so
     * that the URL ends in something a platform and a person both recognise.
     */
    const path = (params as Record<string, string>)['*'] ?? ''
    const token = path.split('/')[0] ?? ''
    if (!token) return status(404, { error: 'Not found' })

    let key: string
    try {
      const claims = await verifyMediaToken(token, env.APP_SECRET_KEY)
      // Signed by us, and checked again anyway: a link minted before the canonical-key rule
      // must not reach another tenant's file through a `..` in its key.
      if (!isWorkspaceKey(claims.ws, claims.key)) throw new Error('foreign key')
      key = claims.key
    } catch {
      /**
       * An expired link and a forged one get the same answer. There is nothing useful to
       * tell the difference to, and a fetcher holding a dead URL should simply stop.
       */
      return status(404, { error: 'Not found' })
    }

    try {
      const object = await runtime.blob.get(key)
      return new Response(new Blob([object.data]), {
        headers: {
          // The same policy as the console's own route: this one is public and on our origin.
          ...mediaServingHeaders(object.mime),
          /**
           * Public because the link is the credential and it expires; a platform's fetcher
           * and its CDN are entitled to keep the copy for as long as the link lives.
           */
          'cache-control': `public, max-age=${env.MEDIA_LINK_TTL_DAYS * 24 * 60 * 60}`,
        },
      })
    } catch {
      return status(404, { error: 'Not found' })
    }
  })
}
