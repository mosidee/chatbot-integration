import { describe, expect, test } from 'bun:test'
import type { WorkspaceSettings } from '@ci/db/schema/app'
import type { IdentityProof } from '@ci/shared'
import { boundIdentityFor, identityProofAccepted } from '../src/identity'

/**
 * Which proof still counts.
 *
 * `boundIdentityFor` is the one place that decides whether a recorded proof becomes a value
 * bound into a tool call. A workspace that stops accepting a proof has to stop binding it
 * immediately, without anything being rewritten in the database, because the recorded proof
 * is a fact about the past and the switch is a decision about the present.
 *
 * Pure, so this needs no database: it takes a conversation, an identity and the settings.
 */

type Context = Parameters<typeof boundIdentityFor>[0]

function context(
  verifiedVia: IdentityProof | null,
  verifiedSubject: string | null = 'acct_7',
): Context {
  return {
    conversation: {
      id: 'conv1',
      workspaceId: 'w1',
      customerId: 'cust1',
    },
    identity: {
      verifiedVia,
      verifiedSubject,
      verifiedAttributes: { plan: 'pro' },
    },
  } as unknown as Context
}

function settings(widgetToken: boolean, verificationLink: boolean): WorkspaceSettings {
  return {
    identity: {
      widgetToken: { enabled: widgetToken },
      verificationLink: {
        enabled: verificationLink,
        url: verificationLink ? 'https://salon.example.com/verify' : null,
        secretEncrypted: null,
        ttlMinutes: 15,
      },
    },
  } as unknown as WorkspaceSettings
}

describe('boundIdentityFor', () => {
  test('always binds the values that need no proof', () => {
    const bound = boundIdentityFor(context(null, null), settings(true, true))
    expect(bound.workspaceId).toBe('w1')
    expect(bound.conversationId).toBe('conv1')
    expect(bound.customerId).toBe('cust1')
  })

  test('binds nothing when nobody ever proved anything', () => {
    const bound = boundIdentityFor(context(null, null), settings(true, true))
    expect(bound.subject).toBeNull()
    expect(bound.attributes).toEqual({})
  })

  test('binds a widget token proof while the workspace accepts one', () => {
    const bound = boundIdentityFor(context('widget_token'), settings(true, true))
    expect(bound.subject).toBe('acct_7')
    expect(bound.attributes).toEqual({ plan: 'pro' })
  })

  test('binds a verification link proof while the workspace accepts one', () => {
    const bound = boundIdentityFor(context('verification_link'), settings(true, true))
    expect(bound.subject).toBe('acct_7')
    expect(bound.attributes).toEqual({ plan: 'pro' })
  })

  test('withholds a widget token proof once that switch is off', () => {
    const bound = boundIdentityFor(context('widget_token'), settings(false, true))
    expect(bound.subject).toBeNull()
    // The attributes go with it: they are part of what the proof asserted, and a plan read
    // out of a proof the workspace no longer trusts is exactly as untrustworthy.
    expect(bound.attributes).toEqual({})
  })

  test('withholds a verification link proof once that switch is off', () => {
    const bound = boundIdentityFor(context('verification_link'), settings(true, false))
    expect(bound.subject).toBeNull()
    expect(bound.attributes).toEqual({})
  })

  test('the switches are independent, so accepting one does not accept the other', () => {
    // Accepting links but not widget tokens.
    expect(boundIdentityFor(context('verification_link'), settings(false, true)).subject).toBe(
      'acct_7',
    )
    expect(boundIdentityFor(context('widget_token'), settings(false, true)).subject).toBeNull()

    // And the other way round.
    expect(boundIdentityFor(context('widget_token'), settings(true, false)).subject).toBe('acct_7')
    expect(boundIdentityFor(context('verification_link'), settings(true, false)).subject).toBeNull()
  })

  test('the conversation still works with both switches off', () => {
    // Turning a proof off must not break anything: the customer is still identified, and
    // the workspace, conversation and customer are still bound. Only the account goes.
    const bound = boundIdentityFor(context('widget_token'), settings(false, false))
    expect(bound.customerId).toBe('cust1')
    expect(bound.subject).toBeNull()
  })
})

describe('identityProofAccepted', () => {
  test('refuses an identity that carries no proof at all', () => {
    expect(identityProofAccepted(null, settings(true, true))).toBe(false)
  })

  test('answers per proof, not per workspace', () => {
    expect(identityProofAccepted('widget_token', settings(true, false))).toBe(true)
    expect(identityProofAccepted('verification_link', settings(true, false))).toBe(false)
    expect(identityProofAccepted('widget_token', settings(false, true))).toBe(false)
    expect(identityProofAccepted('verification_link', settings(false, true))).toBe(true)
  })
})
