import { z } from 'zod'

/**
 * What a person thought of something the AI wrote.
 *
 * Feedback is the only signal that says whether an answer was any good. The rating is the
 * cheap part: one click, and an agent in the middle of a shift will give it. The reason is
 * what makes it useful later, which is why it comes from a fixed list rather than free
 * text — five reasons rank on a dashboard and tell you what to fix next, while a thousand
 * sentences do not.
 */
export const feedbackRatingSchema = z.enum(['up', 'down'])
export type FeedbackRating = z.infer<typeof feedbackRatingSchema>

/** Only meaningful on a thumbs-down; an approving click has nothing to explain. */
export const feedbackReasonSchema = z.enum([
  /** The answer was simply not correct. */
  'wrong_answer',
  /** The model invented something the knowledge base never said. */
  'fabricated',
  /** The answer was not there to give: write it into the knowledge base. */
  'missing_knowledge',
  /** Right facts, wrong voice — or the wrong language entirely. */
  'wrong_tone_or_language',
  /** It should have stopped and fetched a person instead of answering. */
  'should_have_handed_off',
])
export type FeedbackReason = z.infer<typeof feedbackReasonSchema>

/**
 * What the feedback is about: a reply the AI already sent, or a draft it offered a human.
 * Both are AI output and both are worth rating, but only one of them reached a customer.
 */
export const feedbackTargetTypeSchema = z.enum(['message', 'suggestion'])
export type FeedbackTargetType = z.infer<typeof feedbackTargetTypeSchema>
