import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { loadEnv } from '@ci/config'
import { createDb, createWorkspace, newId, schema } from '@ci/db'
import { eq } from 'drizzle-orm'
import { ForeignStorageKeyError, foreignStorageKey, storeMessage } from '../src/repo'
import { eraseCustomer } from '../src/retention'

/**
 * A storage key names an object, and the workspace it belongs to is its prefix.
 *
 * The key arrives in a request body on the agent-send and simulator routes, and nothing
 * downstream re-derives it: vision reads those bytes and erasure deletes them. So a key from
 * another tenant, written once, is both a read of their file and — later, quietly — a
 * deletion of it. Two locks on the same door, and this pins down both.
 */

const env = loadEnv()
const { db, close } = createDb(env.DATABASE_URL)

let workspaceId: string
let otherWorkspaceId: string
const slug = `keys-${Math.random().toString(36).slice(2, 8)}`

beforeAll(async () => {
  workspaceId = (await createWorkspace(db, { name: slug, slug })).workspaceId
  otherWorkspaceId = (await createWorkspace(db, { name: `${slug}-b`, slug: `${slug}-b` }))
    .workspaceId
})

afterAll(async () => {
  for (const id of [workspaceId, otherWorkspaceId]) {
    await db.delete(schema.organization).where(eq(schema.organization.id, id))
  }
  await close()
})

const fileMessage = (storageKey: string) => ({
  kind: 'file' as const,
  text: null,
  attachments: [
    {
      storageKey,
      sourceUrl: null,
      mime: 'application/pdf',
      sizeBytes: 10,
      fileName: 'invoice.pdf',
      width: null,
      height: null,
      durationMs: null,
    },
  ],
})

/** A conversation to hang messages on, with its customer and channel identity. */
async function makeConversation(ws: string): Promise<{ id: string; customerId: string }> {
  const channels = await db
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(eq(schema.channels.workspaceId, ws))
    .limit(1)
  const channelId = channels[0]?.id ?? ''

  const customerId = newId()
  await db.insert(schema.customers).values({ id: customerId, workspaceId: ws })

  const identityId = newId()
  await db.insert(schema.channelIdentities).values({
    id: identityId,
    workspaceId: ws,
    channelId,
    customerId,
    externalId: `ext-${newId()}`,
  })

  const conversationId = newId()
  await db.insert(schema.conversations).values({
    id: conversationId,
    workspaceId: ws,
    customerId,
    channelId,
    channelIdentityId: identityId,
    status: 'open',
    mode: 'ai',
  })
  return { id: conversationId, customerId }
}

describe('naming a storage key', () => {
  test('spots one that belongs to another workspace', () => {
    expect(foreignStorageKey(workspaceId, fileMessage(`${otherWorkspaceId}/theirs.pdf`))).toBe(
      `${otherWorkspaceId}/theirs.pdf`,
    )
    expect(foreignStorageKey(workspaceId, fileMessage(`${workspaceId}/ours.pdf`))).toBeNull()
  })

  test('is untroubled by a message with no attachments', () => {
    expect(foreignStorageKey(workspaceId, { kind: 'text', text: 'hello' })).toBeNull()
  })

  /**
   * A prefix check, not a substring one. `<other>/x` must not pass merely because the
   * workspace id appears somewhere in it.
   */
  test('is not fooled by a key that merely contains the workspace id', () => {
    const sneaky = `${otherWorkspaceId}/${workspaceId}/theirs.pdf`
    expect(foreignStorageKey(workspaceId, fileMessage(sneaky))).toBe(sneaky)
  })

  /**
   * Recommendation #6: a key that starts with our prefix and climbs out of it. The
   * filesystem store resolves `..`, so this named workspace B's file with A's prefix.
   */
  test('is not fooled by a key that climbs out of the workspace', () => {
    for (const sneaky of [
      `${workspaceId}/../${otherWorkspaceId}/theirs.pdf`,
      `${workspaceId}/./x.pdf`,
      `${workspaceId}//x.pdf`,
      `${workspaceId}/a\\..\\x.pdf`,
    ]) {
      expect(foreignStorageKey(workspaceId, fileMessage(sneaky))).toBe(sneaky)
    }
  })

  test('refuses to store a message naming another workspace object', async () => {
    const conversation = await makeConversation(workspaceId)
    await expect(
      storeMessage(db, {
        workspaceId,
        conversationId: conversation.id,
        direction: 'outbound',
        senderType: 'human',
        message: fileMessage(`${otherWorkspaceId}/theirs.pdf`),
        redaction: { cardNumbers: false, thaiNationalId: false },
      }),
    ).rejects.toThrow(ForeignStorageKeyError)
  })

  test('stores one of our own', async () => {
    const conversation = await makeConversation(workspaceId)
    const stored = await storeMessage(db, {
      workspaceId,
      conversationId: conversation.id,
      direction: 'outbound',
      senderType: 'human',
      message: fileMessage(`${workspaceId}/ours.pdf`),
      redaction: { cardNumbers: false, thaiNationalId: false },
    })
    expect(stored.duplicate).toBe(false)
  })
})

describe('erasing a customer', () => {
  /**
   * The second lock. A row written before `storeMessage` refused foreign keys still names
   * one, and erasure is irreversible: it must not take another tenant's file with it.
   */
  test('never deletes an object outside the workspace', async () => {
    const conversation = await makeConversation(workspaceId)
    const theirKey = `${otherWorkspaceId}/theirs.pdf`

    // Written straight to the table, which is the only way such a row can exist now.
    await db.insert(schema.messages).values({
      id: newId(),
      workspaceId,
      conversationId: conversation.id,
      direction: 'outbound',
      senderType: 'human',
      content: fileMessage(theirKey),
      text: '[file (invoice.pdf)]',
      status: 'sent',
    })
    await db.insert(schema.messages).values({
      id: newId(),
      workspaceId,
      conversationId: conversation.id,
      direction: 'outbound',
      senderType: 'human',
      content: fileMessage(`${workspaceId}/ours.pdf`),
      text: '[file (invoice.pdf)]',
      status: 'sent',
    })

    const asked: string[] = []
    const blob = {
      put: async () => {},
      get: async () => ({ data: new Uint8Array(), mime: 'application/pdf' }),
      remove: async (key: string) => {
        asked.push(key)
      },
      urlFor: () => '',
    }

    await eraseCustomer(db, blob, { workspaceId, customerId: conversation.customerId })

    expect(asked).toContain(`${workspaceId}/ours.pdf`)
    expect(asked).not.toContain(theirKey)
  })
})
