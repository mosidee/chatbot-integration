import { deleteWorkspaceTag, loadWorkspaceSettings, renameWorkspaceTag } from '@ci/infra'
import { tagSchema } from '@ci/shared'
import Elysia from 'elysia'
import { z } from 'zod'
import { authPlugin } from '../auth-plugin'
import type { ApiContext } from '../context'

/**
 * Tags across the whole workspace: rename (merging into a tag that already exists) and
 * delete. Admin only — one request changes every conversation in the tenant. Adding and
 * removing a tag on one conversation is an agent's, in `conversations.ts`.
 */
export function tagRoutes(ctx: ApiContext) {
  const { db, runtime } = ctx

  return new Elysia({ prefix: '/settings/tags' })
    .use(authPlugin(ctx))

    .patch(
      '/',
      async ({ workspaceId, body, status }) => {
        const settings = await loadWorkspaceSettings(db, workspaceId)
        const changed = await renameWorkspaceTag(
          db,
          workspaceId,
          body.from,
          body.to,
          settings.redaction,
        )
        if (changed === 'empty') return status(400, { error: 'tag is empty' })
        if (changed > 0) await runtime.publisher.publish(workspaceId, { type: 'tags.changed' })
        return { changed }
      },
      { auth: 'admin', body: z.object({ from: tagSchema, to: tagSchema }) },
    )

    .delete(
      '/',
      async ({ workspaceId, body }) => {
        const changed = await deleteWorkspaceTag(db, workspaceId, body.tag)
        if (changed > 0) await runtime.publisher.publish(workspaceId, { type: 'tags.changed' })
        return { changed }
      },
      { auth: 'admin', body: z.object({ tag: tagSchema }) },
    )
}
