import { useQuery } from '@tanstack/react-query'
import { api, type Me } from './api'

/**
 * What the person looking may do, in one place.
 *
 * The API refuses regardless; this is so the console does not invite anybody to do what
 * it will refuse. A viewer used to be shown a composer, a take-over button and knowledge
 * editors, and the Settings page queried three admin-only endpoints for every role.
 */
export type Capability =
  /** Reply, take over, resolve, hand back, rate, promote to knowledge. */
  | 'reply'
  /** Add, edit, reindex and remove knowledge; run the test search. */
  | 'editKnowledge'
  /** Send test messages through the simulator. */
  | 'simulate'
  /** Workspace settings, providers, channels, tools, identity, members. */
  | 'admin'

const RANK = { viewer: 0, agent: 1, admin: 2 } as const

const NEEDS: Record<Capability, keyof typeof RANK> = {
  reply: 'agent',
  editKnowledge: 'agent',
  simulate: 'agent',
  admin: 'admin',
}

export function can(me: Me | null | undefined, capability: Capability): boolean {
  const role = me?.role
  if (!role) return false
  return RANK[role] >= RANK[NEEDS[capability]]
}

/** The same question from inside a component, sharing the one `['me']` query. */
export function useCan(capability: Capability): boolean {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.settings.me(), staleTime: 60_000 })
  return can(me.data, capability)
}
