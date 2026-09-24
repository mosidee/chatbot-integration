/**
 * How a stored file is handed back to a browser.
 *
 * Every stored file is served from the console's own origin: agent uploads, what customers
 * sent us on LINE and Messenger, knowledge documents. Their types are whatever the sender
 * claimed, so an HTML page or a script-bearing SVG served inline would run as the console,
 * with the signed-in agent's session, and could call the API as them.
 *
 * So the type decides only whether a file is shown or downloaded, and neither can run:
 * - Inline only for kinds a browser renders without a document of its own: raster images,
 *   audio and video. SVG is not one of them; it is a document that may carry script.
 * - PDF inline too, without the sandbox directive: Chrome refuses to show a sandboxed PDF,
 *   and its viewer runs in its own origin rather than ours. Customers open the files we
 *   send them in LINE's browser, where a forced download is a dead end.
 * - Everything else is an attachment, which a browser saves rather than renders.
 * - `nosniff` stops a browser second-guessing the type into something it will execute, and
 *   the CSP `sandbox` puts anything that is rendered anyway in an opaque origin with no
 *   script and no cookies.
 *
 * `Content-Disposition` carries no file name. The URL already ends in one, and a Thai name
 * in a header needs RFC 5987 encoding that a bare header write would get wrong.
 */

const INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
])

const SANDBOXED_CSP =
  "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox"

/** A type we are prepared to repeat in a header; anything else is served as bytes. */
function cleanMime(mime: string): string {
  const bare = (mime.split(';')[0] ?? '').trim().toLowerCase()
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(bare)
    ? bare
    : 'application/octet-stream'
}

export function mediaServingHeaders(mime: string): Record<string, string> {
  const type = cleanMime(mime)
  const isPdf = type === 'application/pdf'
  const inline =
    INLINE_TYPES.has(type) || type.startsWith('audio/') || type.startsWith('video/') || isPdf

  return {
    'content-type': type,
    'content-disposition': inline ? 'inline' : 'attachment',
    'x-content-type-options': 'nosniff',
    ...(isPdf ? {} : { 'content-security-policy': SANDBOXED_CSP }),
  }
}

/**
 * A file name reduced to something safe inside a storage key.
 *
 * The key is a path in the filesystem store and in the bucket, and the upload's name comes
 * from the request. Letters in any script, digits, dot, dash and underscore survive; a
 * slash, a backslash or a control character does not, so a name cannot climb out of the
 * workspace's prefix into another tenant's.
 */
export function safeKeySegment(name: string, maxLength = 120): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}._-]+/gu, '_')
    .replace(/^\.+/, '')
    .slice(0, maxLength)
  return cleaned || 'file'
}

/** The extension of an uploaded file name, or nothing when it has none worth keeping. */
export function safeExtension(name: string): string {
  const match = /\.([a-z0-9]{1,8})$/i.exec(name)
  return match?.[1] ? `.${match[1].toLowerCase()}` : ''
}
