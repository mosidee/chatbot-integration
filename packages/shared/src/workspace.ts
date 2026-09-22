import { z } from 'zod'

/**
 * Tenancy, as the browser needs to see it.
 *
 * A tenant is one workspace. Who may do what inside it is a role on a membership; whether
 * the workspace may be used at all is its status. The two are deliberately separate: an
 * admin of a suspended workspace is still its admin, and gets a locked screen rather than a
 * demotion.
 *
 * These live in `@ci/shared` rather than `@ci/db` because the console renders both, and the
 * console cannot import a package that reaches for Postgres.
 */

/**
 * The roles a person can hold in a workspace.
 *
 * Ordered from least to most, which is the order the API's rank check uses. Note this is
 * not the whole story of authority: a platform admin is not a role here, because their
 * authority is over tenants rather than inside one. See decision 22.
 */
export const USER_ROLES = ['viewer', 'agent', 'admin'] as const
export const userRoleSchema = z.enum(USER_ROLES)
export type UserRoleName = (typeof USER_ROLES)[number]

/**
 * Whether a workspace may be used.
 *
 * `suspended` is reversible and keeps every row: members are locked out, webhooks are
 * acknowledged and dropped, and queued work is skipped. `deleting` is not reversible; it is
 * set the moment an erasure is requested so that nothing new arrives while the job runs.
 */
export const workspaceStatusSchema = z.enum(['active', 'suspended', 'deleting'])
export type WorkspaceStatus = z.infer<typeof workspaceStatusSchema>

/**
 * Paths the console already owns, which therefore cannot be a tenant's slug.
 *
 * Opening `/<slug>` switches to that workspace, and a static route always wins over the
 * parameter, so a tenant slugged `settings` would be permanently unreachable by URL while
 * looking perfectly normal in every list. Refusing the name at creation is the only moment
 * anybody is in a position to choose a different one.
 *
 * The server's own prefixes are here too. They never reach the console at all, so a tenant
 * named after one would fail in a way that looks like the product is broken.
 */
export const RESERVED_SLUGS = [
  'admin',
  'api',
  'dashboard',
  'healthz',
  'invite',
  'knowledge',
  'login',
  'platform',
  'settings',
  'simulator',
  'widget',
  'ws',
] as const

/**
 * A slug is part of a URL and part of how an operator refers to a tenant out loud, so it is
 * kept to the shape that survives both: lowercase, digits and inner hyphens, 1–40 characters.
 */
export const workspaceSlugSchema = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/,
    'lowercase letters, digits and hyphens, not starting or ending with a hyphen',
  )
  .refine((slug) => !(RESERVED_SLUGS as readonly string[]).includes(slug), {
    message: 'that name is used by the console itself',
  })

/** True when the console owns this path, so the caller can explain rather than just refuse. */
export function isReservedSlug(slug: string): boolean {
  return (RESERVED_SLUGS as readonly string[]).includes(slug)
}

/** The seed's own slugifier, shared so the console can suggest exactly what the API accepts. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Why a link was issued.
 *
 * Both purposes are the same object — a single-use token with an expiry — because both
 * answer the same question: this person, at this address, may now do one thing. Keeping
 * them in one table is what stops a second, subtly different expiry rule being written.
 */
export const invitationPurposeSchema = z.enum(['invite', 'password_reset'])
export type InvitationPurpose = z.infer<typeof invitationPurposeSchema>

/**
 * Better Auth's own bounds, restated so the console refuses a password the API would.
 *
 * Its minimum is 8 and its maximum is 128; a longer one is rejected after the person has
 * typed it, which is the worst moment to find out.
 */
export const passwordSchema = z.string().min(8).max(128)

/** Addresses are compared case-insensitively everywhere, so they are stored lowercased. */
const emailSchema = z.email().transform((value) => value.trim().toLowerCase())

export const createInvitationBodySchema = z.object({
  email: emailSchema,
  role: userRoleSchema,
})
export type CreateInvitationBody = z.infer<typeof createInvitationBodySchema>

/**
 * What the person opening a link sends back.
 *
 * Both fields are optional here and required by the route that knows the purpose: joining
 * with a new account needs both, joining with an account that already exists needs neither,
 * and a password reset needs only the password. The email is never in this body — it comes
 * from the stored row, so a link cannot be pointed at a different address.
 */
export const acceptInvitationBodySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  password: passwordSchema.optional(),
})
export type AcceptInvitationBody = z.infer<typeof acceptInvitationBodySchema>

export const createTenantBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: workspaceSlugSchema,
  /** The first admin. They receive the only link that can get into a brand-new tenant. */
  adminEmail: emailSchema,
})
export type CreateTenantBody = z.infer<typeof createTenantBodySchema>

export const updateTenantBodySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  slug: workspaceSlugSchema.optional(),
})
export type UpdateTenantBody = z.infer<typeof updateTenantBodySchema>

export const updateMemberBodySchema = z.object({
  role: userRoleSchema.optional(),
  name: z.string().trim().min(1).max(120).optional(),
})
export type UpdateMemberBody = z.infer<typeof updateMemberBodySchema>
