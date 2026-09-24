# ADR 0008: media lives in Cloudflare R2, not a bundled MinIO

Accepted 2026-09-24.

## Context

Customer photos and files, agent uploads and knowledge documents are stored through an S3
client (`packages/infra/src/blob.ts`) using four operations: get, put, delete and list. The
production stack bundled MinIO for this, pinned by digest.

MinIO archived its community edition in September 2026. Anonymous pulls of `minio/minio` and
`minio/mc` from Docker Hub began answering 401 on 2026-09-11; the project moved to the
identical digests on quay.io, which answered 401 in turn from about 13:00 UTC on 2026-09-24.
CI's check and release-image jobs failed at the pull, and a fresh server could no longer be
built. The running production host kept working only because it already held the images.

A bundled store that cannot be reinstalled is not a dependency to keep. Holding a private
copy of an archived release would restore installs but not updates.

## Decision

Production media goes to a private Cloudflare R2 bucket, `chatbot-media`, created with the
`apac` location hint to sit near the pilot's customers. It is reached with the existing S3
client — `S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com`, `S3_REGION=auto` — and
an API token scoped to Object Read & Write on that bucket only. The bucket has no public
URL: customers, LINE and Messenger fetch media through the API's signed `/api/media` links,
as before (ADR 0001 still holds).

CI and local development use the filesystem store (ADR 0002). MinIO is removed from both
compose files.

Carried out the same day: 20 objects (4.4 MB) copied and verified byte for byte, the
production `.env` repointed, the MinIO container, volume and images removed. An archive of
its volume, `~/miniodata-pre-r2-20260924T1437.tgz`, stays on the VPS.

## Consequences

- Customer media is stored with Cloudflare, in the Asia-Pacific region, not on the VPS. An
  operator with contractual or PDPA commitments about where data sits should check them.
- Erasure and retention are unchanged: they delete through the same client and the
  `blob_deletions` queue.
- CI no longer exercises the S3 client against a server. The S3 half of `blob.test.ts` runs
  wherever `S3_ENDPOINT` is an http(s) URL; run it against the bucket after changing the
  client or the SDK.
- Production depends on Cloudflare's availability for media as well as on the VPS.
- Cost at pilot scale is inside R2's free allowance, and R2 charges nothing for egress.
