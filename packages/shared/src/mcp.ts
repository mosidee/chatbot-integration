import { z } from 'zod'
import { toolBindingSchema, toolEffectSchema } from './tools'

/**
 * MCP servers a workspace connects (ADR 0011).
 *
 * A tenant runs a server of their own and its tools become the AI's. Nothing is offered
 * because the server lists it: an admin fetches the list, ticks the tools the AI may use and
 * says for each whether it only reads or changes something. What the model is shown is the
 * stored snapshot of that list, so a server changing a description after approval changes
 * nothing until an admin fetches again.
 */

/** The prefix every exposed tool carries: `<server>_<tool>`. */
export const mcpServerNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,23}$/, 'must be lowercase letters, digits and underscores')

/**
 * How the server is reached. `header`: a token an admin pastes, sent in a header they name.
 * `oauth`: the MCP authorization flow, an admin signing in to the server once.
 */
export const mcpAuthSchema = z.enum(['none', 'header', 'oauth'])
export type McpAuth = z.infer<typeof mcpAuthSchema>

/** Limits on what a server may put in front of the model. */
export const MCP_LIMITS = {
  tools: 100,
  pages: 10,
  descriptionChars: 1000,
  schemaBytes: 8 * 1024,
} as const

/** One tool as the server described it when an admin last fetched the list. */
export type McpToolSnapshot = {
  /** The server's own name for it, which is what a call sends. */
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /**
   * The server's own hint: `true` read-only, `false` changes something, null unsaid.
   * Advice, not a guarantee; the admin's choice of effect is what the AI runs by.
   */
  readOnly: boolean | null
  /** Too large to offer, and so refused at the allowlist. */
  tooLarge?: boolean
}

export const mcpAllowedToolSchema = z.object({
  name: z.string().min(1).max(128),
  effect: toolEffectSchema,
  bindings: z.array(toolBindingSchema).max(4).default([]),
})
export type McpAllowedTool = z.infer<typeof mcpAllowedToolSchema>

/**
 * The name the model sees: `<server>_<tool>`, lowercased, anything else made an underscore,
 * cut to the 64 characters function calling allows. Two tools can sanitise to the same name
 * (`get-user`, `get_user`), which is why the allowlist checks uniqueness when it is saved.
 */
export function exposedMcpToolName(server: string, tool: string): string {
  const cleaned = tool
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
  return `${server}_${cleaned || 'tool'}`.slice(0, 64)
}

/** What the browser is told about a server. Its credential is never part of it. */
export type McpServerSummary = {
  id: string
  name: string
  url: string
  enabled: boolean
  auth: McpAuth
  headerName: string | null
  hasCredential: boolean
  /** `needs_reconnect` when a sign-in expired for good; its tools are left out of turns. */
  status: 'ok' | 'needs_reconnect'
  lastError: string | null
  timeoutMs: number
  fetchedAt: string | null
  snapshot: McpToolSnapshot[]
  allowed: McpAllowedTool[]
}
