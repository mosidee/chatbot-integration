import { afterEach, describe, expect, test } from 'bun:test'
import { type LineConfig, lineChannelAdapter } from '../src/adapters/line'
import { type MessengerConfig, messengerChannelAdapter } from '../src/adapters/messenger'
import { UncertainDeliveryError } from '../src/types'

/**
 * Recommendation #9: one message can be several sends, and a retry must resume rather than
 * repeat. The platforms are stubbed at `fetch`, which both adapters go through.
 */

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const MESSENGER: MessengerConfig = {
  appSecret: 'meta-app-secret',
  pageId: '100000000000001',
  pageAccessToken: 'page-access-token',
  graphVersion: 'v26.0',
}
const LINE: LineConfig = {
  channelSecret: 'line-secret',
  channelAccessToken: 'line-token',
} as LineConfig

const file = (name: string) => ({
  storageKey: `ws/${name}`,
  sourceUrl: `https://chat.example.com/api/media/tok/${name}`,
  mime: 'application/pdf',
  sizeBytes: 12,
  fileName: name,
  width: null,
  height: null,
  durationMs: null,
})

const twoFiles = {
  kind: 'file' as const,
  text: 'Here you are',
  attachments: [file('a.pdf'), file('b.pdf')],
}

describe('Messenger', () => {
  test('skips units taken on an earlier attempt and reports each one taken now', async () => {
    const sent: string[] = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { message: unknown }
      sent.push(JSON.stringify(body.message))
      return Response.json({ message_id: `mid-${sent.length}` })
    }) as typeof fetch

    const all = await messengerChannelAdapter.send('psid', twoFiles, MESSENGER, {})
    const total = sent.length
    expect(total).toBeGreaterThan(1)

    sent.length = 0
    const reported: [number, string | null][] = []
    await messengerChannelAdapter.send('psid', twoFiles, MESSENGER, {
      startAt: 1,
      onUnitSent: async (index, id) => {
        reported.push([index, id])
      },
    })
    expect(sent).toHaveLength(total - 1)
    expect(reported.map(([index]) => index)).toEqual(
      Array.from({ length: total - 1 }, (_, i) => i + 1),
    )
    expect(all.platformMessageId).toBeTruthy()
  })

  test('a send that got no answer is uncertain, not a plain failure to retry', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('socket hang up')
    }) as unknown as typeof fetch
    await expect(
      messengerChannelAdapter.send('psid', { kind: 'text', text: 'hi' }, MESSENGER, {}),
    ).rejects.toBeInstanceOf(UncertainDeliveryError)
  })
})

describe('LINE', () => {
  test('pushes with the retry key, and treats a repeat of that key as delivered', async () => {
    const keys: (string | null)[] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      keys.push(
        new Headers(init?.headers ?? (input instanceof Request ? input.headers : {})).get(
          'x-line-retry-key',
        ),
      )
      // LINE answers 409 when the key was already accepted: an earlier attempt delivered it.
      return new Response(JSON.stringify({ message: 'already accepted' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const key = '01a0d330-6758-77fe-9469-037e13350000'
    const result = await lineChannelAdapter.send(
      'U0123456789abcdef0123456789abcdef',
      { kind: 'text', text: 'สวัสดีค่ะ' },
      LINE,
      { retryKey: key },
    )
    expect(result.platformMessageId).toBeNull()
    expect(keys).toEqual([key])
  })
})
