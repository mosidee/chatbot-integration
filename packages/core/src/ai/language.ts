import type { Language } from '@ci/shared'

/**
 * Which language a customer is writing in, judged by script alone.
 *
 * This exists for the messages the product writes itself — the holding message a customer
 * reads when the AI stops answering — not for the model's replies, which follow the
 * customer's language because the prompt tells them to. A person who has been typing Thai
 * should not be told in English that a colleague is coming.
 *
 * Script, not vocabulary: Thai has its own block, so one Thai character is proof, while
 * "ok" and a product name are not proof of English. Returning null rather than guessing
 * leaves the decision to the customer's recorded language and then the workspace default,
 * both of which are better evidence than a coin toss.
 */
export function detectLanguage(text: string | null | undefined): Language | null {
  if (!text) return null

  // The Thai block, which no other language in this product's reach shares.
  if (/[฀-๿]/.test(text)) return 'th'

  // Latin letters are weaker evidence: a Thai speaker writes "ok" and types a product name
  // in Latin script constantly. Ask for a run of them, which a stray token will not reach.
  if (/[A-Za-z]{4,}/.test(text)) return 'en'

  return null
}
