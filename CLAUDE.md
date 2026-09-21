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
apps/widget   Embeddable chat widget: a loader script and an iframe app. No framework.
packages/core      Framework-free domain: state machine, AI harness, redaction, ports.
packages/channels  Normalised message model and one adapter per platform.
packages/db        Drizzle schema, migrations, auth config, encryption.
packages/infra     Runtime wiring: Redis, queues, storage, repository, effect ports.
packages/shared    Zod schemas and types shared with the browser.
packages/config    Environment parsing.
```

## Rules that matter

**The AI never goes silent.** Every path out of an AI turn ends in a message to the
customer or a handoff to a person. An empty answer is a handoff, not a quiet return: a
reasoning model can spend its whole output budget thinking and emit nothing, and the
customer is left waiting for a reply that no colleague knows is owed. Reasoning tokens
count against `maxOutputTokens`, which is why its default is not sized for a short reply.

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
bun run db:reset        # DESTROYS ALL DATA, then migrates and seeds. Local only:
                        # it refuses production and any non-local database
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
- A gateway may answer a non-streaming request with an event stream anyway, and in more than
  one shape: a complete JSON body with the terminator glued on, or genuine
  `chat.completion.chunk` deltas holding no complete answer at all. `createCompatibleFetch`
  repairs both, assembling deltas including tool calls, whose arguments arrive as string
  fragments. Which shape a gateway uses can differ per upstream model, so test each one.
- A reasoning model is supposed to report its thinking in a separate field. Several
  gateways leave it in the message content instead, so a reply reaches the customer as
  `<think>…</think>answer`, sometimes with the block empty. `stripReasoning` removes it
  from both the answer and the vision description, before storage and before the next
  prompt.
- Structured output through an OpenAI-compatible provider is sent as
  `response_format: {type: 'json_object'}` and the schema is dropped. Put the schema in the
  prompt yourself, derived from the Zod schema so it cannot drift. DeepSeek additionally
  refuses `json_object` unless the prompt contains the word "json".
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
- A browser test must not put a bare thirteen-digit number in message text. `Date.now()` is
  thirteen digits, and about one in ten of those satisfies the Thai national ID checksum, so
  redaction masks it, the text the test waits for never appears, and the suite fails one run
  in ten while the product is correct. Use `uniqueToken()` from the e2e helpers.
- `DROP SCHEMA public CASCADE` leaves Drizzle's journal in its own `drizzle` schema, so the
  next migrate is a no-op against an empty database that claims to be migrated. `bun run
  db:reset` drops both, and refuses to run against production or a non-local host.
- Card redaction requires an issuer prefix as well as a Luhn check. Roughly one in ten random
  digit strings passes Luhn, so without the prefix a timestamp or a long order reference gets
  masked, which contradicts deliberately preserving order references.
- Webhook signatures must be computed over the exact bytes received. Never parse and
  re-serialise the body before verifying: it passes for ASCII and fails for Thai, so the bug
  looks like a platform outage.
- Delivery and read receipts are not messages. Messenger reports them as a watermark over
  the conversation, so they raise the status of every outbound message sent at or before
  that instant and never appear in the thread. They arrive out of order, so `applyReceipt`
  only ever raises a status, never lowers it.
- The widget is served by the API from `apps/widget/dist` in every environment, not only
  production, because nothing else serves it: there is no Vite dev server in front of it
  and the browser tests embed it. Run `bun run build:widget` or its routes 404.
- A widget visitor's channel identity carries a prefix, `anon:` or `host:`, and the
  prefixed form is what the identity is stored under. Sending the raw id instead created
  an identity the session could never find again.
- A raw `sql` template hands its parameters straight to postgres-js, which refuses a Date:
  "The 'string' argument must be of type string". The query builder serialises Dates, raw
  SQL does not. Pass `date.toISOString()` and cast it, as `packages/infra/src/dashboard.ts`
  does.
- LINE reply tokens are single-use and expire in about a minute. They are stored on the
  conversation and cleared the moment they are spent.
- `docker compose up -d` does not rebuild when a Dockerfile changes. Always pass `--build`,
  or the stack silently runs the previous image.
- Bun installs workspace dependencies into each workspace's own `node_modules`, not only the
  root. A Docker runtime stage that copies `/app/node_modules` alone leaves every package
  unable to resolve its imports; copy the whole built tree.
- Biome cannot parse Tailwind 4 at-rules, so CSS is excluded from it.
- A gateway's `/models` catalogue lists what it is configured to offer, not what it will
  serve. On the pilot gateway 8 of 39 entries are refused when called, for three unrelated
  reasons. Settings has a per-model test button for this; it calls the model through the
  same path a real turn uses, so the compatibility shim is exercised too.
- A `<datalist>` is not a picker. Browsers filter its options by whatever the input already
  contains, so a field holding a saved value offers only the entries resembling it and the
  rest cannot be reached. Its arrow is also hidden until hover. Where every option must be
  visible, as in the model field, use a `<select>` and give it an entry that switches to
  free text for values the list does not carry.
- `conversations.reviewed_at` is set with the database's `now()`, never a Date from the API
  process. It is compared against `messages.created_at`, which `defaultNow()` writes on the
  database clock, and two clocks a second apart would either mark AI replies reviewed before
  they were written or leave a conversation stuck in the review queue.
- A popover inside the message thread is clipped by its scroll container, so its bounding box
  can extend over the header and the click lands on the header instead. Panels that open from
  a bubble go in the normal flow and let the thread grow.
- TypeScript is pinned to 5.9.3. Elysia and Eden lean hard on inference and 7.x is too new to
  risk on that path.

## Adding things

**A channel:** implement `ChannelAdapter` in `packages/channels/src/adapters/`, register it in
that package's `index.ts`, and add fixture tests. Nothing else changes: the webhook route,
worker and console are already channel-neutral. Where the platform publishes typed webhook
definitions, type the fixtures with them, so a payload the platform would not send fails to
compile. Where it does not, say so in the test file rather than letting composed fixtures read
as authoritative. Implement `fetchMedia` if the platform sends references rather than bytes,
and `checkCredentials` so settings can verify a token without waiting for a customer.

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
