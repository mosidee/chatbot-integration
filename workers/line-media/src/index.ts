/**
 * A narrow proxy for LINE message content.
 *
 * The VPS reaches LINE's content server (api-data.line.me, Tokyo) over a route that loses a
 * third of its packets, so a photo arrives at about 14 KB/s and the customer's answer waits a
 * minute or more behind it. This Worker makes the same request from Cloudflare's network and
 * streams the bytes back. It stores nothing and logs nothing.
 *
 * It can only ever fetch one kind of URL, built here from a numeric message id: never a URL
 * it is given, or it would be an open proxy. The caller proves itself with a shared secret;
 * the LINE token travels in the body, per request, because each tenant's channel has its own.
 */

type Env = { PROXY_SECRET: string }

const MESSAGE_ID = /^\d{1,32}$/

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
    if (!env.PROXY_SECRET || !(await authorised(request, env.PROXY_SECRET))) {
      return new Response('unauthorised', { status: 401 })
    }

    let body: { messageId?: unknown; token?: unknown }
    try {
      body = await request.json()
    } catch {
      return new Response('bad request', { status: 400 })
    }
    const { messageId, token } = body
    if (typeof messageId !== 'string' || !MESSAGE_ID.test(messageId)) {
      return new Response('bad message id', { status: 400 })
    }
    if (typeof token !== 'string' || token.length === 0 || token.length > 1024) {
      return new Response('bad token', { status: 400 })
    }

    const upstream = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
      headers: { authorization: `Bearer ${token}` },
    })

    // Status and type pass through unchanged; the caller decides what a refusal means.
    // `x-upstream` tells LINE's own answer apart from this Worker's refusals (401, 400),
    // so the caller does not retry a photo LINE says is gone.
    const headers = new Headers({ 'cache-control': 'no-store', 'x-upstream': 'line' })
    const type = upstream.headers.get('content-type')
    if (type) headers.set('content-type', type)
    const length = upstream.headers.get('content-length')
    if (length) headers.set('content-length', length)
    return new Response(upstream.body, { status: upstream.status, headers })
  },
}

/** `Authorization: Bearer <secret>`, compared in constant time. */
async function authorised(request: Request, secret: string): Promise<boolean> {
  const header = request.headers.get('authorization') ?? ''
  const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
  const encoder = new TextEncoder()
  // Hash both sides first, so the comparison is over equal lengths whatever was sent.
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(given)),
    crypto.subtle.digest('SHA-256', encoder.encode(secret)),
  ])
  return (
    crypto.subtle as unknown as { timingSafeEqual(x: ArrayBuffer, y: ArrayBuffer): boolean }
  ).timingSafeEqual(a, b)
}
