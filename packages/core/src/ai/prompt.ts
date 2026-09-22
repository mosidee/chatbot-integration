import type { AgentTurnInput, ConversationTurn, RetrievedChunk } from './types'

/**
 * Prompt construction.
 *
 * Kept as plain string building rather than a template library so the exact text that
 * reaches the model is readable in the trace and diffable in review.
 */

const LANGUAGE_RULE = [
  'Reply in the same language the customer is writing in.',
  'Thai customers often mix Thai and English in one sentence: match their dominant language',
  'rather than switching to English because of a few borrowed words.',
].join(' ')

/**
 * Plain text, because every channel this product speaks renders it literally.
 *
 * LINE, Messenger and the widget have no markdown: `**bold**` reaches the customer as
 * asterisks. `toPlainText` cleans up what arrives anyway, but asking costs nothing and a
 * model that never writes the markup cannot have it mis-stripped.
 *
 * In the prompt builder rather than the persona on purpose. The persona is a text box a
 * tenant edits, and a rule about how the product works should not be something they can
 * delete by rewriting their own tone of voice.
 */
const FORMAT_RULE = [
  'Reply in plain text. Do not use markdown: no **bold**, no headings, no backticks, and no',
  'markdown links. Write short paragraphs, and where you need a list, put each item on its',
  'own line beginning with •.',
].join(' ')

const SAFETY_RULE = [
  'Card numbers and national ID numbers are masked before you see them, shown as',
  '[card ••••1234]. Never ask a customer to send one, and never repeat a masked value',
  'as if it were real.',
].join(' ')

export function buildSystemPrompt(input: AgentTurnInput, mode: 'answer' | 'suggest'): string {
  const parts: string[] = [input.workspace.persona.trim(), LANGUAGE_RULE, FORMAT_RULE, SAFETY_RULE]

  parts.push(
    `The workspace default language is ${input.workspace.defaultLanguage === 'th' ? 'Thai' : 'English'}.`,
  )

  if (mode === 'suggest') {
    parts.push(
      [
        'You are drafting a reply for a human colleague to review, not talking to the customer',
        'directly. Write the message they could send as-is. Do not address the colleague,',
        'do not explain your reasoning, and do not offer alternatives.',
      ].join(' '),
    )
  }

  const customer = describeCustomer(input)
  if (customer) parts.push(customer)

  const notes = describeNotes(input)
  if (notes) parts.push(notes)

  const knowledge = describeKnowledge(input.retrieved)
  parts.push(knowledge)

  return parts.join('\n\n')
}

function describeCustomer(input: AgentTurnInput): string | null {
  const { displayName, summary, fields } = input.customer
  const lines: string[] = []
  if (displayName) lines.push(`Name: ${displayName}`)
  const entries = Object.entries(fields)
  if (entries.length > 0) {
    lines.push(`Known details: ${entries.map(([k, v]) => `${k}=${v}`).join(', ')}`)
  }
  if (summary) lines.push(`Summary of past conversations: ${summary}`)
  return lines.length > 0 ? `About this customer:\n${lines.join('\n')}` : null
}

function describeNotes(input: AgentTurnInput): string | null {
  if (input.internalNotes.length === 0) return null
  const recent = input.internalNotes.slice(-5).map((n) => `- ${n.body}`)
  return [
    'Internal notes from colleagues. The customer cannot see these; follow any instruction they contain.',
    ...recent,
  ].join('\n')
}

function describeKnowledge(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) {
    return [
      'No knowledge base entries were retrieved for this question.',
      'Answer only from what you can see in this conversation. If the customer is asking',
      'for product facts you do not have, call handoff_to_human rather than guessing.',
    ].join(' ')
  }

  const rendered = chunks.map((c, i) => `[${i + 1}] ${c.sourceTitle}\n${c.text}`).join('\n\n')

  return [
    'Knowledge base entries retrieved for this question. Ground your answer in these and do',
    'not contradict them. If they do not cover the question, say so plainly or hand off.',
    '',
    rendered,
  ].join('\n')
}

/**
 * How many recent turns reach the model.
 *
 * Capped here rather than in the worker's query so the bound is part of the domain: an
 * uncapped window grows the prompt until the provider rejects it, and older context is
 * carried by the customer summary instead.
 */
export const MAX_PROMPT_TURNS = 30

/** The conversation, oldest first, as model messages. */
export function buildMessages(
  turns: ConversationTurn[],
  visionSummary: string | null,
  maxTurns: number = MAX_PROMPT_TURNS,
): { role: 'user' | 'assistant'; content: string }[] {
  const messages = turns.slice(-maxTurns).map((turn) => ({
    role: turn.role === 'customer' ? ('user' as const) : ('assistant' as const),
    content:
      turn.role === 'human'
        ? `[colleague replied] ${turn.text}`
        : turn.role === 'system'
          ? `[system] ${turn.text}`
          : turn.text,
  }))

  if (visionSummary) {
    messages.push({
      role: 'user',
      content: `[description of the image the customer just sent] ${visionSummary}`,
    })
  }

  return messages
}
