import { afterEach, describe, expect, test } from 'bun:test'
import type { HttpToolConfig } from '@ci/shared'
import { httpToolConfigSchema } from '@ci/shared'
import { runAgentTurn } from '../src/ai/agent'
import {
  createHttpToolSource,
  executeHttpTool,
  type HttpToolDefinition,
  inputSchemaFor,
} from '../src/ai/http-tool'
import { clearModelCache } from '../src/ai/registry'
import type { BoundIdentity } from '../src/ai/tool-source'
import { createScratchpad, type ToolContext } from '../src/ai/tools'
import type { AgentTurnInput, ProviderProfile, SlotConfig } from '../src/ai/types'
import { type MockServer, startMockOpenAI } from './helpers/mock-openai-server'

/**
 * Tenant-defined HTTP tools.
 *
 * The rules worth pinning are the ones that keep a model from choosing whose account to
 * read, and the ones that keep a half-finished turn from changing something real.
 */

const servers: { stop: () => void }[] = []

afterEach(() => {
  for (const s of servers.splice(0)) s.stop()
  clearModelCache()
})

function local(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch: handler })
  servers.push({ stop: () => server.stop(true) })
  return `http://127.0.0.1:${server.port}`
}

/** TypeScript narrows a `let` assigned only inside a callback; a field does not. */
function capture<T>(): { value: T | null } {
  return { value: null }
}

function config(overrides: Partial<HttpToolConfig> = {}): HttpToolConfig {
  return httpToolConfigSchema.parse({
    method: 'GET',
    url: 'https://api.example.com/plan',
    ...overrides,
  })
}

function definition(overrides: Partial<HttpToolDefinition> = {}): HttpToolDefinition {
  return {
    id: 'tool-1',
    name: 'check_plan',
    description: 'Look up the plan this customer is on.',
    config: config(),
    credential: null,
    ...overrides,
  }
}

function bound(overrides: Partial<BoundIdentity> = {}): BoundIdentity {
  return {
    workspaceId: 'w1',
    conversationId: 'conv1',
    customerId: 'cust1',
    subject: null,
    attributes: {},
    ...overrides,
  }
}

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    customer: { displayName: null, primaryLanguage: 'th', summary: null, fields: {} },
    scratchpad: createScratchpad(),
    bound: bound(),
    mode: 'answer',
    turnKey: 'turn-1',
    ...overrides,
  }
}

describe('the input schema a model is shown', () => {
  test('contains the arguments and never a binding', () => {
    const schema = inputSchemaFor(
      config({
        args: [{ name: 'order_id', type: 'string', description: 'Which order', required: true }],
        bindings: [{ name: 'account_id', source: 'subject' }],
      }),
    )
    expect(Object.keys(schema.shape)).toEqual(['order_id'])
  })

  test('strips a key the model invents, including one named after a binding', () => {
    const schema = inputSchemaFor(
      config({
        args: [{ name: 'order_id', type: 'string', description: 'Which order', required: true }],
        bindings: [{ name: 'account_id', source: 'subject' }],
      }),
    )
    const parsed = schema.parse({ order_id: 'A1', account_id: 'somebody-else', extra: 1 })
    expect(parsed).toEqual({ order_id: 'A1' })
  })

  test('an optional argument may be left out', () => {
    const schema = inputSchemaFor(
      config({
        args: [{ name: 'note', type: 'string', description: 'Anything to add', required: false }],
      }),
    )
    expect(schema.parse({})).toEqual({})
  })
})

describe('definition-time refusals', () => {
  test('an argument may not share a binding name', () => {
    expect(() =>
      config({
        args: [{ name: 'account_id', type: 'string', description: 'Account', required: true }],
        bindings: [{ name: 'account_id', source: 'subject' }],
      }),
    ).toThrow(/may not share a name/)
  })

  test('the header auth kind needs a header to put it in', () => {
    expect(() => config({ auth: 'header' })).toThrow(/authHeaderName/)
  })
})

describe('executeHttpTool', () => {
  test('sends arguments and bound values as query parameters on a GET', async () => {
    const seen = capture<URL>()
    const base = local((request) => {
      seen.value = new URL(request.url)
      return Response.json({ plan: 'pro' })
    })

    const outcome = await executeHttpTool(
      definition({
        config: config({
          url: `${base}/plan`,
          args: [{ name: 'order_id', type: 'string', description: 'Which order', required: true }],
          bindings: [
            { name: 'account_id', source: 'subject' },
            { name: 'workspace', source: 'workspace_id' },
          ],
        }),
      }),
      { order_id: 'A1' },
      bound({ subject: 'acct_7' }),
      { fetch },
    )

    expect(outcome.status).toBe(200)
    expect(outcome.body).toEqual({ plan: 'pro' })
    expect(seen.value?.searchParams.get('order_id')).toBe('A1')
    expect(seen.value?.searchParams.get('account_id')).toBe('acct_7')
    expect(seen.value?.searchParams.get('workspace')).toBe('w1')
  })

  test('the bound value wins even if an argument of that name slipped through', async () => {
    const seen = capture<URL>()
    const base = local((request) => {
      seen.value = new URL(request.url)
      return Response.json({})
    })

    await executeHttpTool(
      definition({
        config: config({
          url: `${base}/plan`,
          bindings: [{ name: 'account_id', source: 'subject' }],
        }),
      }),
      // Not reachable through the schema; asserted here because it is the failure that
      // would matter most if it ever became reachable.
      { account_id: 'somebody-else' },
      bound({ subject: 'acct_7' }),
      { fetch },
    )

    expect(seen.value?.searchParams.get('account_id')).toBe('acct_7')
  })

  test('sends a JSON body on a POST', async () => {
    const body = capture<unknown>()
    const base = local(async (request) => {
      body.value = await request.json()
      return Response.json({ ok: true })
    })

    await executeHttpTool(
      definition({
        config: config({
          method: 'POST',
          url: `${base}/notes`,
          args: [{ name: 'note', type: 'string', description: 'The note', required: true }],
          bindings: [{ name: 'conversation', source: 'conversation_id' }],
        }),
      }),
      { note: 'called back' },
      bound(),
      { fetch },
    )

    expect(body.value).toEqual({ note: 'called back', conversation: 'conv1' })
  })

  test('substitutes and encodes a placeholder in the path', async () => {
    const path = capture<string>()
    const base = local((request) => {
      path.value = new URL(request.url).pathname
      return Response.json({})
    })

    await executeHttpTool(
      definition({
        config: config({
          url: `${base}/accounts/{{account_id}}/plan`,
          bindings: [{ name: 'account_id', source: 'subject' }],
        }),
      }),
      {},
      bound({ subject: 'acct/7 8' }),
      { fetch },
    )

    expect(path.value).toBe('/accounts/acct%2F7%208/plan')
  })

  test('a value consumed by the path is not repeated in the query', async () => {
    const url = capture<URL>()
    const base = local((request) => {
      url.value = new URL(request.url)
      return Response.json({})
    })

    await executeHttpTool(
      definition({
        config: config({
          url: `${base}/accounts/{{account_id}}`,
          bindings: [{ name: 'account_id', source: 'subject' }],
        }),
      }),
      {},
      bound({ subject: 'acct_7' }),
      { fetch },
    )

    expect(url.value?.search).toBe('')
  })

  test('sends the credential as a bearer token', async () => {
    const auth = capture<string>()
    const base = local((request) => {
      auth.value = request.headers.get('authorization')
      return Response.json({})
    })

    await executeHttpTool(
      definition({
        config: config({ url: `${base}/plan`, auth: 'bearer' }),
        credential: 'secret-token',
      }),
      {},
      bound(),
      { fetch },
    )

    expect(auth.value).toBe('Bearer secret-token')
  })

  test('sends the credential in a named header', async () => {
    const value = capture<string>()
    const base = local((request) => {
      value.value = request.headers.get('x-api-key')
      return Response.json({})
    })

    await executeHttpTool(
      definition({
        config: config({ url: `${base}/plan`, auth: 'header', authHeaderName: 'X-Api-Key' }),
        credential: 'secret-token',
      }),
      {},
      bound(),
      { fetch },
    )

    expect(value.value).toBe('secret-token')
  })

  test('adds an idempotency key when one is given', async () => {
    const key = capture<string>()
    const base = local((request) => {
      key.value = request.headers.get('idempotency-key')
      return Response.json({})
    })

    await executeHttpTool(
      definition({ config: config({ method: 'POST', url: `${base}/x` }) }),
      {},
      bound(),
      { fetch },
      { idempotencyKey: 'job-9-0' },
    )

    expect(key.value).toBe('job-9-0')
  })

  test('throws on a non-2xx answer, quoting what came back', async () => {
    const base = local(() => new Response('no such account', { status: 404 }))
    await expect(
      executeHttpTool(definition({ config: config({ url: `${base}/x` }) }), {}, bound(), { fetch }),
    ).rejects.toThrow(/returned 404: no such account/)
  })

  test('throws when the endpoint takes longer than its timeout', async () => {
    // The floor on a configured timeout is one second, so the endpoint has to outlast it.
    const base = local(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3000))
      return Response.json({})
    })
    await expect(
      executeHttpTool(
        definition({ config: config({ url: `${base}/x`, timeoutMs: 1000 }) }),
        {},
        bound(),
        { fetch },
      ),
    ).rejects.toThrow(/timed out after 1000ms/)
  })

  test('truncates an answer too large to put in a prompt', async () => {
    const base = local(() => new Response('x'.repeat(200_000), { headers: {} }))
    const outcome = await executeHttpTool(
      definition({ config: config({ url: `${base}/x` }) }),
      {},
      bound(),
      { fetch },
    )
    expect(String(outcome.body).length).toBeLessThanOrEqual(8 * 1024)
  })
})

describe('which tools a turn is offered', () => {
  test('a tool binding a subject is absent when nothing was proven', () => {
    const source = createHttpToolSource(
      [
        definition({
          config: config({ bindings: [{ name: 'account_id', source: 'subject' }] }),
        }),
      ],
      { fetch },
    )
    expect(Object.keys(source.tools(context()))).toEqual([])
  })

  test('the same tool appears once an identity is proven', () => {
    const source = createHttpToolSource(
      [
        definition({
          config: config({ bindings: [{ name: 'account_id', source: 'subject' }] }),
        }),
      ],
      { fetch },
    )
    const offered = source.tools(context({ bound: bound({ subject: 'acct_7' }) }))
    expect(Object.keys(offered)).toEqual(['check_plan'])
  })

  test('a tool bound only to the customer needs no proof', () => {
    const source = createHttpToolSource(
      [definition({ config: config({ bindings: [{ name: 'customer', source: 'customer_id' }] }) })],
      { fetch },
    )
    expect(Object.keys(source.tools(context()))).toEqual(['check_plan'])
  })

  test('a writing tool is withheld while the AI is only drafting', () => {
    const source = createHttpToolSource(
      [definition({ config: config({ method: 'POST', effect: 'write' }) })],
      { fetch },
    )
    expect(Object.keys(source.tools(context({ mode: 'suggest' })))).toEqual([])
    expect(Object.keys(source.tools(context({ mode: 'answer' })))).toEqual(['check_plan'])
  })
})

describe('a writing tool during the turn', () => {
  test('records intent and sends nothing', async () => {
    let calls = 0
    const base = local(() => {
      calls += 1
      return Response.json({})
    })

    const ctx = context()
    const source = createHttpToolSource(
      [
        definition({
          config: config({
            method: 'POST',
            url: `${base}/cancel`,
            effect: 'write',
            args: [{ name: 'reason', type: 'string', description: 'Why', required: true }],
          }),
        }),
      ],
      { fetch },
    )

    const tool = source.tools(ctx).check_plan
    const result = await tool?.execute?.({ reason: 'too expensive' }, {
      toolCallId: 't1',
      messages: [],
    } as never)

    expect(calls).toBe(0)
    expect(result).toMatchObject({ queued: true })
    expect(ctx.scratchpad.pendingWrites).toEqual([
      { toolId: 'tool-1', tool: 'check_plan', args: { reason: 'too expensive' } },
    ])
  })
})

describe('a failing read inside a real turn', () => {
  const servers2: MockServer[] = []
  afterEach(() => {
    for (const s of servers2.splice(0)) s.stop()
  })

  function provider(baseUrl: string): ProviderProfile {
    return {
      id: 'p1',
      name: 'mock',
      baseUrl,
      apiKey: 'k',
      headers: {},
      supportsTools: true,
      supportsVision: false,
    }
  }

  function slot(baseUrl: string): SlotConfig {
    return {
      task: 'agent_chat',
      primary: { provider: provider(baseUrl), model: 'mock-model' },
      fallback: null,
      params: {},
    }
  }

  const input: AgentTurnInput = {
    workspace: { persona: 'You support salon-saas.', defaultLanguage: 'th' },
    customer: { displayName: null, primaryLanguage: 'th', summary: null, fields: {} },
    recentMessages: [{ role: 'customer', text: 'แพ็กเกจของฉันคืออะไร', at: new Date() }],
    internalNotes: [],
    retrieved: [],
    images: [],
  }

  test('ends the turn with a person rather than whatever the model wrote next', async () => {
    const endpoint = local(() => new Response('boom', { status: 500 }))
    const model = startMockOpenAI([
      { kind: 'tool_calls', toolCalls: [{ name: 'check_plan', arguments: {} }] },
      { kind: 'text', text: 'คุณอยู่แพ็กเกจ Pro ค่ะ' },
    ])
    servers2.push(model)

    const result = await runAgentTurn({
      input,
      chatSlot: slot(model.url),
      visionSlot: null,
      prices: {},
      mode: 'answer',
      maxRetries: 0,
      bound: bound(),
      turnKey: 'turn-1',
      toolSources: [
        createHttpToolSource([definition({ config: config({ url: `${endpoint}/plan` }) })], {
          fetch,
        }),
      ],
    })

    // The model did answer. The answer is discarded, because it was written after being
    // told the lookup failed and is therefore an invention.
    expect(result.handoff?.reason).toBe('tool_error')
    expect(result.handoff?.note).toContain('check_plan')
    expect(result.trace.outcome).toBe('handoff')
  })

  test('the trace records what a tenant tool answered, not only that it was called', async () => {
    const endpoint = local(() => Response.json({ plan: 'pro' }))
    const model = startMockOpenAI([
      { kind: 'tool_calls', toolCalls: [{ name: 'check_plan', arguments: {} }] },
      { kind: 'text', text: 'คุณอยู่แพ็กเกจ Pro ค่ะ' },
    ])
    servers2.push(model)

    const result = await runAgentTurn({
      input,
      chatSlot: slot(model.url),
      visionSlot: null,
      prices: {},
      mode: 'answer',
      maxRetries: 0,
      bound: bound(),
      turnKey: 'turn-1',
      toolSources: [
        createHttpToolSource([definition({ config: config({ url: `${endpoint}/plan` }) })], {
          fetch,
        }),
      ],
    })

    const calls = result.trace.toolCalls as { toolName: string; output: unknown }[]
    expect(calls).toHaveLength(1)
    expect(calls[0]?.toolName).toBe('check_plan')
    expect(calls[0]?.output).toMatchObject({ status: 200, body: { plan: 'pro' } })
  })

  test('a tenant tool cannot take the name of an internal one', async () => {
    const model = startMockOpenAI([{ kind: 'text', text: 'ok' }])
    servers2.push(model)

    await runAgentTurn({
      input,
      chatSlot: slot(model.url),
      visionSlot: null,
      prices: {},
      mode: 'answer',
      maxRetries: 0,
      bound: bound(),
      turnKey: 'turn-1',
      toolSources: [createHttpToolSource([definition({ name: 'handoff_to_human' })], { fetch })],
    })

    const request = model.requests[0] as { tools?: { function?: { description?: string } }[] }
    const handoff = request.tools?.find(
      (t) => (t.function as { name?: string } | undefined)?.name === 'handoff_to_human',
    )
    // The internal one, which the AI needs in order never to go silent.
    expect(handoff?.function?.description).toContain('human colleague')
  })
})
