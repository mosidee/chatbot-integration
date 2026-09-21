import { z } from 'zod'

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true'))

const base64Key32 = z
  .string()
  .min(1, 'required')
  .refine((v) => {
    try {
      return Uint8Array.from(atob(v), (c) => c.charCodeAt(0)).length === 32
    } catch {
      return false
    }
  }, 'must be base64 of exactly 32 bytes')

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  APP_SECRET_KEY: base64Key32,

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('media'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: boolish.default(true),
  S3_PUBLIC_URL: z.string().optional(),

  BETTER_AUTH_SECRET: z.string().min(16),
  BETTER_AUTH_URL: z.string().default('http://localhost:3000'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  API_PORT: z.coerce.number().int().positive().default(3000),
  /** The worker serves only a health endpoint, for container checks and test readiness. */
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(3001),
  PUBLIC_API_URL: z.string().default('http://localhost:3000'),
  PUBLIC_WEB_URL: z.string().default('http://localhost:5173'),
  WEBHOOK_BASE_URL: z.string().default('http://localhost:3000'),

  /**
   * Let tenant-defined tools reach loopback and private addresses.
   *
   * Off everywhere real. The worker shares a Docker network with Postgres, Redis and
   * MinIO, and the model gateway answers on a private address, so a tenant who could aim a
   * tool inward would have us fetch it and read the answer out to a customer. Tests and
   * local development need a tool endpoint on localhost, which is the only reason this
   * exists; `createRuntime` refuses to start with it on in production.
   */
  TOOL_EGRESS_ALLOW_PRIVATE: boolish.default(false),

  SEED_ADMIN_EMAIL: z.string().optional(),
  SEED_ADMIN_PASSWORD: z.string().optional(),
  SEED_WORKSPACE_NAME: z.string().default('salon-saas'),
  SEED_PROVIDER_NAME: z.string().optional(),
  SEED_PROVIDER_BASE_URL: z.string().optional(),
  SEED_PROVIDER_KEY: z.string().optional(),
  SEED_CHAT_MODEL: z.string().optional(),
  SEED_VISION_MODEL: z.string().optional(),
})

export type Env = z.infer<typeof envSchema>

let cached: Env | undefined

/** Parse and cache process.env. Throws a readable error listing every missing/invalid key. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  if (cached) return cached
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}`)
  }
  cached = parsed.data
  return cached
}

/** Test helper: forget the cached env so the next loadEnv() re-parses. */
export function resetEnvCache(): void {
  cached = undefined
}

export const isProduction = (): boolean => loadEnv().NODE_ENV === 'production'
