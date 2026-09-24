import type { ChannelAdapter } from '@ci/channels'
import type { BlobStore, Logger } from '@ci/core'
import { newId } from '@ci/db'
import type { ChannelType, NormalizedMessage } from '@ci/shared'
import { safeKeySegment } from './media-serving'

/**
 * Resolving platform media into our own storage.
 *
 * Neither LINE nor Messenger sends media in the webhook. LINE gives a message id to fetch
 * from its blob endpoint; Messenger gives a CDN URL that expires within days. Either way a
 * reference is worthless later, so the bytes are pulled in before the AI turn runs and
 * stored under our own key. That is what lets a vision model see the image, and what lets
 * an agent still open it a week afterwards.
 *
 * A download that fails does not fail the message. The customer said something and an agent
 * needs to see it; a missing photo is a degraded conversation, a dropped message is a lost
 * one.
 */

const MAX_BYTES = 25 * 1024 * 1024

/**
 * The platform says this media cannot be had — expired, deleted, forbidden. Asking again
 * returns the same answer, so it is not retried.
 */
export class PermanentMediaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermanentMediaError'
  }
}

export type MediaResolution = {
  message: NormalizedMessage
  downloaded: number
  failed: number
}

export async function resolveInboundMedia(
  message: NormalizedMessage,
  input: {
    workspaceId: string
    channelType: ChannelType
    /** Passed in rather than looked up, so this is testable with a stub adapter. */
    adapter: Pick<ChannelAdapter<never>, 'fetchMedia'>
    config: unknown
    blob: BlobStore
    logger: Logger
    /**
     * Names the stored files after the event they arrived in, so a retried job writes the
     * same objects again rather than leaving the first attempt's copies behind unreferenced.
     */
    eventKey?: string
  },
): Promise<MediaResolution> {
  if (
    message.kind !== 'image' &&
    message.kind !== 'file' &&
    message.kind !== 'audio' &&
    message.kind !== 'video'
  ) {
    return { message, downloaded: 0, failed: 0 }
  }

  const fetchMedia = input.adapter.fetchMedia
  if (!fetchMedia) return { message, downloaded: 0, failed: 0 }

  let downloaded = 0
  let failed = 0

  const attachments = await Promise.all(
    message.attachments.map(async (attachment, index) => {
      // Already ours, or nothing to fetch from.
      if (attachment.storageKey || !attachment.sourceUrl) return attachment

      try {
        const fetched = await withRetry(() =>
          fetchMedia(attachment.sourceUrl as string, input.config as never),
        )

        if (fetched.data.byteLength > MAX_BYTES) {
          throw new Error(`media is ${fetched.data.byteLength} bytes, over the ${MAX_BYTES} limit`)
        }

        const mime = pickMime(fetched.mime, attachment.mime, attachment.fileName)
        const name = input.eventKey ? `${safeKeySegment(input.eventKey, 80)}-${index}` : newId()
        const key = `${input.workspaceId}/inbound/${name}${extensionFor(mime)}`
        await input.blob.put(key, fetched.data, mime)
        downloaded += 1

        return {
          ...attachment,
          storageKey: key,
          mime,
          sizeBytes: fetched.data.byteLength,
        }
      } catch (error) {
        failed += 1
        input.logger.warn('could not download inbound media', {
          channelType: input.channelType,
          reference: attachment.sourceUrl,
          error: error instanceof Error ? error.message : String(error),
        })
        // Keep the attachment so an agent sees that something was sent, and so a later
        // re-fetch is possible while the platform reference still resolves.
        return attachment
      }
    }),
  )

  return { message: { ...message, attachments }, downloaded, failed }
}

/** One retry: platform blob endpoints are occasionally slow rather than broken. */
async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof PermanentMediaError) throw error
    return run()
  }
}

/**
 * Platforms are vague about media types. LINE's blob endpoint returns a generic one, so a
 * type the adapter already knew, or one implied by the file name, is preferred.
 */
function pickMime(fetched: string, declared: string, fileName: string | null): string {
  const generic = ['application/octet-stream', '', 'binary/octet-stream']
  if (!generic.includes(fetched)) return fetched
  if (!generic.includes(declared)) return declared

  const extension = fileName?.includes('.') ? fileName.split('.').pop()?.toLowerCase() : null
  const byExtension: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
    mp4: 'video/mp4',
    m4a: 'audio/mp4',
    mp3: 'audio/mpeg',
  }
  return (extension && byExtension[extension]) || 'application/octet-stream'
}

function extensionFor(mime: string): string {
  const byMime: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
    'video/mp4': '.mp4',
    'audio/mp4': '.m4a',
    'audio/mpeg': '.mp3',
  }
  return byMime[mime] ?? ''
}
