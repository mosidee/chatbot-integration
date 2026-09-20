/**
 * Taking a model's thinking out of its answer.
 *
 * A reasoning model is supposed to report its thinking in a separate field. Several
 * gateways instead leave it inside the message content, wrapped in a tag, and what reaches
 * the customer begins with `<think>…</think>`. Seen in production on Claude through a
 * self-hosted gateway, where the block was even empty: `<think></think>สวัสดีค่ะ`.
 *
 * Stripping it here rather than in the console means it never reaches the database, the
 * customer, or the next turn's prompt, which are three different places it would otherwise
 * have to be handled.
 */

const TAGS = ['think', 'thinking', 'reasoning', 'thought'] as const

const CLOSED = new RegExp(`<(${TAGS.join('|')})\\b[^>]*>[\\s\\S]*?</\\1\\s*>`, 'gi')
const UNCLOSED = new RegExp(`<(${TAGS.join('|')})\\b[^>]*>[\\s\\S]*$`, 'i')

export function stripReasoning(text: string): string {
  const withoutBlocks = text.replace(CLOSED, '')

  /**
   * An opener with no closer means the answer was cut off mid-thought, so everything after
   * it is thinking and none of it is an answer. Dropping it can leave nothing at all, which
   * is the honest outcome: the turn then hands off rather than sending half a thought.
   */
  const withoutTail = withoutBlocks.replace(UNCLOSED, '')

  return withoutTail.trim()
}
