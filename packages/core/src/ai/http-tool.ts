import type { HttpToolArg, HttpToolConfig, ToolBindingSource } from '@ci/shared'
import { dynamicTool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { BoundIdentity, ToolSource } from './tool-source'
import type { ToolContext } from './tools'

/**
 * Tenant-defined HTTP tools.
 *
 * Pure: the `fetch` it calls is injected, which is how the worker gives it the restricted
 * client (`packages/infra/src/egress.ts`) while tests give it a local server. Core must
 * stay framework-free, and it must also stay unable to decide for itself what is safe to
 * reach — that judgement belongs to the runtime that knows what network it is on.
 */

/** Bodies larger than this are truncated before parsing. A tool answer is not a download. */
const MAX_BODY_BYTES = 64 * 1024
/** What the model is shown. A large answer eats the budget it needs to write a reply. */
const MAX_BODY_CHARS = 8 * 1024

export type HttpToolDefinition = {
  id: string
  name: string
  description: string
  config: HttpToolConfig
  /** Decrypted at the moment of use by the caller, never held in a row or a log. */
  credential: string | null
}

export class HttpToolError extends Error {
  constructor(
    message: string,
    readonly toolName: string,
  ) {
    super(message)
    this.name = 'HttpToolError'
  }
}

/**
 * Just enough of `fetch` to call it.
 *
 * Not `typeof globalThis.fetch`: Bun's carries extra members such as `preconnect`, so a
 * plain function is not assignable to it and every injected client would need padding.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type HttpToolDeps = {
  fetch: FetchLike
}

/** The value the system binds for each source. Never reachable from the model's arguments. */
function boundValue(source: ToolBindingSource, bound: BoundIdentity): string | null {
  switch (source) {
    case 'subject':
      return bound.subject
    case 'customer_id':
      return bound.customerId
    case 'conversation_id':
      return bound.conversationId
    case 'workspace_id':
      return bound.workspaceId
  }
}

function argSchema(arg: HttpToolArg): z.ZodTypeAny {
  const base =
    arg.type === 'number'
      ? z.number()
      : arg.type === 'boolean'
        ? z.boolean()
        : arg.enum && arg.enum.length > 0
          ? z.enum(arg.enum as [string, ...string[]])
          : z.string()
  const described = base.describe(arg.description)
  return arg.required ? described : described.optional()
}

/** The input schema the model sees: arguments only. Bindings are deliberately absent. */
export function inputSchemaFor(config: HttpToolConfig): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const arg of config.args) shape[arg.name] = argSchema(arg)
  // Strips anything else the model invents, including a key named after a binding.
  return z.object(shape).strip()
}

/**
 * Compose the request.
 *
 * Bindings are applied after arguments everywhere, so even if validation were bypassed a
 * model-supplied value could not win over a system-supplied one.
 */
function composeRequest(
  def: HttpToolDefinition,
  args: Record<string, unknown>,
  bound: BoundIdentity,
): { url: URL; init: RequestInit } {
  const { config } = def

  const values = new Map<string, string>()
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) values.set(key, String(value))
  }
  for (const binding of config.bindings) {
    const value = boundValue(binding.source, bound)
    if (value !== null) values.set(binding.name, value)
  }

  // `{{name}}` in the path, so an endpoint shaped /accounts/{{account_id}}/plan works.
  const consumedByPath = new Set<string>()
  const rawUrl = config.url.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi, (whole, name: string) => {
    const value = values.get(name)
    if (value === undefined) return whole
    consumedByPath.add(name)
    return encodeURIComponent(value)
  })

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new HttpToolError(`"${rawUrl}" is not a valid URL`, def.name)
  }

  const remaining = [...values.entries()].filter(([name]) => !consumedByPath.has(name))

  const headers: Record<string, string> = {
    accept: 'application/json',
    ...config.headers,
    // Lets a tenant see in their own logs which tool a request came from.
    'x-ci-tool': def.name,
  }
  if (config.auth === 'bearer' && def.credential) {
    headers.authorization = `Bearer ${def.credential}`
  } else if (config.auth === 'header' && config.authHeaderName && def.credential) {
    headers[config.authHeaderName.toLowerCase()] = def.credential
  }

  if (config.method === 'GET') {
    for (const [name, value] of remaining) url.searchParams.set(name, value)
    return { url, init: { method: 'GET', headers } }
  }

  headers['content-type'] = 'application/json'
  return {
    url,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify(Object.fromEntries(remaining)),
    },
  }
}

export type HttpToolOutcome = {
  status: number
  body: unknown
}

/**
 * Call the endpoint once.
 *
 * Exported because three callers must behave identically: a read during the turn, a write
 * after it, and the test button in settings. A tenant who sees the button succeed has to
 * be able to trust that a real turn does the same thing.
 */
export async function executeHttpTool(
  def: HttpToolDefinition,
  args: Record<string, unknown>,
  bound: BoundIdentity,
  deps: HttpToolDeps,
  options: { idempotencyKey?: string } = {},
): Promise<HttpToolOutcome> {
  const { url, init } = composeRequest(def, args, bound)
  if (options.idempotencyKey) {
    ;(init.headers as Record<string, string>)['idempotency-key'] = options.idempotencyKey
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), def.config.timeoutMs)

  let response: Response
  try {
    response = await deps.fetch(url.toString(), { ...init, signal: controller.signal })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new HttpToolError(
      controller.signal.aborted
        ? `timed out after ${def.config.timeoutMs}ms`
        : `could not be reached: ${message}`,
      def.name,
    )
  } finally {
    clearTimeout(timer)
  }

  const text = await readCapped(response)

  if (!response.ok) {
    throw new HttpToolError(`returned ${response.status}: ${text.slice(0, 200)}`, def.name)
  }

  const contentType = response.headers.get('content-type') ?? ''
  let body: unknown = text.slice(0, MAX_BODY_CHARS)
  if (contentType.includes('json')) {
    try {
      body = JSON.parse(text)
    } catch {
      // A wrong content type is the tenant's business; the text still answers the question.
    }
  }

  return { status: response.status, body }
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''

  const chunks: Uint8Array[] = []
  let total = 0
  while (total < MAX_BODY_BYTES) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      total += value.byteLength
    }
  }
  await reader.cancel().catch(() => {})

  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined.slice(0, MAX_BODY_BYTES))
}

/** True when this definition cannot run without an identity nobody has proved. */
function needsAbsentSubject(config: HttpToolConfig, bound: BoundIdentity): boolean {
  return bound.subject === null && config.bindings.some((b) => b.source === 'subject')
}

/**
 * Turn definitions into a source.
 *
 * Two kinds of tool are left out rather than offered and refused: one binding a subject in
 * a conversation where identity was never proven, and any writing tool while the turn is
 * only drafting. A tool the model cannot see is a tool it cannot argue with.
 */
export function createHttpToolSource(
  definitions: HttpToolDefinition[],
  deps: HttpToolDeps,
): ToolSource {
  return {
    id: 'http',
    tools(ctx: ToolContext): ToolSet {
      const set: ToolSet = {}

      for (const def of definitions) {
        if (needsAbsentSubject(def.config, ctx.bound)) continue
        if (def.config.effect === 'write' && ctx.mode === 'suggest') continue

        const schema = inputSchemaFor(def.config)

        set[def.name] = dynamicTool({
          description: def.description,
          inputSchema: schema,
          execute: async (rawInput: unknown) => {
            const parsed = schema.safeParse(rawInput ?? {})
            if (!parsed.success) {
              return {
                error: `invalid arguments: ${parsed.error.issues[0]?.message ?? 'bad input'}`,
              }
            }
            const args = parsed.data

            if (def.config.effect === 'write') {
              // Recorded, not run. The worker fires it once the turn has finished, which is
              // what stops a turn that fails half way leaving a record in somebody's system.
              ctx.scratchpad.pendingWrites.push({ toolId: def.id, tool: def.name, args })
              return {
                ok: true,
                queued: true,
                message: 'Recorded. It will be carried out once this reply is sent.',
              }
            }

            try {
              const outcome = await executeHttpTool(def, args, ctx.bound, deps)
              return outcome
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              // Recorded so the turn ends in a handoff. Returned so the model knows not to
              // answer from thin air in the step it has left.
              ctx.scratchpad.toolErrors.push({ tool: def.name, message })
              return { error: `${def.name} ${message}` }
            }
          },
        })
      }

      return set
    },
  }
}
