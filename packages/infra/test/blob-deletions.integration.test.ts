import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadEnv } from '@ci/config'
import type { BlobStore } from '@ci/core'
import { createDb, createWorkspace, schema } from '@ci/db'
import { eq } from 'drizzle-orm'
import {
  drainBlobDeletions,
  queueAbandonedUploads,
  queueBlobDeletions,
} from '../src/blob-deletions'
import { createFilesystemBlobStore } from '../src/blob-fs'

/**
 * Recommendation #13: a stored file whose rows are gone is removed eventually, however
 * many times the store refuses first, and an upload nobody sent does not stay for ever.
 */

const env = loadEnv()
const { db, close } = createDb(env.DATABASE_URL)
let root: string
let blob: BlobStore
let workspaceId: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'blob-deletions-'))
  blob = createFilesystemBlobStore(root, '/uploads')
  const slug = `blobdel-${Math.random().toString(36).slice(2, 10)}`
  workspaceId = (await createWorkspace(db, { name: slug, slug })).workspaceId
})

afterAll(async () => {
  await db.delete(schema.organization).where(eq(schema.organization.id, workspaceId))
  await close()
  await rm(root, { recursive: true, force: true })
})

const png = new Uint8Array(new ArrayBuffer(4))

describe('queued deletions', () => {
  test('a removal that fails stays queued until one succeeds', async () => {
    const key = `${workspaceId}/inbound/keep-trying.png`
    await blob.put(key, png, 'image/png')
    await queueBlobDeletions(db, workspaceId, [key], 'retention')

    const refusing: BlobStore = {
      ...blob,
      remove: async () => {
        throw new Error('store unavailable')
      },
    }
    const first = await drainBlobDeletions(db, refusing, { workspaceId })
    expect(first.failed).toBe(1)
    const [queued] = await db
      .select()
      .from(schema.blobDeletions)
      .where(eq(schema.blobDeletions.storageKey, key))
    expect(queued?.attempts).toBe(1)
    expect(queued?.lastError).toBe('store unavailable')

    const second = await drainBlobDeletions(db, blob, { workspaceId })
    expect(second.removed).toBe(1)
    const left = await db
      .select()
      .from(schema.blobDeletions)
      .where(eq(schema.blobDeletions.storageKey, key))
    expect(left).toHaveLength(0)
    // The media-type sidecar goes with the object.
    expect(existsSync(join(root, key))).toBe(false)
    expect(existsSync(join(root, `${key}.mime`))).toBe(false)
  })

  test('refuses to queue a key that is not the workspace’s own', async () => {
    await queueBlobDeletions(
      db,
      workspaceId,
      [`${workspaceId}/../other/x.png`, 'other/y.png'],
      'retention',
    )
    const rows = await db
      .select()
      .from(schema.blobDeletions)
      .where(eq(schema.blobDeletions.workspaceId, workspaceId))
    expect(rows).toHaveLength(0)
  })
})

describe('abandoned uploads', () => {
  test('queues an old upload nobody sent, and leaves a recent one', async () => {
    const old = `${workspaceId}/abandoned.png`
    const recent = `${workspaceId}/just-picked.png`
    await blob.put(old, png, 'image/png')
    await blob.put(recent, png, 'image/png')
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    await utimes(join(root, old), twoDaysAgo, twoDaysAgo)

    const queued = await queueAbandonedUploads(db, blob, { workspaceId })
    expect(queued).toBe(1)
    const rows = await db
      .select({ key: schema.blobDeletions.storageKey })
      .from(schema.blobDeletions)
      .where(eq(schema.blobDeletions.workspaceId, workspaceId))
    expect(rows.map((row) => row.key)).toEqual([old])
  })
})
