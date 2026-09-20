/**
 * A minimal OpenAI-compatible chat-completions server.
 *
 * Tests run against this rather than a stubbed model so the real provider wiring
 * (createOpenAICompatible → HTTP → response parsing) is exercised end to end.
 */

export type ToolCallSpec = { name: string; arguments: Record<string, unknown> }

export type MockReply =
  | { kind: 'text'; text: string }
  | { kind: 'tool_calls'; toolCalls: ToolCallSpec[] }
  /** Structured output: the value is returned as the assistant's JSON content. */
  | { kind: 'json'; value: unknown }
  | { kind: 'error'; status: number; message: string }

/** Hash character trigrams into a normalised vector of the requested size. */
export function trigramEmbedding(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0)
  const normalised = ` ${text.toLowerCase().trim()} `

  for (let i = 0; i < normalised.length - 2; i += 1) {
    const gram = normalised.slice(i, i + 3)
    let hash = 2166136261
    for (let c = 0; c < gram.length; c += 1) {
      hash ^= gram.charCodeAt(c)
      hash = Math.imul(hash, 16777619)
    }
    const slot = Math.abs(hash) % dimensions
    vector[slot] = (vector[slot] ?? 0) + 1
  }

  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0))
  if (magnitude === 0) {
    // An empty string still needs a unit vector; pgvector cannot compare a zero vector.
    vector[0] = 1
    return vector
  }
  return vector.map((v) => v / magnitude)
}

const ONE_PIXEL_PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
)

export type MockServer = {
  url: string
  /** Every request body the server received, in order. */
  requests: unknown[]
  stop: () => void
}

/**
 * `replies` is consumed one entry per request. The last entry repeats once exhausted,
 * which keeps multi-step tool loops simple to script.
 */
export function startMockOpenAI(replies: MockReply[]): MockServer {
  const requests: unknown[] = []
  let index = 0

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)

      // A real, fetchable image: the AI SDK downloads image URLs before sending them,
      // so tests need a URL that actually resolves.
      if (url.pathname.startsWith('/img/')) {
        return new Response(ONE_PIXEL_PNG, { headers: { 'content-type': 'image/png' } })
      }

      // Deterministic embeddings: character trigrams hashed into a fixed-size vector, then
      // normalised. Crude, but genuinely semantic in the only sense tests need — text that
      // shares substrings produces nearby vectors — so retrieval assertions mean something.
      if (url.pathname.endsWith('/embeddings')) {
        const payload = (await request.json()) as {
          input?: string | string[]
          model?: string
          dimensions?: number
        }
        const inputs = Array.isArray(payload.input) ? payload.input : [payload.input ?? '']
        const dimensions = payload.dimensions ?? 1024

        return Response.json({
          object: 'list',
          model: payload.model ?? 'mock-embed',
          data: inputs.map((text, index) => ({
            object: 'embedding',
            index,
            embedding: trigramEmbedding(text, dimensions),
          })),
          usage: { prompt_tokens: inputs.join(' ').length, total_tokens: inputs.join(' ').length },
        })
      }

      // A reranker that simply reverses the given order: clearly different from the fused
      // order, so a test can tell whether reranking actually took effect.
      if (url.pathname.endsWith('/rerank')) {
        const payload = (await request.json()) as { documents?: string[]; top_n?: number }
        const documents = payload.documents ?? []
        const indices = documents.map((_, i) => i).reverse()
        const limited = payload.top_n === undefined ? indices : indices.slice(0, payload.top_n)
        return Response.json({
          results: limited.map((index, rank) => ({
            index,
            relevance_score: 1 - rank / Math.max(limited.length, 1),
          })),
        })
      }

      if (url.pathname.endsWith('/models')) {
        return Response.json({
          object: 'list',
          data: [{ id: 'mock-model', object: 'model', owned_by: 'mock' }],
        })
      }

      const body = await request.json().catch(() => ({}))
      requests.push(body)

      const reply = replies[Math.min(index, replies.length - 1)] ?? { kind: 'text', text: 'ok' }
      index += 1

      if (reply.kind === 'error') {
        return Response.json({ error: { message: reply.message } }, { status: reply.status })
      }

      const message =
        reply.kind === 'text'
          ? { role: 'assistant', content: reply.text }
          : reply.kind === 'json'
            ? { role: 'assistant', content: JSON.stringify(reply.value) }
            : {
                role: 'assistant',
                content: null,
                tool_calls: reply.toolCalls.map((call, i) => ({
                  id: `call_${i}`,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                })),
              }

      return Response.json({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-model',
        choices: [
          {
            index: 0,
            message,
            finish_reason: reply.kind === 'tool_calls' ? 'tool_calls' : 'stop',
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      })
    },
  })

  return {
    url: `http://localhost:${server.port}`,
    requests,
    stop: () => server.stop(true),
  }
}
