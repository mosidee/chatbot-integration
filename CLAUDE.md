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

**Every tenant-owned query is scoped by `workspaceId`.** There is no ambient workspace and
no helper that adds it: put an explicit `eq(table.workspaceId, workspaceId)` in every
WHERE, and add `workspace_id` to every new tenant-owned table. A lookup keyed by a row
id alone is acceptable only when that id was itself loaded under a workspace check.

**A workspace's status is checked wherever its work happens.** `active`, `suspended` or
`deleting`, on the `workspaces` row. The authenticated path gets it free: `loadMemberships`
joins it, so the role and the status are one query and cannot disagree. Queued jobs ask
`workspaceIsWorkable` and drop with a log line rather than failing. Public paths each answer
in the way their caller can cope with: webhooks acknowledge and discard, the widget says the
workspace is suspended, and anything `deleting` reads as gone. A new processor or public
route without this check is a way for a suspended tenant to keep working.

**Authority over tenants is not a role.** A role lives inside one workspace. Creating,
suspending and deleting tenants is a row in `platform_admins`, behind the `platform: true`
guard, which resolves no workspace at all. Do not add an optional `workspaceId` to that
path: an optional workspace in scope is the ambient tenant this codebase refuses to have.

**Redact before you persist.** Card numbers and Thai national IDs are masked before anything
reaches the database or a model. `storeMessage` does this; do not write message rows by hand.
Text that is not a message is masked where it is written: `recordTrace` takes the workspace's
redaction rules as a required argument, and drafts, notes, summaries, summariser facts, field
updates and vision descriptions go through `redactText`/`redactDeep` from `@ci/core`.

**Credentials are write-only.** Provider keys and channel config are encrypted with
AES-256-GCM and decrypted at the moment of use. API responses expose `hasKey`, never the key.

**Webhook handlers return fast.** Verify, persist the raw request, enqueue, return. LINE and
Meta retry or disable endpoints that answer slowly.

**Nothing calls a queue but the relay.** Work is asked for by writing a row to `outbox`, in
the same transaction as the change that made it necessary; the worker's relay moves those
rows to BullMQ. `Runtime` carries no queues, so this is a rule the types keep rather than one
a comment asks for. The writer chooses the job id, which is what makes both the relay's retry
and the consumer's retry safe. See ADR 0006. The one exception is registering the job *schedulers* in
the worker (nightly retention, quarter-hourly idle resolve), which describe when jobs come
into being rather than asking for one.

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
bun run typecheck       # server packages, the web app and the widget
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
- **Replies are plain text.** LINE, Messenger and the widget render `**bold**` and `- item`
  literally, so the customer read asterisks. The prompt's `FORMAT_RULE` asks for plain text
  and `toPlainText` (after `stripReasoning` in `agent.ts`) converts what arrives anyway. The
  rule lives in the prompt builder, not the persona, so a tenant cannot edit it away.
  `bun run backfill:plain-text` converts older stored replies; dry by default.
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
- `conversations.handoff_reason` is cleared when a conversation goes back to the AI, so it
  can never be the source for reporting: the dashboard list of what the AI could not handle
  emptied itself as agents worked their queue. `handoff_events` is the history; the column
  stays for the inbox badge. Both exist on purpose.
- Merging two customers must repoint every table holding a person's history before the
  losing row is deleted, in one transaction. Five tables reference `customers.id` and all
  cascade on delete, which is how erasure wipes a person in one statement, so the wrong
  order destroys history instead of moving it. `packages/infra/src/merge.ts` repoints four
  and leaves `merge_suggestions` to the cascade on purpose; a new table that stores anything
  worth keeping goes on the repoint list.
- The e2e mock provider answers a phone number with a `set_customer_field` tool call, but
  only while no `tool` message is in the request. Without that guard the turn calls the tool
  forever and the harness gives up.
- `TOOL_EGRESS_ALLOW_PRIVATE` lets a tenant-defined tool — and a provider or external
  retrieval URL — reach loopback and private addresses. Tests and local development need it; `createRuntime` **throws at startup** if
  it is set with `NODE_ENV=production`, because the worker shares a network with Postgres,
  Redis and MinIO. `playwright.config.ts` sets it for the servers it starts, which does not
  cover a dev server Playwright reuses: restart that one with the flag, or the tools spec
  fails with an egress refusal that reads like a product bug.
- A writing tool is never offered while the AI is drafting for a human (`mode: 'suggest'`).
  A draft nobody has approved must not change anything in the tenant's system.
- Writes fire after the turn and before the reply is stored, so a failed write discards the
  reply and hands off. The handoff note names what *did* succeed as well as what failed:
  `runPendingWrites` stops at the first failure, so the writes ahead of it already landed
  and the person picking it up needs to know that.
- `customers.fields.account_id` is what a customer typed into a chat. `channel_identities.
  verified_subject` is what an identity proof carried. Only the second may be bound into a
  tool call, and they are separate columns so that the difference cannot be lost.
- Browser tests must clear tenant tools before defining their own. Tools persist between
  runs and the AI is offered all of them, so one left behind points at a port that died with
  its test process, the model picks it, and the conversation hands off before reaching the
  tool under test. `clearTools()` in `e2e/helpers.ts`.
- An IPv6 address has many spellings and only one meaning. `::ffff:127.0.0.1` and
  `::ffff:7f00:1` are the same host, and a URL preserves whichever was typed, so any check
  on an address must expand it rather than match its text. `packages/infra/src/egress.ts`
  does; an earlier version matched the dotted form only and let the hex form reach loopback.
- `redirect: 'manual'` switches off everything `fetch` does with a redirect, not just the
  following. Headers must be filtered by hand when the origin changes — an **allowlist**,
  because a tool's credential can be in any header its tenant names (`x-api-key` survived
  the old denylist) — a cross-origin 307/308 is refused, and 301, 302 and 303 must become a
  GET without a body, or a write is replayed at the new location.
- **Every URL a tenant types is restricted egress, providers included.** Model calls,
  embeddings, rerank, `/models` discovery and external retrieval use
  `workspaceProviderFetch(runtime, workspaceId)`; `ProviderProfile.fetch` is required so a
  builder cannot forget it. A private gateway (e.g. `http://10.0.0.5:8080`) is
  reachable only when a **platform admin** lists its origin in `workspaces.
  private_egress_origins` from the Platform page — a column, not a setting, because tenant
  admins write settings. A new provider or retrieval call that uses the global `fetch` is an
  SSRF hole.
- **Stored files are served through `mediaServingHeaders`,** never with the stored MIME type
  as-is: that type is whatever the sender claimed, and an SVG or HTML file served inline on
  the console's origin runs with the agent's session. Uploads accept raster images by name
  (not `image/`, which admits SVG) and take only a short alphanumeric extension from the
  submitted file name, which used to be able to put `/` into the storage key.
- An idempotency key must not depend on position. A retry re-runs the whole turn and the
  model may ask for the same operations in a different order, so a key built from an index
  hands the second operation the key the tenant already answered for the first. Keys are
  decided when the model asks, from the turn, the tool and a fingerprint of the arguments.
- Anything after the outbound job is queued in `ai-turn.ts` runs with the reply already
  sent, so a throw there re-runs the whole turn: another model call, another reply to the
  customer, another pass over the writes. Work in that tail catches its own errors.
- A tool whose promise only the `send` path can keep must not be offered on the `draft`
  path. `request_identity_verification` was, so a supervised workspace could approve a
  draft saying a link had been sent when nothing would ever send it.
- Better Auth's `setPassword` refuses an account that already has a password, which is every
  account a reset link is ever issued for. Go through `auth.$context` and the internal
  adapter — `password.hash`, `findCredentialAccount`, `updatePassword`, then
  `deleteUserSessions` — which is what its own reset flow does.
- **The public webhook route serves only adapters that verify a platform signature**
  (`capabilities.publicWebhook`). The web and test channels do not: their callers are our own
  widget and console, authenticated by session before ingestion, so they come in through
  `ingestInternal` and the public route answers for them as if the channel did not exist. A
  web channel id is printed in the embed code on the host's own page, so it is public
  knowledge, and an honest refusal would confirm which ids are real.
- **A proved identity reaches `resolveConversation` from the envelope, never from a parsed
  body.** Only `ingestInternal` writes `trusted`, and only the widget session route passes
  one. The web adapter used to accept a `verified` block inside the request and copy it onto
  the event; it was written to `channel_identities.verified_subject` and bound into the
  tenant's tool calls from there, and the public route reached that adapter with an id
  anybody could read. The adapter no longer knows the concept exists.
- **A workspace admin may reset a password only for a member whose sole membership is that
  workspace and who is not a platform admin.** A reset link sets the password on a global
  account, so anything wider is a takeover of access the issuer has no authority over.
  Everyone else is recovered from `/platform/users/reset-link`; see ADR 0005.
- **`storeMessage` refuses an attachment whose storage key is outside the workspace.** The
  key arrives in a request body on the agent-send and simulator routes and nothing downstream
  re-derives it: vision reads those bytes and erasure deletes them. `mediaKeysOf` filters by
  the same prefix, because deletion is irreversible and a row written before the rule existed
  must not take another tenant's file with it.
- `pg_notify` inside a transaction fires **at commit** and is dropped on rollback, which is
  exactly what the outbox needs: the relay is woken when the row becomes visible and never
  for one that was rolled back. It is called on the same executor as the insert for that
  reason. Measured at 29ms against a 30-second timer, so the notification and not the sweep
  is doing the work; the sweep exists for a dropped connection or a pooler in transaction
  mode, which carries no notifications at all.
- The `outbox` table is **not tenant-owned** and has no workspace foreign key. A
  workspace-erasure job must outlive the cascade it was queued to perform, and the nightly
  sweep belongs to no tenant — nor does the idle-resolve planning pass, which fans out one
  job per active workspace keyed `idle-resolve-<workspace>-<slot>`.
- **A turn answers once because of `messages.turn_key`,** which is the turn's BullMQ job id,
  which is the customer message that prompted it. The processor reads it before calling the
  model; the unique index behind it catches the race that read cannot. On a collision
  `storeMessage` reports `duplicate` and the id it returns names no row — the AI turn
  re-selects the winner rather than queueing delivery for a message that does not exist.
  Holding messages use the same column, keyed `ack-<kind>-<conversation>-<at ms>` where `at`
  travels on the effect, so a replayed effect list sends one acknowledgement per wait; on a
  collision `findMessageIdByTurnKey` reads the winner back and delivery is queued anyway.
- **`messages.sent_parts` is the delivery checkpoint.** Long text goes out as several sends;
  without it a failure on part three restarted at part one and the customer read the opening
  twice. Delivery state is monotonic: the early return covers `sent`, `delivered` **and**
  `read`, because receipts only ever raise a status.
- **Telling the console is not part of delivering.** The publish used to sit inside the try
  that wraps the adapter call, so a Redis hiccup after a successful send marked the message
  failed and threw, and the retry sent the customer the same words again.
- Tests must **relay before looking at a queue** (`drainQueue` in the worker fixture does it
  for you). A test that reads BullMQ directly sees an empty queue and concludes nothing was
  asked for.
- **A last-admin check and the change it guards share one transaction.** The `FOR UPDATE`
  lock over the admin set lives only as long as its transaction: checking in one and mutating
  after it returned let two concurrent demotions both through, which is the outcome the lock
  exists to prevent. Return the refusal from inside the transaction rather than calling
  `tx.rollback()`, which throws and surfaces as a 500.
- The API holds a **second auth instance** (`ctx.authSignUp`) that allows sign-up, and it is
  never mounted. `disableSignUp` is checked inside Better Auth's handler, per instance, so
  this is what lets an invitation create an account while the public API stays invite-only.
  Do not pass it to `authHandler`, and do not reach for it outside the accept route.
- Spending an invitation and writing the membership share a transaction. Apart, a failure
  between them leaves somebody with an account, no membership, and a link that will never
  work again — the one outcome with no way out but an admin issuing another.
- Two Elysia plugins each carrying a `.as('global')` macro do not merge in the type: a route
  can only see the macros of one of them. All three guards live in one `.macro()` call for
  that reason. None of them branches on its own parameter either: a macro only runs for a
  route that names it, and returning `{}` for `false` widens every handler's type until
  `user` is no longer known to be there.
- Drizzle wraps a driver error in `DrizzleQueryError`, which carries the query and the
  parameters but not the code. `isUniqueViolation` walks the `cause` chain; a check on
  `error.code` alone silently turns a duplicate slug into a 500.
- A suspended workspace's queued AI turn is **dropped**, which contradicts "the AI never goes
  silent" everywhere else. It is deliberate and commented at the call site: there is no
  colleague to hand off to, because every agent in the tenant is locked out too.
- A webhook for a suspended tenant answers **200 and discards**. Erroring would be more
  honest and would cost the operator their webhook registration: LINE and Meta disable an
  endpoint that keeps failing, and a suspension is meant to be reversible in an afternoon.
- `eraseWorkspace` refuses to delete anything unless a `workspace_erasures` row says the
  deletion was asked for, and saves the media keys onto that row **before** the rows go.
  After the cascade there is nothing left to read them from, so a retry would otherwise
  leave every object behind. It collects `knowledge_sources.storage_key` as well as message
  attachments; `mediaKeysOf` only knows about the latter.
- The seed grants platform admin to `SEED_ADMIN_EMAIL`. An installation seeded before M6
  must re-run `bun run db:seed`, or the platform page is invisible to everybody and no
  second tenant can ever be created.
- **Outbound media leaves as a signed link, not as bytes.** LINE and Messenger do not accept
  a file: they take a URL and fetch it themselves, from their own servers, with no session.
  `withMediaLinks` in the outbound processor turns a storage key into a link signed with
  `APP_SECRET_KEY` and expiring after `MEDIA_LINK_TTL_DAYS`, and `/api/media/*` serves it
  publicly. Adapters stay pure translators and read `sourceUrl` only. This is the one place
  the private-bucket posture of ADR 0001 is relaxed, and the link is what makes it safe.
- **LINE has no document message.** Its outbound types are text, sticker, image, video,
  audio, location, imagemap, template and flex. A file therefore goes as a **Flex card**
  naming it with a button that opens the link; Messenger carries it natively. The card's
  `altText` carries the link too, because a client too old for Flex sees only that. Neither platform's image or file carries a
  caption, so an agent's note is sent as its own message first rather than dropped.
- The conversation panel keeps the **most recent** thirty messages live and fetches older
  pages by cursor (`GET /conversations/:id?before=<message id>`) as somebody scrolls up —
  and only on the way up: opening a thread lands at its end instantly, because a smooth
  scroll from the top passed every older-page trigger and loaded the whole history. It
  used to widen one window to a cap of 500, which left a long thread's opening unreachable.
- Finding or creating a conversation happens under a row lock on the channel identity, and
  the identity insert tolerates a conflict. Inbound runs ten jobs at a time, so two messages
  typed in quick succession are two jobs: without both, one burst of typing became two
  conversations, or the second job failed on the unique index.
- The inbox order lives in SQL and the browser must not re-sort it. It used to lift
  `waiting_human` to the top client-side, which was right when the whole queue arrived in
  one page; the order now depends on who owns each customer, which only the database knows,
  so re-sorting a page of fifty contradicts it.
- **`customers.assignee_user_id` is the relationship; `conversations.assignee_user_id` is
  the thread.** A new conversation inherits the customer's owner, a colleague can take one
  thread without inheriting the customer, and a merge carries the owner onto the survivor
  when it has none. A column on `customers` is not covered by the repoint list in
  `merge.ts`: it has to be named in the survivor-wins block or it is dropped with the row.
- Browser tests resolve every open conversation before the suite runs (`clearInbox`). The
  suite creates conversations and never deletes them, which cost nothing while the inbox was
  newest-first; with longest-wait-first, days of unanswered test conversations sit at the top
  and push each new arrival past the fifty the list asks for. CI never saw it because it
  seeds from empty.
- A bare `/<slug>` in the console switches to that workspace, so **a tenant cannot be named
  after a console path**: a static route outranks the `$slug` parameter, and a tenant slugged
  `settings` would be unreachable by URL while looking perfectly normal in every list.
  `RESERVED_SLUGS` in `packages/shared/src/workspace.ts` refuses them at creation. Add to it
  when you add a top-level route.
- The slug route resolves against the caller's own memberships, never a lookup by slug. A
  workspace somebody does not belong to must be indistinguishable from one that does not
  exist, or the URL becomes a way to enumerate the tenants on an installation.
- `session.activeOrganizationId` is plain text with no foreign key. It survives being
  removed from a workspace and survives that workspace being deleted, so `chooseMembership`
  falls back rather than trusting it.
- **A handoff always tells the customer.** `ai_handoff` and the unsupported-media branch
  emit `send_acknowledgement {kind:'handoff'}` before the note and the nudge to agents; the
  waiting-human timer sends `kind:'still_waiting'`, a separate apology, so the customer never
  reads the same sentence twice. The language comes from the customer's last message
  (`detectLanguage`), then their record, then the workspace default. Both texts are editable
  per language in Settings → General; if both are empty it logs a warning rather than
  returning in silence.
- **Postgres keeps microseconds and a JavaScript Date keeps milliseconds.** A `created_at`
  read into JS and compared back reads as earlier than its own row, so "nothing newer than
  this" is never true. Compare by message id — ids are time-ordered — as
  `packages/infra/src/idle-resolve.ts` does, and break `created_at` ties on id.
- **An agent's reply does not update `conversations.last_message_at`.** Only an inbound
  message and the AI turn write it; the agent send route and holding messages do not. The
  inbox's "customer spoke last" ordering therefore treats an agent-answered conversation as
  unanswered, and retention ages from the last customer or AI message. Where it matters, read
  the last row of `messages`, as idle-resolve does. Known and not yet fixed.
- **Resolving does not change `mode`.** "Waiting" means `status = 'open' AND mode =
  'waiting_human'` everywhere it is counted: the Inbox badge (`/v1/conversations/counts`),
  the inbox's Waiting tab and the dashboard's `waitingNow`. Filtering on mode alone kept a
  conversation closed mid-wait counted forever, until red read higher than blue.
- **Conversations close on their own** after `autoResolveAfterHours` (default 24, null =
  off) when open, in `ai` mode, our side (AI or colleague — not a system message) spoke last,
  and the customer has been quiet since. A sweep every 15 minutes, not a timer per
  conversation; the close repeats the rule in its own UPDATE so a customer writing mid-sweep
  keeps an open conversation, and it goes through `set_status` so the summary runs. A
  handed-back conversation qualifies; waiting or colleague-owned ones never do.
- **A nullable workspace setting needs `'key' in settings`, not `??`, for its read-time
  default.** Absent means a workspace older than the setting; `null` means somebody switched
  it off, which `??` silently undoes (`withSettingsDefaults`, `autoResolveAfterHours`).
- **Summariser facts go to `customers.notes`, never `customers.fields`.** `fields` holds the
  five identifiers `set_customer_field` accepts, which merge matching compares; the
  summariser used to merge free-form keys in and filled the panel with invented ones. See
  ADR 0007. `notes` is named in the survivor-wins block in `merge.ts`.
- **A running `bun run dev` steals integration-test work.** Queue prefixes are per fixture,
  but `outbox` is one shared table: the dev worker's relay claims a test's rows and runs them,
  and the test's `drainQueue` sees nothing — failures look like unrelated bugs ("job locked
  by another worker", a reply that never arrived). Stop the dev servers before `bun run test`
  and before `bun run test:e2e`.
- **Destructive actions use `ConfirmButton`, never `window.confirm`.** A native dialog blocks
  the page, cannot be styled, is dismissed by reflex, and hangs a browser test with no dialog
  handler. Where there is no button to arm — a select — confirm inline, as the self-demotion
  panel in `Admin.tsx` does. `ConfirmButton` ignores a confirm within 400 ms of arming, which
  is a double-click, so a browser test uses `confirmTwice()` from `e2e/helpers.ts`; erasing
  a customer is a separate step naming them, not a second click.
- **Settings and the inbox keep their tab in the address** (`/settings?tab=general|channels|
  models|integrations`, `/?tab=open|waiting|review|resolved`). A browser test must go to the
  tab its control lives on, or the control is not rendered. Integrations is admins only.
- **Do not call `useSearch({ from })`.** The routes are declared inline and have no id for
  `from` to resolve, so it throws on first render. Read `useRouterState({ select: s =>
  s.location.search })` instead.
- **`display:flex` beats the `hidden` attribute,** which only sets `display:none` in the
  user-agent stylesheet. An element styled as flex needs `[hidden] { display: none }` — the
  widget's typing dots showed from page load without it.
- **The widget's own words are in `COPY` in `apps/widget/src/app.ts`, Thai and English.**
  The language is `data-lang` on the embed tag, else the workspace's language from the
  session, else Thai. The line saying who is answering (`stateText`) comes from the API in
  the visitor's language.
- **`loader.js` must not share a module with the chat app.** It is embedded with a classic
  `<script>`; a shared chunk turns it into a module whose `import` a host page cannot run.
  That is why `launcher-colour.ts` duplicates `readableOn` from `contrast.ts`.
- **Internal notes are interleaved with messages in the thread, clamped to the loaded
  window.** The endpoint windows messages but not notes, so a note older than the oldest
  loaded message is held back until the window reaches it.
- TypeScript is pinned to 5.9.3. Elysia and Eden lean hard on inference and 7.x is too new to
  risk on that path.
- **Storage keys are judged by `isWorkspaceKey`, never `startsWith`.** A prefix check
  accepted `workspaceA/../workspaceB/file`, which the filesystem store resolves into another
  tenant's directory. Every read, signature and deletion uses the canonical check.
- **The restricted fetch connects to the address it checked** (`pinnedRequest`, Node
  `https.request` with a pinned `lookup`, `agent: false`). A pooled agent skips `lookup`
  and would reconnect wherever the pool first went, which reopens the DNS race.
- **The widget shows only delivered replies and pages by `coalesce(sent_at, created_at)`.**
  A reply withheld by a takeover (`canceled`) or still `queued` never reaches the visitor;
  paging by creation time would skip a reply sent after a later row moved the cursor.
- **Messages have `canceled` and `uncertain` statuses.** `canceled`: withheld because a
  colleague took over. `uncertain`: the platform did not answer (`UncertainDeliveryError`),
  so it may have arrived; the outbound job never resends either.
- **`failed` means nothing will try again.** The outbound job writes it only on its last
  attempt (`JobMeta.finalAttempt`); before that the row stays `queued` with the error noted.
  That is what makes the console's resend (`POST /conversations/:id/messages/:messageId/
  resend`) safe: it locks the row, requires `failed`, moves it to `queued` and queues a job
  with a fresh id (`outbound-<id>-resend-<uuid>`), since BullMQ keeps the failed job under
  the old one and would ignore the add.
- **An adapter that sends one message as several requests reports each** (`startAt`,
  `onUnitSent` on `SendContext`); the outbound job checkpoints units in `sent_parts` for a
  non-text message. LINE pushes carry `X-Line-Retry-Key` from the message id and part, and
  a 409 on it means an earlier attempt delivered.
- **Delete rows that name stored files and queue the files in one transaction**
  (`queueBlobDeletions`), then `drainBlobDeletions`. A failed removal stays queued; the
  nightly retention job retries it and queues agent uploads never sent after a day.
- **Membership uniqueness (`member_org_user_uq`) lives in migration 0012, not in
  `schema/auth.ts`,** because `bun run auth:generate` rewrites that file. Inserts into
  `member` use `onConflictDoNothing()`.
- **A reset link carries `issuer_scope`.** A workspace-issued one is re-checked at
  redemption with `accountReach`; widening the account since issue refuses it with 409.
- **A socket re-proves itself on `auth.changed`.** Publish it (to each of the person's
  workspaces) whenever something narrows somebody's access; the socket server closes what
  no longer qualifies with 4401/4403, and the console does not retry those codes.
- **Internal ingestion writes an event id into a body that has none** (a fingerprint of the
  body). Two identical simulator messages to the same customer without an `eventId` are
  therefore one event; a test that means two sends gives each its own id or text.
- **Every stored vector has an `embedding_space`** (`model|dims` or `model|native`), and
  dense search and recall compare only within the query's space. A new embedding writer
  stores `embedded.space` from `embedTexts`.
- **Summaries are incremental** from `conversations.summarized_through_message_id`; recall
  rows are appended, never rebuilt, and recall excludes the current conversation only from
  the start of the visible window.
- **`ProviderProfile.revision` is the provider's `updatedAt`.** The model caches rebuild a
  client when it changes; a builder of profiles sets it, or a rotated key lingers.
- **The console asks `can(me, capability)` (`apps/web/src/lib/capabilities.ts`)** before
  offering an action or firing a query a role will be refused. Viewers get read-only notes.
- **Modals use `Dialog` from `ui.tsx`** (focus in, trap, Escape, inert `#root`, focus back).
- **`useSaveState` returns a sequence from `onMutate`;** pass `(data, variables, context)`
  through when wrapping `onSuccess`/`onError`, or an older save's outcome can overwrite a
  newer one.
- **Browser tests that embed the widget serve a host page from `127.0.0.1`** against the
  widget on `localhost`, with Chrome's `LocalNetworkAccessChecks` disabled in
  `playwright.config.ts`; a public-looking hostname cannot load a loopback script at all. A
  phone-width host page needs a viewport tag, or the phone lays it out at 980px.
- **Playwright projects are selected by tag:** untagged tests run on desktop Chromium,
  `@mobile` on a Pixel 7, `@theme` in dark mode and Thai.

## Adding things

**A channel:** implement `ChannelAdapter` in `packages/channels/src/adapters/`, register it in
that package's `index.ts`, and add fixture tests. Nothing else changes: the webhook route,
worker and console are already channel-neutral. Where the platform publishes typed webhook
definitions, type the fixtures with them, so a payload the platform would not send fails to
compile. Where it does not, say so in the test file rather than letting composed fixtures read
as authoritative. Implement `fetchMedia` if the platform sends references rather than bytes,
and `checkCredentials` so settings can verify a token without waiting for a customer.

**An AI tool:** add it to `createInternalTools` in `packages/core/src/ai/tools.ts` **and to
`RESERVED_TOOL_NAMES` in `packages/shared/src/tools.ts`**. Both: the reserved list is what
stops a tenant defining a tool of the same name, which the settings route would otherwise
accept and `mergeToolSources` would then silently drop, leaving the built-in one missing
from that workspace with nothing logged at definition time. Tools record intent on the
scratchpad and never write to the database, so a failed turn leaves no partial side effects.
A tool a *tenant* defines is not code: it is a `tools` row an admin writes in settings,
offered through `createHttpToolSource`.

**A tool source:** implement `ToolSource` from `packages/core/src/ai/tool-source.ts` and add
it to the list the worker passes to `runAgentTurn`. The agent takes sources rather than
tools precisely so this needs no change to the turn. The internal source is merged first and
wins any name clash.

**A tenant-owned table:** add `workspace_id` with `onDelete: 'cascade'`, and ask whether it
holds anything a person would want to keep. If it does, it goes on the repoint list in
`packages/infra/src/merge.ts`. If it points at stored media, its key column goes into
`eraseWorkspace`, because blobs do not cascade.

**A migration:** edit `packages/db/src/schema/app.ts`, run `bun run db:generate`, review the
generated SQL, then `bun run db:migrate`. A migration that moves data should be idempotent
(a second run finds nothing to move); take a `pg_dump` before deploying it.

**A workspace setting:** it is one jsonb document, so no migration. Add the key to
`WorkspaceSettings` (`packages/db/src/schema/app.ts`) and `defaultWorkspaceSettings`, give
it a read-time default in `withSettingsDefaults` (`packages/infra/src/repo.ts`) so older
workspaces get it, accept it in the PATCH schema in `apps/api/src/routes/settings.ts`, add it
to the web `WorkspaceSettings` type, and set it in `DEFAULT_SETTINGS` in
`apps/worker/test/helpers/fixture.ts` if tests depend on it.

## Pull requests

Feature branches into `main`. CI runs lint, typecheck, migrations, tests, the web build, the
browser tests, and builds both release images and requires them to start healthy.
End commit messages with:

```
Co-Authored-By: Claude <model> <noreply@anthropic.com>
```
- **One turn per customer message, but a superseded one steps aside.** An AI turn that finds
  a newer customer message with its own `ai-turn-<id>` row in the outbox drops itself: before
  the model call, after it, and under the commit lock — the last only if none of its tenant
  writes fired, since then its reply is the customer's only account of them. A newer message
  with no turn owed (it arrived while a colleague held the conversation) never silences the
  older turn. `outbox_job_id_idx` (migration 0015) keeps the lookup cheap.
- **Settings and knowledge entries carry a revision** (`revision` from `GET /settings/
  workspace`, an entry's `updatedAt`). A save sends the one it started from and a mismatch
  is a 409, so nobody overwrites a value they never saw. **Never take that revision from the
  query cache at save time**: the socket's reconnect refetches every query, which moves the
  cache on while the fields still show the old text. Settings keep it in a ref (first load,
  own saves, a conflict); the entry editor takes it at focus and follows its own chain of
  saves through a map. Saves go one at a time. Omitting `revision` still overwrites.
- **Index swaps re-check under a lock.** `indexEntry` locks the entry and stores nothing if
  its text changed while embedding (the edit queued its own job); `replaceFileSource` locks
  the source row, since two concurrent swaps could not see each other's new entry and left
  the document indexed twice.
