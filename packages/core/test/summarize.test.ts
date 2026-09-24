import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { clearModelCache } from '../src/ai/registry'
import { SUMMARY_SYSTEM_PROMPT, summarizeCustomer } from '../src/ai/summarize'
import type { ProviderProfile, SlotConfig } from '../src/ai/types'

/**
 * What the summariser actually puts on the wire.
 *
 * Structured output is requested with `response_format: json_object`, and DeepSeek refuses
 * that unless the prompt names JSON. Every summary against a DeepSeek model failed on it in
 * production, and nothing in the type system or the schema would have caught it, so the
 * request body is asserted directly.
 */

const SUMMARY = {
  summary: 'ลูกค้าสนใจแพ็กเกจ Pro และถามเรื่องราคา',
  facts: { plan: 'trial' },
  openIssues: ['รอใบเสนอราคา'],
}

function profile(): ProviderProfile {
  return {
    id: 'p1',
    name: 'stub',
    baseUrl: 'http://provider.invalid/v1',
    apiKey: 'k',
    headers: {},
    supportsTools: true,
    supportsVision: false,
    fetch: (input, init) => globalThis.fetch(input, init),
  }
}

function slot(): SlotConfig {
  return {
    task: 'summarize',
    primary: { provider: profile(), model: 'summary-model' },
    fallback: null,
    params: {},
  }
}

const realFetch = globalThis.fetch
let bodies: Record<string, unknown>[] = []

function stubChat(): void {
  bodies = []
  const stub = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    return Response.json({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: JSON.stringify(SUMMARY) },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
    })
  }
  ;(stub as unknown as { preconnect: () => void }).preconnect = () => {}
  globalThis.fetch = stub as unknown as typeof fetch
}

function run() {
  return summarizeCustomer({
    slot: slot(),
    customer: { displayName: 'Nok', fields: {}, summary: null, primaryLanguage: 'th' },
    previousSummary: null,
    messages: [{ role: 'customer', text: 'ราคาเท่าไหร่คะ', at: new Date('2026-09-20T09:00:00Z') }],
    prices: {},
  })
}

beforeEach(() => {
  clearModelCache()
  stubChat()
})
afterEach(() => {
  globalThis.fetch = realFetch
  clearModelCache()
})

describe('summarizeCustomer', () => {
  test('names JSON in the prompt, which DeepSeek requires for structured output', async () => {
    await run()

    const messages = bodies[0]?.messages as { role: string; content: string }[]
    const wholePrompt = messages.map((m) => m.content).join('\n')
    expect(wholePrompt.toLowerCase()).toContain('json')
  })

  test('the system prompt carries the word, since nothing else guarantees it', () => {
    expect(SUMMARY_SYSTEM_PROMPT.toLowerCase()).toContain('json')
  })

  test('tells the model which fields to return', async () => {
    // An OpenAI-compatible provider sends `json_object` and drops the schema, so a model
    // told only "return an object" invents fields and the reply fails validation here.
    await run()

    const messages = bodies[0]?.messages as { role: string; content: string }[]
    const system = messages.find((m) => m.role === 'system')?.content ?? ''
    expect(system).toContain('summary')
    expect(system).toContain('facts')
    expect(system).toContain('openIssues')
  })

  test('describes the shape from the schema rather than a second copy of it', () => {
    // Drifting instructions are worse than none: the model would satisfy the prompt and
    // fail validation. Field descriptions come from the schema, so this catches a rename.
    expect(SUMMARY_SYSTEM_PROMPT).toContain('Anything left unresolved')
  })

  test('asks for structured output at all', async () => {
    await run()

    expect(bodies[0]).toHaveProperty('response_format')
  })

  test('returns the parsed summary', async () => {
    const result = await run()

    expect(result.summary).toEqual(SUMMARY)
    expect(result.trace.task).toBe('summarize')
    expect(result.trace.model).toBe('summary-model')
  })

  test('records a refusal in the trace rather than throwing', async () => {
    // Shaped like the refusal this fix is about, so the trace an operator reads is asserted
    // to carry the provider's own words.
    const refusal = {
      error: {
        message:
          "Prompt must contain the word 'json' in some form to use 'response_format' of type 'json_object'.",
        type: 'invalid_request_error',
      },
    }
    const stub = async () => Response.json(refusal, { status: 400 })
    ;(stub as unknown as { preconnect: () => void }).preconnect = () => {}
    globalThis.fetch = stub as unknown as typeof fetch
    clearModelCache()

    const result = await run()

    // A failed summary must not interrupt anyone: the previous summary simply stands.
    expect(result.summary).toBeNull()
    expect(result.trace.outcome).toBe('error')
    expect(result.trace.error).toContain('json_object')
  })
})
