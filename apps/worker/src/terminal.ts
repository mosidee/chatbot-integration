/**
 * Has BullMQ given up on this job for good?
 *
 * Two ways, and the hook that owes somebody an outcome — a handoff for an AI turn, `failed`
 * for a delivery — must catch both. The ordinary one uses the last attempt. The other is a job
 * that stalled more than `maxStalledCount` times (a worker restarted mid-job, twice): BullMQ
 * fails it with an `UnrecoverableError` without running it or counting an attempt, so the
 * attempts check alone left the message `queued` and the customer unanswered for ever.
 */
export function isTerminalFailure(
  job: { attemptsMade: number; opts: { attempts?: number } },
  error: Error,
): boolean {
  if (error.name === 'UnrecoverableError') return true
  return job.attemptsMade >= (job.opts.attempts ?? 1)
}
