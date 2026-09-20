import { generateText } from 'ai'
import { embedTexts } from '../rag/embed'
import { resolveModel } from './registry'
import type { SlotConfig, SlotTarget } from './types'

/**
 * Asking a provider whether it will actually serve a model.
 *
 * A gateway's catalogue is a list of what it is configured to offer, not a list of what
 * works. On the gateway this was written for, eight of thirty-nine advertised models are
 * refused when called: one has no name mapping to its upstream, one is outside the
 * account's entitlement, and six need a different kind of credential. Without this, each
 * of those is discovered when a customer asks a question and gets silence.
 *
 * The check goes through the same path a real turn uses, including the compatibility shim,
 * so a gateway that answers but frames its answer oddly is reported as working rather than
 * as broken, and vice versa.
 */

export type VerifyResult = { ok: true; detail: string } | { ok: false; error: string }

/** Long enough that a reasoning model is not cut off before it emits anything. */
const VERIFY_OUTPUT_TOKENS = 256

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const trimmed = message.trim()
  return trimmed === '' ? 'The provider refused the request without saying why.' : trimmed
}

export async function verifyChatModel(target: SlotTarget): Promise<VerifyResult> {
  const startedAt = Date.now()
  try {
    const result = await generateText({
      model: resolveModel(target),
      prompt: 'Reply with the single word: ok',
      maxOutputTokens: VERIFY_OUTPUT_TOKENS,
      // No retries: a check should report the first answer, not a provider's best of three.
      maxRetries: 0,
    })
    // Empty text is not a failure. A model that spends its budget on reasoning still proves
    // the id is served, which is the only question being asked.
    const tokens = result.usage?.outputTokens ?? 0
    return {
      ok: true,
      detail: `answered in ${Date.now() - startedAt} ms, ${tokens} output tokens`,
    }
  } catch (error) {
    return { ok: false, error: describe(error) }
  }
}

export async function verifyEmbeddingModel(
  target: SlotTarget,
  dimensions: number,
  sendDimensions: boolean,
): Promise<VerifyResult> {
  const startedAt = Date.now()
  const slot: SlotConfig = {
    task: 'embed',
    primary: target,
    fallback: null,
    params: { sendDimensions, maxRetries: 0 },
  }
  try {
    const result = await embedTexts(slot, ['ตรวจสอบการเชื่อมต่อ'], dimensions, { maxRetries: 0 })
    const size = result.embeddings[0]?.length ?? 0
    return { ok: true, detail: `answered in ${Date.now() - startedAt} ms, ${size} dimensions` }
  } catch (error) {
    return { ok: false, error: describe(error) }
  }
}
