import { describe, expect, test } from 'bun:test'
import { isReservedSlug, RESERVED_SLUGS, slugify, workspaceSlugSchema } from '../src/workspace'

/**
 * The slug is the one tenant field that has to survive being typed into an address bar, an
 * invoice and a conversation, so its rules are worth pinning down.
 */

describe('slugify', () => {
  test('produces something the schema accepts', () => {
    for (const name of ['Bangkok Clinic', 'ACME  Co.', 'salon—saas', '  spaced  out  ']) {
      const slug = slugify(name)
      expect(workspaceSlugSchema.safeParse(slug).success).toBe(true)
    }
  })

  test('strips the punctuation that would otherwise end up in a URL', () => {
    expect(slugify('Bangkok Clinic')).toBe('bangkok-clinic')
    expect(slugify('ACME Co.')).toBe('acme-co')
  })
})

describe('the slug rules', () => {
  test('accept what a tenant would reasonably choose', () => {
    for (const slug of ['a', 'salon-saas', 'clinic2', 'a1-b2-c3']) {
      expect(workspaceSlugSchema.safeParse(slug).success).toBe(true)
    }
  })

  test('refuse shapes that break a URL or read badly', () => {
    for (const slug of ['', '-leading', 'trailing-', 'Upper', 'has space', 'has_underscore']) {
      expect(workspaceSlugSchema.safeParse(slug).success).toBe(false)
    }
  })

  test('refuse anything longer than forty characters', () => {
    expect(workspaceSlugSchema.safeParse('a'.repeat(40)).success).toBe(true)
    expect(workspaceSlugSchema.safeParse('a'.repeat(41)).success).toBe(false)
  })

  /**
   * The console's own paths win over the slug parameter, so a tenant named after one would
   * be permanently unreachable by URL while looking ordinary everywhere else. Creation is
   * the only moment anybody can still pick a different name.
   */
  test('refuse every path the console already owns', () => {
    for (const slug of RESERVED_SLUGS) {
      expect(isReservedSlug(slug)).toBe(true)
      const parsed = workspaceSlugSchema.safeParse(slug)
      expect(parsed.success).toBe(false)
    }
  })

  test('do not refuse a name that merely contains a reserved word', () => {
    expect(workspaceSlugSchema.safeParse('settings-co').success).toBe(true)
    expect(isReservedSlug('settings-co')).toBe(false)
  })
})
