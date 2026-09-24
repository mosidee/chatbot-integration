# ADR 0009: LINE media is fetched through a Cloudflare Worker

Accepted 2026-09-24.

## Context

LINE sends no media in its webhook: the worker fetches each photo, video or file from
`api-data.line.me` before the AI turn, because the vision model and the agent both need the
bytes. From the pilot VPS (Siamdata, Nonthaburi) that host (LY Corporation, Tokyo) is reached
through Singapore and Hong Kong at about 185 ms with roughly a third of packets lost. LINE
answers in about a second and then sends at about 14 KB/s: an 899 KB photo took 65 seconds,
twice running. The customer's answer waits behind it, and past about a minute LINE's free
reply token has expired, so the answer goes out as a push counted against the monthly quota.

A per-attempt deadline was tried and reverted the same day: the endpoint does not stall, it
is slow, so a deadline failed every photo over about 200 KB.

## Decision

A Worker, `workers/line-media` (`chatbot-line-media` on the operator's Cloudflare account),
makes the request from Cloudflare's network and streams the bytes back. Measured from the
VPS: the same photo in 1.1–1.3 seconds.

- It fetches only `https://api-data.line.me/v2/bot/message/<digits>/content`, built from a
  numeric message id. It never accepts a URL, so it cannot be used as an open proxy.
- The caller proves itself with a shared secret (`PROXY_SECRET` on the Worker,
  `LINE_MEDIA_PROXY_SECRET` on the VPS), compared in constant time. The LINE channel token
  travels in the request body, per request, because every tenant's channel has its own.
- It stores and logs nothing; Workers observability is off for it.
- It has no R2 binding. The bytes come back to the worker process and are stored by the
  ordinary path, so key rules, the size limit and `isWorkspaceKey` apply unchanged, and a
  leaked secret cannot write to the media bucket.

The app uses it for LINE only when `LINE_MEDIA_PROXY_URL` and `LINE_MEDIA_PROXY_SECRET` are
both set (`withLineMediaProxy`), and falls back to the direct fetch if it fails. The URL is
the operator's, from the environment, never a tenant's, so it is a plain `fetch` and not
restricted egress (ADR 0004).

## Consequences

- LINE channel tokens pass through the operator's own Cloudflare account in transit.
- A Cloudflare outage degrades LINE media to the old slow path; it does not lose it.
- Deploying the Worker is a separate step: `cd workers/line-media && bunx wrangler deploy`,
  and `wrangler secret put PROXY_SECRET` with the same value as the VPS's `.env`.
- Rotating the secret means setting it in both places; until both match, the app falls back
  to the direct fetch.
