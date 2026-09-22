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
- `TOOL_EGRESS_ALLOW_PRIVATE` lets a tenant-defined tool reach loopback and private
  addresses. Tests and local development need it; `createRuntime` **throws at startup** if
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
  following. Credential headers must be dropped by hand when the origin changes, and 301,
  302 and 303 must become a GET without a body, or a write is replayed at the new location.
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
- The conversation panel loads the **most recent** thirty messages and widens the window as
  somebody scrolls up. It used to take the first two hundred, which showed a long thread's
  opening and hid everything an agent needed. Paging widens the window rather than walking a
  cursor backwards, so a reply arriving while somebody reads history cannot open a gap in
  the middle of what they are looking at.
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
generated SQL, then `bun run db:migrate`.

## Pull requests

Feature branches into `main`. CI runs lint, typecheck, migrations, tests and the web build.
End commit messages with:

```
Co-Authored-By: Claude <model> <noreply@anthropic.com>
```
