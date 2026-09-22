import type { WorkspaceStatus } from '@ci/shared'
import { eq } from 'drizzle-orm'
import type { Database } from './client'
import { newId } from './id'
import * as schema from './schema'
import type { WorkspaceSettings } from './schema/app'

/**
 * Making a tenant.
 *
 * Here rather than in `packages/infra` because the seed needs it and the seed cannot reach
 * infra: it runs against a bare connection before any runtime exists. The platform routes
 * call the same function, so a tenant created from the console and a tenant created by the
 * seed are the same thing, with the same channels and the same defaults.
 */

/**
 * What a new workspace starts with.
 *
 * This used to exist three times — in the seed and in two test fixtures — and the copies
 * disagreed about business hours and the waiting-human fallback, so a test could pass
 * against defaults no real workspace ever had. One definition, overridable per caller.
 */
export function defaultWorkspaceSettings(
  overrides: Partial<WorkspaceSettings> = {},
): WorkspaceSettings {
  return {
    defaultLanguage: 'th',
    defaultMode: 'ai',
    persona: [
      'You are a helpful customer support assistant for salon-saas, a SaaS platform that salon',
      'owners use to run their business. You answer questions from salon owners and prospects',
      'about pricing, onboarding, features, billing and troubleshooting.',
      'Be concise, warm and practical. Never invent product facts: if you are unsure or the',
      'question needs account-specific action, hand off to a human.',
    ].join(' '),
    businessHours: {
      timezone: 'Asia/Bangkok',
      days: {
        '1': { open: '09:00', close: '18:00' },
        '2': { open: '09:00', close: '18:00' },
        '3': { open: '09:00', close: '18:00' },
        '4': { open: '09:00', close: '18:00' },
        '5': { open: '09:00', close: '18:00' },
      },
    },
    retentionDays: 730,
    redaction: { cardNumbers: true, thaiNationalId: true },
    waitingHumanFallbackMinutes: 15,
    acknowledgementText: {
      th: 'สักครู่นะคะ กำลังโอนสายให้เจ้าหน้าที่ดูแลต่อค่ะ',
      en: 'One moment please, I am passing you to a colleague.',
    },
    modelPrices: {},
    externalRetrieval: null,
    identity: {
      widgetToken: { enabled: true },
      verificationLink: { enabled: false, url: null, secretEncrypted: null, ttlMinutes: 15 },
    },
    ...overrides,
  }
}

export type CreatedWorkspace = { workspaceId: string }

/**
 * Insert an organization, its workspace and the two channels every tenant needs.
 *
 * The simulator channel is how an operator tries the AI without a customer, and the web
 * channel is what the widget embeds; a tenant without them looks broken on arrival. A
 * duplicate slug surfaces as the unique violation from Postgres, which the route turns into
 * a 409 rather than this function inventing its own error type.
 */
export async function createWorkspace(
  db: Database,
  input: {
    id?: string
    name: string
    slug: string
    settings?: WorkspaceSettings
    status?: WorkspaceStatus
  },
): Promise<CreatedWorkspace> {
  const workspaceId = input.id ?? newId()

  await db.insert(schema.organization).values({
    id: workspaceId,
    name: input.name,
    slug: input.slug,
    createdAt: new Date(),
  })

  await db.insert(schema.workspaces).values({
    id: workspaceId,
    settings: input.settings ?? defaultWorkspaceSettings(),
    ...(input.status ? { status: input.status } : {}),
  })

  for (const [type, name] of [
    ['test', 'Simulator'],
    ['web', 'Web widget'],
  ] as const) {
    await db.insert(schema.channels).values({
      id: newId(),
      workspaceId,
      type,
      name,
      webhookSecret: newId(),
    })
  }

  return { workspaceId }
}

/** True when a slug is already taken, so a route can answer 409 before attempting an insert. */
export async function slugExists(db: Database, slug: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.slug, slug))
    .limit(1)
  return rows.length > 0
}

/** Postgres' unique-violation code, so a race on a slug reads as a conflict, not a crash. */
export const UNIQUE_VIOLATION = '23505'

/**
 * Whether this error is Postgres refusing a duplicate.
 *
 * The chain has to be walked: Drizzle wraps the driver's error in a `DrizzleQueryError`
 * that carries the query and the parameters but not the code, so the thing worth checking
 * is one `cause` further down than it looks.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (typeof current !== 'object') return false
    if ((current as { code?: unknown }).code === UNIQUE_VIOLATION) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}
