import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export type Database = ReturnType<typeof createDb>['db']

/**
 * Create a Drizzle client.
 *
 * `max` is deliberately modest: several app replicas multiply connections, and the VPS
 * deployment puts PgBouncer in front. `prepare: false` keeps it compatible with
 * transaction-pooling mode.
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
