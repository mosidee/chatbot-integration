import type { FetchLike } from '@ci/core'

/**
 * `fetch` with a deadline and a ceiling on the body. The restricted client has neither, and
 * the SDK reads a whole response before anything here can trim it, so without this a
 * tenant's server could hold a worker or fill its memory within one call.
 */
export function boundedFetch(
  fetch: FetchLike,
  limits: { maxBytes: number; timeoutMs: number },
): FetchLike {
  return async (input, init) => {
    const deadline = AbortSignal.timeout(limits.timeoutMs)
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline
    const response = await fetch(input, { ...init, signal })
    if (!response.body) return response
    let seen = 0
    const capped = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          seen += chunk.byteLength
          if (seen > limits.maxBytes) {
            controller.error(new Error(`the server sent more than ${limits.maxBytes} bytes`))
            return
          }
          controller.enqueue(chunk)
        },
      }),
    )
    return new Response(capped, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}
