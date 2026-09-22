import { signPayload, verifySignedPayload } from '@ci/channels'

/**
 * Links to stored files that a chat platform can fetch.
 *
 * The bucket is private on purpose, and everything else here reads media as bytes rather
 * than by URL for exactly that reason (ADR 0001). LINE and Messenger cannot work that way:
 * neither accepts the bytes of a file, they take a URL and fetch it themselves, from their
 * own servers, with no session and no header we control.
 *
 * So a file an agent sends gets a link that stands on its own, and the link is made safe by
 * being unguessable and short-lived rather than by being secret. It carries the storage key
 * and an expiry inside a signature, so it cannot be edited into a link for somebody else's
 * file, and it stops working on its own. The platforms cache what they fetch, so the
 * customer keeps seeing the file long after the link we handed out has died.
 *
 * The same HMAC envelope the widget's session token uses, rather than a second one.
 */

export type MediaClaims = {
  /** The object key. Always begins with the workspace id, which is what scopes it. */
  key: string
  /**
   * The workspace the link was minted for.
   *
   * The signature proves we made the link, not that its holder may see that tenant's file.
   * Carrying the workspace and checking the key still begins with it is the same rule the
   * authenticated `/api/v1/uploads/*` route enforces, kept rather than dropped because this
   * route is public. Today only the outbound job mints links; this is what stops a future
   * caller handing out a path into somebody else's tenant by accident.
   */
  ws: string
  exp: number
}

/**
 * Hand-written rather than a Zod schema, because `packages/infra` does not depend on Zod
 * and one claim shape is not worth a dependency. `verifySignedPayload` asks only for
 * something with `safeParse`, and checks the expiry itself.
 */
const mediaClaimsSchema = {
  safeParse(value: unknown): { success: boolean; data?: MediaClaims } {
    const claims = value as Partial<MediaClaims> | null
    if (!claims || typeof claims.key !== 'string' || claims.key.length === 0) {
      return { success: false }
    }
    if (typeof claims.ws !== 'string' || claims.ws.length === 0) return { success: false }
    if (typeof claims.exp !== 'number') return { success: false }

    // The key has to be inside the workspace the link was minted for.
    if (!claims.key.startsWith(`${claims.ws}/`)) return { success: false }

    return { success: true, data: { key: claims.key, ws: claims.ws, exp: claims.exp } }
  },
}

export const DAY_MS = 24 * 60 * 60 * 1000

/**
 * A link a platform can fetch, valid for a while.
 *
 * The file name is appended as a last path segment and plays no part in the signature. It
 * is there so the URL ends in something recognisable: LINE is happier with an image URL
 * that looks like an image, and a customer saving a PDF gets a sensible name rather than a
 * token.
 */
export async function signMediaUrl(input: {
  workspaceId: string
  storageKey: string
  fileName?: string | null
  secret: string
  baseUrl: string
  ttlDays: number
  now?: Date
}): Promise<string> {
  if (!input.storageKey.startsWith(`${input.workspaceId}/`)) {
    // Refused rather than signed: a key outside the workspace is a bug upstream, and this
    // is the last point at which it is still cheap to notice.
    throw new Error('refusing to sign a link for a file outside its workspace')
  }

  const now = input.now ?? new Date()
  const claims: MediaClaims = {
    key: input.storageKey,
    ws: input.workspaceId,
    exp: Math.floor((now.getTime() + input.ttlDays * DAY_MS) / 1000),
  }

  const token = await signPayload(claims, input.secret)
  const base = input.baseUrl.replace(/\/$/, '')
  const name = safeFileName(input.fileName ?? input.storageKey.split('/').pop() ?? 'file')
  return `${base}/api/media/${token}/${encodeURIComponent(name)}`
}

/** Read a token, or refuse. Throws when the signature is wrong or the link has expired. */
export async function verifyMediaToken(
  token: string,
  secret: string,
  now: Date = new Date(),
): Promise<MediaClaims> {
  return verifySignedPayload(token, secret, mediaClaimsSchema, now)
}

/**
 * A file name that survives being put in a URL and cannot climb out of it.
 *
 * The name never reaches the filesystem — the storage key does — so this is about the link
 * reading sensibly and about not handing a platform something that breaks its parser.
 */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[/\\?%*:|"<>]/g, '-').trim()
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'file'
}

/**
 * The same message, with every stored file turned into a link a platform can fetch.
 *
 * Only attachments we hold are touched: one that already carries a `sourceUrl` came from
 * the platform's own CDN and is better left alone. An attachment with neither is passed
 * through untouched and the adapter falls back to its text stand-in, which is the same
 * thing it does for a media kind it cannot send.
 */
export async function withMediaLinks<T extends { kind: string }>(
  message: T,
  options: { workspaceId: string; secret: string; baseUrl: string; ttlDays: number; now?: Date },
): Promise<T> {
  const media = message as T & {
    attachments?: { storageKey: string | null; sourceUrl: string | null; fileName: string | null }[]
  }
  if (!Array.isArray(media.attachments) || media.attachments.length === 0) return message

  const attachments = await Promise.all(
    media.attachments.map(async (attachment) => {
      if (attachment.sourceUrl || !attachment.storageKey) return attachment
      return {
        ...attachment,
        sourceUrl: await signMediaUrl({
          workspaceId: options.workspaceId,
          storageKey: attachment.storageKey,
          fileName: attachment.fileName,
          secret: options.secret,
          baseUrl: options.baseUrl,
          ttlDays: options.ttlDays,
          ...(options.now ? { now: options.now } : {}),
        }),
      }
    }),
  )

  return { ...media, attachments } as T
}
