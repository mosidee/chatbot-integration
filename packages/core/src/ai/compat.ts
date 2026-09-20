/**
 * Tolerating self-hosted OpenAI-compatible gateways.
 *
 * The product's promise is that any OpenAI-compatible endpoint works, and in practice the
 * self-hosted ones are not uniformly compatible. Two shapes were found on one real gateway,
 * both in answer to a request that did **not** ask for streaming.
 *
 * The first returns the complete JSON body with the Server-Sent Events terminator appended
 * to it, labelled `text/event-stream`:
 *
 * ```
 * {"id":"…","choices":[…]}data: [DONE]
 * ```
 *
 * That is valid JSON with trailing rubbish, so parsing fails and every reply comes back as
 * "Invalid JSON response" with no indication of why.
 *
 * The second, used by the same gateway for a different upstream, is a genuine stream of
 * `chat.completion.chunk` frames carrying deltas. There is no complete answer anywhere in
 * it: the text has to be assembled from the fragments. Taking the last frame, which is what
 * this file used to do, yields a chunk whose choices hold `delta` and no `message`, so the
 * reply arrives empty and a tool call is lost entirely.
 *
 * Rather than telling an operator their gateway is wrong and leaving them stuck, the
 * response is repaired when it can be repaired, and passed through untouched otherwise.
 */

type ToolCallFragment = {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

type StreamFrame = {
  id?: string
  created?: number
  model?: string
  object?: string
  usage?: unknown
  choices?: {
    index?: number
    delta?: { role?: string; content?: string; tool_calls?: ToolCallFragment[] }
    message?: unknown
    finish_reason?: string | null
  }[]
}

/** A frame is a fragment when it carries a delta rather than a finished message. */
function isChunk(frame: StreamFrame): boolean {
  if (frame.object === 'chat.completion.chunk') return true
  return (frame.choices ?? []).some((choice) => choice.delta !== undefined)
}

/**
 * Rebuild one chat completion from the fragments of a stream.
 *
 * Content is concatenated in arrival order. Tool calls arrive split across frames, keyed by
 * their position rather than their id, and their arguments are streamed as a string in
 * pieces, so both are joined per position.
 */
export function assembleStreamedCompletion(frames: StreamFrame[]): string | null {
  if (frames.length === 0) return null

  const choices = new Map<
    number,
    { content: string; finishReason: string | null; toolCalls: Map<number, ToolCallFragment> }
  >()
  let usage: unknown
  let id: string | undefined
  let created: number | undefined
  let model: string | undefined

  for (const frame of frames) {
    id ??= frame.id
    created ??= frame.created
    model ??= frame.model
    if (frame.usage !== undefined && frame.usage !== null) usage = frame.usage

    for (const choice of frame.choices ?? []) {
      const index = choice.index ?? 0
      let accumulated = choices.get(index)
      if (!accumulated) {
        accumulated = { content: '', finishReason: null, toolCalls: new Map() }
        choices.set(index, accumulated)
      }
      if (choice.delta?.content) accumulated.content += choice.delta.content
      if (choice.finish_reason) accumulated.finishReason = choice.finish_reason

      for (const fragment of choice.delta?.tool_calls ?? []) {
        const position = fragment.index ?? 0
        const existing = accumulated.toolCalls.get(position)
        if (!existing) {
          accumulated.toolCalls.set(position, {
            index: position,
            id: fragment.id,
            type: fragment.type ?? 'function',
            function: {
              name: fragment.function?.name,
              arguments: fragment.function?.arguments ?? '',
            },
          })
          continue
        }
        existing.id ??= fragment.id
        if (fragment.function?.name) {
          existing.function = { ...existing.function, name: fragment.function.name }
        }
        if (fragment.function?.arguments) {
          existing.function = {
            ...existing.function,
            arguments: (existing.function?.arguments ?? '') + fragment.function.arguments,
          }
        }
      }
    }
  }

  if (choices.size === 0) return null

  return JSON.stringify({
    id: id ?? 'chatcmpl-assembled',
    object: 'chat.completion',
    created: created ?? Math.floor(Date.now() / 1000),
    model: model ?? '',
    choices: [...choices.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, accumulated]) => {
        const toolCalls = [...accumulated.toolCalls.values()]
          .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
          .map(({ index: _index, ...call }) => call)
        return {
          index,
          message: {
            role: 'assistant',
            // Null rather than empty when the answer is a tool call, which is what the
            // OpenAI API itself returns and what the SDK expects to see.
            content:
              accumulated.content === '' && toolCalls.length > 0 ? null : accumulated.content,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: accumulated.finishReason ?? 'stop',
        }
      }),
    ...(usage !== undefined ? { usage } : {}),
  })
}

/** Pull a single JSON document out of a body that also carries stream framing. */
export function recoverJsonBody(text: string): string | null {
  // A JSON document with the terminator stuck on the end.
  const withoutTerminator = text.replace(/\s*data:\s*\[DONE\]\s*$/i, '').trim()
  if (withoutTerminator.length > 0 && isJson(withoutTerminator)) return withoutTerminator

  const frames: StreamFrame[] = []
  for (const match of text.matchAll(/^data:\s*(.+)$/gm)) {
    const payload = match[1]?.trim() ?? ''
    if (payload.length === 0 || payload === '[DONE]') continue
    const parsed = parseJson(payload)
    if (parsed !== null) frames.push(parsed)
  }

  if (frames.length === 0) return null

  // Fragments of an answer: assemble them. Anything else, such as a gateway that sends one
  // complete completion inside a frame, is already the answer.
  if (frames.some(isChunk)) return assembleStreamedCompletion(frames)

  const last = frames[frames.length - 1]
  return last === undefined ? null : JSON.stringify(last)
}

function parseJson(text: string): StreamFrame | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? (parsed as StreamFrame) : null
  } catch {
    return null
  }
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
 * Deliberately narrow: it only acts when the response claims to be an event stream and the
 * request did not ask for one. Anything it cannot make sense of is returned exactly as it
 * arrived, so a real stream is never disturbed and a genuine error still reads as itself.
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
