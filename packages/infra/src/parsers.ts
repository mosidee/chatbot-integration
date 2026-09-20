/**
 * Turning an uploaded file into text.
 *
 * Each format sits behind one interface so a better parser, or an OCR service, can replace
 * any of them without touching ingestion. Thai PDFs are the known weak point: many are
 * scans, and many that are not still extract as mojibake. A parser that produces nothing
 * usable says so, because "the upload failed for this reason" is a far better outcome than
 * a knowledge base quietly full of noise.
 */

export type ParsedDocument = {
  text: string
  pages: number | null
  warnings: string[]
}

export type DocumentParser = {
  name: string
  supports: (mime: string, fileName: string) => boolean
  parse: (bytes: Uint8Array, fileName: string) => Promise<ParsedDocument>
}

export class UnsupportedDocumentError extends Error {
  constructor(mime: string, fileName: string) {
    super(`No parser handles ${mime || 'unknown type'} (${fileName})`)
    this.name = 'UnsupportedDocumentError'
  }
}

export class UnreadableDocumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnreadableDocumentError'
  }
}

const extensionOf = (fileName: string): string =>
  fileName.includes('.') ? (fileName.split('.').pop() ?? '').toLowerCase() : ''

/**
 * Does the extracted text look like language, or like a failed extraction?
 *
 * Counts characters that belong to a writing system. A scanned PDF yields almost nothing;
 * a mis-decoded one yields mostly replacement characters and control codes.
 */
export function looksReadable(text: string): { ok: boolean; reason?: string } {
  const trimmed = text.trim()
  if (trimmed.length < 20) {
    return {
      ok: false,
      reason:
        'Almost no text could be extracted. The file is probably a scan, which needs OCR rather than text extraction.',
    }
  }

  const meaningful = trimmed.match(/[\p{L}\p{N}]/gu)?.length ?? 0
  const ratio = meaningful / trimmed.length
  if (ratio < 0.4) {
    return {
      ok: false,
      reason: `Only ${Math.round(ratio * 100)}% of the extracted characters are letters or digits, so the text is likely mis-decoded.`,
    }
  }

  const replacements = (trimmed.match(/�/g)?.length ?? 0) / trimmed.length
  if (replacements > 0.02) {
    return {
      ok: false,
      reason:
        'The extracted text is full of replacement characters, so its encoding was not understood.',
    }
  }

  return { ok: true }
}

const pdfParser: DocumentParser = {
  name: 'pdf',
  supports: (mime, fileName) => mime === 'application/pdf' || extensionOf(fileName) === 'pdf',
  parse: async (bytes) => {
    const { extractText, getDocumentProxy } = await import('unpdf')
    const document = await getDocumentProxy(bytes)
    const { text, totalPages } = await extractText(document, { mergePages: true })
    const merged = Array.isArray(text) ? text.join('\n\n') : String(text)
    return { text: merged, pages: totalPages ?? null, warnings: [] }
  },
}

const docxParser: DocumentParser = {
  name: 'docx',
  supports: (mime, fileName) =>
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    extensionOf(fileName) === 'docx',
  parse: async (bytes) => {
    const mammoth = await import('mammoth')
    const result = await mammoth.extractRawText({
      buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    })
    return {
      text: result.value,
      pages: null,
      warnings: result.messages.map((m) => m.message),
    }
  },
}

const xlsxParser: DocumentParser = {
  name: 'xlsx',
  supports: (mime, fileName) =>
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    extensionOf(fileName) === 'xlsx',
  parse: async (bytes) => {
    const ExcelJS = await import('exceljs')
    const workbook = new ExcelJS.default.Workbook()
    await workbook.xlsx.load(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    )

    const parts: string[] = []
    workbook.eachSheet((sheet) => {
      parts.push(`# ${sheet.name}`)
      sheet.eachRow((row) => {
        // A row reads as a line of tab-separated cells, which keeps columns adjacent in the
        // chunk so a lookup table stays interpretable.
        const cells: string[] = []
        row.eachCell({ includeEmpty: false }, (cell) => {
          const value = cell.value
          cells.push(value === null || value === undefined ? '' : String(cell.text ?? value))
        })
        if (cells.length > 0) parts.push(cells.join('\t'))
      })
    })

    return { text: parts.join('\n'), pages: null, warnings: [] }
  },
}

const csvParser: DocumentParser = {
  name: 'csv',
  supports: (mime, fileName) =>
    mime === 'text/csv' || ['csv', 'tsv'].includes(extensionOf(fileName)),
  parse: async (bytes, fileName) => {
    const Papa = await import('papaparse')
    const text = new TextDecoder().decode(bytes)
    const delimiter = extensionOf(fileName) === 'tsv' ? '\t' : ''
    const result = Papa.default.parse<string[]>(text, {
      skipEmptyLines: true,
      ...(delimiter ? { delimiter } : {}),
    })
    const lines = result.data.map((row) => row.join('\t'))
    return {
      text: lines.join('\n'),
      pages: null,
      warnings: result.errors.slice(0, 5).map((e) => e.message),
    }
  },
}

const textParser: DocumentParser = {
  name: 'text',
  supports: (mime, fileName) =>
    mime.startsWith('text/') || ['txt', 'md', 'markdown'].includes(extensionOf(fileName)),
  parse: async (bytes) => ({
    text: new TextDecoder().decode(bytes),
    pages: null,
    warnings: [],
  }),
}

// Order matters: the text parser matches broadly and must come last.
export const PARSERS: DocumentParser[] = [pdfParser, docxParser, xlsxParser, csvParser, textParser]

export function findParser(mime: string, fileName: string): DocumentParser | null {
  return PARSERS.find((p) => p.supports(mime, fileName)) ?? null
}

/** Parse a file, rejecting output that is not usable as knowledge. */
export async function parseDocument(
  bytes: Uint8Array,
  mime: string,
  fileName: string,
): Promise<ParsedDocument> {
  const parser = findParser(mime, fileName)
  if (!parser) throw new UnsupportedDocumentError(mime, fileName)

  let parsed: ParsedDocument
  try {
    parsed = await parser.parse(bytes, fileName)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new UnreadableDocumentError(
      `The ${parser.name} parser could not read this file: ${message}`,
    )
  }

  const readable = looksReadable(parsed.text)
  if (!readable.ok) throw new UnreadableDocumentError(readable.reason ?? 'The text is unusable.')

  return parsed
}
