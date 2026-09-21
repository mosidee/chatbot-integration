import type { ToolSet } from 'ai'
import type { Logger } from '../ports'
import type { ToolContext } from './tools'

/**
 * Tool sources.
 *
 * The agent takes sources, not tools. An `http_tool` row contributes one entry and a
 * connected MCP server will contribute its whole set, so the turn never learns which kind
 * produced what and adding the second kind does not touch the loop. See decision 18 in
 * docs/REQUIREMENTS.md.
 */

/**
 * The values the system supplies to a tool call, as opposed to the ones the model fills.
 *
 * `subject` is the only one that can be absent: it is an identity somebody proved, and in
 * a conversation where nothing was proved there is none. A tool that binds it is simply
 * not offered, which is the rule that stops a model choosing whose account to read.
 */
export type BoundIdentity = {
  workspaceId: string
  conversationId: string
  customerId: string
  subject: string | null
  /** What the proof carried, such as the plan a customer is on. */
  attributes: Record<string, string>
}

export type ToolSource = {
  /** Identifies the source in logs when two of them offer the same name. */
  id: string
  tools(ctx: ToolContext): ToolSet
}

/**
 * Flatten sources into the set `generateText` takes.
 *
 * The first source to claim a name keeps it, and the internal source goes first, so a
 * tenant tool can never shadow `handoff_to_human` and leave the AI unable to fetch a
 * person. Definition-time validation refuses a reserved name as well; this is the belt to
 * that's braces, because a name can also collide between two tenant sources.
 */
export function mergeToolSources(
  sources: ToolSource[],
  ctx: ToolContext,
  logger?: Logger,
): ToolSet {
  const merged: ToolSet = {}
  for (const source of sources) {
    for (const [name, tool] of Object.entries(source.tools(ctx))) {
      if (name in merged) {
        logger?.warn('tool name already taken; the later definition is ignored', {
          tool: name,
          source: source.id,
        })
        continue
      }
      merged[name] = tool
    }
  }
  return merged
}
