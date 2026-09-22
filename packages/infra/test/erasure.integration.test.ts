import { afterEach, describe, expect, test } from 'bun:test'
import { loadEnv } from '@ci/config'
import { createWorkspace, newId, schema } from '@ci/db'
import { eq } from 'drizzle-orm'
import { requestWorkspaceErasure } from '../src/platform'
import { storeMessage } from '../src/repo'
import { eraseWorkspace } from '../src/retention'
import { createRuntime, type Runtime } from '../src/runtime'

/**
 * Erasing a tenant.
 *
 * The rows take care of themselves through the cascade; what needs proving is everything
 * that does not cascade. Stored media lives in object storage, knowledge files are reached
 * by a column that the message-attachment sweep never looks at, and the record of the
 * erasure has to survive the erasure.
 */

const env = loadEnv()

type Fixture = {
  runtime: Runtime
  workspaceId: string
  slug: string
  messageKey: string
  knowledgeKey: string
  cleanup: () => Promise<void>
}

const fixtures: Fixture[] = []

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop()
    await fixture?.cleanup()
  }
})

async function createFixture(): Promise<Fixture> {
  const runtime = createRuntime('test', env, {
    queuePrefix: `{erase-${Math.random().toString(36).slice(2, 8)}}`,
  })
  const { db, blob } = runtime
  const slug = `erase-${Math.random().toString(36).slice(2, 10)}`
  const { workspaceId } = await createWorkspace(db, { name: slug, slug })

  const channels = await db
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(eq(schema.channels.workspaceId, workspaceId))
  const channelId = channels[0]?.id ?? ''

  const customerId = newId()
  await db.insert(schema.customers).values({
    id: customerId,
    workspaceId,
    displayName: 'Erasable',
    primaryLanguage: 'th',
    fields: {},
  })
  const identityId = newId()
  await db.insert(schema.channelIdentities).values({
    id: identityId,
    workspaceId,
    channelId,
    externalId: `erase-${customerId.slice(0, 6)}`,
    customerId,
    profile: {},
  })
  const conversationId = newId()
  await db.insert(schema.conversations).values({
    id: conversationId,
    workspaceId,
    channelId,
    customerId,
    channelIdentityId: identityId,
    mode: 'ai',
    status: 'open',
  })

  // One object reached through a message attachment, one through a knowledge source: the
  // two different ways a tenant's bytes get into storage.
  const messageKey = `${workspaceId}/inbound/${newId()}.bin`
  const knowledgeKey = `${workspaceId}/knowledge/${newId()}.pdf`
  const bytes = new Uint8Array(new ArrayBuffer(4))
  bytes.set([1, 2, 3, 4])
  await blob.put(messageKey, bytes, 'application/octet-stream')
  await blob.put(knowledgeKey, bytes, 'application/pdf')

  await storeMessage(db, {
    workspaceId,
    conversationId,
    direction: 'inbound',
    senderType: 'customer',
    message: {
      kind: 'image',
      text: null,
      attachments: [
        {
          storageKey: messageKey,
          sourceUrl: null,
          mime: 'image/png',
          sizeBytes: 4,
          fileName: null,
          width: null,
          height: null,
          durationMs: null,
        },
      ],
    },
    status: 'sent',
    redaction: { cardNumbers: true, thaiNationalId: true },
  })

  await db.insert(schema.knowledgeSources).values({
    id: newId(),
    workspaceId,
    kind: 'file',
    title: 'A document',
    status: 'ready',
    storageKey: knowledgeKey,
  })

  const fixture: Fixture = {
    runtime,
    workspaceId,
    slug,
    messageKey,
    knowledgeKey,
    cleanup: async () => {
      await db.delete(schema.organization).where(eq(schema.organization.id, workspaceId))
      await db
        .delete(schema.workspaceErasures)
        .where(eq(schema.workspaceErasures.workspaceId, workspaceId))
      await db
        .delete(schema.platformAuditLog)
        .where(eq(schema.platformAuditLog.targetId, workspaceId))
      await runtime.queues.workspace_erasure.obliterate({ force: true }).catch(() => {})
      await runtime.close()
    },
  }
  fixtures.push(fixture)
  return fixture
}

const exists = async (runtime: Runtime, key: string): Promise<boolean> => {
  try {
    await runtime.blob.get(key)
    return true
  } catch {
    return false
  }
}

describe('erasing a workspace', () => {
  test('removes the rows, both kinds of stored media, and records that it did', async () => {
    const fixture = await createFixture()
    const { runtime, workspaceId } = fixture

    const queued = await requestWorkspaceErasure(runtime.db, runtime.outbox, {
      workspaceId,
      actorUserId: null,
    })
    expect(queued).toBe(true)

    const result = await eraseWorkspace(runtime.db, runtime.blob, {
      workspaceId,
      logger: runtime.logger,
    })
    expect(result.skipped).toBe(false)
    expect(result.rowsDeleted).toBe(true)
    expect(result.mediaFailed).toBe(0)
    expect(result.media).toBe(2)

    // The tenant is gone.
    const organizations = await runtime.db
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.id, workspaceId))
    expect(organizations).toHaveLength(0)

    // Both objects are gone, including the knowledge file the message sweep never sees.
    expect(await exists(runtime, fixture.messageKey)).toBe(false)
    expect(await exists(runtime, fixture.knowledgeKey)).toBe(false)

    // And the record outlived the thing it describes.
    const record = await runtime.db
      .select()
      .from(schema.workspaceErasures)
      .where(eq(schema.workspaceErasures.workspaceId, workspaceId))
    expect(record[0]?.completedAt).not.toBeNull()
    expect(record[0]?.slug).toBe(fixture.slug)
    expect(record[0]?.mediaRemoved).toBe(2)

    const audit = await runtime.db
      .select()
      .from(schema.platformAuditLog)
      .where(eq(schema.platformAuditLog.targetId, workspaceId))
    expect(audit.map((row) => row.action)).toContain('tenant.erased')
  })

  test('does nothing at all when no erasure was requested', async () => {
    const fixture = await createFixture()
    const { runtime, workspaceId } = fixture

    const result = await eraseWorkspace(runtime.db, runtime.blob, {
      workspaceId,
      logger: runtime.logger,
    })
    expect(result.skipped).toBe(true)

    // Still there, untouched.
    const organizations = await runtime.db
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.id, workspaceId))
    expect(organizations).toHaveLength(1)
    expect(await exists(runtime, fixture.messageKey)).toBe(true)
  })

  test('is safe to run again after the rows are already gone', async () => {
    const fixture = await createFixture()
    const { runtime, workspaceId } = fixture

    await requestWorkspaceErasure(runtime.db, runtime.outbox, { workspaceId, actorUserId: null })
    await eraseWorkspace(runtime.db, runtime.blob, { workspaceId, logger: runtime.logger })

    // The retry finds the rows deleted and no media left, and neither throws nor duplicates.
    const again = await eraseWorkspace(runtime.db, runtime.blob, {
      workspaceId,
      logger: runtime.logger,
    })
    expect(again.skipped).toBe(false)
    expect(again.rowsDeleted).toBe(true)
    expect(again.media).toBe(0)
    expect(again.mediaFailed).toBe(0)

    const audit = await runtime.db
      .select()
      .from(schema.platformAuditLog)
      .where(eq(schema.platformAuditLog.targetId, workspaceId))
    expect(audit.filter((row) => row.action === 'tenant.erased')).toHaveLength(2)
  })

  test('refuses a workspace that is not marked for deletion', async () => {
    const fixture = await createFixture()
    const { runtime, workspaceId } = fixture

    // A record with no status change: exactly what a stray enqueue would look like.
    await runtime.db.insert(schema.workspaceErasures).values({
      workspaceId,
      name: fixture.slug,
      slug: fixture.slug,
    })

    const result = await eraseWorkspace(runtime.db, runtime.blob, {
      workspaceId,
      logger: runtime.logger,
    })
    expect(result.skipped).toBe(true)

    const organizations = await runtime.db
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.id, workspaceId))
    expect(organizations).toHaveLength(1)
  })
})
