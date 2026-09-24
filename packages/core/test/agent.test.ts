import { afterEach, describe, expect, test } from 'bun:test'
import { runAgentTurn } from '../src/ai/agent'
import { clearModelCache } from '../src/ai/registry'
import type { BoundIdentity } from '../src/ai/tool-source'
import type { AgentTurnInput, ProviderProfile, SlotConfig } from '../src/ai/types'
import { type MockServer, startMockOpenAI } from './helpers/mock-openai-server'

/** A 1x1 PNG passed to the vision model as bytes. */
const PNG = {
  data: Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    ),
    (c) => c.charCodeAt(0),
  ),
  mime: 'image/png',
}

const servers: MockServer[] = []

afterEach(() => {
  for (const s of servers.splice(0)) s.stop()
  clearModelCache()
})

function mock(...args: Parameters<typeof startMockOpenAI>): MockServer {
  const server = startMockOpenAI(...args)
  servers.push(server)
  return server
}

function provider(baseUrl: string, overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'p1',
    name: 'mock',
    baseUrl,
    apiKey: 'test-key',
    headers: {},
    supportsTools: true,
    supportsVision: true,
    fetch: (input, init) => globalThis.fetch(input, init),
    ...overrides,
  }
}

function slot(baseUrl: string, overrides: Partial<SlotConfig> = {}): SlotConfig {
  return {
    task: 'agent_chat',
    primary: { provider: provider(baseUrl), model: 'mock-model' },
    fallback: null,
    params: {},
    ...overrides,
  }
}

/** The values the system binds. Unverified by default: most tests are not about identity. */
function bound(overrides: Partial<BoundIdentity> = {}): BoundIdentity {
  return {
    workspaceId: 'w1',
    conversationId: 'c1',
    customerId: 'cust1',
    subject: null,
    attributes: {},
    ...overrides,
  }
}

function input(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    workspace: { persona: 'You support salon-saas.', defaultLanguage: 'th' },
    customer: { displayName: 'Nok', primaryLanguage: 'th', summary: null, fields: {} },
    recentMessages: [{ role: 'customer', text: 'ราคาเท่าไหร่คะ', at: new Date() }],
    internalNotes: [],
    retrieved: [],
    images: [],
    ...overrides,
  }
}

describe('runAgentTurn', () => {
  test('returns the model reply and a sent trace', async () => {
    const server = mock([{ kind: 'text', text: 'แพ็กเกจเริ่มต้น 990 บาทต่อเดือนค่ะ' }])

    const result = await runAgentTurn({
      input: input(),
      chatSlot: slot(server.url),
      visionSlot: null,
      bound: bound(),
      turnKey: 'turn-test',
      prices: {},
      mode: 'answer',
      maxRetries: 0,
    })

    expect(result.text).toBe('แพ็กเกจเริ่มต้น 990 บาทต่อเดือนค่ะ')
    expect(result.handoff).toBeNull()
    expect(result.trace.outcome).toBe('sent')
    expect(result.trace.model).toBe('mock-model')
    expect(result.trace.tokensIn).toBe(100)
    expect(result.trace.tokensOut).toBe(20)
    expect(result.trace.usedFallback).toBe(false)
  })

  test('never sends the thinking of a model to the customer', async () => {
    // Captured from production: a gateway left the reasoning block in the message content,
    // so replies began with the tag. The customer read it.
    const server = mock([{ kind: 'text', text: '<think></think>แพ็กเกจเริ่มต้น 990 บาทต่อเดือนค่ะ' }])

    const result = await runAgentTurn({
      input: input(),
      chatSlot: slot(server.url),
      visionSlot: null,
      bound: bound(),
      turnKey: 'turn-test',
      prices: {},
      mode: 'answer',
      maxRetries: 0,
    })

    expect(result.text).toBe('แพ็กเกจเริ่มต้น 990 บาทต่อเดือนค่ะ')
    expect(result.trace.outcome).toBe('sent')
  })

  test('an answer that is nothing but thinking counts as empty', async () => {
    // Which means it hands off rather than sending half a thought.
    const server = mock([{ kind: 'text', text: '<think>still working it out' }])

    const result = await runAgentTurn({
      input: input(),
      chatSlot: slot(server.url),
      visionSlot: null,
      bound: bound(),
      turnKey: 'turn-test',
      prices: {},
      mode: 'answer',
      maxRetries: 0,
    })

    expect(result.text).toBe('')
    expect(result.trace.outcome).toBe('error')
  })

  test('records an empty answer as an error, not as a send', async () => {
    // A reasoning model can spend its whole output budget thinking and emit nothing. The
    // turn succeeds at the provider, so nothing else marks it as a failure, and a trace
    // saying "sent" for a turn the customer never saw hides it completely.
    const server = mock([{ kind: 'text', text: '' }])

    const result = await runAgentTurn({
      input: input(),
      chatSlot: slot(server.url),
      visionSlot: null,
      bound: bound(),
      turnKey: 'turn-test',
      prices: {},
      mode: 'answer',
      maxRetries: 0,
    })

    expect(result.text).toBe('')
    expect(result.trace.outcome).toBe('error')
    expect(result.trace.error).toContain('no text')
  })

  test('treats whitespace as empty', async () => {
    const server = mock([{ kind: 'text', text: '   \n  ' }])

    const result = await runAgentTurn({
      input: input(),
      chatSlot: slot(server.url),
      visionSlot: null,
      bound: bound(),
      turnKey: 'turn-test',
      prices: {},
      mode: 'answer',
      maxRetries: 0,
    })

    expect(result.text).toBe('')
    expect(result.trace.outcome).toBe('error')
  })

  test('sends the persona and the customer message to the provider', async () => {
    const server = mock([{ kind: 'text', text: 'ok' }])
    await runAgentTurn({
      input: input(),
      chatSlot: slot(server.url),
      visionSlot: null,
      bound: bound(),
      turnKey: 'turn-test',
      prices: {},
      mode: 'answer',
      maxRetries: 0,
    })

    const body = server.requests[0] as { messages: { role: string; content: string }[] }
    const system = body.messages.find((m) => m.role === 'system')?.content ?? ''
    expect(system).toContain('You support salon-saas.')
    expect(system).toContain('same language')
    expect(body.messages.at(-1)?.content).toBe('ราคาเท่าไหร่คะ')
  })

  test('marks the trace as a draft when suggesting for a human', async () => {
    const server = mock([{ kind: 'text', text: 'draft reply' }])
    const result = await runAgentTurn({
      input: input(),
      chatSlot: slot(server.url, { task: 'suggestion_for_human' }),
      visionSlot: null,
      bound: bound(),
      turnKey: 'turn-test',
      prices: {},
      mode: 'suggest',
      maxRetries: 0,
    })

    expect(result.trace.outcome).toBe('draft')
    const body = server.requests[0] as { messages: { role: string; content: string }[] }
    const system = body.messages.find((m) => m.role === 'system')?.content ?? ''
    expect(system).toContain('drafting a reply for a human colleague')
  })

  test('records a handoff when the model calls the tool', async () => {
    const server = mock([
      {
        kind: 'tool_calls',
        toolCalls: [
          {
            name: 'handoff_to_human',
            arguments: { reason: 'customer_requested', note: 'Wants to talk to a person.' },
          },
        ],
      },
      { kind: 'text', text: 'ขอโอนสายให้เจ้าหน้าที่นะคะ' },
    ])

    const result = await runAgentTurn({
      input: input(),
      chatSlot: slot(server.url),
      visionSlot: null,
      bound: bound(),
      turnKey: 'turn-test',
      prices: {},
      mode: 'answer',
      maxRetries: 0,
    })

    expect(result.handoff).toEqual({
      reason: 'customer_requested',
      note: 'Wants to talk to a person.',
    })
    expect(result.trace.outcome).toBe('handoff')
  })

  test('collects customer field updates and tags from tool calls', async () => {
    const server = mock([
      {
        kind: 'tool_calls',
        toolCalls: [
          { name: 'set_customer_field', arguments: { key: 'order_id', value: 'SO-8891' } },
          { name: 'tag_conversation', arguments: { tags: ['billing'] } },
        ],
      },
      { kind: 'text', text: 'ได้รับเลขที่ออร์เดอร์แล้วค่ะ' },
    ])

    const result = await runAgentTurn({
      input: input(),
      chatSlot: slot(server.url),
      visionSlot: null,
      bound: bound(),
      turnKey: 'turn-test',
      prices: {},
      mode: 'answer',
      maxRetries: 0,
    })

    expect(result.customerFieldUpdates).toEqual({ order_id: 'SO-8891' })
    expect(result.tagsToAdd).toEqual(['billing'])
  })

  test('omits tools for a provider without function calling', async () => {
    const server = mock([{ kind: 'text', text: 'answer only' }])
    await runAgentTurn({
      input: input(),
      chatSlot: slot(server.url, {
        primary: { provider: provider(server.url, { supportsTools: false }), model: 'mock-model' },
      }),
      visionSlot: null,
      bound: bound(),
      turnKey: 'turn-test',
      prices: {},
      mode: 'answer',
      maxRetries: 0,
    })

    const body = server.requests[0] as { tools?: unknown[] }
    expect(body.tools).toBeUndefined()
  })

  test('falls back to the secondary provider when the primary errors', async () => {
    const down = mock([{ kind: 'error', status: 503, message: 'upstream unavailable' }])
    const up = mock([{ kind: 'text', text: 'answered by fallback' }])

    const result = await runAgentTurn({
      input: input(),
      chatSlot: slot(down.url, {
        fallback: {
          provider: provider(up.url, { id: 'p2', name: 'backup' }),
          model: 'mock-model',
        },
      }),
      visionSlot: null,
      bound: bound(),
      turnKey: 'turn-test',
      prices: {},
      mode: 'answer',
      maxRetries: 0,
    })

    expect(result.text).toBe('answered by fallback')
    expect(result.trace.usedFallback).toBe(true)
    expect(result.trace.providerName).toBe('backup')
  })

  /**
   * Recommendation #10. A primary that recorded intents and then failed must not hand them
   * to a fallback that never asked for them.
   */
  test('a failed primary attempt leaves nothing behind for the fallback', async () => {
    const primary = mock([
      {
        kind: 'tool_calls',
        toolCalls: [
          { name: 'set_customer_field', arguments: { key: 'order_id', value: 'SO-1' } },
          { name: 'tag_conversation', arguments: { tags: ['from-primary'] } },
          { name: 'handoff_to_human', arguments: { reason: 'customer_requested', note: 'x' } },
        ],
      },
      { kind: 'error', status: 503, message: 'fell over after the tools' },
    ])
    const fallback = mock([{ kind: 'text', text: 'answered cleanly' }])

    const result = await runAgentTurn({
      input: input(),
      chatSlot: slot(primary.url, {
        fallback: { provider: provider(fallback.url, { id: 'p2', name: 'backup' }), model: 'm' },
      }),
      visionSlot: null,
      bound: bound(),
      turnKey: 'turn-isolation',
      prices: {},
      mode: 'answer',
      maxRetries: 0,
    })

    expect(result.text).toBe('answered cleanly')
    expect(result.handoff).toBeNull()
    expect(result.customerFieldUpdates).toEqual({})
    expect(result.tagsToAdd).toEqual([])
  })

  /** Recommendation #11. A provider that never answers ends in a handoff, not a hang. */
  test('a provider that never answers is abandoned at its deadline', async () => {
    const silent = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
    try {
      const started = Date.now()
      const result = await runAgentTurn({
        input: input(),
        chatSlot: {
          ...slot(`http://localhost:${silent.port}/v1`),
          params: { timeoutMs: 300 },
        },
        visionSlot: null,
        bound: bound(),
        turnKey: 'turn-deadline',
        prices: {},
        mode: 'answer',
        maxRetries: 0,
      })
      expect(Date.now() - started).toBeLessThan(5000)
      expect(result.handoff?.reason).toBe('model_error')
    } finally {
      silent.stop(true)
    }
  })

  test('hands off rather than going silent when every provider fails', async () => {
    const down = mock([{ kind: 'error', status: 500, message: 'boom' }])

    const result = await runAgentTurn({
      input: input(),
      chatSlot: slot(down.url),
      visionSlot: null,
      bound: bound(),
      turnKey: 'turn-test',
      prices: {},
      mode: 'answer',
      maxRetries: 0,
    })

    expect(result.text).toBe('')
    expect(result.handoff?.reason).toBe('model_error')
    expect(result.trace.outcome).toBe('error')
    expect(result.trace.error).toBeTruthy()
  })

  test('estimates cost when the model is priced', async () => {
    const server = mock([{ kind: 'text', text: 'ok' }])
    const result = await runAgentTurn({
      input: input(),
      chatSlot: slot(server.url),
      visionSlot: null,
      bound: bound(),
      turnKey: 'turn-test',
      prices: { 'mock:mock-model': { inputPerMillion: 1000, outputPerMillion: 2000 } },
      mode: 'answer',
      maxRetries: 0,
    })
    // 100 in at 1000/M = 0.1, 20 out at 2000/M = 0.04
    expect(result.trace.costEstimate).toBeCloseTo(0.14, 5)
  })

  test('includes retrieved knowledge in the system prompt', async () => {
    const server = mock([{ kind: 'text', text: 'ok' }])
    await runAgentTurn({
      input: input({
        retrieved: [
          {
            id: 'c1',
            sourceId: 's1',
            sourceTitle: 'Pricing',
            text: 'Starter is 990 THB per month.',
            score: 0.9,
            language: 'en',
          },
        ],
      }),
      chatSlot: slot(server.url),
      visionSlot: null,
      bound: bound(),
      turnKey: 'turn-test',
      prices: {},
      mode: 'answer',
      maxRetries: 0,
    })

    const body = server.requests[0] as { messages: { role: string; content: string }[] }
    const system = body.messages.find((m) => m.role === 'system')?.content ?? ''
    expect(system).toContain('Starter is 990 THB per month.')
    expect(system).toContain('[1] Pricing')
  })

  test('tells the model to hand off when no knowledge was retrieved', async () => {
    const server = mock([{ kind: 'text', text: 'ok' }])
    await runAgentTurn({
      input: input(),
      chatSlot: slot(server.url),
      visionSlot: null,
      bound: bound(),
      turnKey: 'turn-test',
      prices: {},
      mode: 'answer',
      maxRetries: 0,
    })

    const body = server.requests[0] as { messages: { role: string; content: string }[] }
    const system = body.messages.find((m) => m.role === 'system')?.content ?? ''
    expect(system).toContain('No knowledge base entries were retrieved')
  })

  test('passes an agent instruction note through to the model', async () => {
    const server = mock([{ kind: 'text', text: 'ok' }])
    await runAgentTurn({
      input: input({
        internalNotes: [{ body: 'Refund already issued; confirm shipping only.', at: new Date() }],
      }),
      chatSlot: slot(server.url),
      visionSlot: null,
      bound: bound(),
      turnKey: 'turn-test',
      prices: {},
      mode: 'answer',
      maxRetries: 0,
    })

    const body = server.requests[0] as { messages: { role: string; content: string }[] }
    const system = body.messages.find((m) => m.role === 'system')?.content ?? ''
    expect(system).toContain('Refund already issued; confirm shipping only.')
  })

  test('includes the customer summary and known fields', async () => {
    const server = mock([{ kind: 'text', text: 'ok' }])
    await runAgentTurn({
      input: input({
        customer: {
          displayName: 'Nok',
          primaryLanguage: 'th',
          summary: 'Runs two salons in Chiang Mai.',
          fields: { order_id: 'SO-1' },
        },
      }),
      chatSlot: slot(server.url),
      visionSlot: null,
      bound: bound(),
      turnKey: 'turn-test',
      prices: {},
      mode: 'answer',
      maxRetries: 0,
    })

    const body = server.requests[0] as { messages: { role: string; content: string }[] }
    const system = body.messages.find((m) => m.role === 'system')?.content ?? ''
    expect(system).toContain('Runs two salons in Chiang Mai.')
    expect(system).toContain('order_id=SO-1')
  })
})

describe('vision', () => {
  test('describes images with the vision slot and feeds the text to the chat model', async () => {
    const visionServer = mock([
      { kind: 'text', text: 'A screenshot of the billing page showing "card declined".' },
    ])
    const chatServer = mock([{ kind: 'text', text: 'ขอโทษค่ะ บัตรถูกปฏิเสธ' }])

    const result = await runAgentTurn({
      input: input({ images: [PNG] }),
      chatSlot: slot(chatServer.url),
      visionSlot: slot(visionServer.url, { task: 'vision' }),
      bound: bound(),
      turnKey: 'turn-test',
      prices: {},
      mode: 'answer',
      maxRetries: 0,
    })

    expect(result.text).toBe('ขอโทษค่ะ บัตรถูกปฏิเสธ')

    // The vision model was asked about the image.
    const visionBody = visionServer.requests[0] as {
      messages: { role: string; content: unknown }[]
    }
    expect(JSON.stringify(visionBody.messages)).toContain('image_url')

    // The chat model received the description, not the image.
    const chatBody = chatServer.requests[0] as { messages: { role: string; content: string }[] }
    const lastUser = chatBody.messages.at(-1)?.content ?? ''
    expect(lastUser).toContain('card declined')
    expect(JSON.stringify(chatBody.messages)).not.toContain('image_url')
  })

  test('skips the vision call when no vision slot is configured', async () => {
    const chatServer = mock([{ kind: 'text', text: 'ok' }])
    const result = await runAgentTurn({
      input: input({ images: [PNG] }),
      chatSlot: slot(chatServer.url),
      visionSlot: null,
      bound: bound(),
      turnKey: 'turn-test',
      prices: {},
      mode: 'answer',
      maxRetries: 0,
    })
    expect(result.text).toBe('ok')
    expect(chatServer.requests).toHaveLength(1)
  })

  test('a vision failure degrades the turn instead of sinking it', async () => {
    const visionServer = mock([{ kind: 'error', status: 500, message: 'vision down' }])
    const chatServer = mock([{ kind: 'text', text: 'ขอรบกวนอธิบายเพิ่มเติมได้ไหมคะ' }])

    const result = await runAgentTurn({
      input: input({ images: [PNG] }),
      chatSlot: slot(chatServer.url),
      visionSlot: slot(visionServer.url, { task: 'vision' }),
      bound: bound(),
      turnKey: 'turn-test',
      prices: {},
      mode: 'answer',
      maxRetries: 0,
    })

    expect(result.text).toBe('ขอรบกวนอธิบายเพิ่มเติมได้ไหมคะ')
    expect(result.trace.outcome).toBe('sent')
    const chatBody = chatServer.requests[0] as { messages: { role: string; content: string }[] }
    expect(chatBody.messages.at(-1)?.content).toContain('could not be read')
  })
})
