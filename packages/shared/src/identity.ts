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

/** Attributes a proof carried, such as the plan a customer is on. Strings only. */
export const identityAttributesSchema = z.record(z.string(), z.string())

export type VerifiedIdentity = {
  subject: string
  attributes: Record<string, string>
  via: IdentityProof
}
