import { z } from 'zod'

/**
 * Conversation tags: free text, so a team can name things its own way, normalised so that
 * `Billing`, ` billing ` and `billing` are one tag in the filter, the suggestions and the
 * dashboard. Thai has no case, so lowercasing leaves it as typed.
 *
 * Migration 0019 normalised the tags already stored with the same rules in SQL; change one
 * and the other must follow (`packages/infra/test/tags.integration.test.ts` holds them
 * together).
 */

export const MAX_TAG_LENGTH = 40
export const MAX_TAGS_PER_CONVERSATION = 20

/** The tag as stored, or null when nothing is left of it. */
export function normaliseTag(raw: string): string | null {
  const collapsed = raw.replace(/,/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
  // By character, not UTF-16 unit, as Postgres's `left()` counts: an emoji is not cut in half.
  const tag = Array.from(collapsed).slice(0, MAX_TAG_LENGTH).join('').trim()
  return tag.length > 0 ? tag : null
}

/** Normalised, de-duplicated, empties dropped, order kept. */
export function normaliseTags(raw: readonly string[]): string[] {
  const out: string[] = []
  for (const value of raw) {
    const tag = normaliseTag(value)
    if (tag && !out.includes(tag)) out.push(tag)
  }
  return out
}

/** A tag as a request carries it: normalised on the way in, refused when empty. */
export const tagSchema = z
  .string()
  .max(200)
  .transform((value, ctx) => {
    const tag = normaliseTag(value)
    if (!tag) {
      ctx.addIssue({ code: 'custom', message: 'tag is empty' })
      return z.NEVER
    }
    return tag
  })

export type TagCount = { tag: string; count: number }
