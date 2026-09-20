import { v7 as uuidv7 } from 'uuid'

/**
 * Time-ordered UUIDv7 primary key.
 *
 * Deliberately the `uuid` npm package rather than `Bun.randomUUIDv7()`: packages/db is
 * imported by the worker, which we want to keep portable across runtimes. Runtime-specific
 * APIs belong in the app layer, not in a package every process depends on.
 */
export function newId(): string {
  return uuidv7()
}
