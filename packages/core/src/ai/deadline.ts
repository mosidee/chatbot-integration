/**
 * A deadline for one model attempt, inside an optional deadline for the whole turn.
 *
 * Retries and fallback only help when a call fails. A provider that accepts the request and
 * never answers does not fail: it holds a worker slot while the customer waits, and the
 * fallback never starts. Every model call therefore carries a signal that fires after
 * `ms`, or sooner if the turn as a whole has run out.
 */
export function attemptSignal(ms: number, turn?: AbortSignal): AbortSignal {
  const own = AbortSignal.timeout(ms)
  return turn ? AbortSignal.any([own, turn]) : own
}

/** Per-attempt defaults, overridable per slot with `params.timeoutMs`. */
export const DEFAULT_ATTEMPT_MS = {
  chat: 60_000,
  vision: 45_000,
  summary: 90_000,
  embed: 30_000,
} as const
