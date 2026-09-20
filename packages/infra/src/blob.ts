import {
  GetObjectCommand,
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
      return {
        data: new Uint8Array(bytes),
        mime: response.ContentType ?? 'application/octet-stream',
      }
    },

    async put(key: string, data: Uint8Array, mime: string) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: data,
          ContentType: mime,
        }),
      )
    },

    urlFor(key: string) {
      const base = config.publicUrl ?? `${config.endpoint}/${config.bucket}`
      return `${base.replace(/\/$/, '')}/${key}`
    },
  }
}
