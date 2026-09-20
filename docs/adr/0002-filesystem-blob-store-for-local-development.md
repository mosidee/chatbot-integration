# 0002 — A filesystem blob store for local development

Date: 2026-09-20
Status: accepted

## Context

Media is stored in S3-compatible object storage: MinIO in Docker for development, R2 or S3
in production. On macOS with Colima, a process running on the host cannot talk to the MinIO
container at all. Every signed request, including a plain bucket listing, is rejected with
`InvalidAccessKeyId`, while the same code with the same credentials succeeds from a
container on the Docker network, and the MinIO client succeeds from inside the VM.

The cause is Colima's port forwarder mangling SigV4-signed requests. It is not specific to
one SDK: the AWS SDK and Bun's own S3 client fail identically, and a freshly created MinIO
user fails the same way as the root credentials. Clocks are in sync and only one MinIO is
listening.

Two paths were available: require every developer on macOS to reconfigure their Docker VM
with a routable address, or let the storage implementation swap.

## Decision

`BlobStore` was already a port. `S3_ENDPOINT` now selects the implementation: a `file://`
path uses filesystem storage, anything else uses the S3 client. Local development on macOS
sets `S3_ENDPOINT=file://./.data/media`; CI and production keep an http endpoint.

## Consequences

- Local development works with no VM reconfiguration and one less running container.
- Development and CI exercise different storage implementations. To keep that honest, the
  storage test suite runs against whichever implementation the environment selects, and CI
  runs MinIO so the S3 path is proven on every push.
- The filesystem store keeps each object's media type in a sibling `.mime` file, since a
  filesystem has nowhere else to record it.
- Storage keys are attacker-influenced, so the filesystem store refuses any key that
  resolves outside its root.
- A developer on Linux, where Docker networking is native, can keep using MinIO by leaving
  `S3_ENDPOINT` alone.
