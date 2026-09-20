# chatbot-integration — working conventions

An AI customer-chat harness for Facebook Messenger, LINE and an embeddable web widget, with
a RAG knowledge base, per-customer memory, and a web console where humans take over from the
AI or the AI hands off to them. Any OpenAI-compatible model and provider can be used.

Pilot tenant is **salon-saas**, the operator's own SaaS. Its customers are salon owners and
prospects asking about the platform itself, not end consumers of a salon.

Scope and decisions live in `docs/REQUIREMENTS.md`. Architecture is in `docs/ARCHITECTURE.md`.
Decisions taken during implementation are recorded in `docs/adr/`.

## Stack

Bun + Elysia, Drizzle on Postgres 16 with pgvector and pg_trgm, BullMQ on Redis, MinIO for
media, Vite + React 19 for the console. Bun workspaces monorepo. Zod everywhere.

```
apps/api      HTTP, WebSocket, webhooks. Thin.
apps/worker   BullMQ processors. Where the real work happens.
apps/web      Agent console (Vite React SPA).
packages/core      Framework-free domain: state machine, AI harness, redaction, ports.
packages/channels  Normalised message model and one adapter per platform.
packages/db        Drizzle schema, migrations, auth config, encryption.
packages/infra     Runtime wiring: Redis, queues, storage, repository, effect ports.
packages/shared    Zod schemas and types shared with the browser.
packages/config    Environment parsing.
```

## Rules that matter

**The AI never sends while the mode is `human`.** The state machine enforces it, an
exhaustive test sweeps it, and the AI-turn processor re-reads the mode before sending
because a human may have taken over since the job was queued. Do not add a path around this.

**`packages/core` stays framework-free.** No Elysia, no React, no Bun-only APIs, no Drizzle.
It defines ports; `apps/*` and `packages/infra` implement them. This is what keeps the domain
testable with fakes and the worker portable.

**Every tenant-owned query is scoped by `workspaceId`.** There is no ambient workspace. Use
`scoped()` from `@ci/db` or pass the id explicitly, and add `workspace_id` to every new
tenant-owned table.

**Redact before you persist.** Card numbers and Thai national IDs are masked before anything
reaches the database or a model. `storeMessage` does this; do not write message rows by hand.

**Credentials are write-only.** Provider keys and channel config are encrypted with
AES-256-GCM and decrypted at the moment of use. API responses expose `hasKey`, never the key.

**Webhook handlers return fast.** Verify, persist the raw request, enqueue, return. LINE and
Meta retry or disable endpoints that answer slowly.

**Effects must be idempotent.** The queue retries jobs and `applyEffects` re-runs the whole
list when it does.

**Retrieval is scoped twice.** Knowledge is scoped by workspace. Recall over past
conversations is scoped by workspace **and customer**, and the customer id comes from the
caller, never from the model. One customer's history surfacing in another's conversation is
the leak this product refuses to accept.

**Zod, not TypeBox.** Elysia 1.4 accepts Zod through Standard Schema. If its OpenAPI
generation ever misbehaves on a specific route, that one route may use TypeBox; record it in
an ADR.

## Commands

```
bun run infra:up        # Postgres, Redis, MinIO in Docker
bun run db:migrate      # apply migrations (creates extensions first)
bun run db:seed         # workspace, admin user, test and web channels
bun run dev             # api + worker + web with hot reload
bun run test            # unit and integration (needs infra:up)
bun run test:e2e        # Playwright browser tests (starts the app itself)
bun run typecheck       # server packages and the web app
bun run lint            # Biome
bun run auth:generate   # regenerate the Better Auth schema after changing auth config
./scripts/smoke.sh      # end-to-end: sign in, configure a mock provider, assert the AI answers
```

`scripts/mock-provider.ts` is a local OpenAI-compatible stand-in, so the loop can be driven
without spending money.

## Gotchas learned the hard way

- The Better Auth schema generator is the **`auth`** package, not `@better-auth/cli`, which
  stopped tracking releases at 1.4.21. Keep its version equal to `better-auth`.
- Better Auth's routes must be mounted at the **root** of the app. Mounting them inside a
  prefixed group buries `/api/auth` and sign-in returns 404.
- MinIO images come from **quay.io**; the Docker Hub repository is no longer public. The `mc`
  image runs `mc` as its entrypoint, so shell commands need `--entrypoint /bin/sh`.
- The AI SDK refuses to download images from loopback and private hosts. Vision receives
  **bytes**, not URLs; see ADR 0001.
- The AI SDK's `image` content part is deprecated in v7. Use a `file` part with `mediaType`.
- When adding a workspace package, run `bun install` **before** committing, or CI's
  `--frozen-lockfile` fails on a package.json the lockfile has never seen.
- On macOS with Colima, a host process cannot reach MinIO: the port forwarder corrupts
  SigV4 requests and every call fails with `InvalidAccessKeyId`, even though containers on
  the same network work. Set `S3_ENDPOINT=file://./.data/media` locally; see ADR 0002.
- Redis outlives a database reset. After `bun run db:seed` on a wiped database, old jobs can
  reference rows that no longer exist and the worker logs "message vanished" warnings. They
  are harmless; `bun run infra:reset` clears them.
- BullMQ rejects a custom job id containing `:` unless it splits into exactly three parts.
  Use `-` as the separator; a two-part `prefix:id` throws at enqueue time.
- Better Auth needs `trustedOrigins`. In development the console runs on Vite's port and
  proxies to the API on another, so without it every browser sign-in is `Forbidden`.
- For trigram search use `word_similarity`, never `similarity`. The latter compares whole
  strings, so a short query against a longer chunk always scores near zero and falls below
  the default threshold. See ADR 0003.
- `bun test` would pick up Playwright specs, so the root script scopes it to `apps packages`.
  Browser tests run through `bun run test:e2e`.
- Browser tests find controls by `data-testid`, not by visible text: the console defaults to
  Thai, so label matchers would depend on the active language.
- Biome cannot parse Tailwind 4 at-rules, so CSS is excluded from it.
- TypeScript is pinned to 5.9.3. Elysia and Eden lean hard on inference and 7.x is too new to
  risk on that path.

## Adding things

**A channel:** implement `ChannelAdapter` in `packages/channels/src/adapters/`, register it in
that package's `index.ts`, and add fixture tests replaying real captured payloads. Nothing
else changes: the webhook route, worker and console are already channel-neutral.

**An AI tool:** add it to `createInternalTools` in `packages/core/src/ai/tools.ts`. Tools
record intent on the scratchpad and never write to the database, so a failed turn leaves no
partial side effects.

**A migration:** edit `packages/db/src/schema/app.ts`, run `bun run db:generate`, review the
generated SQL, then `bun run db:migrate`.

## Pull requests

Feature branches into `main`. CI runs lint, typecheck, migrations, tests and the web build.
End commit messages with:

```
Co-Authored-By: Claude <model> <noreply@anthropic.com>
```
