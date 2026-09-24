import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { loadEnv } from '@ci/config'
import { createDb, createWorkspace, newId, schema } from '@ci/db'
import { eq } from 'drizzle-orm'
import { loadDashboard } from '../src/dashboard'

/**
 * Recommendation #23: the dashboard counts what reached customers, on the workspace's own
 * calendar.
 */

const env = loadEnv()
const { db, close } = createDb(env.DATABASE_URL)
let workspaceId: string
let conversationId: string

beforeAll(async () => {
  const slug = `dash-${Math.random().toString(36).slice(2, 10)}`
  workspaceId = (await createWorkspace(db, { name: slug, slug })).workspaceId
  const [channel] = await db
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(eq(schema.channels.workspaceId, workspaceId))
  const customerId = newId()
  await db.insert(schema.customers).values({ id: customerId, workspaceId, displayName: 'D' })
  const identityId = newId()
  await db.insert(schema.channelIdentities).values({
    id: identityId,
    workspaceId,
    channelId: channel?.id ?? '',
    customerId,
    externalId: `dash-${Math.random().toString(36).slice(2, 10)}`,
  })
  conversationId = newId()
  await db.insert(schema.conversations).values({
    id: conversationId,
    workspaceId,
    customerId,
    channelId: channel?.id ?? '',
    channelIdentityId: identityId,
    mode: 'ai',
    status: 'open',
    // 18:30 UTC is 01:30 the next morning in Bangkok.
    createdAt: new Date('2026-09-20T18:30:00Z'),
  })
})

afterAll(async () => {
  await db.delete(schema.organization).where(eq(schema.organization.id, workspaceId))
  await close()
})

async function turn(status: 'sent' | 'failed' | 'canceled', at: Date) {
  const traceId = newId()
  await db.insert(schema.aiTraces).values({
    id: traceId,
    workspaceId,
    conversationId,
    task: 'agent_chat',
    outcome: 'sent',
    prompt: {},
    toolCalls: [],
    retrieved: [],
    createdAt: at,
  })
  await db.insert(schema.messages).values({
    id: newId(),
    workspaceId,
    conversationId,
    direction: 'outbound',
    senderType: 'ai',
    content: { kind: 'text', text: status },
    text: status,
    status,
    aiTraceId: traceId,
    createdAt: at,
    ...(status === 'sent' ? { sentAt: at } : {}),
  })
}

describe('the dashboard', () => {
  test('counts an answer only once it reached the customer', async () => {
    const at = new Date('2026-09-21T03:00:00Z')
    await db.insert(schema.messages).values({
      id: newId(),
      workspaceId,
      conversationId,
      direction: 'inbound',
      senderType: 'customer',
      content: { kind: 'text', text: 'hello' },
      text: 'hello',
      createdAt: new Date(at.getTime() - 60_000),
    })
    await turn('failed', at)
    await turn('canceled', new Date(at.getTime() + 1000))

    const before = await loadDashboard(db, {
      workspaceId,
      days: 7,
      now: new Date('2026-09-22T00:00:00Z'),
      timezone: 'Asia/Bangkok',
    })
    expect(before.totals.answered).toBe(0)
    expect(before.firstResponse.conversations).toBe(0)

    await turn('sent', new Date(at.getTime() + 2000))
    const after = await loadDashboard(db, {
      workspaceId,
      days: 7,
      now: new Date('2026-09-22T00:00:00Z'),
      timezone: 'Asia/Bangkok',
    })
    expect(after.totals.answered).toBe(1)
    expect(after.firstResponse.conversations).toBe(1)
  })

  test('buckets days in the workspace timezone', async () => {
    const dashboard = await loadDashboard(db, {
      workspaceId,
      days: 7,
      now: new Date('2026-09-22T00:00:00Z'),
      timezone: 'Asia/Bangkok',
    })
    expect(dashboard.timezone).toBe('Asia/Bangkok')
    // Created 18:30 UTC on the 20th: the 21st in Bangkok.
    expect(dashboard.days.find((d) => d.day === '2026-09-21')?.conversations).toBe(1)
    expect(dashboard.days.find((d) => d.day === '2026-09-20')?.conversations ?? 0).toBe(0)
    // The window ends on today's date in Bangkok (07:00 on the 22nd there).
    expect(dashboard.days.at(-1)?.day).toBe('2026-09-22')
  })
})
