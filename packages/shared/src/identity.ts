import { z } from 'zod'

/**
 * How we know who a customer actually is.
 *
 * A channel identity says which LINE account or browser is writing. That is continuity,
 * not proof: anyone can open a LINE chat and claim to be anyone. A tool that reads an
 * account needs proof, and these are the two ways to get it.
 *
 * Each proof is switched on and off separately by the workspace, because they are not
 * equivalent. The widget token is as trustworthy as the host application that signed it.
 * The verification link asks the person to log in somewhere we do not control and is worth
 * whatever that login is worth.
 */
export const identityProofSchema = z.enum([
  /** A short-lived token the host application signed for its logged-in user. */
  'widget_token',
  /** A one-time link the person followed and confirmed inside the host application. */
  'verification_link',
])
export type IdentityProof = z.infer<typeof identityProofSchema>

/**
 * How much of a proof's attributes we are willing to keep.
 *
 * These are new in three ways at once: persisted as jsonb, signed into the widget's session
 * token, and read into every prompt through `get_customer_profile`. A tenant who puts their
 * whole user record in here would be paying for it on every turn, so it is capped where it
 * enters rather than discovered later in a token that will not fit.
 */
export const MAX_IDENTITY_ATTRIBUTES_BYTES = 2048

/** Attributes a proof carried, such as the plan a customer is on. Strings only. */
export const identityAttributesSchema = z
  .record(z.string(), z.string())
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).length <= MAX_IDENTITY_ATTRIBUTES_BYTES,
    { message: `attributes must serialise to at most ${MAX_IDENTITY_ATTRIBUTES_BYTES} bytes` },
  )

/**
 * Keep as many attributes as fit, in the order given, and drop the rest.
 *
 * Dropping rather than refusing: a customer whose account carries one oversized field
 * should still get support, and the alternative is a conversation that silently loses its
 * identity because somebody added a long field to a user record.
 */
export function capIdentityAttributes(attributes: Record<string, string>): Record<string, string> {
  const encoder = new TextEncoder()
  if (encoder.encode(JSON.stringify(attributes)).length <= MAX_IDENTITY_ATTRIBUTES_BYTES) {
    return attributes
  }

  const kept: Record<string, string> = {}
  for (const [key, value] of Object.entries(attributes)) {
    const candidate = { ...kept, [key]: value }
    if (encoder.encode(JSON.stringify(candidate)).length > MAX_IDENTITY_ATTRIBUTES_BYTES) continue
    kept[key] = value
  }
  return kept
}

/**
 * The attributes a signed token asserts, as we store them.
 *
 * Both proofs sign the same claim shape and both need the same projection: the free-form
 * attributes, with the email folded in, capped. Two copies of this drifted apart once
 * already, so there is one.
 */
export function attributesFromClaims(claims: {
  attributes?: Record<string, string> | undefined
  email?: string | undefined
}): Record<string, string> {
  return capIdentityAttributes({
    ...(claims.attributes ?? {}),
    ...(claims.email ? { email: claims.email } : {}),
  })
}

export type VerifiedIdentity = {
  subject: string
  attributes: Record<string, string>
  via: IdentityProof
}
