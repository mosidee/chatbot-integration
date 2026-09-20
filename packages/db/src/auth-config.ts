/**
 * Better Auth configuration.
 *
 * This file is both the runtime auth setup (via `createAuth`) and the input to
 * `bunx auth generate`, which regenerates src/schema/auth.ts. The generated schema is
 * committed so migrations are reproducible without running the CLI.
 *
 * Note the CLI package is `auth`, not `@better-auth/cli`; the latter stopped tracking
 * better-auth releases. Keep the CLI version equal to the better-auth version.
 */
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { organization } from 'better-auth/plugins'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { ac, roles } from './permissions'
import * as schema from './schema'

export { USER_ROLES } from './permissions'

type AnyDrizzle = Parameters<typeof drizzleAdapter>[0]

export type AuthOverrides = {
  /**
   * Allow email sign-up. Only the seed/bootstrap path sets this: the running API is
   * invite-only, so there is no public route that can create an account.
   */
  allowSignUp?: boolean
}

function baseOptions(db: AnyDrizzle, overrides: AuthOverrides = {}) {
  return {
    database: drizzleAdapter(db, { provider: 'pg' as const, schema }),
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
    /**
     * Origins allowed to call the auth endpoints.
     *
     * In development the console runs on Vite's port and proxies to the API on another, so
     * the browser's Origin never matches baseURL and every sign-in is rejected as Forbidden.
     * In production both are the same host and this is simply that host.
     */
    trustedOrigins: [
      process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
      process.env.PUBLIC_WEB_URL ?? 'http://localhost:5173',
      process.env.PUBLIC_API_URL ?? 'http://localhost:3000',
    ].filter((origin, index, all) => all.indexOf(origin) === index),
    emailAndPassword: {
      enabled: true,
      // Invite-only: the API exposes no public sign-up route.
      disableSignUp: !overrides.allowSignUp,
    },
    socialProviders:
      process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: process.env.GOOGLE_CLIENT_ID,
              clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            },
          }
        : {},
    plugins: [
      // An organization IS a workspace. `workspaces` extends it 1:1 with product settings.
      organization({
        allowUserToCreateOrganization: false,
        ac,
        roles,
      }),
    ],
  }
}

/** Runtime factory used by the API, sharing the application's connection pool. */
export function createAuth(db: AnyDrizzle, overrides: AuthOverrides = {}) {
  return betterAuth(baseOptions(db, overrides))
}

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://ci:ci_dev_password@localhost:5432/chatbot_integration'

/** Static instance for `bunx auth generate`. Not used at runtime. */
export const auth = createAuth(drizzle(postgres(connectionString, { max: 1 }), { schema }))

export type Auth = ReturnType<typeof createAuth>
