import { z } from 'zod'

/**
 * Tenant-defined tools.
 *
 * A workspace admin describes an endpoint of their own and the AI gains the ability to
 * call it. The definition is deliberately narrow: the point is not to express every HTTP
 * request that exists, it is to express the small subset a model can be trusted to fill in
 * without being able to reach somewhere it should not.
 *
 * The shape that matters is the split between `args`, which the model fills, and
 * `bindings`, which the system fills. See decision 19 in docs/REQUIREMENTS.md: a model
 * that can name whose account to read is the cross-customer leak in a new place.
 */

/**
 * The name the model sees. Lowercase with underscores, because that is what every
 * function-calling schema in the wild uses and a name with a space or a dot is rejected by
 * some gateways rather than sanitised.
 */
export const toolNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,63}$/, 'must be lowercase letters, digits and underscores')

/**
 * Names the internal registry already uses. A tenant tool may not take one of these: the
 * merge would silently drop whichever lost, and losing `handoff_to_human` would break the
 * rule that the AI never goes silent.
 */
export const RESERVED_TOOL_NAMES = [
  'handoff_to_human',
  'tag_conversation',
  'set_customer_field',
  'get_customer_profile',
  'search_knowledge',
  'search_past_conversations',
  'request_identity_verification',
] as const

/** `mcp` arrives with the MCP client source; the column exists so it needs no migration. */
export const toolKindSchema = z.enum(['http'])
export type ToolKind = z.infer<typeof toolKindSchema>

/**
 * Whether calling this tool changes anything on the other side.
 *
 * A `read` runs during the turn, so the model can use the answer in its reply. A `write`
 * records intent and fires after the turn, because a turn that fails half way must not
 * leave a real record in somebody else's system.
 */
export const toolEffectSchema = z.enum(['read', 'write'])
export type ToolEffect = z.infer<typeof toolEffectSchema>

/**
 * A value the system supplies. The model never sees these in the input schema and cannot
 * override one: `subject` in particular is the identity we proved, not one the model chose.
 */
export const toolBindingSourceSchema = z.enum([
  /** The verified account id from an identity proof. Absent identity means no tool. */
  'subject',
  'customer_id',
  'conversation_id',
  'workspace_id',
])
export type ToolBindingSource = z.infer<typeof toolBindingSourceSchema>

export const toolBindingSchema = z.object({
  /** The parameter name the endpoint expects, which need not match the source. */
  name: toolNameSchema,
  source: toolBindingSourceSchema,
})
export type ToolBinding = z.infer<typeof toolBindingSchema>

export const httpToolArgSchema = z.object({
  name: toolNameSchema,
  type: z.enum(['string', 'number', 'boolean']),
  /** Shown to the model. This is the whole of what it knows about the argument. */
  description: z.string().min(1).max(300),
  required: z.boolean().default(true),
  /** Restricts a string argument to a fixed set, which models follow far more reliably. */
  enum: z.array(z.string().min(1).max(100)).max(20).optional(),
})
export type HttpToolArg = z.infer<typeof httpToolArgSchema>

export const httpToolAuthSchema = z.enum(['none', 'bearer', 'header'])
export type HttpToolAuth = z.infer<typeof httpToolAuthSchema>

export const httpToolConfigSchema = z
  .object({
    method: z.enum(['GET', 'POST']),
    /**
     * May contain `{{name}}` placeholders naming an argument or a binding, so an endpoint
     * shaped `/accounts/{{account_id}}/plan` works without inventing a path syntax.
     */
    url: z.string().min(1).max(2000),
    /** Plain headers. A secret belongs in the credential, which is encrypted at rest. */
    headers: z.record(z.string(), z.string()).default({}),
    auth: httpToolAuthSchema.default('none'),
    /** Header the credential is sent in when `auth` is `header`. */
    authHeaderName: z.string().min(1).max(80).optional(),
    args: z.array(httpToolArgSchema).max(12).default([]),
    bindings: z.array(toolBindingSchema).max(4).default([]),
    effect: toolEffectSchema.default('read'),
    /**
     * A customer is waiting on a webhook, so this is capped low. The same reasoning as the
     * model slots' retry count: failing fast beats hanging on a dead endpoint.
     */
    timeoutMs: z.number().int().min(1000).max(15000).default(8000),
  })
  .refine((config) => config.auth !== 'header' || Boolean(config.authHeaderName), {
    message: 'authHeaderName is required when auth is "header"',
    path: ['authHeaderName'],
  })
  .refine(
    (config) => {
      const names = [...config.args.map((a) => a.name), ...config.bindings.map((b) => b.name)]
      return new Set(names).size === names.length
    },
    {
      // An argument sharing a binding's name is how a model would overwrite the bound
      // value, so it is refused at definition time rather than resolved at call time.
      message: 'an argument and a binding may not share a name',
      path: ['args'],
    },
  )
export type HttpToolConfig = z.infer<typeof httpToolConfigSchema>

/** What the browser is told about a tool. The credential is never part of it. */
export type ToolSummary = {
  id: string
  kind: ToolKind
  name: string
  description: string
  enabled: boolean
  config: HttpToolConfig
  hasCredential: boolean
}
