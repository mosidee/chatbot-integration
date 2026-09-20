import { describe, expect, test } from 'bun:test'
import { createCompatibleFetch, recoverJsonBody } from '../src/ai/compat'

/**
 * Repairing gateways that frame a non-streaming answer as an event stream.
 *
 * The shape here is taken from a real gateway, which answered a non-streaming request with
 * the complete JSON body and the stream terminator appended to it, labelled
 * text/event-stream. Every reply came back as "Invalid JSON response" with no hint why.
 */

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

  test('takes the last payload from genuine event-stream frames', () => {
    const body = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'สวัส' } }] })}`,
      `data: ${JSON.stringify(COMPLETION)}`,
      'data: [DONE]',
      '',
    ].join('\n\n')
    expect(JSON.parse(recoverJsonBody(body) as string)).toEqual(COMPLETION)
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
  const respond = (body: string, contentType: string, status = 200) =>
    createCompatibleFetch(
      async () => new Response(body, { status, headers: { 'content-type': contentType } }),
    )

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
