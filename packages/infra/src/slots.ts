import type { FetchLike, PriceTable, ProviderProfile, SlotConfig } from '@ci/core'
import { type Database, decryptJson, decryptSecret, schema } from '@ci/db'
import type { AiTask } from '@ci/shared'
import { eq } from 'drizzle-orm'

/**
 * Load a workspace's AI configuration.
 *
 * Provider secrets live encrypted at rest and are decrypted here, at the moment of use,
 * so a plaintext key never sits in a row, a log line or an API response.
 */

export type WorkspaceAiConfig = {
  slots: Map<AiTask, SlotConfig>
  prices: PriceTable
}

export async function loadAiConfig(
  db: Database,
  workspaceId: string,
  secretKey: string,
  prices: PriceTable,
  /** `Runtime.providerFetch`: the base URLs were typed by a tenant admin. */
  fetch: FetchLike,
): Promise<WorkspaceAiConfig> {
  const [providerRows, slotRows] = await Promise.all([
    db.select().from(schema.providers).where(eq(schema.providers.workspaceId, workspaceId)),
    db.select().from(schema.taskSlots).where(eq(schema.taskSlots.workspaceId, workspaceId)),
  ])

  const profiles = new Map<string, ProviderProfile>()
  for (const row of providerRows) {
    if (!row.enabled) continue
    profiles.set(row.id, {
      id: row.id,
      name: row.name,
      baseUrl: row.baseUrl,
      apiKey: row.apiKeyEncrypted ? await decryptSecret(row.apiKeyEncrypted, secretKey) : null,
      headers: row.headersEncrypted
        ? await decryptJson<Record<string, string>>(row.headersEncrypted, secretKey)
        : {},
      supportsTools: row.supportsTools,
      supportsVision: row.supportsVision,
      fetch,
    })
  }

  const slots = new Map<AiTask, SlotConfig>()
  for (const row of slotRows) {
    const primaryProvider = row.primaryProviderId ? profiles.get(row.primaryProviderId) : undefined
    const fallbackProvider = row.fallbackProviderId
      ? profiles.get(row.fallbackProviderId)
      : undefined

    slots.set(row.task, {
      task: row.task,
      primary:
        primaryProvider && row.primaryModel
          ? { provider: primaryProvider, model: row.primaryModel }
          : null,
      fallback:
        fallbackProvider && row.fallbackModel
          ? { provider: fallbackProvider, model: row.fallbackModel }
          : null,
      params: row.params as SlotConfig['params'],
    })
  }

  return { slots, prices }
}

/** A slot is usable only when at least one target is fully configured. */
export function usableSlot(config: WorkspaceAiConfig, task: AiTask): SlotConfig | null {
  const slot = config.slots.get(task)
  if (!slot) return null
  return slot.primary || slot.fallback ? slot : null
}
