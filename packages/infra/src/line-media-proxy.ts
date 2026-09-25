import type { ChannelAdapter } from '@ci/channels'
import type { Logger } from '@ci/core'
import type { ChannelType } from '@ci/shared'
import { PermanentMediaError } from './media'

/**
 * LINE media through the Cloudflare Worker in `workers/line-media` (ADR 0009).
 *
 * The pilot VPS reaches LINE's content server over a route that loses about a third of its
 * packets: an 899 KB photo took 65 seconds direct and 1.2 seconds through the Worker, and the
 * customer's answer waits on this download. The Worker only ever fetches LINE's content URL
 * for a numeric message id, and stores nothing; the bytes come back here and are stored by
 * the ordinary path, with its key rules and size limit.
 *
 * The proxy URL is the operator's, from the environment, never a tenant's, which is why a
 * plain fetch is right here and restricted egress is not.
 *
 * If the Worker fails, the direct fetch still runs: slow is better than a missing photo. If
 * LINE itself refused (a 4xx the Worker passed through, marked `x-upstream`), the direct fetch
 * would be refused the same way, so it is skipped and the refusal is not retried.
 */

type Fetcher = Pick<ChannelAdapter<never>, 'fetchMedia'>

/** Long enough for a large video through the Worker; the direct fallback follows. */
const PROXY_TIMEOUT_MS = 30_000

export function withLineMediaProxy(
  adapter: Fetcher,
  input: {
    channelType: ChannelType
    proxyUrl: string | undefined
    proxySecret: string | undefined
    logger: Logger
  },
): Fetcher {
  const direct = adapter.fetchMedia
  const { proxyUrl, proxySecret } = input
  if (input.channelType !== 'line' || !direct || !proxyUrl || !proxySecret) return adapter

  return {
    async fetchMedia(reference, config) {
      try {
        return await viaProxy(reference, config as { channelAccessToken?: string }, {
          url: proxyUrl,
          secret: proxySecret,
        })
      } catch (error) {
        if (error instanceof PermanentMediaError) throw error
        input.logger.warn('LINE media proxy failed; fetching directly', {
          error: error instanceof Error ? error.message : String(error),
        })
        return direct(reference, config)
      }
    },
  }
}

async function viaProxy(
  reference: string,
  config: { channelAccessToken?: string },
  proxy: { url: string; secret: string },
): Promise<{ data: Uint8Array<ArrayBuffer>; mime: string }> {
  const messageId = reference.startsWith('line:') ? reference.slice('line:'.length) : reference
  if (!config.channelAccessToken) throw new Error('the LINE channel has no access token')
  const response = await fetch(proxy.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${proxy.secret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ messageId, token: config.channelAccessToken }),
    signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
  })
  const fromLine = response.headers.get('x-upstream') === 'line'
  if (!response.ok) await response.body?.cancel().catch(() => {})
  if (fromLine && response.status >= 400 && response.status < 500 && response.status !== 429) {
    throw new PermanentMediaError(`LINE refused the media: ${response.status}`)
  }
  if (!response.ok) throw new Error(`the proxy answered ${response.status}`)
  const buffer = await response.arrayBuffer()
  const data = new Uint8Array(new ArrayBuffer(buffer.byteLength))
  data.set(new Uint8Array(buffer))
  return { data, mime: response.headers.get('content-type') ?? 'application/octet-stream' }
}
