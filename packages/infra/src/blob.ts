import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'
import type { BlobStore } from '@ci/core'

/**
 * S3-compatible object storage.
 *
 * MinIO in development, R2 or S3 in production: the same client code, differing only by
 * endpoint and path-style addressing. Media is read back as bytes for the vision model
 * rather than exposed by URL, so the bucket can stay private (see ADR 0001).
 */

export type BlobConfig = {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
  publicUrl?: string | undefined
}

export function createBlobStore(config: BlobConfig): BlobStore & { client: S3Client } {
  const clientConfig: S3ClientConfig = {
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    /**
     * Without these a stalled connection to the store holds whatever waits on it — an
     * inbound photo, and the customer's answer behind it — until the socket gives up. The
     * SDK retries a timed-out request itself.
     */
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  }
  const client = new S3Client(clientConfig)

  return {
    client,

    async get(key: string) {
      const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
      const bytes = await response.Body?.transformToByteArray()
      if (!bytes) throw new Error(`object ${key} has no body`)
      // Copy into a plain ArrayBuffer so the result satisfies Response, Blob and Web Crypto.
      const data = new Uint8Array(new ArrayBuffer(bytes.byteLength))
      data.set(bytes)
      return { data, mime: response.ContentType ?? 'application/octet-stream' }
    },

    async put(key: string, data: Uint8Array<ArrayBuffer>, mime: string) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: data,
          ContentType: mime,
        }),
      )
    },

    async remove(key: string) {
      // S3 answers 204 whether or not the key existed, which is the behaviour wanted here.
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
    },

    async list(prefix: string) {
      const found: { key: string; modifiedAt: Date }[] = []
      let token: string | undefined
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: prefix,
            // Only this level: sub-folders come back as prefixes, not objects.
            Delimiter: '/',
            ...(token ? { ContinuationToken: token } : {}),
          }),
        )
        for (const object of page.Contents ?? []) {
          if (object.Key)
            found.push({ key: object.Key, modifiedAt: object.LastModified ?? new Date() })
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined
      } while (token)
      return found
    },

    urlFor(key: string) {
      const base = config.publicUrl ?? `${config.endpoint}/${config.bucket}`
      return `${base.replace(/\/$/, '')}/${key}`
    },
  }
}
