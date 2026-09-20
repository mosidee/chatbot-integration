/**
 * Tolerating self-hosted OpenAI-compatible gateways.
 *
 * The product's promise is that any OpenAI-compatible endpoint works, and in practice the
 * self-hosted ones are not uniformly compatible. The case this handles was found on a real
 * gateway: it answers a **non-streaming** request with the complete JSON body and then
 * appends the Server-Sent Events terminator to the same body, labelling the whole thing
 * `text/event-stream`:
 *
 * ```
 * {"id":"…","choices":[…]}data: [DONE]
 * ```
 *
 * That is valid JSON with trailing rubbish, so parsing fails and every reply comes back as
 * "Invalid JSON response" with no indication of why.
 *
 * Rather than telling an operator their gateway is wrong and leaving them stuck, the
 * response is repaired when it can be repaired, and passed through untouched otherwise.
 */

/** Pull a single JSON document out of a body that also carries stream framing. */
export function recoverJsonBody(text: string): string | null {
  // A JSON document with the terminator stuck on the end.
  const withoutTerminator = text.replace(/\s*data:\s*\[DONE\]\s*$/i, '').trim()
  if (withoutTerminator.length > 0 && isJson(withoutTerminator)) return withoutTerminator

  // Or genuine Server-Sent Events frames: the last complete payload is the answer.
  const payloads = [...text.matchAll(/^data:\s*(.+)$/gm)]
    .map((match) => match[1]?.trim() ?? '')
    .filter((payload) => payload.length > 0 && payload !== '[DONE]')

  for (const payload of payloads.reverse()) {
    if (isJson(payload)) return payload
  }

  return null
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

function askedForStreaming(init: RequestInit | undefined): boolean {
  const body = init?.body
  if (typeof body !== 'string') return false
  try {
    return (JSON.parse(body) as { stream?: unknown }).stream === true
  } catch {
    return false
  }
}

/**
 * A fetch that repairs stream-framed responses to non-streaming requests.
 *
 * Deliberately narrow: it only acts when the response claims to be an event stream, the
 * request did not ask for one, and the body yields a single JSON document. Anything else is
 * returned exactly as it arrived, so a real stream is never disturbed.
 */
export function createCompatibleFetch(baseFetch: typeof fetch = fetch): typeof fetch {
  const compatible = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const response = await baseFetch(input, init)

    if (askedForStreaming(init)) return response
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('event-stream')) return response

    const text = await response.text()
    const recovered = recoverJsonBody(text)

    if (recovered === null) {
      // Nothing to repair; hand back what arrived so the error reflects reality.
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    }

    const headers = new Headers(response.headers)
    headers.set('content-type', 'application/json')
    return new Response(recovered, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }

  // The SDK's option is typed as the full fetch, which carries this. Delegate rather than
  // cast, so the shim stays a drop-in replacement.
  compatible.preconnect = baseFetch.preconnect ?? (() => {})
  return compatible as typeof fetch
}
