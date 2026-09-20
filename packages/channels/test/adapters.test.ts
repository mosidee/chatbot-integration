import { describe, expect, test } from 'bun:test'
import { getAdapter, hasAdapter } from '../src'
import { testChannelAdapter } from '../src/adapters/test-channel'
import type { WebhookRequest } from '../src/types'

function request(body: unknown): WebhookRequest {
  return { rawBody: JSON.stringify(body), headers: {}, query: {} }
}

describe('adapter registry', () => {
  test('resolves the registered adapters', () => {
    expect(getAdapter('test').type).toBe('test')
    expect(getAdapter('web').type).toBe('web')
    expect(getAdapter('line').type).toBe('line')
  })

  test('reports which channel types are implemented', () => {
    expect(hasAdapter('test')).toBe(true)
    expect(hasAdapter('web')).toBe(true)
    expect(hasAdapter('line')).toBe(true)
  })

  test('throws for a channel type with no adapter yet', () => {
    expect(() => getAdapter('messenger')).toThrow(/No adapter registered/)
  })
})

describe('test channel adapter', () => {
  test('normalises an inbound text message', () => {
    const events = testChannelAdapter.parseInbound(
      request({
        externalId: 'sim-user-1',
        message: { kind: 'text', text: 'ราคาเท่าไหร่' },
        eventId: 'evt-1',
        displayName: 'Nok',
      }),
      {},
    )

    expect(events).toHaveLength(1)
    expect(events[0]?.externalId).toBe('sim-user-1')
    expect(events[0]?.platformEventId).toBe('evt-1')
    expect(events[0]?.message).toEqual({ kind: 'text', text: 'ราคาเท่าไหร่' })
    expect(events[0]?.profile?.displayName).toBe('Nok')
  })

  test('generates an event id when the caller omits one', () => {
    const events = testChannelAdapter.parseInbound(
      request({ externalId: 'u', message: { kind: 'text', text: 'hi' } }),
      {},
    )
    expect(events[0]?.platformEventId).toBeTruthy()
  })

  test('rejects a payload that is not a valid normalised message', () => {
    expect(() =>
      testChannelAdapter.parseInbound(
        request({ externalId: 'u', message: { kind: 'nonsense' } }),
        {},
      ),
    ).toThrow()
  })

  test('accepts an image message with attachments', () => {
    const events = testChannelAdapter.parseInbound(
      request({
        externalId: 'u',
        message: {
          kind: 'image',
          attachments: [{ mime: 'image/png', storageKey: 'media/1.png' }],
        },
      }),
      {},
    )
    expect(events[0]?.message.kind).toBe('image')
  })

  test('needs no signature verification', async () => {
    expect(await testChannelAdapter.verifyWebhook(request({}), {})).toBe(true)
  })

  test('returns a platform message id when sending', async () => {
    const result = await testChannelAdapter.send('u', { kind: 'text', text: 'hi' }, {}, {})
    expect(result.platformMessageId).toMatch(/^test-/)
  })
})
