import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'
import zlib from 'node:zlib'

/**
 * One HTTP request, connected to an address we already checked.
 *
 * `fetch` resolves the hostname again when it connects, and a name can answer differently
 * the second time: public for the egress check, `127.0.0.1` a moment later. Connecting to
 * the address the check approved closes that window. The hostname still goes to TLS, so the
 * certificate is verified against the name and SNI is sent as usual; only the resolution is
 * ours.
 *
 * `agent: false` matters: a pooled connection skips `lookup` altogether and would carry the
 * request to whichever address the pool connected to first.
 */
export async function pinnedRequest(
  url: URL,
  init: RequestInit,
  addresses: { address: string; family: number }[],
): Promise<Response> {
  // Normalised through a Request, which turns every body type fetch accepts into bytes and
  // supplies the content type a FormData or URLSearchParams body implies.
  const method = (init.method ?? 'GET').toUpperCase()
  const normalised = new Request(url, {
    method,
    headers: init.headers,
    ...(init.body != null && method !== 'GET' && method !== 'HEAD' ? { body: init.body } : {}),
  })
  const body = normalised.body != null ? Buffer.from(await normalised.arrayBuffer()) : undefined

  const headers: Record<string, string> = {}
  for (const [name, value] of normalised.headers.entries()) headers[name] = value
  if (body) headers['content-length'] = String(body.byteLength)

  const client = url.protocol === 'https:' ? https : http
  const first = addresses[0]
  if (!first) throw new Error(`no address to connect to for ${url.hostname}`)

  return new Promise<Response>((resolve, reject) => {
    const request = client.request(
      url,
      {
        method,
        headers,
        agent: false,
        ...(init.signal ? { signal: init.signal } : {}),
        lookup: (_hostname, options, callback) => {
          const all = (options as { all?: boolean }).all
          if (all) {
            ;(callback as (e: null, a: { address: string; family: number }[]) => void)(
              null,
              addresses,
            )
          } else {
            ;(callback as (e: null, a: string, f: number) => void)(
              null,
              first.address,
              first.family,
            )
          }
        },
      },
      (incoming) => {
        const status = incoming.statusCode ?? 502
        const responseHeaders = new Headers()
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value === undefined) continue
          for (const one of Array.isArray(value) ? value : [value])
            responseHeaders.append(name, one)
        }

        // fetch decompresses for its callers; this has to as well, or JSON arrives gzipped.
        let stream: Readable = incoming
        const encoding = (responseHeaders.get('content-encoding') ?? '').toLowerCase()
        if (encoding === 'gzip' || encoding === 'x-gzip')
          stream = incoming.pipe(zlib.createGunzip())
        else if (encoding === 'deflate') stream = incoming.pipe(zlib.createInflate())
        else if (encoding === 'br') stream = incoming.pipe(zlib.createBrotliDecompress())
        if (stream !== incoming) {
          responseHeaders.delete('content-encoding')
          responseHeaders.delete('content-length')
        }

        const noBody = method === 'HEAD' || status === 204 || status === 304
        if (noBody) incoming.resume()
        resolve(
          new Response(noBody ? null : (Readable.toWeb(stream) as unknown as ReadableStream), {
            status,
            statusText: incoming.statusMessage ?? '',
            headers: responseHeaders,
          }),
        )
      },
    )
    request.on('error', reject)
    if (body) request.write(body)
    request.end()
  })
}
