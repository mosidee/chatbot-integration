/**
 * Split outbound text to fit a platform's per-message limit.
 *
 * Breaks on paragraph, then sentence, then word boundaries, and only splits mid-word when
 * a single word exceeds the limit. Thai has no spaces between words, so a long Thai
 * sentence legitimately hits the hard-split path; the limit is in characters, which is
 * what the platforms actually count.
 */
export function splitText(text: string, maxLength: number): string[] {
  const trimmed = text.trim()
  if (trimmed.length === 0) return []
  if (trimmed.length <= maxLength) return [trimmed]

  const chunks: string[] = []
  let remaining = trimmed

  while (remaining.length > maxLength) {
    const window = remaining.slice(0, maxLength)
    const breakAt = findBreakPoint(window, maxLength)
    chunks.push(remaining.slice(0, breakAt).trim())
    remaining = remaining.slice(breakAt).trim()
  }

  if (remaining.length > 0) chunks.push(remaining)
  return chunks.filter((c) => c.length > 0)
}

function findBreakPoint(window: string, maxLength: number): number {
  for (const separator of ['\n\n', '\n', '. ', '! ', '? ', ' ']) {
    const index = window.lastIndexOf(separator)
    // Ignore break points so early that the chunk would be mostly empty.
    if (index > maxLength * 0.5) return index + separator.length
  }
  return maxLength
}
