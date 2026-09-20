import type { Server } from 'bun'

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
  | { kind: 'error'; status: number; message: string }

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

  const server: Server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)

      // A real, fetchable image: the AI SDK downloads image URLs before sending them,
      // so tests need a URL that actually resolves.
      if (url.pathname.startsWith('/img/')) {
        return new Response(ONE_PIXEL_PNG, { headers: { 'content-type': 'image/png' } })
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
