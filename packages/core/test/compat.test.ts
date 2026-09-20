import { describe, expect, test } from 'bun:test'
import { createCompatibleFetch, recoverJsonBody } from '../src/ai/compat'

/**
 * Repairing gateways that frame a non-streaming answer as an event stream.
 *
 * The shape here is taken from a real gateway, which answered a non-streaming request with
 * the complete JSON body and the stream terminator appended to it, labelled
 * text/event-stream. Every reply came back as "Invalid JSON response" with no hint why.
 */

/** One Server-Sent Events frame carrying a chunk, as a gateway writes it. */
const frame = (payload: Record<string, unknown>): string =>
  `data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'm', ...payload })}`

const COMPLETION = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'สวัสดีค่ะ' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
}

describe('recoverJsonBody', () => {
  test('strips a terminator appended straight onto the JSON', () => {
    const body = `${JSON.stringify(COMPLETION)}data: [DONE]`
    expect(JSON.parse(recoverJsonBody(body) as string)).toEqual(COMPLETION)
  })

  test('strips a terminator separated by newlines', () => {
    const body = `${JSON.stringify(COMPLETION)}\n\ndata: [DONE]\n\n`
    expect(JSON.parse(recoverJsonBody(body) as string)).toEqual(COMPLETION)
  })

  test('returns a complete completion delivered inside a single frame', () => {
    const body = [`data: ${JSON.stringify(COMPLETION)}`, 'data: [DONE]', ''].join('\n\n')
    expect(JSON.parse(recoverJsonBody(body) as string)).toEqual(COMPLETION)
  })

  test('assembles an answer that arrives only as deltas', () => {
    // This gateway streams `chat.completion.chunk` frames even for a non-streaming request,
    // so no frame holds the answer. Taking the last one yielded an empty reply.
    const body = [
      frame({ choices: [{ index: 0, delta: { role: 'assistant' } }] }),
      frame({ choices: [{ index: 0, delta: { content: 'สวัสดี' } }] }),
      frame({ choices: [{ index: 0, delta: { content: 'ค่ะ' } }] }),
      frame({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      }),
      'data: [DONE]',
      '',
    ].join('\n\n')

    const recovered = JSON.parse(recoverJsonBody(body) as string) as typeof COMPLETION
    expect(recovered.object).toBe('chat.completion')
    expect(recovered.choices[0]?.message.content).toBe('สวัสดีค่ะ')
    expect(recovered.choices[0]?.finish_reason).toBe('stop')
    expect(recovered.usage).toEqual({ prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 })
  })

  test('assembles a tool call split across frames', () => {
    // Handing off to a human is a tool call. Losing it means the customer waits forever.
    const body = [
      frame({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'handoff_to_human' },
                },
              ],
            },
          },
        ],
      }),
      frame({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"reason":' } }] },
          },
        ],
      }),
      frame({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '"pricing"}' } }] },
          },
        ],
      }),
      frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]',
      '',
    ].join('\n\n')

    const recovered = JSON.parse(recoverJsonBody(body) as string) as {
      choices: {
        message: {
          content: string | null
          tool_calls?: { id: string; function: { name: string; arguments: string } }[]
        }
        finish_reason: string
      }[]
    }
    const call = recovered.choices[0]?.message.tool_calls?.[0]
    expect(call?.id).toBe('call_1')
    expect(call?.function.name).toBe('handoff_to_human')
    expect(JSON.parse(call?.function.arguments ?? '{}')).toEqual({ reason: 'pricing' })
    // Null, not empty, when the answer is a tool call. That is what the OpenAI API returns.
    expect(recovered.choices[0]?.message.content).toBeNull()
    expect(recovered.choices[0]?.finish_reason).toBe('tool_calls')
  })

  test('assembles the exact frames a real gateway sent for Gemini', () => {
    // Captured from the gateway in use. Two frames, no content at all, because the model
    // spent its budget on reasoning. The result must still be a well-formed completion.
    const body =
      'data: {"id":"chatcmpl-VMK","object":"chat.completion.chunk","created":1789903445,' +
      '"model":"gemini-3.7-flash","choices":[{"index":0,"delta":{"role":"assistant"},' +
      '"finish_reason":null}]}\n\n' +
      'data: {"id":"chatcmpl-VMK","object":"chat.completion.chunk","created":1789903445,' +
      '"model":"gemini-3.7-flash","choices":[{"index":0,"delta":{},"finish_reason":"length"}],' +
      '"usage":{"prompt_tokens":2010,"completion_tokens":37,"total_tokens":2047}}\n\n'

    const recovered = JSON.parse(recoverJsonBody(body) as string) as typeof COMPLETION
    expect(recovered.object).toBe('chat.completion')
    expect(recovered.id).toBe('chatcmpl-VMK')
    expect(recovered.choices[0]?.message.content).toBe('')
    expect(recovered.choices[0]?.finish_reason).toBe('length')
  })

  test('returns plain JSON unchanged', () => {
    const body = JSON.stringify(COMPLETION)
    expect(JSON.parse(recoverJsonBody(body) as string)).toEqual(COMPLETION)
  })

  test('gives up on a body with no JSON in it', () => {
    expect(recoverJsonBody('upstream unavailable')).toBeNull()
    expect(recoverJsonBody('')).toBeNull()
    expect(recoverJsonBody('data: [DONE]')).toBeNull()
  })

  test('preserves Thai text exactly', () => {
    const body = `${JSON.stringify(COMPLETION)}data: [DONE]`
    expect(recoverJsonBody(body)).toContain('สวัสดีค่ะ')
  })
})

describe('createCompatibleFetch', () => {
  /** Stands in for the global fetch, which carries `preconnect` in these types. */
  const stubFetch = (body: string, contentType: string, status: number): typeof fetch => {
    const impl = async () =>
      new Response(body, { status, headers: { 'content-type': contentType } })
    impl.preconnect = () => {}
    return impl as unknown as typeof fetch
  }

  const respond = (body: string, contentType: string, status = 200) =>
    createCompatibleFetch(stubFetch(body, contentType, status))

  test('repairs a stream-framed answer to a non-streaming request', async () => {
    const tolerant = respond(`${JSON.stringify(COMPLETION)}data: [DONE]`, 'text/event-stream')
    const response = await tolerant('http://gateway/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', messages: [] }),
    })

    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.json()).toEqual(COMPLETION)
  })

  test('leaves an ordinary JSON answer alone', async () => {
    const tolerant = respond(JSON.stringify(COMPLETION), 'application/json')
    const response = await tolerant('http://gateway/v1/chat/completions', { method: 'POST' })
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.json()).toEqual(COMPLETION)
  })

  test('never touches a response to a request that asked for streaming', async () => {
    const stream = `data: ${JSON.stringify(COMPLETION)}\n\ndata: [DONE]\n\n`
    const tolerant = respond(stream, 'text/event-stream')
    const response = await tolerant('http://gateway/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', messages: [], stream: true }),
    })

    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(await response.text()).toBe(stream)
  })

  test('passes an unrepairable body through so the error reflects reality', async () => {
    const tolerant = respond('gateway exploded', 'text/event-stream', 502)
    const response = await tolerant('http://gateway/v1/chat/completions', { method: 'POST' })
    expect(response.status).toBe(502)
    expect(await response.text()).toBe('gateway exploded')
  })

  test('preserves the status of a repaired error body', async () => {
    const error = { error: { message: 'model not found' } }
    const tolerant = respond(`${JSON.stringify(error)}data: [DONE]`, 'text/event-stream', 404)
    const response = await tolerant('http://gateway/v1/chat/completions', { method: 'POST' })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual(error)
  })
})
