import {
  type BoundIdentity,
  createHttpToolSource,
  executeHttpTool,
  type HttpToolDefinition,
  type PendingWrite,
  type ToolSource,
} from '@ci/core'
import { type Database, decryptSecret, schema } from '@ci/db'
import { and, eq } from 'drizzle-orm'
import type { Runtime } from './runtime'

/**
 * Loading and running a workspace's own tools.
 *
 * Credentials live encrypted at rest and are decrypted here, at the moment of use, the same
 * way `slots.ts` treats provider keys: a plaintext credential never sits in a row, a log
 * line or an API response.
 */

export async function loadToolDefinitions(
  db: Database,
  workspaceId: string,
  secretKey: string,
): Promise<HttpToolDefinition[]> {
  const rows = await db
    .select()
    .from(schema.tools)
    .where(and(eq(schema.tools.workspaceId, workspaceId), eq(schema.tools.enabled, true)))

  const definitions: HttpToolDefinition[] = []
  for (const row of rows) {
    definitions.push({
      id: row.id,
      name: row.name,
      description: row.description,
      config: row.config,
      credential: row.credentialEncrypted
        ? await decryptSecret(row.credentialEncrypted, secretKey)
        : null,
    })
  }
  return definitions
}

/** One source today. The MCP client adds a second here and the agent loop is untouched. */
export function createWorkspaceToolSources(
  definitions: HttpToolDefinition[],
  runtime: Runtime,
): ToolSource[] {
  if (definitions.length === 0) return []
  return [createHttpToolSource(definitions, { fetch: runtime.toolFetch })]
}

export type WriteOutcome = {
  /** Tools that reached the tenant and answered. */
  succeeded: string[]
  /** The one that did not, if any. Everything after it was never attempted. */
  failed: { tool: string; message: string } | null
}

/**
 * Fire the writes a finished turn asked for.
 *
 * Stops at the first failure, because a tool that failed may be the reason the later ones
 * made sense. The caller hands off, and the note names what did happen as well as what did
 * not: whoever picks the conversation up needs to know the tenant's system is in a partly
 * changed state, which is exactly what a note saying only "it failed" hides.
 */
export async function runPendingWrites(
  definitions: HttpToolDefinition[],
  writes: PendingWrite[],
  bound: BoundIdentity,
  runtime: Runtime,
): Promise<WriteOutcome> {
  const succeeded: string[] = []

  for (const write of writes) {
    const def = definitions.find((d) => d.id === write.toolId)
    if (!def) {
      return {
        succeeded,
        failed: { tool: write.tool, message: 'is no longer defined in this workspace' },
      }
    }

    try {
      await executeHttpTool(
        def,
        write.args,
        bound,
        { fetch: runtime.toolFetch },
        {
          // Decided when the model asked for the write, from the turn, the tool and the
          // arguments, rather than from the position in this list: a retried turn may ask
          // for a different set of calls, and a positional key would then hand a second
          // operation the key the tenant already answered for a first. See `PendingWrite`.
          idempotencyKey: write.idempotencyKey,
        },
      )
      succeeded.push(write.tool)
    } catch (error) {
      return {
        succeeded,
        failed: {
          tool: write.tool,
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }

  return { succeeded, failed: null }
}

/** The note an agent reads when a write failed. Names the partial state, not just the error. */
export function describeWriteFailure(outcome: WriteOutcome): string {
  if (!outcome.failed) return ''
  const done =
    outcome.succeeded.length > 0
      ? ` These were already carried out and may need undoing: ${outcome.succeeded.join(', ')}.`
      : ' Nothing was carried out.'
  return `The AI wrote a reply but "${outcome.failed.tool}" ${outcome.failed.message}, so the reply was not sent.${done}`
}
