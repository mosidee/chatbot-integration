# Architecture

## Processes (Docker Compose)
- **api** — Elysia on Bun. HTTP + WebSocket. Stateless. Webhook endpoints verify signature, persist raw event, enqueue, return 200. Also serves the built console and the widget from disk, so one hostname fronts the product; neither has a process of its own.
- **worker** — Bun. BullMQ consumers: inbound, ai_turn, suggestion, outbound, the waiting_human timer, summarize, knowledge_ingest, retention (nightly), idle_resolve (every 15 minutes), customer and workspace erasure; plus the outbox relay and the two job schedulers.
- **postgres** (pgvector, pg_trgm), **redis** (queues + pub/sub). Media is in an S3-compatible bucket outside the stack — Cloudflare R2 in production (ADR 0008), the filesystem locally.

## Monorepo
```
apps/api  apps/worker  apps/web  apps/widget
packages/core      framework-free domain: conversation state machine, AI harness, retrieval, memory, redaction, tool registry
packages/channels  normalised message model + adapters: line, messenger, web, test
packages/db        Drizzle schema + migrations (workspace_id on every tenant-owned table), auth config, encryption
packages/infra     runtime wiring: Redis, queues, storage, repository, effect ports
packages/shared    Zod schemas and the types shared with the browser
packages/config    environment parsing
workers/line-media Cloudflare Worker that fetches LINE media for the worker (ADR 0009); not a Bun workspace
```
The browser talks to the API through a hand-written `fetch` client (`apps/web/src/lib/api.ts`), not Eden Treaty: inferring the whole route tree into the browser build made the frontend typecheck depend on the server's inference and slowed it markedly.
Rule: `apps/*` are thin. Nothing in `packages/core` imports Elysia, Bun-only APIs, or React.

## Inbound flow
channel webhook → adapter.verify + adapter.normalise → `inbound_events` (raw, idempotent on platform id) **+ an `outbox` row, one transaction** → relay → queue `inbound` → worker: upsert identity/customer/conversation → redact → store message → publish realtime → decide by `conversation.mode`:
- `ai` → queue `ai_turn` → agent loop → trace → store the reply and queue `outbound` in one commit → adapter sends
- `ai_supervised` → agent loop → store draft → notify humans
- `human` → queue `suggestion` → store suggestion (never send)
- `waiting_human` → queue `suggestion` for whoever picks it up. The customer was already told at handoff (`acknowledgementText`); if nobody has picked up after `waitingHumanFallbackMinutes`, the timer sends `stillWaitingText` and nudges agents

## Turns that overlap (apps/worker/src/processors/ai-turn.ts)
Every customer message queues its own turn, keyed `ai-turn-<message id>`. A turn that finds a newer customer message with its own turn owed — an `ai_turn` outbox row that was not cancelled — steps aside, because the newer turn sees both messages and answers them together (`newerTurnOwed`, served by `outbox_job_id_idx`). It asks before calling the model, after it, before storing a draft, and under the commit lock; the last only if none of its tenant writes fired. A newer message that arrived while a colleague owned the conversation queued no turn, so it never silences the older one. Inbound locks the conversation row before storing a message, so within one conversation message ids follow commit order and the newer turn always sees the older message.

A turn's replies, drafts, traces, notes and summaries are masked with the workspace's redaction rules as they are written (`recordTrace` requires them; `redactDeep`), not only the customer's messages.

## Agent loop (packages/core/src/ai)
Context = system prompt (workspace persona, language rule) + customer summary + recent window + retrieved chunks (pre-fetched) + tools. Model via Vercel AI SDK `openai-compatible` provider chosen from task slot `agent_chat` with fallback. Tools come from sources: the internal registry and tenant-defined `http_tool` rows today, an MCP client next (see Tools below). Structured output is used by the summariser only; quick replies as structured output are not built. Every turn writes `ai_traces`.

## Retrieval (packages/core/src/rag)
Chunks table with `embedding vector`, `tsv`/trigram index, workspace + language + source filters. Query: dense top-k ∪ keyword top-k → RRF → optional rerank slot → threshold → chunks with scores. Same function serves the AI and the human suggestion panel. External adapters implement the same `retrieve(query, opts)` interface.

Editing knowledge is guarded twice. An entry's `updatedAt` is its revision: a save that started from an older one is refused with 409, as is a settings save carrying a stale `revision`. And a reindex re-checks under a row lock before it swaps chunks: `indexEntry` stores nothing if the entry changed while it was embedding, and `replaceFileSource` locks the source so two reindexes of one file cannot both insert.

## Key tables
Tenant-owned, every one carrying `workspace_id`: channels, channel_identities, customers, merge_suggestions, conversations, messages, internal_notes, inbound_events, ai_traces, suggestions, feedback, handoff_events, tools, identity_verifications, workspace_invitations, knowledge_sources, knowledge_entries, knowledge_chunks, conversation_embeddings, customer_summaries, providers, task_slots, canned_responses, audit_log, blob_deletions. `customers.fields` (the five identifiers `set_customer_field` accepts) and `customers.notes` (what the summariser observed) are separate `jsonb` columns, see ADR 0007; attachments live inside `messages.content`.

`workspaces` is a one-to-one extension of Better Auth's `organization`. Better Auth owns its own tables, without `workspace_id`: user, session, account, verification, organization, member, invitation (`packages/db/src/schema/auth.ts`, regenerated by `bun run auth:generate`). Its `invitation` table is unused: ours is `workspace_invitations`, which stores a hash rather than the token and carries a purpose.

Three tables are deliberately **not** tenant-owned (`packages/db/src/schema/platform.ts`): `platform_admins`, `platform_audit_log` and `workspace_erasures`. None has a `workspace_id`, and `workspace_erasures` has no foreign key at all, because all three have to survive the deletion of the tenant they describe — a workspace's own `audit_log` cascades with it and so cannot record its own erasure. The `outbox` carries a `workspace_id` for logs but no foreign key, for the same reason: an erasure job must outlive the cascade it performs.

## Tenancy (apps/api/src/context.ts, auth-plugin.ts)
A tenant is one workspace, and `workspaces.id` *is* `organization.id`. Membership is Better Auth's `member` row; the role on it is plain text, and anything unrecognised reads as `agent`, which is the safe direction to be wrong in.

`loadMemberships` joins member × organization × workspaces in one query, so a request's role and its workspace's status are read together and cannot disagree. `chooseMembership` picks the session's active organization when it names one the person belongs to, and their oldest membership otherwise; a stale active id is ordinary, because Better Auth stores it as text with no foreign key and it survives both removal from a workspace and that workspace's deletion.

Three guards, each resolving its own shape: `auth: 'agent'` (a user, a workspace, a minimum role, and a workspace that is active), `session: true` (a user, no workspace — used by `/settings/me`, which has to answer while every workspace the caller belongs to is suspended), and `platform: true` (a user and a row in `platform_admins`, no workspace at all). They live in one `.macro()` call because two plugins each carrying a global macro do not merge in the type.

`workspaces.private_egress_origins` is the one tenant-owned column a tenant cannot write: the origins its providers may reach although private or plain http. It sits on the row rather than in `settings` because tenant admins write `settings`, and only the `platform: true` tenant PATCH writes it. `workspaceProviderFetch` reads it per call site and hands back the restricted client for that list.

**Status.** `active | suspended | deleting`. Suspended and deleting are refused to every member including the workspace's own admin, before the role is even compared. Webhooks for a suspended tenant answer 200 and discard, so LINE and Meta do not disable the endpoint over a reversible state; the widget says plainly that the workspace is suspended, because there is a person reading it. `deleting` reads as gone everywhere public. Queued jobs check `workspaceIsWorkable` and drop with a log line — including the AI turn, which is the one deliberate exception to the rule that a turn never ends in silence, since every agent who could be handed the conversation is locked out too.

**Erasure.** `requestWorkspaceErasure` sets the status, writes a `workspace_erasures` row and promises the job, all in one transaction. `eraseWorkspace` refuses without that row, saves the media keys onto it (message attachments *and* `knowledge_sources.storage_key`, which the retention sweep never reads) before deleting the organization row, then removes the objects and shrinks the list to whatever failed, so a retry works on the remainder.

**Slug URLs.** `/<slug>` is not a route into a tenant; it switches the session to that workspace and redirects to the inbox, so the workspace still comes from the session and nothing else in the console learns about the URL. The lookup is over the caller's own memberships, so a slug they do not belong to is indistinguishable from one that does not exist. Console path names are refused as slugs (`RESERVED_SLUGS`), because a static route outranks the parameter.

**Invitations.** A single-use token, stored as a SHA-256 hash, with a purpose of `invite` or `password_reset` and an expiry. The accept route spends the token and writes the membership in one transaction; accounts are created through a second Better Auth instance that allows sign-up and is never mounted, so the public API stays invite-only. A password reset goes through `auth.$context.internalAdapter`, because `setPassword` refuses an account that already has one.

## Asking for work (packages/infra/src/outbox.ts)

Nothing in the product calls BullMQ. Work is asked for by writing a row to `outbox`, in the
same transaction as the change that made it necessary; a relay in the worker moves those rows
to the queue. `Runtime` carries no queues at all, so a route or processor cannot reach past
the relay even by accident.

The writer chooses the job id — the message being delivered, the customer message that
prompted a turn — which is what makes both retries safe: BullMQ ignores an `add` for an id it
holds, and the consumer can recognise its own earlier attempt from the same id. Rows are
claimed `FOR UPDATE SKIP LOCKED`, so a second worker replica relays alongside the first.

The relay wakes on `pg_notify`, which Postgres delivers at commit and drops on rollback, and
sweeps on a one-second timer besides. The worker's health endpoint reports the pending count
and the age of the oldest row, and calls itself degraded past a minute. Relayed rows are
pruned after a day. See ADR 0006.

## The inbox queue (apps/api/src/routes/conversations.ts)
Ordered in SQL, and nothing re-sorts it in the browser. Three groups, by who owns the *customer*: yours, then nobody's, then somebody else's. Inside each, longest wait first, where waiting means either the conversation was handed to a person (`waiting_human_since`) or the customer spoke last and nobody has answered (`last_customer_message_at >= last_message_at` — and an agent's reply does not update `last_message_at`, so an agent-answered conversation still reads as waiting here; known, not yet fixed); anything nobody is waiting on falls to the bottom of its group, newest first.

Ownership deliberately outranks urgency: a colleague's overdue conversation sits below your quiet one, because the person who owns a relationship is the one who should answer it. `customers.assignee_user_id` is that owner and outlives every conversation; `conversations.assignee_user_id` owns one thread, is inherited from the customer when a new conversation opens, and can be handed to somebody else without changing the relationship. The list pages by `offset` and returns `nextOffset`; the order is total (id breaks every tie), so a queue that is not changing is reached once. `?q=` searches it: a substring `ILIKE` on the customer's name, the values of their identifiers and every message's text, within the workspace and the current tab, served by the trigram index `messages_text_trgm_idx`.

## Conversation continuity (packages/infra/src/repo.ts)
One conversation per channel identity, found or created under a row lock on that identity because inbound runs ten jobs at a time. A resolved conversation is reopened by the customer's next message rather than replaced, in the mode a new one would have started in and carrying the customer's owner: the customer sees one unbroken chat on their phone, and splitting it where a colleague decided they were finished gave the agent a fragment of it. The state machine therefore never observes a resolved conversation on a customer message; an agent writing into one still reopens it there.

The panel loads the most recent thirty messages and fetches older pages by cursor (`GET /v1/conversations/:id?before=<message id>`) only while scrolling up; ids are time-ordered, so there is no cap and a long thread's opening is reachable. Internal notes are interleaved by time, held back while they are older than the oldest loaded message (the endpoint windows messages but not notes), and the thread is broken by day.

The Inbox in the navigation carries two counts on every page, blue for open and red for waiting, from one query (`/v1/conversations/counts`). Waiting is `status = 'open' AND mode = 'waiting_human'` there, in the inbox's Waiting tab and in the dashboard banner alike: resolving does not change the mode.

## Sending a file (packages/infra/src/media-links.ts)
Inbound media is downloaded into our own private storage and read back as bytes (ADR 0001). Outbound cannot work that way: LINE and Messenger take a URL and fetch it from their own servers with no session, so `withMediaLinks` turns the storage key into a link signed with `APP_SECRET_KEY` and carrying an expiry, and `/api/media/*` serves it publicly by verifying that signature. The link is unguessable and dies on its own; the platforms cache what they fetch, so the customer keeps the file after it does. `MEDIA_LINK_TTL_DAYS` sets the lifetime, seven days by default.

Adapters remain pure translators reading `sourceUrl`. LINE has no document message type at all, so a file becomes a Flex card naming it with a button that opens the link, and the card's `altText` repeats the link for clients that cannot render one; Messenger carries it natively. Neither platform's media message has a caption field, so an agent's note goes out first as its own message.

## Review queue (packages/infra/src/review.ts)
One SQL fragment, `inReviewQueue()`, correlated on the `conversations` row of whatever query uses it, so the inbox list, the tab's count badge and the dashboard all ask the identical question. It reads: no handoff reason, no message with `sender_type = 'human'`, and some message with `sender_type = 'ai'` newer than `conversations.reviewed_at`. `reviewed_at` is written with the database's `now()`, because it is compared against `messages.created_at`, which `defaultNow()` writes on the same clock. Feedback rows hang off the conversation and cascade with it, which is how retention and erasure reach them.

## Tools (packages/core/src/ai/tool-source.ts, http-tool.ts)
The agent takes tool **sources**, not tools: `internalToolSource` contributes the built-in registry, `createHttpToolSource` contributes one entry per `tools` row, and a connected MCP server will contribute a set. The turn never learns which produced what. The internal source is merged first and a reserved name is refused at definition time, so nothing a tenant writes can shadow `handoff_to_human` and leave the AI unable to fetch a person.

A definition separates the arguments the model fills from the values the system binds (`subject`, `customer_id`, `conversation_id`, `workspace_id`). The model's input schema is built from the arguments alone and strips everything else, and bindings are applied after arguments when the request is composed, so a model-supplied value cannot win over a system-supplied one even if it reached that far. A tool binding `subject` is not offered at all in a conversation where nothing was proved.

`effect: 'read'` runs during the turn. `effect: 'write'` records intent and the worker fires it after the turn, before the reply is stored, with an idempotency key decided when the model asks, from the BullMQ job id, the tool name and a fingerprint of the arguments, so a retried turn that reorders its calls still lands each one once; a failure discards the reply and hands off with `tool_error`, in a note naming what did succeed as well as what did not, because the writes ahead of the failure already landed. A turn that ends in a handoff for any other reason abandons its pending writes unfired: the model asked for them on the way to deciding it could not finish, and a conversation going to a person should not also have changed something on its own initiative. Writing tools are never offered while the AI is drafting for a human. A tool that cannot be reached, answers with an error status or times out ends the turn with a person rather than a model left to invent an answer. Arguments the model got wrong are a different case and are handed back to it to correct, because the endpoint was never called and nothing failed on the tenant's side.

Tenant endpoints — tools, model providers, embeddings, rerank, external retrieval — go through `packages/infra/src/egress.ts`; see ADR 0004. Private or plain-http origins are reachable only when a platform admin approved them for that tenant (`workspaces.private_egress_origins`). Redirects are followed by hand, which means the two things `fetch` would otherwise do have to be done explicitly: only an allowlist of identifying-nobody headers crosses to another origin, a cross-origin 307/308 is refused, and 301, 302 and 303 become a GET without a body.

Stored files are served back on the console's origin through `mediaServingHeaders` (`packages/infra/src/media-serving.ts`): raster images, audio, video and PDF inline, everything else as an attachment, always `nosniff`, and a script-free CSP `sandbox` on all but PDF. Every storage key is judged by `isWorkspaceKey`, which refuses any spelling that is not the canonical path inside the workspace.

Deleting stored files goes through `blob_deletions` (`packages/infra/src/blob-deletions.ts`): keys are queued in the transaction that deletes the rows naming them and removed afterwards, and a row leaves the table only when its object is gone. Retention, customer erasure and knowledge-source deletion all use it; the nightly retention job drains what failed and queues agent uploads nobody sent.

Delivery keeps a checkpoint per unit, not only per text part: one message sent as several requests (Messenger's text and then each file) resumes after the last unit taken, every platform id is kept, LINE pushes carry `X-Line-Retry-Key`, and a Messenger send that got no answer is `uncertain` rather than retried. A reply withheld by a takeover is `canceled`. `failed` is written only when the outbound job has used its last attempt (`JobMeta.finalAttempt`), or by the worker's terminal-failure hook when the job failed before reaching the send; until then the row stays `queued`. An agent can resend a `failed` message (`POST /v1/conversations/:id/messages/:messageId/resend`): the row is locked, moved back to `queued` and given a fresh job id, and `sent_parts` makes it resume after what already went out. `messages.sent_at` is when the platform took it; the widget pages by it and the dashboard measures from it.

Live sockets re-prove themselves: the socket server re-checks session, membership and workspace status on `auth.changed` (published on removal, role change and password reset) and `workspace.status`, and every five minutes, closing with 4401 or 4403. The console runs one socket in the shell and refetches everything on screen after a reconnect.

## Identity (packages/infra/src/identity.ts)
`channel_identities.external_id` says which LINE account or browser is writing. `verified_subject` says who that was proved to be, and only it may be bound into a tool call; `customers.fields` is what somebody typed into a chat and is never evidence. Two proofs write it: a token the host application signs, which the widget presents once at session start and the signed session carries thereafter, and a one-time verification link, where we mint a code, the customer opens the tenant's page, and that page posts the code back with a token it signed. `POST /api/identity/confirm` looks the code up without claiming it, verifies the token against the workspace's configured secret, and only then spends it — in a single UPDATE that both checks and claims, so two requests racing one code cannot both win. The order matters as much as the atomicity: spending first would let a bad token destroy a customer's only link, and the code travels through a chat message they can read. Each proof has its own switch in workspace settings, and `boundIdentityFor` withholds a subject whose proof is no longer accepted.

## Handoffs (handoff_events)
`conversations.handoff_reason` is current state: why this conversation is waiting now, cleared when a person hands it back. `handoff_events` is history, written by a `record_handoff` effect the state machine emits from both handoff paths — the AI giving up, and media it cannot read. The dashboard's reasons and its handoff total both read the log, so a conversation an agent has already dealt with still counts, and a media handoff that never ran an AI turn is visible. The effect carries the instant the state machine decided, and the table is unique on `(conversation_id, occurred_at)`, so a retried job replaying an already-computed effect list writes the row it already wrote.

Both paths also emit `send_acknowledgement {kind: 'handoff', language, at}`, before the note and the nudge to agents, so the customer is told first. The language is what the customer last typed — `customerLanguageEvidence` (`packages/infra/src/repo.ts`), the newest of their last five messages with words in it, via `typedText` and `detectLanguage` — so a photo's stored placeholder `[image]` is never mistaken for English. With no typed evidence the port falls back to the customer's recorded language and then the workspace default. The message is keyed `ack-<kind>-<conversation>-<at ms>` in `messages.turn_key`, so a replayed effect list stores one and delivers it once.

## Merging customers (packages/infra/src/merge.ts)
Each channel identity creates its own `customers` row; nothing is linked automatically. When `set_customer_field` records a `phone`, `email` or `account_id` that actually changed, the worker looks for another record in the workspace whose same key normalises identically and writes a `merge_suggestions` row. The pair is stored with the older id first, under a unique index, and `onConflictDoNothing` is what makes a rejection permanent. Accepting repoints `channel_identities`, `conversations`, `conversation_embeddings` and `customer_summaries` — every table holding the person's history — and only then deletes the absorbed row, inside one transaction, because all of them cascade on delete. The fifth referencing table, `merge_suggestions`, is left to the cascade on purpose. An `audit_log` entry with both ids is the lasting record. Columns on `customers` are not covered by repointing and are named in a survivor-wins block instead: `fields`, `notes`, the owner and the rest.

## Closing quiet conversations (packages/infra/src/idle-resolve.ts)
The worker schedules a pass every 15 minutes. With no workspace in the job it plans: one job per active workspace, keyed `idle-resolve-<workspace>-<slot>` so a restart cannot run a slot twice. Per workspace, with `autoResolveAfterHours` set, it finds conversations that are open, in `ai` mode, whose last non-event message came from the AI or a colleague — not the customer, and not a system holding message — and is older than the cutoff. Who spoke last is read from `messages`, not `last_message_at`, which misses agent replies.

Each close is its own transaction, and the UPDATE repeats the rule, with "nothing written since" checked against the last message's id rather than its time (Postgres keeps microseconds, a JS Date does not). The effects are the state machine's own `set_status: resolved` — the summary job among them — plus an internal note saying it was automatic. A customer who writes again reopens the conversation as after any resolve. A sweep rather than a timer per conversation, because timers would need cancelling on every reply and a missed cancel closes a live conversation.

## Media storage (packages/infra/src/blob.ts, blob-fs.ts, line-media-proxy.ts)
Media lives in an S3-compatible bucket, Cloudflare R2 in production (ADR 0008), or on disk where `S3_ENDPOINT` is a `file://` path, as in local development and CI. LINE sends media only as a reference; from the pilot server its content endpoint is reached over a lossy route, so when `LINE_MEDIA_PROXY_URL` and `LINE_MEDIA_PROXY_SECRET` are set the download goes through a Cloudflare Worker (`workers/line-media`, ADR 0009), which fetches LINE's content URL for a numeric message id and streams the bytes back. The worker stores them on the ordinary path, with its key rules and size limit, and falls back to fetching directly if the Worker fails.

## The widget (apps/widget, apps/api/src/routes/widget.ts)
A loader script and an iframe app with no framework. The poll carries who is answering (`state`, and a `stateText` line composed server-side in the visitor's language) and who wrote each message (`sender`); the first page is the newest thirty. The contract with a host page, including the postMessage protocol, is in `docs/WIDGET.md`.

## Scale path
Same images on Fly.io / Cloud Run / k3s / Cloudflare Containers. Requirements already met: stateless api, Redis fan-out, separate worker, S3 client, pooled Postgres.
