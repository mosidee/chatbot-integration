import { describe, expect, test } from 'bun:test'
import {
  contentMatchesType,
  isWorkspaceKey,
  mediaServingHeaders,
  safeExtension,
  safeKeySegment,
} from '../src/media-serving'

/**
 * Recommendation #3: a stored file is served on the console's origin, so nothing a sender
 * uploads may run there. The type decides only whether it is shown or downloaded.
 */
describe('mediaServingHeaders', () => {
  for (const mime of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml']) {
    test(`${mime} downloads, sandboxed and unsniffed`, () => {
      const headers = mediaServingHeaders(mime)
      expect(headers['content-disposition']).toBe('attachment')
      expect(headers['x-content-type-options']).toBe('nosniff')
      expect(headers['content-security-policy']).toContain('sandbox')
      expect(headers['content-security-policy']).toContain("default-src 'none'")
    })
  }

  for (const mime of ['image/png', 'image/jpeg', 'audio/mpeg', 'video/mp4']) {
    test(`${mime} is shown inline, still sandboxed`, () => {
      const headers = mediaServingHeaders(mime)
      expect(headers['content-disposition']).toBe('inline')
      expect(headers['content-security-policy']).toContain('sandbox')
    })
  }

  test('a PDF is shown inline without the sandbox Chrome refuses to render under', () => {
    const headers = mediaServingHeaders('application/pdf')
    expect(headers['content-disposition']).toBe('inline')
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['content-security-policy']).toBeUndefined()
  })

  test('a type that cannot be repeated safely becomes bytes', () => {
    expect(mediaServingHeaders('text/html\r\nset-cookie: x')['content-type']).toBe(
      'application/octet-stream',
    )
    expect(mediaServingHeaders('')['content-disposition']).toBe('attachment')
  })

  test('parameters are dropped and case is folded', () => {
    expect(mediaServingHeaders('IMAGE/PNG; charset=binary')['content-type']).toBe('image/png')
  })
})

describe('storage key segments', () => {
  test('a name cannot add path segments', () => {
    expect(safeKeySegment('../../other-workspace/x.pdf')).not.toContain('/')
    expect(safeKeySegment('a\\b.pdf')).not.toContain('\\')
    expect(safeKeySegment('...hidden')).toBe('hidden')
  })

  test('Thai names survive', () => {
    expect(safeKeySegment('ราคา บริการ.pdf')).toBe('ราคา_บริการ.pdf')
  })

  test('only a short alphanumeric extension is kept', () => {
    expect(safeExtension('photo.JPG')).toBe('.jpg')
    expect(safeExtension('x./../../evil')).toBe('')
    expect(safeExtension('noext')).toBe('')
  })
})

describe('isWorkspaceKey', () => {
  test('accepts the canonical spelling of our own key', () => {
    expect(isWorkspaceKey('ws1', 'ws1/abc.png')).toBe(true)
    expect(isWorkspaceKey('ws1', 'ws1/knowledge/id-ราคา.pdf')).toBe(true)
  })

  test('refuses anything that is, or could become, another path', () => {
    for (const key of [
      'ws2/x',
      'ws1/../ws2/x',
      'ws1/./x',
      'ws1//x',
      'ws1/x\\..',
      'ws1',
      'ws10/x',
    ]) {
      expect(isWorkspaceKey('ws1', key)).toBe(false)
    }
    expect(isWorkspaceKey('', '/x')).toBe(false)
  })
})

describe('contentMatchesType', () => {
  test('agrees with real signatures and refuses a disguise', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])
    expect(contentMatchesType('image/png', png)).toBe(true)
    expect(contentMatchesType('image/jpeg', png)).toBe(false)
    expect(contentMatchesType('application/pdf', new TextEncoder().encode('%PDF-1.7'))).toBe(true)
    expect(contentMatchesType('image/png', new TextEncoder().encode('<svg>'))).toBe(false)
  })

  test('leaves types it does not know to the serving policy', () => {
    expect(contentMatchesType('text/plain', new TextEncoder().encode('anything'))).toBe(true)
  })
})
