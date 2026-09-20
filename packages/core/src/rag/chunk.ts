/**
 * Splitting text for retrieval.
 *
 * Sizes are counted in characters rather than tokens. Thai writes without spaces between
 * words, so a token count would be a guess anyway, and characters are what a human editing
 * a knowledge entry can see and reason about.
 *
 * Breaks prefer a paragraph boundary, then a sentence boundary, then a space, and only
 * split mid-word when a single run exceeds the limit. That last case is normal for Thai.
 */

export type ChunkOptions = {
  /** Target characters per chunk. */
  size: number
  /** Characters repeated from the end of the previous chunk, so an answer split across a
   *  boundary is still retrievable from either side. */
  overlap: number
  /** Chunks shorter than this are folded into the previous one rather than kept alone. */
  minSize: number
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  size: 900,
  overlap: 120,
  minSize: 80,
}

/** Thai and Latin sentence enders, plus newlines. */
const SENTENCE_BREAKS = ['\n\n', '\n', '. ', '! ', '? ', '。', '॥', ' ๆ ', ' ']

export function chunkText(input: string, options: Partial<ChunkOptions> = {}): string[] {
  const { size, overlap, minSize } = { ...DEFAULT_CHUNK_OPTIONS, ...options }
  const text = input.replace(/\r\n/g, '\n').trim()
  if (text.length === 0) return []
  if (text.length <= size) return [text]

  const chunks: string[] = []
  let start = 0

  while (start < text.length) {
    const end = Math.min(start + size, text.length)

    // Last chunk: take the remainder rather than searching for a break.
    if (end === text.length) {
      chunks.push(text.slice(start).trim())
      break
    }

    const window = text.slice(start, end)
    const breakAt = findBreak(window, size)
    const piece = text.slice(start, start + breakAt).trim()
    if (piece.length > 0) chunks.push(piece)

    // Step forward, minus the overlap, but always make progress.
    const next = start + Math.max(breakAt - overlap, 1)
    start = next <= start ? start + size : next
  }

  return foldShortTail(chunks, minSize)
}

function findBreak(window: string, size: number): number {
  for (const separator of SENTENCE_BREAKS) {
    const index = window.lastIndexOf(separator)
    // Ignore a break so early that the chunk would be mostly empty.
    if (index > size * 0.4) return index + separator.length
  }
  return window.length
}

/** A trailing fragment carries no meaning on its own; attach it to the chunk before it. */
function foldShortTail(chunks: string[], minSize: number): string[] {
  if (chunks.length < 2) return chunks
  const last = chunks[chunks.length - 1]
  const previous = chunks[chunks.length - 2]
  if (last && previous && last.length < minSize) {
    return [...chunks.slice(0, -2), `${previous}\n${last}`.trim()]
  }
  return chunks
}

/**
 * A Q&A entry is chunked as a unit where possible: splitting a question from its answer
 * makes both halves worse to retrieve.
 */
export function chunkQa(
  question: string | null,
  body: string,
  options?: Partial<ChunkOptions>,
): string[] {
  const combined = question ? `${question.trim()}\n${body.trim()}` : body.trim()
  const chunks = chunkText(combined, options)
  if (!question || chunks.length <= 1) return chunks
  // When it had to be split, repeat the question on each piece so every chunk stays answerable.
  return chunks.map((chunk, i) => (i === 0 ? chunk : `${question.trim()}\n${chunk}`))
}
