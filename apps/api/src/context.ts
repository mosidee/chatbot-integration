import { type Env, loadEnv } from '@ci/config'
import { createAuth, type Database, schema } from '@ci/db'
import { createRuntime, type Runtime } from '@ci/infra'
import { eq } from 'drizzle-orm'

/**
 * The API's shared context: runtime services plus the auth instance, built once at startup.
 */
export type ApiContext = {
  env: Env
  runtime: Runtime
  db: Database
  auth: ReturnType<typeof createAuth>
}

export function createApiContext(env: Env = loadEnv()): ApiContext {
  const runtime = createRuntime('api', env)
  return {
    env,
    runtime,
    db: runtime.db,
    auth: createAuth(runtime.db),
  }
}

export type Membership = {
  workspaceId: string
  role: 'admin' | 'agent' | 'viewer'
}

/**
 * Resolve the workspace a user belongs to.
 *
 * The GUI shows a single workspace, so the first membership wins. When multi-workspace
 * arrives this reads the session's active organization instead; the call sites do not
 * change because they already take the workspace id from here.
 */
export async function resolveMembership(
  db: Database,
  userId: string,
  activeOrganizationId?: string | null,
): Promise<Membership | null> {
  const rows = await db.select().from(schema.member).where(eq(schema.member.userId, userId))
  if (rows.length === 0) return null

  const chosen = activeOrganizationId
    ? (rows.find((r) => r.organizationId === activeOrganizationId) ?? rows[0])
    : rows[0]
  if (!chosen) return null

  const role = chosen.role
  const normalised: Membership['role'] =
    role === 'admin' || role === 'agent' || role === 'viewer' ? role : 'agent'

  return { workspaceId: chosen.organizationId, role: normalised }
}
