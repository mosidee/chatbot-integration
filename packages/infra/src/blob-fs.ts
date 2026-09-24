import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { BlobStore } from '@ci/core'

/**
 * Filesystem-backed object storage, for local development.
 *
 * Selected by setting `S3_ENDPOINT` to a `file://` path, which local development and CI do.
 * It began as a way round Colima's port forwarder corrupting SigV4 requests to a local MinIO
 * (ADR 0002); since MinIO was removed it is simply the store wherever there is no bucket.
 * Production uses the S3 implementation against Cloudflare R2 (ADR 0008).
 */
export function createFilesystemBlobStore(root: string, publicUrl: string): BlobStore {
  const base = resolve(root)

  const pathFor = (key: string): string => {
    const target = resolve(join(base, key))
    // A key is attacker-influenced (it embeds a workspace id and a generated name);
    // refuse anything that escapes the root.
    if (target !== base && !target.startsWith(base + sep)) {
      throw new Error(`storage key escapes the root: ${key}`)
    }
    return target
  }

  return {
    async get(key: string) {
      const file = pathFor(key)
      const [data, mime] = await Promise.all([
        readFile(file),
        readFile(`${file}.mime`, 'utf8').catch(() => 'application/octet-stream'),
      ])
      const bytes = new Uint8Array(new ArrayBuffer(data.byteLength))
      bytes.set(data)
      return { data: bytes, mime: mime.trim() }
    },

    async put(key: string, data: Uint8Array<ArrayBuffer>, mime: string) {
      const file = pathFor(key)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, data)
      // The media type is kept beside the object; the filesystem has nowhere else to put it.
      await writeFile(`${file}.mime`, mime, 'utf8')
    },

    async remove(key: string) {
      const file = pathFor(key)
      await rm(file, { force: true })
      // The media type lives beside the object and goes with it.
      await rm(`${file}.mime`, { force: true })
    },

    async list(prefix: string) {
      const dir = pathFor(prefix.replace(/\/$/, ''))
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      const found: { key: string; modifiedAt: Date }[] = []
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.endsWith('.mime')) continue
        const info = await stat(join(dir, entry.name))
        found.push({ key: `${prefix}${entry.name}`, modifiedAt: info.mtime })
      }
      return found
    },

    urlFor(key: string) {
      return `${publicUrl.replace(/\/$/, '')}/${key}`
    },
  }
}
