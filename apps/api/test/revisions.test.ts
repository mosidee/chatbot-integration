import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { loadEnv } from '@ci/config'
import { createApp } from '../src/app'
import { createApiContext } from '../src/context'
import { type ApiFixture, createApiFixture } from './helpers/session'

/**
 * Two people editing one thing.
 *
 * Saves are merged under a lock, so neither loses a field the other did not touch. What the
 * lock cannot stop is somebody overwriting a value they never saw, from a page loaded before
 * a colleague changed it. The caller says which version it started from, and a save made
 * from an older one is refused.
 */

const env = { ...loadEnv(), TOOL_EGRESS_ALLOW_PRIVATE: false }
const ctx = createApiContext(env)
const app = createApp(ctx)

let fixture: ApiFixture

beforeAll(async () => {
  fixture = await createApiFixture(ctx, app)
})

afterAll(async () => {
  await fixture.cleanup()
  await ctx.runtime.close()
})

const json = (body: unknown): RequestInit => ({
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('workspace settings', () => {
  test('a save made from an older version is refused, and one from the current is taken', async () => {
    const loaded = await (await fixture.as(fixture.admin, '/api/v1/settings/workspace')).json()
    expect(typeof loaded.revision).toBe('string')

    // A colleague saves first, from the same version.
    const first = await fixture.as(
      fixture.admin,
      '/api/v1/settings/workspace',
      json({ persona: 'written at noon', revision: loaded.revision }),
    )
    expect(first.status).toBe(200)
    const saved = await first.json()
    expect(saved.revision).not.toBe(loaded.revision)

    // The morning page tries to put its own text back.
    const stale = await fixture.as(
      fixture.admin,
      '/api/v1/settings/workspace',
      json({ persona: 'written in the morning', revision: loaded.revision }),
    )
    expect(stale.status).toBe(409)
    expect((await stale.json()).code).toBe('settings_conflict')

    const after = await (await fixture.as(fixture.admin, '/api/v1/settings/workspace')).json()
    expect(after.settings.persona).toBe('written at noon')
    expect(after.revision).toBe(saved.revision)

    // Saving on from the version the save returned goes through: one person's saves in a row.
    const next = await fixture.as(
      fixture.admin,
      '/api/v1/settings/workspace',
      json({ defaultLanguage: 'en', revision: saved.revision }),
    )
    expect(next.status).toBe(200)
  })

  /**
   * What the console sends. A whole-document revision refused a save whenever anything had
   * changed — a colleague on another card, a platform admin suspending and restoring the
   * tenant. Now only the settings being changed are compared.
   */
  test('a colleague changing another setting does not block a save; the same setting does', async () => {
    const page = (await (await fixture.as(fixture.admin, '/api/v1/settings/workspace')).json()) as {
      settings: { persona: string; defaultLanguage: string }
    }

    // A colleague rewrites the persona.
    expect(
      (
        await fixture.as(
          fixture.admin,
          '/api/v1/settings/workspace',
          json({ persona: `colleague ${Math.random()}` }),
        )
      ).status,
    ).toBe(200)

    // The page changes the language, from what it showed: nothing to do with the persona.
    const other = await fixture.as(
      fixture.admin,
      '/api/v1/settings/workspace',
      json({
        defaultLanguage: page.settings.defaultLanguage === 'th' ? 'en' : 'th',
        expected: { defaultLanguage: page.settings.defaultLanguage },
      }),
    )
    expect(other.status).toBe(200)

    // The page changes the persona too, from the text it still shows: refused, and named.
    const same = await fixture.as(
      fixture.admin,
      '/api/v1/settings/workspace',
      json({ persona: 'from the morning', expected: { persona: page.settings.persona } }),
    )
    expect(same.status).toBe(409)
    expect((await same.json()).fields).toEqual(['persona'])
  })

  test('a nested setting compares by value, whatever order its keys come back in', async () => {
    const page = (await (await fixture.as(fixture.admin, '/api/v1/settings/workspace')).json()) as {
      settings: { redaction: { cardNumbers: boolean; thaiNationalId: boolean } }
    }
    const reordered = {
      thaiNationalId: page.settings.redaction.thaiNationalId,
      cardNumbers: page.settings.redaction.cardNumbers,
    }
    const response = await fixture.as(
      fixture.admin,
      '/api/v1/settings/workspace',
      json({ redaction: page.settings.redaction, expected: { redaction: reordered } }),
    )
    expect(response.status).toBe(200)
  })

  test('a save without a revision still overwrites, for scripts that mean to', async () => {
    const response = await fixture.as(
      fixture.admin,
      '/api/v1/settings/workspace',
      json({ persona: 'from a script' }),
    )
    expect(response.status).toBe(200)
  })
})

describe('knowledge entries', () => {
  test('an edit from an entry that has since changed is refused', async () => {
    const created = await fixture.as(fixture.agent, '/api/v1/knowledge/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Trial',
        language: 'en',
        question: 'Is there a trial?',
        body: 'Fourteen days.',
      }),
    })
    expect(created.status).toBe(200)
    const { sourceId } = await created.json()

    const { entries } = await (
      await fixture.as(fixture.agent, `/api/v1/knowledge/sources/${sourceId}/entries`)
    ).json()
    const entry = entries[0]
    expect(entry).toBeDefined()

    const first = await fixture.as(
      fixture.agent,
      `/api/v1/knowledge/entries/${entry.id}`,
      json({ body: 'Thirty days.', revision: entry.updatedAt }),
    )
    expect(first.status).toBe(200)
    const { revision } = await first.json()

    const stale = await fixture.as(
      fixture.agent,
      `/api/v1/knowledge/entries/${entry.id}`,
      json({ body: 'Seven days.', revision: entry.updatedAt }),
    )
    expect(stale.status).toBe(409)
    expect((await stale.json()).code).toBe('entry_conflict')

    const onward = await fixture.as(
      fixture.agent,
      `/api/v1/knowledge/entries/${entry.id}`,
      json({ enabled: false, revision }),
    )
    expect(onward.status).toBe(200)

    const missing = await fixture.as(
      fixture.agent,
      '/api/v1/knowledge/entries/not-an-entry',
      json({ body: 'x' }),
    )
    expect(missing.status).toBe(404)
  })
})
