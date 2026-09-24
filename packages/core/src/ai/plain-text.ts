/**
 * Turning a model's markdown into what a customer will actually read.
 *
 * LINE, Messenger and the widget all render plain text. A model that writes `**Growth
 * ฿299/เดือน**` therefore sends the asterisks, and the customer reads them — seen in
 * production on the pilot tenant, where a pricing answer arrived as a wall of `**` and
 * `###`. The console showed the same characters, so nobody reading the inbox could tell
 * whether the customer had seen something worse.
 *
 * The prompt asks for plain text, and this catches what comes back anyway. Both, because a
 * tenant can rewrite the persona and a model can ignore an instruction, and neither should
 * put punctuation in front of a customer.
 *
 * Deliberately not a markdown parser. It is a handful of substitutions over the constructs
 * chat models actually emit, and anything it does not recognise is left alone: text that
 * reaches a customer unchanged is a far better failure than text a parser has rearranged.
 */

/** A bullet becomes one, rather than disappearing: the list was the point. */
const BULLET = '• '

export function toPlainText(text: string): string {
  if (!text) return text

  const lines = text.split('\n').map((line) => convertLine(line))

  return (
    lines
      .join('\n')
      // Fenced code markers have nothing to mark in a chat bubble.
      .replace(/^ *```[^\n]*$/gm, '')
      // Three or more blank lines are what removing those markers tends to leave behind.
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

function convertLine(line: string): string {
  let out = line

  // A heading is a line of emphasis, so it keeps its words and loses its hashes.
  out = out.replace(/^ {0,3}#{1,6} +/, '')

  // `- item`, `* item`, `+ item`. The indent is kept, so a nested list stays nested.
  out = out.replace(/^(\s*)[-*+] +/, `$1${BULLET}`)

  // A horizontal rule is a row of punctuation with nothing to separate in a bubble.
  if (/^ {0,3}([-*_])( *\1){2,} *$/.test(out)) return ''

  // `> quoted`, which a model uses to quote the customer back at themselves.
  out = out.replace(/^ {0,3}> ?/, '')

  return convertInline(out)
}

function convertInline(line: string): string {
  return (
    line
      // An image is a link to something the bubble will not show. Before the link rule,
      // which would otherwise match inside it and leave a stray `!` in front.
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt: string, href: string) =>
        alt ? `${alt}: ${href}` : href,
      )
      // A link becomes its text and its address, because the address is the useful half and
      // a bubble cannot make the text clickable.
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, href: string) =>
        label.trim() === href.trim() ? href : `${label} (${href})`,
      )
      // Bold and italic, longest marker first so `***both***` does not leave a stray star.
      .replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '$1')
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1')
      .replace(/__(?=\S)([\s\S]*?\S)__/g, '$1')
      /**
       * Single markers are the risky ones. `*` and `_` are ordinary characters in a
       * filename, a product code or a search query, so they are only removed when they
       * wrap a short run with no space against the marker, which is what emphasis looks
       * like and what `snake_case_name` does not.
       */
      .replace(/(^|[\s(])\*(?=\S)([^*\n]{1,120}?\S)\*(?=[\s).,!?:;]|$)/g, '$1$2')
      .replace(/(^|[\s(])_(?=\S)([^_\n]{1,120}?\S)_(?=[\s).,!?:;]|$)/g, '$1$2')
      // Inline code: the backticks say "this is literal", which the bubble cannot show.
      .replace(/`([^`\n]+)`/g, '$1')
      // What a model writes when it has already been told not to use markdown and reaches
      // for emphasis anyway.
      .replace(/(^|\s)\*\*(\s|$)/g, '$1$2')
  )
}
