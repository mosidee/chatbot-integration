import { type Env, loadEnv } from '@ci/config'
import { createAuth, type Database, schema } from '@ci/db'
import { createRuntime, type Runtime } from '@ci/infra'
import type { UserRoleName, WorkspaceStatus } from '@ci/shared'
import { asc, eq } from 'drizzle-orm'

/**
 * The API's shared context: runtime services plus the auth instance, built once at startup.
 */
export type ApiContext = {
  env: Env
  runtime: Runtime
  db: Database
  auth: ReturnType<typeof createAuth>
  /**
   * A second auth instance that is allowed to create accounts, and is never mounted.
   *
   * The public instance has sign-up disabled, which is what makes the product invite-only:
   * there is no route anybody can post to and come out with an account. But accepting an
   * invitation does have to create one, and Better Auth checks `disableSignUp` inside its
   * handler, per instance. So the capability lives here, reachable only from the accept
   * route, which has already proved the caller holds a valid single-use token.
   *
   * Both instances share the secret and the database, so a session cookie minted by this
   * one is an ordinary session to the other.
   */
  authSignUp: ReturnType<typeof createAuth>
}

export function createApiContext(env: Env = loadEnv()): ApiContext {
  const runtime = createRuntime('api', env)
  return {
    env,
    runtime,
    db: runtime.db,
    auth: createAuth(runtime.db),
    authSignUp: createAuth(runtime.db, { allowSignUp: true }),
  }
}

export type Membership = {
  workspaceId: string
  role: UserRoleName
  /** Enough to render a workspace switcher without a second query. */
  name: string
  slug: string
  status: WorkspaceStatus
}

/**
 * Every workspace this user belongs to.
 *
 * The status comes back with the membership rather than from a second query, because every
 * authenticated request needs both and they must agree: a check that reads the role now and
 * the status a moment later can let a request through a workspace that was suspended in
 * between. It is one join over three primary keys.
 *
 * Ordered by when the membership was made, so the fallback below is deterministic. It used
 * to be whatever order Postgres felt like returning, which meant a person in two workspaces
 * could land in a different one on each request.
 */
export async function loadMemberships(db: Database, userId: string): Promise<Membership[]> {
  const rows = await db
    .select({
      workspaceId: schema.member.organizationId,
      role: schema.member.role,
      name: schema.organization.name,
      slug: schema.organization.slug,
      status: schema.workspaces.status,
      createdAt: schema.member.createdAt,
    })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.member.organizationId))
    .where(eq(schema.member.userId, userId))
    .orderBy(asc(schema.member.createdAt))

  return rows.map((row) => ({
    workspaceId: row.workspaceId,
    /**
     * Better Auth's column defaults to the string 'member', which is not one of ours. An
     * unrecognised role becomes the middle one rather than the most powerful: being wrong
     * in the direction of less authority is the only safe direction to be wrong in.
     */
    role:
      row.role === 'admin' || row.role === 'agent' || row.role === 'viewer' ? row.role : 'agent',
    name: row.name,
    slug: row.slug,
    status: row.status,
  }))
}

/**
 * Which workspace this request is about.
 *
 * The session's active organization when it names one the person actually belongs to, and
 * their first membership otherwise. A stale active id is ordinary: it survives being
 * removed from a workspace, and it survives that workspace being deleted, because Better
 * Auth stores it as plain text with no foreign key.
 */
export function chooseMembership(
  memberships: Membership[],
  activeOrganizationId?: string | null,
): Membership | null {
  if (memberships.length === 0) return null
  if (activeOrganizationId) {
    const active = memberships.find((m) => m.workspaceId === activeOrganizationId)
    if (active) return active
  }
  return memberships[0] ?? null
}

/** The pair, for the callers that only want an answer. */
export async function resolveMembership(
  db: Database,
  userId: string,
  activeOrganizationId?: string | null,
): Promise<Membership | null> {
  return chooseMembership(await loadMemberships(db, userId), activeOrganizationId)
}
