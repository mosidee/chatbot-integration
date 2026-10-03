import type { ToolBinding, ToolEffect } from '@ci/shared'
import { dynamicTool, jsonSchema, type ToolSet } from 'ai'
import { boundValue } from './http-tool'
import type { BoundIdentity, ToolSource } from './tool-source'
import type { ToolContext } from './tools'

/**
 * Tools from a workspace's MCP servers (ADR 0011).
 *
 * Pure, like the HTTP source: calling a server is injected (`McpCaller`), because how to
 * connect — which egress, which credentials — is the runtime's to decide. What is offered
 * comes from the snapshot an admin approved, never from asking the server during the turn.
 */

/** One approved tool, ready to offer. */
export type McpToolDefinition = {
  serverId: string
  /** What the model calls it: `<server>_<tool>`, sanitised. */
  exposedName: string
  /** What the server calls it, which is what a call sends. */
  remoteName: string
  description: string
  /** The server's JSON Schema for the arguments, as approved. */
  inputSchema: Record<string, unknown>
  effect: ToolEffect
  /** Arguments the system fills, removed from what the model sees. */
  bindings: ToolBinding[]
}

export type McpCallResult = { isError: boolean; text: string }

export type McpCaller = {
  call(
    serverId: string,
    tool: string,
    args: Record<string, unknown>,
    options?: { idempotencyKey?: string },
  ): Promise<McpCallResult>
}

/** What the model is shown of an answer. A large one eats the budget for the reply. */
export const MCP_RESULT_CHARS = 8 * 1024

/**
 * The schema the model sees: the server's, with every bound argument taken out of both
 * `properties` and `required`. A model cannot fill in what it cannot see, and the call
 * overwrites it anyway (`withBindings`).
 */
export function modelSchemaFor(
  inputSchema: Record<string, unknown>,
  bindings: ToolBinding[],
): Record<string, unknown> {
  const bound = new Set(bindings.map((b) => b.name))
  const properties = { ...((inputSchema.properties as Record<string, unknown>) ?? {}) }
  for (const name of bound) delete properties[name]
  const required = Array.isArray(inputSchema.required)
    ? (inputSchema.required as unknown[]).filter((name) => !bound.has(String(name)))
    : undefined
  return {
    ...inputSchema,
    type: 'object',
    properties,
    ...(required ? { required } : {}),
  }
}

/**
 * The model's arguments with the system's values laid over them, last, so a key the model
 * sent outside its schema (`jsonSchema` does not validate) cannot stand in for a bound one.
 * Null when a binding needs a value this conversation does not have.
 */
export function withBindings(
  args: Record<string, unknown>,
  bindings: ToolBinding[],
  bound: BoundIdentity,
): Record<string, unknown> | null {
  const filled: Record<string, unknown> = {}
  for (const binding of bindings) {
    const value = boundValue(binding.source, bound)
    if (value === null) return null
    filled[binding.name] = value
  }
  return { ...args, ...filled }
}

/** The same arguments in any key order, at any depth, give the same key. */
export function stableFingerprint(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical)
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.keys(input as Record<string, unknown>)
          .sort()
          .map((key) => [key, canonical((input as Record<string, unknown>)[key])]),
      )
    }
    return input
  }
  const text = JSON.stringify(canonical(value)) ?? ''
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function needsAbsentSubject(def: McpToolDefinition, bound: BoundIdentity): boolean {
  return bound.subject === null && def.bindings.some((b) => b.source === 'subject')
}

/**
 * Turn approved MCP tools into a source.
 *
 * The same two are left out as for HTTP tools: one binding a subject nobody proved, and any
 * writing tool while the turn is only drafting.
 */
export function createMcpToolSource(
  definitions: McpToolDefinition[],
  caller: McpCaller,
): ToolSource {
  return {
    id: 'mcp',
    tools(ctx: ToolContext): ToolSet {
      const set: ToolSet = {}
      for (const def of definitions) {
        if (needsAbsentSubject(def, ctx.bound)) continue
        if (def.effect === 'write' && ctx.mode === 'suggest') continue

        set[def.exposedName] = dynamicTool({
          description: def.description,
          inputSchema: jsonSchema(modelSchemaFor(def.inputSchema, def.bindings)),
          execute: async (rawInput: unknown) => {
            const args =
              rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
                ? (rawInput as Record<string, unknown>)
                : {}

            if (def.effect === 'write') {
              // Recorded, not run: fired after the turn, with the bindings applied then.
              ctx.scratchpad.pendingWrites.push({
                toolId: def.serverId,
                tool: def.exposedName,
                remoteTool: def.remoteName,
                source: 'mcp',
                bindings: def.bindings,
                args,
                idempotencyKey: `${ctx.turnKey}-${def.exposedName}-${stableFingerprint(args)}`,
              })
              return {
                ok: true,
                queued: true,
                message: 'Recorded. It will be carried out once this reply is sent.',
              }
            }

            const call = withBindings(args, def.bindings, ctx.bound)
            if (!call) return { error: `${def.exposedName} needs a verified identity` }
            try {
              const result = await caller.call(def.serverId, def.remoteName, call)
              if (result.isError) {
                // The server said it failed. Same as an HTTP tool's error: recorded so the
                // turn hands off rather than answering around a lookup that did not happen.
                const message = result.text.slice(0, 300) || 'the tool reported an error'
                ctx.scratchpad.toolErrors.push({ tool: def.exposedName, message })
                return { error: `${def.exposedName} ${message}` }
              }
              return { result: result.text.slice(0, MCP_RESULT_CHARS) }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              ctx.scratchpad.toolErrors.push({ tool: def.exposedName, message })
              return { error: `${def.exposedName} ${message}` }
            }
          },
        })
      }
      return set
    },
  }
}
