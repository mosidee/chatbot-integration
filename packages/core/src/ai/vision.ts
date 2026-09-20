import { generateText } from 'ai'
import { runWithFallback } from './registry'
import type { ImageInput, SlotConfig } from './types'

/**
 * Describe images with the `vision` slot.
 *
 * Deliberately a separate call from the chat turn so the operator can point chat and
 * vision at different models and providers.
 *
 * Known limit: the chat model receives a text description rather than the image itself,
 * so follow-up questions that depend on looking again ("what about the second photo?")
 * will not work. Revisit if that becomes a real complaint.
 */

const VISION_PROMPT = [
  'Describe what this image shows, for a customer support agent who cannot see it.',
  'If it is a screenshot of an app, describe the screen, any visible error message and',
  'the text of buttons or fields. If it contains text, transcribe the important parts',
  'verbatim, preserving Thai text exactly. Be factual and concise. Do not speculate',
  'about what the customer wants.',
].join(' ')

export type VisionResult = {
  summary: string
  providerName: string | null
  model: string | null
  usedFallback: boolean
  tokensIn: number | null
  tokensOut: number | null
  latencyMs: number
}

export async function describeImages(
  slot: SlotConfig,
  images: ImageInput[],
  options: { maxRetries?: number } = {},
): Promise<VisionResult | null> {
  if (images.length === 0) return null
  if (!slot.primary && !slot.fallback) return null

  const startedAt = Date.now()

  const attempt = await runWithFallback(slot, async (_target, model) =>
    generateText({
      model,
      temperature: slot.params.temperature ?? 0.2,
      maxOutputTokens: slot.params.maxOutputTokens ?? 500,
      maxRetries: options.maxRetries ?? slot.params.maxRetries ?? 1,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: VISION_PROMPT },
            ...images.map((image) => ({
              type: 'file' as const,
              data: image.data,
              mediaType: image.mime,
            })),
          ],
        },
      ],
    }),
  )

  return {
    summary: attempt.result.text.trim(),
    providerName: attempt.target.provider.name,
    model: attempt.target.model,
    usedFallback: attempt.usedFallback,
    tokensIn: attempt.result.usage?.inputTokens ?? null,
    tokensOut: attempt.result.usage?.outputTokens ?? null,
    latencyMs: Date.now() - startedAt,
  }
}
