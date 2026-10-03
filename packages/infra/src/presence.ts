import type { Redis } from 'ioredis'

/**
 * Which conversation each person has open, for the push sender (ADR 0010).
 *
 * A notification that a customer wrote is noise for the person already reading that
 * conversation. The console says what it is showing over its socket; the socket server
 * records it here and the worker reads it before sending.
 *
 * One hash per person and workspace, one field per socket: two tabs, or a laptop and a
 * phone, each say what they show, and a tab going to the background must not clear what
 * another tab is still showing. Each field carries its own expiry because a hash field
 * cannot have one; the hash as a whole expires with the newest, so a server that died
 * without saying goodbye leaves nothing behind for long.
 */

/** How long a report counts without being renewed. The console renews every 30 s. */
export const VIEWING_TTL_MS = 75_000

const key = (workspaceId: string, userId: string) => `viewing:${workspaceId}:${userId}`

export async function markViewing(
  redis: Redis,
  input: { workspaceId: string; userId: string; socketId: string; conversationId: string | null },
): Promise<void> {
  const k = key(input.workspaceId, input.userId)
  if (input.conversationId === null) {
    await redis.hdel(k, input.socketId)
    return
  }
  await redis
    .multi()
    .hset(k, input.socketId, `${input.conversationId}|${Date.now() + VIEWING_TTL_MS}`)
    .pexpire(k, VIEWING_TTL_MS)
    .exec()
}

/** Who, of `userIds`, has this conversation on screen right now. */
export async function viewersOf(
  redis: Redis,
  input: { workspaceId: string; conversationId: string; userIds: readonly string[] },
): Promise<Set<string>> {
  const now = Date.now()
  const viewing = new Set<string>()
  for (const userId of new Set(input.userIds)) {
    const fields = await redis.hgetall(key(input.workspaceId, userId))
    for (const value of Object.values(fields)) {
      const [conversationId, until] = value.split('|')
      if (conversationId === input.conversationId && Number(until) > now) {
        viewing.add(userId)
        break
      }
    }
  }
  return viewing
}
