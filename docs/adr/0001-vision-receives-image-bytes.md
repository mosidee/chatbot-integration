# 0001 — The vision model receives image bytes, not URLs

Date: 2026-09-20
Status: accepted

## Context

The plan specified passing the URLs of customer images to the vision slot. Building it that
way failed immediately: the AI SDK refuses to download images from loopback and private
hosts as an SSRF precaution, so development against MinIO on localhost could never work.

The deeper problem is that a URL requires the model provider to fetch our object storage
over the public internet. That would force the media bucket to be publicly readable, or
force us to mint presigned URLs with a lifetime long enough for the provider to use them.
Both weaken the storage posture for no benefit.

## Decision

`AgentTurnInput.images` carries `{ data: Uint8Array; mime: string }`. The worker reads the
object from storage and passes the bytes; core never fetches anything over the network.
Images are sent to the provider as AI SDK `file` content parts.

## Consequences

- Object storage can stay entirely private. No public bucket, no presigned URLs for vision.
- Development against MinIO on localhost works with no special configuration.
- Request bodies to the provider are larger, since images are inlined rather than linked.
  Acceptable for support screenshots; revisit if customers start sending large photos, in
  which case the worker should downscale before calling the model.
- The chat model still receives only the text description, so follow-up questions that
  require looking at the image again will not work. That limit is inherent to keeping the
  chat and vision slots independently configurable, which was an explicit product decision.
