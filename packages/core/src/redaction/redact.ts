import type { NormalizedMessage } from '@ci/shared'

/**
 * Redaction of sensitive identifiers before anything is persisted or sent to a model.
 *
 * Scope is deliberately narrow: payment card numbers and Thai national ID numbers.
 * Phone numbers and order IDs are NOT redacted — they are business identifiers the
 * product extracts on purpose to link customers across channels.
 *
 * Both detectors validate a checksum before masking, so ordinary long numbers
 * (order references, booking codes) survive untouched.
 */

export type RedactionType = 'card_number' | 'thai_national_id'

export type RedactionFinding = { type: RedactionType; count: number }

export type RedactionResult = {
  text: string
  findings: RedactionFinding[]
}

export type RedactionOptions = {
  cardNumbers: boolean
  thaiNationalId: boolean
}

export const DEFAULT_REDACTION: RedactionOptions = {
  cardNumbers: true,
  thaiNationalId: true,
}

/** Runs of 13–19 digits, optionally broken by single spaces or dashes. */
const DIGIT_RUN = /(?<![\d])(\d[\d\s-]{11,23}\d)(?![\d])/g

function digitsOf(raw: string): string {
  return raw.replace(/[^\d]/g, '')
}

/**
 * Issuer prefixes for the card networks a Thai business actually sees.
 *
 * Luhn alone is not enough. Roughly one in ten random digit strings passes it, so a bare
 * timestamp or a long order reference would be masked as a card. Since the product
 * deliberately preserves order references, a candidate must also begin like a real card.
 */
const CARD_PREFIXES: { test: (digits: string) => boolean; lengths: number[] }[] = [
  // Visa
  { test: (d) => d.startsWith('4'), lengths: [13, 16, 19] },
  // Mastercard
  {
    test: (d) => {
      const two = Number(d.slice(0, 2))
      const four = Number(d.slice(0, 4))
      return (two >= 51 && two <= 55) || (four >= 2221 && four <= 2720)
    },
    lengths: [16],
  },
  // American Express
  { test: (d) => d.startsWith('34') || d.startsWith('37'), lengths: [15] },
  // JCB, common in Thailand
  {
    test: (d) => {
      const four = Number(d.slice(0, 4))
      return four >= 3528 && four <= 3589
    },
    lengths: [16, 17, 18, 19],
  },
  // UnionPay
  { test: (d) => d.startsWith('62'), lengths: [16, 17, 18, 19] },
  // Discover
  {
    test: (d) => {
      const three = Number(d.slice(0, 3))
      return d.startsWith('6011') || d.startsWith('65') || (three >= 644 && three <= 649)
    },
    lengths: [16, 19],
  },
  // Diners Club
  {
    test: (d) => {
      const three = Number(d.slice(0, 3))
      return (three >= 300 && three <= 305) || d.startsWith('36') || d.startsWith('38')
    },
    lengths: [14, 16, 19],
  },
]

/** Does this look like a card number from a real network, at a length that network issues? */
export function looksLikeCardNumber(digits: string): boolean {
  return CARD_PREFIXES.some(
    (network) => network.test(digits) && network.lengths.includes(digits.length),
  )
}

/** Luhn check, used for payment card numbers. */
export function isLuhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const code = digits.charCodeAt(i) - 48
    if (code < 0 || code > 9) return false
    let value = code
    if (double) {
      value *= 2
      if (value > 9) value -= 9
    }
    sum += value
    double = !double
  }
  return sum % 10 === 0
}

/**
 * Thai national ID checksum.
 * The first 12 digits are weighted 13..2; the check digit is (11 - sum % 11) % 10.
 */
export function isThaiNationalId(digits: string): boolean {
  if (digits.length !== 13) return false
  let sum = 0
  for (let i = 0; i < 12; i += 1) {
    const code = digits.charCodeAt(i) - 48
    if (code < 0 || code > 9) return false
    sum += code * (13 - i)
  }
  const expected = (11 - (sum % 11)) % 10
  return expected === digits.charCodeAt(12) - 48
}

function mask(label: string, digits: string): string {
  return `[${label} ••••${digits.slice(-4)}]`
}

/**
 * Mask sensitive numbers in free text.
 * Thai ID is tested first: it is exactly 13 digits and a valid ID can coincidentally
 * satisfy Luhn, so checking it first keeps the label accurate.
 */
export function redactText(
  input: string,
  options: RedactionOptions = DEFAULT_REDACTION,
): RedactionResult {
  const counts = new Map<RedactionType, number>()

  const text = input.replace(DIGIT_RUN, (match) => {
    const digits = digitsOf(match)

    if (options.thaiNationalId && isThaiNationalId(digits)) {
      counts.set('thai_national_id', (counts.get('thai_national_id') ?? 0) + 1)
      return mask('thai id', digits)
    }

    if (options.cardNumbers && looksLikeCardNumber(digits) && isLuhnValid(digits)) {
      counts.set('card_number', (counts.get('card_number') ?? 0) + 1)
      return mask('card', digits)
    }

    return match
  })

  const findings: RedactionFinding[] = [...counts.entries()].map(([type, count]) => ({
    type,
    count,
  }))

  return { text, findings }
}

/** Apply redaction to every text-bearing field of a normalised message. */
export function redactMessage(
  message: NormalizedMessage,
  options: RedactionOptions = DEFAULT_REDACTION,
): { message: NormalizedMessage; findings: RedactionFinding[] } {
  const merged = new Map<RedactionType, number>()
  const collect = (findings: RedactionFinding[]) => {
    for (const f of findings) merged.set(f.type, (merged.get(f.type) ?? 0) + f.count)
  }

  const redactField = (value: string): string => {
    const result = redactText(value, options)
    collect(result.findings)
    return result.text
  }

  let next: NormalizedMessage = message

  switch (message.kind) {
    case 'text':
      next = { ...message, text: redactField(message.text) }
      break
    case 'image':
    case 'file':
    case 'audio':
    case 'video':
      next = {
        ...message,
        text: message.text === null ? null : redactField(message.text),
        attachments: message.attachments.map((a) => ({
          ...a,
          fileName: a.fileName === null ? null : redactField(a.fileName),
        })),
      }
      break
    case 'quick_replies':
      next = { ...message, text: redactField(message.text) }
      break
    case 'template':
      next = { ...message, altText: redactField(message.altText) }
      break
    case 'location':
      next = {
        ...message,
        address: message.address === null ? null : redactField(message.address),
      }
      break
    case 'sticker':
    case 'event':
      break
  }

  const findings: RedactionFinding[] = [...merged.entries()].map(([type, count]) => ({
    type,
    count,
  }))

  return { message: next, findings }
}
