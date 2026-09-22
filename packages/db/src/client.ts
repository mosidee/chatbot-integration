import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export type Database = ReturnType<typeof createDb>['db']

/**
 * A transaction, as Drizzle hands one to a callback.
 *
 * It is not a `Database`: it has no `$client`, so a function typed to take the pool cannot
 * be called inside `db.transaction`. Anything that has to work both on its own and as part
 * of a larger unit of work takes `Executor` instead, which is the shared query surface.
 */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
export type Executor = Database | Transaction

/**
 * Create a Drizzle client.
 *
 * `max` is deliberately modest: several app replicas multiply connections. `prepare: false`
 * keeps this compatible with a connection pooler in transaction-pooling mode, should one be
 * put in front — there is none today, and the worker's outbox relay depends on that: a
 * pooler in transaction mode carries no LISTEN/NOTIFY, so the relay would fall back to its
 * one-second sweep. If one is introduced, give the relay a connection that bypasses it.
 */
export function createDb(connectionString: string, options?: { max?: number }) {
  const sql = postgres(connectionString, {
    max: options?.max ?? 10,
    prepare: false,
    onnotice: () => {},
  })
  const db = drizzle(sql, { schema })
  return { db, sql, close: () => sql.end({ timeout: 5 }) }
}

export { schema }
