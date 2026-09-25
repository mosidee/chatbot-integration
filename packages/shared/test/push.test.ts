import { describe, expect, test } from 'bun:test'
import { isPushServiceEndpoint, pushSubscriptionSchema } from '../src/push'

/**
 * The worker posts to whatever endpoint a member registered, so this list is the whole of
 * what stops a subscription from pointing our servers somewhere else.
 */
describe('isPushServiceEndpoint', () => {
  test('accepts the endpoints real browsers hand out', () => {
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc:def',
      'https://web.push.apple.com/QGx9xyz',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
      'https://wns2-par02p.notify.windows.com/w/?token=BQYAAA',
    ]) {
      expect(isPushServiceEndpoint(endpoint)).toBe(true)
    }
  })

  test('refuses anything else, including look-alikes', () => {
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com:8443/fcm/send/abc',
      'https://user:pw@fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com.evil.example/x',
      'https://evilpush.apple.com/x',
      'https://push.apple.com.evil.example/x',
      'https://10.0.0.5/push',
      'https://localhost/push',
      'https://[::1]/push',
      'not a url',
      '',
    ]) {
      expect(isPushServiceEndpoint(endpoint)).toBe(false)
    }
  })
})

describe('pushSubscriptionSchema', () => {
  test('takes what PushSubscription.toJSON() gives', () => {
    const parsed = pushSubscriptionSchema.safeParse({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      expirationTime: null,
      keys: { p256dh: 'BExample', auth: 'secret' },
    })
    expect(parsed.success).toBe(true)
  })

  test('refuses an endpoint off the list', () => {
    const parsed = pushSubscriptionSchema.safeParse({
      endpoint: 'https://internal.example/push',
      keys: { p256dh: 'BExample', auth: 'secret' },
    })
    expect(parsed.success).toBe(false)
  })
})
