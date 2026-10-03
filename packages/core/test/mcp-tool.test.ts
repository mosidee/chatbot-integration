import { describe, expect, test } from 'bun:test'
import {
  createMcpToolSource,
  type McpCaller,
  type McpToolDefinition,
  modelSchemaFor,
  stableFingerprint,
  withBindings,
} from '../src/ai/mcp-tool'
import type { BoundIdentity } from '../src/ai/tool-source'
import { createScratchpad, type ToolContext } from '../src/ai/tools'

/** MCP tools as a source (ADR 0011), with the server stood in for by a recording caller. */

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

function definition(overrides: Partial<McpToolDefinition> = {}): McpToolDefinition {
  return {
    serverId: 'srv-1',
    exposedName: 'shop_lookup_order',
    remoteName: 'lookup_order',
    description: 'Look up an order.',
    inputSchema: {
      type: 'object',
      properties: { order_id: { type: 'string' }, account: { type: 'string' } },
      required: ['order_id', 'account'],
    },
    effect: 'read',
    bindings: [],
    ...overrides,
  }
}

function recorder(answer = { isError: false, text: 'shipped' }) {
  const calls: { serverId: string; tool: string; args: Record<string, unknown> }[] = []
  const caller: McpCaller = {
    call: async (serverId, tool, args) => {
      calls.push({ serverId, tool, args })
      return answer
    },
  }
  return { calls, caller }
}

const run = (tool: unknown, args: unknown) =>
  (tool as { execute: (input: unknown, options: unknown) => Promise<unknown> }).execute(args, {
    toolCallId: 'call-1',
    messages: [],
  })

describe('what the model is shown', () => {
  test('a bound argument is gone from properties and required', () => {
    const schema = modelSchemaFor(definition().inputSchema, [
      { name: 'account', source: 'subject' },
    ])
    expect(schema.properties).toEqual({ order_id: { type: 'string' } })
    expect(schema.required).toEqual(['order_id'])
  })

  test('a tool binding a subject nobody proved is not offered; a write is not offered to a draft', () => {
    const { caller } = recorder()
    const source = createMcpToolSource(
      [
        definition({ bindings: [{ name: 'account', source: 'subject' }] }),
        definition({ exposedName: 'shop_cancel', remoteName: 'cancel', effect: 'write' }),
      ],
      caller,
    )
    expect(Object.keys(source.tools(context()))).toEqual(['shop_cancel'])
    expect(
      Object.keys(source.tools(context({ mode: 'suggest', bound: bound({ subject: 'ACC-1' }) }))),
    ).toEqual(['shop_lookup_order'])
  })
})

describe('calling', () => {
  test('a read runs now, with the bound value laid over whatever the model sent', async () => {
    const { calls, caller } = recorder()
    const ctx = context({ bound: bound({ subject: 'ACC-REAL' }) })
    const tools = createMcpToolSource(
      [definition({ bindings: [{ name: 'account', source: 'subject' }] })],
      caller,
    ).tools(ctx)
    const answer = await run(tools.shop_lookup_order, { order_id: 'SO-1', account: 'ACC-OTHER' })
    expect(answer).toEqual({ result: 'shipped' })
    expect(calls).toEqual([
      { serverId: 'srv-1', tool: 'lookup_order', args: { order_id: 'SO-1', account: 'ACC-REAL' } },
    ])
  })

  test('a server error is a tool error, so the turn hands off', async () => {
    const { caller } = recorder({ isError: true, text: 'the shop is closed' })
    const ctx = context()
    const tools = createMcpToolSource([definition()], caller).tools(ctx)
    const answer = await run(tools.shop_lookup_order, { order_id: 'SO-1', account: 'a' })
    expect(answer).toEqual({ error: 'shop_lookup_order the shop is closed' })
    expect(ctx.scratchpad.toolErrors).toEqual([
      { tool: 'shop_lookup_order', message: 'the shop is closed' },
    ])
  })

  test('a write is recorded with a key that ignores argument order, and nothing is called', async () => {
    const { calls, caller } = recorder()
    const ctx = context()
    const tools = createMcpToolSource(
      [definition({ exposedName: 'shop_cancel', remoteName: 'cancel', effect: 'write' })],
      caller,
    ).tools(ctx)
    await run(tools.shop_cancel, { order_id: 'SO-1', reason: { code: 'late', note: 'x' } })
    await run(tools.shop_cancel, { reason: { note: 'x', code: 'late' }, order_id: 'SO-1' })
    expect(calls).toHaveLength(0)
    const [first, second] = ctx.scratchpad.pendingWrites
    expect(first).toMatchObject({ source: 'mcp', toolId: 'srv-1', remoteTool: 'cancel' })
    expect(first?.idempotencyKey).toBe(second?.idempotencyKey ?? '')
  })
})

test('withBindings refuses when a value is missing', () => {
  expect(withBindings({ a: 1 }, [{ name: 'acct', source: 'subject' }], bound())).toBeNull()
  expect(withBindings({ a: 1 }, [{ name: 'cid', source: 'customer_id' }], bound())).toEqual({
    a: 1,
    cid: 'cust1',
  })
})

test('the fingerprint is the same at any depth and key order, and differs for different values', () => {
  expect(stableFingerprint({ a: { x: 1, y: 2 }, b: [1] })).toBe(
    stableFingerprint({ b: [1], a: { y: 2, x: 1 } }),
  )
  expect(stableFingerprint({ a: { x: 1 } })).not.toBe(stableFingerprint({ a: { x: 2 } }))
})
