# chatbot-integration — Requirements and Feature List

Status: living document, first shaped 2026-09-20, last brought up to date 2026-09-24 after the UX pass. Edit freely; this is the source of truth for scope.

## 1. Purpose

An AI customer-chat harness that talks to customers over **Facebook Messenger**, **LINE**, and an **embeddable web widget**, answers from a **RAG knowledge base** and **customer history**, and lets **human agents take over** (or the AI hand off) per conversation through a **web GUI**. Any **OpenAI-compatible model/provider** can be used.

Pilot tenant: **salon-saas** (the operator's own SaaS). Pilot customers are salon owners and prospects asking about the salon-saas platform (pricing, onboarding, features, billing, bugs). Not end-consumers of individual salons.

## 2. Decisions taken (with rationale)

| # | Decision | Choice | Why |
|---|---|---|---|
| 1 | Tenancy | Single business now, **tenant-ready schema** (`workspace_id` on every table), one workspace of UI | Cheap now, keeps SaaS door open |
| 2 | Build vs fork | **Build ourselves**, reuse libraries only | AI+human loop lives in the GUI; bolting it onto Chatwoot's Rails UI is painful. Chatwoot remains the fallback |
| 3 | Deployment | **Docker Compose on operator's VPS** (public IP, Nginx Proxy Manager, Let's Encrypt). Scale-up via containers (Fly.io / Cloud Run / k3s / Cloudflare Containers), not Workers | Long LLM calls, WebSockets and ingestion jobs fit containers |
| 4 | Stack | **Elysia on Bun**, Drizzle ORM, Postgres + pgvector, Redis (BullMQ + pub/sub), MinIO (S3 API), **Vite React SPA** with Tailwind and hand-rolled components, Bun workspaces monorepo, **Zod** schemas shared, hand-written typed `fetch` client | Team preference; thin HTTP layer keeps core framework-free. shadcn/ui, TypeBox and Eden Treaty were in the original plan and not adopted: Eden's route inference slowed the browser typecheck and tied it to the server's |
| 5 | Customer identity | Contact per channel identity → `customers` record; **merge suggested** by shared phone / order ID, **human confirms**; never auto-merge | Avoid leaking one customer's history to another |
| 6 | Conversation modes | `ai` (default for pilot), `ai_supervised`, `human`, `waiting_human`; selectable per workspace / channel / conversation. **AI never sends while mode is `human`** | Trusted pilot partner; supervised mode ready for later |
| 7 | AI capabilities | **Tool-using agent**: internal tools first, the registry designed for HTTP tools and MCP later. Both halves happened — see rows 18 to 20. Fallback to answer-only for models without function calling | Option 3 is "register another tool" |
| 8 | Knowledge sources | Q&A entries, articles, PDF/DOCX upload (parser behind interface), promote human replies to knowledge, external-retrieval adapter; website crawl later. **Hybrid search** (pgvector + trigram keyword, RRF, optional rerank) | Thai product terms need keyword match |
| 9 | Memory & retention | Recent window + per-customer rolling summary always on; semantic search over past conversations as a tool. Default retention 2 years, per-workspace; one-job "delete customer". **Redact card numbers and Thai 13-digit ID numbers** before storage and before any model call | PDPA |
| 10 | Model providers | **Provider profiles + per-task model slots + fallback**. Pilot providers: OpenAI, OpenRouter, operator's self-hosted 9router. Every call logged with provider/model/tokens/latency/cost | Outages must not become silence |
| 11 | GUI v1 | Inbox, conversation view, AI sidebar, customer panel, knowledge management, settings, minimal dashboard, **canned responses**, **mobile-friendly** | Cut list ordered by importance |
| 12 | Channel onboarding | Manual credential paste for LINE and Messenger in pilot; Meta App Review started as soon as webhook works; OAuth connect flow only for second tenant | Review is on the critical path |
| 13 | Message types | All inbound types stored/rendered for humans; **images to vision model** (on); other media → configurable handoff. Outbound: text (per-channel splitting), images, files, quick replies. Rich templates later | Salon-saas screenshots |
| 14 | Dev/test | Internal **test channel** (simulator) from sprint 1 → grows into **web widget with signed-token identification** of logged-in salon-saas users. Staging on VPS for real webhooks; fixture-based adapter tests | Pilot can start on widget before Meta approval |
| 15 | Languages | GUI Thai + English (i18n, Thai default). AI matches customer's dominant language, workspace default Thai. Per-language knowledge variants. Trigram search for Thai | Thai has no word spaces |
| 16 | Quality loop | Thumbs feedback + implicit corrections (draft vs sent), review queue for unsupervised AI conversations, full per-turn trace in v1; automatic grading next; regression evals once knowledge stabilises | Pilot must end with numbers |
| 17 | Phasing | M1 skeleton+loop → M2 knowledge+memory → M3 real channels → M4 pilot readiness → M5 salon-saas tools → M6 tenant and user management. v1 = M1–M4 | Architecture proven before features pile on |
| 18 | Tool extensibility | The agent takes tool **sources**, not tools. `http_tool` (one configured endpoint) and an **MCP client** (a connected server's whole set) are two sources behind one interface; both are **tenant-facing**, configured per workspace by an admin. `http_tool` first | `http_tool` is the low floor: any tenant with an endpoint, no server to run. MCP is the ceiling: the tenant owns the definitions and adds tools without us shipping. A source interface from the start keeps the agent loop untouched when the second arrives |
| 19 | Tool identity | A tool definition separates **arguments the model fills** from **values the system binds** (verified customer, workspace, conversation). The model can neither name nor override a bound value, and a tool needing identity cannot run in a conversation where identity was never proven | Letting a model choose whose account to read is the cross-customer leak in a new place. `get_customer_profile` already does this with an empty input schema; the config format promotes it |
| 20 | Tenant-defined egress | A tenant-defined tool is fetched through a **restricted client**: HTTPS only, hostname resolved and the resolved address checked, loopback / private / link-local / CGNAT refused, re-checked on redirect. Operator-level provider config keeps the unrestricted client | A tenant typing a URL gets a request origin inside our network: the worker shares a network with Postgres, Redis and MinIO, and the model gateway answers on a private address. Checking the hostname alone survives neither a name that resolves inward nor one that changes answer after the check |
| 21 | Identity proofs | Two ways to prove who a customer is, each switched on and off separately: a **widget token** the host application signs, and a **one-time verification link** the person follows and confirms inside that application. A proof that is switched off still identifies a returning visitor, but binds no tool | They are not equivalent, and a tenant should be able to accept one and not the other: a signed token is worth what the application signing it is worth, and a link is worth whatever login sits behind it. Keeping "who is this" separate from "what was proved" is what lets continuity survive turning a proof off |
| 22 | Platform admin | Who may create and delete tenants is a row in **`platform_admins`**, not a role on a membership. It carries no workspace, and a platform admin reads a tenant's conversations only by inviting themselves into it like anybody else | A role lives inside one tenant; this authority is over tenants, so expressing it as a role would make the word "admin" mean two things and put an ambient cross-tenant path into every permission check. The platform tables also have to outlive a tenant: a workspace's own `audit_log` cascades with it, so it cannot be the record of its own deletion |
| 23 | Adding a person | An admin issues a **single-use link** and passes it on themselves. Only its hash is stored, it expires, and the same mechanism issues a password reset. Accounts are created by a second auth instance the public API never mounts | There is no mail transport here, and adding one — provider, domain, deliverability, queue — before the first colleague can be invited is the wrong order. The security property is identical either way: the link is the credential, works once, and expires. Keeping sign-up disabled on the mounted instance is what keeps the product invite-only |
| 24 | Tenant lifecycle | A workspace has a **status**: `active`, `suspended` or `deleting`. Suspended locks members out, drops queued work and acknowledges webhooks without acting; deleting is set before the erasure job runs and is not reversible. Deleting is confirmed by typing the slug | A suspension has to be reversible and cheap, and must not cost the operator their webhook registration: LINE and Meta disable an endpoint that keeps failing, so a suspended tenant answers 200 and discards. Setting the status before the erasure is what stops new rows arriving while the job collects what to delete |
| 25 | Asking for work | Work is promised as a row in **`outbox`**, written in the transaction that made it necessary, and a relay in the worker moves it to BullMQ. Nothing else touches a queue: `Runtime` carries none | Committing rows and then enqueueing is two systems with no transaction between them, and the gap lost work in four separate places — a customer's message stored but never answered, an AI reply written twice, a tenant stuck mid-deletion. The writer choosing the job id makes relaying and consuming both safe to repeat. See ADR 0006 |
| 26 | The customer is told | A handoff always sends the customer a **holding message**, in the language of their last message; the waiting-human timer sends a **second, different** one. Both texts are the workspace's own, editable per language | "The AI never goes silent" was enforced from the inside: a turn ended in a reply or a handoff. A handoff told agents and said nothing to the person who asked, so from their side the thread simply stopped. Repeating one sentence minutes apart reads like a machine that has lost its place |
| 27 | Closing quiet conversations | A conversation **closes itself** after the customer has been quiet for `autoResolveAfterHours` (default 24, off when empty) — only when the AI is answering and our side spoke last. A sweep every 15 minutes, not a timer per conversation | Resolving is what folds a conversation into the customer's summary, so one the customer walked away from was never remembered. Waiting and colleague-owned conversations are owed somebody's reply and are never closed. A sweep reads the truth each time; per-conversation timers would need cancelling on every reply, and a missed cancel closes a live conversation |

Pilot success metrics: share of conversations fully handled by AI with no negative rating and no repeat question within 24 h; median first-response time.

## 3. Feature list

Legend: **[v1]** in version 1 (M1–M4), **[M5]** milestone 5, **[M6]** milestone 6, **[next]** the milestone after, **[later]** backlog.

### 3.1 Channels
- [v1] Normalised message model; every adapter translates to/from it
- [v1] LINE Messaging API adapter (webhook signature verify, reply-token first, push fallback, follow/unfollow, postback, unsend, stickers, media download)
- [v1] Facebook Messenger adapter via Graph API (webhook verify + X-Hub-Signature-256, page token, quick replies, referral params, read receipts, media)
- [v1] Internal test channel / simulator page
- [v1] Embeddable web chat widget (script tag), anonymous or **signed-token (JWT) identified** user
- [v1] Channel settings: paste credentials, show webhook URL, signature status, a credential check button. ("send test message" was planned and not built; the check verifies the token without messaging anyone)
- [v1] Webhook ingestion: verify → persist raw event → enqueue → 200 within ms; idempotency on platform message IDs
- [later] "Connect Facebook Page" OAuth flow; LINE Login
- [later] Additional channels, in order of ease: **Instagram DM** (Meta Graph API, same review as Messenger), **Telegram** (Bot API, no review), **WhatsApp** (Meta Cloud API; needs business number, Business Verification, 24 h customer-service window and paid templates outside it), **TikTok** (Business Messaging API is partner-gated via TikTok Business Center, region-restricted in EEA/CH/UK; TikTok Shop Customer Service API is a separate, harder approval). Design hooks now: per-conversation messaging-window expiry, and a template outbound message type
- [later] Rich templates (LINE Flex, Messenger generic template) via channel-neutral card schema

### 3.2 Conversation and handoff
- [v1] Modes `ai` / `ai_supervised` / `human` / `waiting_human`, defaults per workspace and per channel
- [v1] AI→human handoff: the `handoff_to_human` tool, with the model choosing the reason from a fixed list. Media the AI cannot read hands off without a turn. (A confidence threshold, a sentiment check and keyword/intent rules were planned and not built; the model's own judgement has covered the pilot)
- [v1] Handoff reason posted as internal note
- [UX] The customer is told on every handoff, including media the AI cannot read: `acknowledgementText`, in the language of their last message (`detectLanguage`), editable per language in Settings → General. (`businessHours` is stored and nothing reads it)
- [v1] One-click take over; one-click return to AI with optional instruction note the AI reads
- [v1] `waiting_human` queue. After `waitingHumanFallbackMinutes` the customer gets a second, apologetic holding message (`stillWaitingText`) and agents are nudged; the conversation is not handed back to the AI
- [UX] Conversations close on their own after `autoResolveAfterHours` (default 24, empty = off) when open, the AI is answering, our side spoke last and the customer has been quiet since; the close runs the summary like a manual resolve, leaves an internal note, and a new customer message reopens it
- [v1] Assignment to agent; status open / resolved; tags. (`snoozed` exists in the enum and nothing sets it)
- [next] Debounce AI turns so a burst of customer messages produces one considered reply
  rather than one per message. Needs care: a deterministic job id alone would drop a message
  that arrived mid-turn
- [later] Auto-return to AI after human inactivity; assignment rules / round-robin; SLA timers

### 3.3 AI harness
- [v1] Provider profiles (name, base URL, key, headers), keys encrypted at rest, never returned to browser
- [v1] Task slots: `agent_chat`, `suggestion_for_human`, `summarize`, `embed`, `rerank`, `vision`; each with primary + fallback provider/model. (`classify_intent_and_handoff` is configurable and read by no processor; it awaits the rule engine above)
- [v1] Agent loop on Vercel AI SDK `openai-compatible` provider; tool registry with typed schemas
- [v1] Internal tools: `search_knowledge`, `get_customer_profile`, `search_past_conversations`, `handoff_to_human`, `tag_conversation`, `set_customer_field`. (`propose_merge` struck: a model never sees a second customer, so it cannot name the other half of a merge; deterministic matching does the job, see §3.9. `schedule_follow_up` moved to [later]: never built, nothing depends on it)
- [v1] Answer-only fallback path (retrieval pre-injected) for models without function calling
- [later] Structured output for quick replies / buttons, translated per channel. (Was [v1]; structured output is used by the summariser only)
- [v1] Image understanding when the assigned model supports vision
- [v1] Language matching (Thai/English), workspace default language
- [UX] Replies are plain text: a format rule in the prompt, and `toPlainText` converting any markdown that arrives anyway. `bun run backfill:plain-text` converts older stored replies
- [v1] Full trace per AI turn: prompt, chunks + scores, tool calls, model, tokens, latency, cost
- [v1] Redaction of card numbers and Thai ID numbers before storage and model calls
- [M5] Tool **sources** behind one registry interface, so the agent loop does not know where a tool came from
- [M5] `http_tool`: one endpoint configured per workspace by an admin — URL, method, model-filled arguments, system-bound values, encrypted credential, timeout
- [next] MCP client: a tenant connects their own server and brings its whole tool set; per-workspace allowlist, because every exposed tool costs prompt budget. The source interface it plugs into is built
- [M5] Restricted egress for tenant-defined tools (see decision 20); `tool_error` handoff when a tool cannot be reached, answers with an error status or times out. Arguments the model got wrong go back to it to correct instead, since the endpoint was never called
- [M5] A tool that writes records intent and fires after the turn, as every other side effect does. A write that fails holds the reply back, because a customer must never read "done" for something that did not happen; a turn that hands off for any other reason abandons its pending writes unfired
- [M5] Identity proofs: the widget token, and a one-time verification link for LINE and Messenger (decision 21)
- [M5] salon-saas subscription status, through the widget token's attributes. Account lookup waits on a read-only support credential on the salon-saas side; ticket creation is deliberately not built, because a conversation here already has an assignee, a status, tags, notes and a history
- [M5] Internal tool `request_identity_verification`, offered only when a verification link is configured and nothing has been proved yet
- [later] `schedule_follow_up` tool; per-tenant budgets / rate limits; prompt versioning with A/B

### 3.4 Knowledge (RAG)
- [v1] Q&A entries (question, answer, tags, channel restriction, per-language variants)
- [v1] Articles / Markdown with chunking
- [v1] File upload PDF/DOCX/XLSX/CSV, parser behind interface, ingestion status, re-index
- [v1] "Save reply as knowledge" from conversation view (PII stripped)
- [v1] Hybrid retrieval: pgvector dense + trigram keyword (pg_trgm/pg_bigm), reciprocal rank fusion, optional rerank slot
- [v1] Embeddings via provider layer (OpenAI text-embedding-3, bge-m3 self-hosted, Qwen3-Embedding)
- [v1] Test-search box showing retrieved chunks and scores
- [v1] External retrieval adapter interface (Dify / RAGFlow / custom endpoint)
- [later] Website crawl with refresh schedule; OCR for Thai scanned PDFs; graph RAG if FAQ linking demands it

### 3.5 Customers and memory
- [v1] `channel_identities` → `customers`; profile, avatar, identifier fields limited to phone, email, order_id, account_id and company; what the summariser observes goes to a separate `customers.notes` (ADR 0007)
- [v1] Extraction of phone / order ID from messages; merge suggestions; human accept/reject; merge repoints identities
- [v1] Rolling per-customer summary (background job), with extracted facts written to `customers.notes`, shown to humans and injected into prompts
- [v1] Embedded past conversations for semantic recall tool
- [v1] Retention policy per workspace (default 2 years); delete-customer job erases messages, media, embeddings, summaries
- [v1] Provider audit: which provider received which message

### 3.6 Agent GUI
- [v1] Inbox list: filters by mode/channel/assignee/tags/status, open and waiting counts as badges on the Inbox from every page (`/v1/conversations/counts`), real-time via WebSocket over Redis pub/sub
- [M6] A customer has an **account owner**, set from the conversation sidebar, which outlives every conversation they start and is inherited by the next one nobody has claimed
- [M6] The queue is ordered by that owner first — yours, then unclaimed, then everybody else's — and by longest wait inside each group
- [v1] Conversation view: channel-specific rendering, internal notes, canned responses with shortcuts
- [M6] Composer attachments: an agent sends an image or a document, which reaches LINE as a link, Messenger as a native attachment, and the widget inline
- [v1] AI sidebar: take over / return to AI, live suggested reply (insert, insert & send), retrieved chunks with sources, customer summary, cost so far, feedback thumbs
- [v1] Customer panel: identities, fields, merge suggestions, past conversations
- [v1] Knowledge management screens
- [v1] Settings: channels, providers + task slots, mode defaults, business hours, retention, redaction, members, canned responses. (Handoff rules: no table, route or screen; see the handoff line in §3.2)
- [v1] Minimal dashboard: volume per channel, AI vs human handled, handoff reasons, first-response time, cost/day
- [UX] Dashboard leads with the median wait from a handoff to a colleague's first reply; reasons read as sentences; the waiting and review banners link to those inbox tabs
- [M5] Settings: **Tools**, where an admin defines an endpoint of their own, tests it against the live rule set, and enables or disables it
- [M5] Settings: **Proving who a customer is**, one switch per identity proof plus the verification link's URL, secret and lifetime
- [M5] Conversation sidebar: whether this customer was proved, what the proof carried, and a button to send them a verification link
- [v1] Review queue for unsupervised AI conversations
- [v1] Roles `admin` / `agent` / `viewer`; email+password. (Google sign-in is wired in the auth config and still has no control on the login page)
- [M6] **People**: an admin invites a colleague with a single-use link, changes a role, renames somebody, removes a membership, and issues a password-reset link for a member who belongs to this workspace alone. Anyone who reaches further — a member of two tenants, or a platform admin — is recovered from the platform page instead, because a reset sets the password on a global account. The last admin can be neither demoted nor removed
- [M6] **Platform**: a platform admin creates, renames, suspends, restores and deletes tenants, grants or revokes other platform admins, and issues a password-reset link for an account a workspace admin may not. Deleting asks for the slug to be typed
- [M6] Workspace switcher for anybody who belongs to more than one, and a locked screen naming the reason when the current workspace is suspended or being deleted
- [M6] `/<slug>` opens that workspace, so a link to a tenant can be shared; a mistyped address gets a page that offers the way back rather than two bare words
- [v1] Thai + English i18n; mobile-friendly responsive layout
- [later] Charts dashboard; agent performance; CSAT survey to customer

### 3.7 Quality and observability
- [v1] Thumbs up/down with reason on AI replies and suggestions; implicit corrections (AI draft vs human final)
- [v1] Structured logs, request IDs, job metrics; per-call cost accounting
- [next] Automatic grading job (groundedness, resolution, tone) feeding review queue
- [later] Regression eval set run on knowledge change; alerting

### 3.8 Platform / ops
- [v1] Bun workspaces monorepo: `apps/api`, `apps/worker`, `apps/web`, `apps/widget`, `packages/core` (framework-free domain), `packages/channels`, `packages/db`, `packages/infra`, `packages/shared`, `packages/config`
- [v1] Docker Compose: api, worker, web (static via nginx or served by api), postgres+pgvector, redis, minio; `.env.example`
- [v1] Drizzle migrations; seed script for a workspace, admin user, test channel. [M6] The seed also grants the admin platform admin, since nothing in the running API can create an account
- [v1] Stateless API, BullMQ queues, S3-compatible storage client, PgBouncer-ready connection handling
- [v1] Staging on VPS behind Nginx Proxy Manager (WebSocket enabled)
- [v1] CI: typecheck, lint, unit tests incl. webhook fixture replay
- [M6] Tenant lifecycle: `active` / `suspended` / `deleting` on the workspace, enforced on every authenticated request, every webhook, the widget, the identity link and every queued job
- [M6] Queued tenant erasure: rows by cascade, stored media by a list saved before the rows go, recorded in `platform_audit_log` and `workspace_erasures`, both of which outlive the tenant
- [later] Billing, Cloudflare Containers / Fly.io deployment recipes

## 3.9 Milestone status

**M1 is complete.** The skeleton and the AI/human loop run end to end, locally and as
container images. Delivered:

- Monorepo, Docker Compose infrastructure, CI running lint, typecheck, migrations, the
  test suite and the web build.
- Database schema for the whole M1 surface with `workspace_id` on every tenant-owned table,
  Better Auth with admin/agent/viewer roles, AES-256-GCM credential encryption.
- Conversation state machine and redaction as pure, exhaustively tested functions.
- AI harness over any OpenAI-compatible provider, with per-task slots, fallback, tools and a
  separate vision slot.
- Channel adapter contract with the test and web channels; LINE and Messenger slot in at M3
  without touching the domain.
- API, worker, realtime updates, media upload, and the agent console with inbox,
  conversation view, AI sidebar, simulator and settings in Thai and English.
- Deployment: Dockerfiles, production compose, and a VPS guide.

Verified against the M1 definition of done: a Thai question is answered by the AI in Thai;
taking over stops the AI and produces suggestions instead; an AI turn queued before a
take-over refuses to send when it runs afterwards; returning to the AI passes an agent's
instruction into the next prompt; card numbers never reach the database or the provider; a
provider outage falls over to the secondary; a total failure hands off to a human; and an
image sent through the simulator is described by the vision slot and referenced in the reply.

**M2 is complete.** The AI now answers from a knowledge base and remembers customers.

- Knowledge: Q&A entries, articles, and uploaded PDF, DOCX, XLSX, CSV and text files, parsed
  in the worker behind one parser interface. Extraction that yields nothing usable fails with
  its reason shown in the knowledge screen, because the likeliest first upload is a Thai scan.
- Hybrid retrieval on Postgres: pgvector for meaning, `word_similarity` over a GIN trigram
  index for literal matches, fused with per-list floors. ADR 0003 records the measurements
  that chose those functions. Optional cross-encoder reranking on top.
- The agent pre-fetches knowledge for each customer message and can search for more, plus
  recall over that customer's own past conversations, scoped so it can never reach another's.
- Rolling per-customer summaries written on resolve, with history kept.
- Agent console: knowledge management with a two-half test-search box, promote-a-reply,
  canned responses with composer shortcuts, and a full AI trace view.
- An external retrieval adapter for operators already running Dify or RAGFlow.
- Playwright covers the three core agent flows.

**M3 is complete.** LINE and Messenger are implemented, and connecting them is a settings
screen rather than a deploy.

- Webhook signatures are verified over the exact bytes each platform sent, with tests covering
  Thai, emoji, unusual whitespace and a re-serialised body.
- The LINE adapter handles text, media, stickers, locations, follows, postbacks and unsends,
  with fixtures typed against the SDK's own schema. Reply tokens are carried on the
  conversation and used while fresh, so replies are free rather than billed as pushes.
- The Messenger adapter speaks the Graph API directly on v26.0, handles stickers, quick
  replies, postbacks, referrals and receipts, and refuses to send outside the 24-hour window
  with an explanation rather than an error code.
- Inbound media is downloaded into our own storage before the AI turn runs, because platform
  references expire. A failed download degrades the message rather than dropping it.
- Channel settings show the webhook URL and Meta's verify token alongside the credential
  fields, with a button that asks the platform whether the credentials work.
- `docs/CHANNEL-SETUP.md` covers connecting both platforms; `docs/META-REVIEW.md` covers the
  App Review submission, which is the schedule's long pole.

Verified against a locally signed LINE webhook end to end. Real delivery needs accounts that
do not exist yet.

**M4 is complete.** What it delivered:

- Retention. A nightly sweep, scheduled by the worker rather than a host cron so it exists
  wherever the worker runs, deletes conversations whose last message is older than the
  workspace's retention period, and the stored media with them. Age is measured from the last
  message, so a long conversation is kept until it goes quiet rather than from when it began.
  (Caveat found later: an agent's reply does not update `last_message_at`, so the age runs
  from the last customer or AI message.)
- Erasure on request, which Thailand's PDPA gives a person a right to. An admin triggers it
  beside the conversation where the request arrived, and it removes every conversation,
  channel identity, summary and image belonging to that customer. The audit entry outlives
  them and carries no personal data, which is what lets you show the request was honoured
  without keeping what you were asked to delete.

- The web widget. A loader a host page embeds and a chat application in an iframe on our
  own origin, so the host cannot read the conversation and the widget's requests are
  same-origin. Anonymous by default; salon-saas can sign a short-lived token for its
  logged-in user and the conversation attaches to that account instead. A session token
  minted after we decide who the visitor is carries the identity, and no endpoint accepts a
  conversation id, so a guessed id reaches nothing. See `docs/WIDGET.md`.

- The dashboard. Volume, the share of turns the AI answered on its own, median time to a
  first reply, estimated cost, why it handed off, and which channels the traffic came from,
  over a window of 7, 14 or 30 days. Few figures on purpose: the handoff reasons are the
  list of what to write into the knowledge base next, and everything else answers whether
  the pilot is working. Computed in Postgres and drawn without a charting library.

- Feedback and the review queue. A thumb up or down on every AI reply and on every draft,
  with a fixed list of five reasons behind a thumbs-down and an optional note. The reasons
  are fixed so they can be ranked: the dashboard turns them into a second list of what to
  fix, beside the handoff reasons. One opinion per person per reply, changeable and
  withdrawable.

  The review queue is a tab in the inbox holding the conversations the AI answered with
  nobody watching: an AI reply, no human message, no handoff, and nothing said since the
  last review. Rating a reply counts as reviewing it, and so does saying plainly that it
  was read. A conversation returns to the queue when the AI speaks again afterwards, so
  reviewing is good only until the next unwatched turn.

  Two consequences are deliberate. A conversation a person ever replied in never enters,
  even if the AI then runs it alone for weeks, because someone who answered there has seen
  how the AI behaves. `ai_supervised` conversations never enter either: their drafts are
  sent by a person, under a person's name, so nothing about them was unsupervised.
  Resolved conversations do enter, because one the AI closed badly is exactly what nobody
  notices.

  Drafts an agent sends now record the message they became, whether they were sent
  untouched or edited first. Comparing the two texts is the implicit correction signal the
  requirements ask for, and it costs no extra clicks from the agent.

- Customer merge suggestions. Every channel identity gets its own customer record on
  arrival, because guessing who a stranger is at the moment they first write is how one
  person's history ends up in front of another. The cost is duplicates, and this clears
  them up: when an identifier the AI extracted matches another record in the same
  workspace, the pair is put to a person, who accepts or rejects it.

  Only `phone`, `email` and `account_id` propose a merge. `order_id` and `company` name
  something other than a person, an owner and their staff share both, and merging those two
  is precisely the mistake the decision table forbids. A phone is compared in a normalised
  form, so the same Thai mobile written `081-234-5678`, `+66 81 234 5678` and `0066…` is one
  number; the value the customer typed is never rewritten.

  Nothing merges itself. A rejection is permanent for that pair, so the panel cannot ask
  twice. Accepting repoints the absorbed record's identities, conversations, recall
  embeddings and summaries onto the older record and then deletes it, in one transaction,
  in that order: every one of those tables cascades on delete, so deleting first would
  destroy the history instead of moving it. The audit entry naming both ids outlives the
  record and the proposal.

  The `propose_merge` AI tool from the original §3.3 list is deliberately not built. A model is given one
  customer and never sees another, which is what stops recall leaking across people, so it
  has no way to name the other half of a merge. Deterministic matching on extracted
  identifiers does the same job without that access.

**M4's own list is done.** Not every `[v1]` line in §3 was built; the ones that were not
are marked in place there rather than deleted, so the gap stays visible.

**M5 is built, apart from the MCP client.** A workspace admin can define tools against
their own API, test them from the console, and the AI calls them inside a real turn.
Delivered:

- Tool **sources** behind one interface (`packages/core/src/ai/tool-source.ts`). The
  internal registry is one source and tenant HTTP tools are another; the turn does not know
  which produced what, which is what the MCP client will plug into without touching the loop.
- `http_tool`: method, URL with `{{name}}` placeholders, headers, an encrypted credential,
  model-filled arguments and system-bound values, a timeout, and a read/write distinction.
- Restricted egress (ADR 0004) and a `tool_error` handoff whenever a tool fails.
- Writing tools that record intent and fire after the turn. A failed write **holds the
  reply back** and fetches a person, naming both what succeeded and what did not, because a
  customer must never read "done" for something that did not happen, and whoever picks the
  conversation up needs to know the tenant's system is in a partly changed state.
- Two identity proofs, each with its own switch: the widget token, and a one-time
  verification link for LINE and Messenger, where nothing otherwise proves who is writing.
- A test button that calls the endpoint through the same function and the same restricted
  client a real turn uses.

Not built, on purpose: the MCP client (next; the interface is waiting for it), salon-saas
account lookup (blocked on a read-only support credential on their side), and ticket
creation (a conversation here already is one).

**M6 is built.** A tenant can be created, staffed, suspended and erased from the console,
without anybody touching the database. Delivered:

- **`platform_admins`**, a table rather than a role. The seed grants it to
  `SEED_ADMIN_EMAIL`, because nothing in the running API can create an account and a fresh
  installation would otherwise have no way to reach the platform page at all.
- **Invitations as single-use links.** An admin issues one and passes it on themselves;
  only the hash is stored. A new person sets a name and a password on the page and is signed
  in by the response; somebody who already has an account signs in and is added, which is
  how one person comes to hold two memberships. The same table issues password-reset links.
- **Roles editable in place**, with the last admin protected from being demoted or removed
  by a check that locks the whole admin set rather than the row being changed.
- **A workspace status** — `active`, `suspended`, `deleting` — read on every authenticated
  request in the same query as the membership, and honoured by every webhook, the widget,
  the identity link and every queued job type (nine now, with `idle_resolve`).
- **Queued erasure** with a record written before anything is destroyed, so a retry knows
  which stored objects are left and a job with no record deletes nothing. It collects
  knowledge files as well as message attachments, which the existing media sweep never saw.
- **A workspace switcher**, which finally writes `session.activeOrganizationId`: the field
  was read in two places and written in none, so a person in two workspaces landed in
  whichever one Postgres returned first.

Not built, on purpose: billing, a self-service sign-up, email delivery of invitations, and
restoring a deleted tenant.

**The UX pass after M6 is built** (2026-09-22 to 24, deployed). A review of the console and
the widget against the running product found one defect that reached customers and a long
tail of interface problems. Delivered:

- **The customer is told on a handoff** (decision 26), and the widget says who is answering:
  a typing indicator while the AI works, a line when a person is on the way or with them,
  and an honest message when the workspace is suspended or the network is down. A returning
  visitor sees the end of their conversation rather than its first hundred messages.
- **Plain-text replies**, with the 29 stored pilot replies converted.
- **A console that works on a phone**: the AI panel is a sheet, the bottom bar holds five,
  notes sit where they were written, days are separated.
- **Destructive actions take two clicks**; every save says saved or failed in the card that
  changed; Settings is four tabs (General, Channels, AI models, Integrations).
- **The dashboard** leads with the wait for a person, in words rather than enum keys.
- **Identifiers and notes are separate columns** (ADR 0007); migration 0010 moved 41
  invented keys out of the two pilot customers' identifier lists.
- **Inbox badges**, blue for open and red for waiting, on every page.
- **Conversations close themselves** when the customer walks away (decision 27).

Left from that plan, not built: the agent's name in the widget, a phone-width browser test
for the widget, an explicit Save on the identity card, a remembered result for the model
test button, a currency setting (USD is fixed), a note recorded with a suspension, refusing
to delete a provider that task slots still use, and widget polish (greeting from the embed
tag, drawn launcher icons, an open/close animation). Known bugs: an agent's reply does not
update `last_message_at`, which skews inbox order; the widget's own messages are Thai only.

## 3.10 M5 design intent

Decisions 18 to 21 carry the short form; this is the reasoning that produced them, written
before the milestone was built and kept because it is still what the code does.

**The agent takes tool sources, not tools.** Today `createInternalTools` returns a fixed
object written in TypeScript. An `http_tool` contributes one entry to that object and a
connected MCP server contributes a set, so the registry's unit is a source and the agent
loop never learns which kind produced a tool. Build the interface while `http_tool` is its
only implementation: retrofitting it later means editing the turn, which is the part least
worth disturbing.

**Both extension points are the tenant's, not the operator's.** They are not alternatives.
`http_tool` is the low floor, reaching any API that exists today from a tenant who will
never run a server, and it needs no cooperation from the other side. MCP is the ceiling:
the tenant owns the names, descriptions and schemas, keeps them beside the code that
implements them where they cannot drift, and adds a tool without us shipping anything. A
product sold to more than one business wants both, or every integration is our work
forever.

**Identity is bound by the system, never supplied by the model.** A tool definition has two
kinds of input: arguments the model fills, and values we inject — the verified customer,
the workspace, the conversation. The model cannot name a bound value or override one, and a
tool that needs identity simply cannot be called in a conversation where identity was never
proven. This is the same rule that scopes recall by workspace and customer, and
`get_customer_profile` already demonstrates the shape with an empty input schema. MCP makes
it harder rather than easier, because a server declares its own arguments; a tenant tool
that asks for a customer id gets ours or nothing.

**A tenant who can type a URL has a request origin inside our network.** The worker shares a
Docker network with Postgres, Redis and MinIO, and the model gateway answers on a private
address, so a tool aimed at an internal host would fetch it and read the answer to a
customer. Tenant-defined tools therefore go through a restricted client: HTTPS, the
hostname resolved and the resolved address checked rather than the string, loopback,
private, link-local and CGNAT ranges refused, and the check repeated on redirect. Operator
provider configuration keeps the unrestricted client, because a self-hosted gateway on a
private address is the legitimate case the restriction would otherwise break.

**Three smaller rulings.** Defining a tool stores a credential and points our infrastructure
at a host, so it is admin-only. A tool that writes records intent and fires after the turn,
because a turn that fails halfway must not leave a real record in somebody else's system.
And every tool a source exposes costs prompt budget, so an MCP connection needs a
per-workspace allowlist; since the trace already records tokens and cost, settings can show
a tenant what their tool list costs per conversation rather than letting them degrade their
own AI invisibly.

**Identity is proved in two ways, and each can be refused.** A channel identity says which
LINE account or browser is writing, which is continuity rather than evidence: anyone can
open a chat and claim to be anyone. `channel_identities.verified_subject` is separate, and
holds only what a proof carried. A workspace accepts each proof separately, and a proof it
has stopped accepting still identifies the visitor — the same person keeps one history —
while binding nothing. That is what makes turning one off safe rather than disruptive:
conversations carry on and account tools quietly stop being offered.

**The salon-saas tools are the first consumers**, and only one of the three is reachable
today. Subscription status can be answered with no new credential at all by putting `plan`
and `paidUntil` into the widget token's existing attributes. Account lookup is blocked:
every platform route is guarded by a check that refuses any bearer header before it
evaluates a session, deliberately, so it needs a narrow read-only support credential on the
salon-saas side. Ticket creation has nothing to call, and should not be built: a conversation
in this console already has an assignee, a status, tags, notes and a history, which is what a
ticket is.

## 3.11 M6 design intent

Decisions 22 to 24 carry the short form; this is the reasoning behind them.

**A platform admin is not a role.** Every role in this product is held inside a workspace
and means something there. The authority to create and delete tenants is held over
workspaces, so writing it as a fourth role would make `admin` mean two different things
depending on which table it was read from, and would put a cross-tenant path into a
permission check that currently has none. It is a row in its own table, resolved by its own
guard, and that guard resolves no workspace at all — an optional `workspaceId` in scope is
exactly the ambient tenant this codebase refuses to have.

It follows that a platform admin can see no conversation anywhere. To read one they invite
themselves into the tenant, which leaves a membership its own admins can see in their member
list. That is a deliberate trade: support work costs an audit trail rather than being
invisible.

**The link is the credential.** There is no mail transport here, and adding one — a
provider, a domain, deliverability, a queue, a bounce story — before the first colleague can
be invited is the wrong order to build in. So the console shows the link once and the admin
sends it however they already talk to that person. What matters is unchanged: it is
unguessable, single-use, short-lived, and only its hash is stored, for the same reason every
other credential here is encrypted.

Creating the account needs sign-up, which is disabled on purpose. Rather than flipping the
flag, the API holds a second auth instance that allows it and never mounts it: the
capability exists at exactly one call site, reached only after a valid token has been
spent. The spend and the membership share a transaction, because a failure between them
would leave somebody with an account, no membership, and a link that will never work again.

**Suspension is not deletion, and neither is a flag somebody checks.** The status lives on
the workspace and is read in the same query that resolves the membership, so a request
cannot be judged against a role read now and a status read a moment later. A suspended
tenant answers its webhooks with 200 and discards the payload, which looks dishonest and is
not: LINE and Meta disable an endpoint that keeps failing, so erroring would cost the
operator their webhook registration and a support conversation to get it back, for a state
that is meant to be reversible in an afternoon.

Dropping a queued AI turn is the one deliberate exception to the rule that a turn never ends
in silence. Everywhere else, going quiet is the bug that rule exists to prevent. Here there
is no colleague to hand off to, because every agent in the tenant is locked out of the
console too, and sending on behalf of a suspended operator is the worse outcome. It is
commented as an exception at the call site so the next reader does not take it for the bug.

**A slug is a name, and now also a link.** It was never a route: the workspace comes from
the session, and every console path is fixed. That is still true — `/<slug>` switches the
session and redirects, rather than becoming a prefix on every route, so there remains exactly
one place that decides which tenant you are in and no handler has to be taught about the URL.
The lookup runs over the caller's own memberships, so the address bar cannot be used to find
out which tenants exist. The cost is that a tenant may not be named after a console path,
since a static route outranks the parameter; those names are refused at creation, which is
the only moment anybody can still choose another.

**Erasing a tenant is staged because it has to be.** The rows cascade from one delete and
the stored media does not, so the keys are collected while the rows that name them still
exist and the objects are removed afterwards. What makes the job safe to retry is a record
written before any of it: the processor refuses to delete a workspace it finds no record
for, saves the key list onto that record, and shrinks it to whatever failed. The record has
no foreign key and the audit entry goes to a table with no `workspace_id`, because a
workspace's own audit log cascades with the very deletion it would be the record of.

## 4. Open questions / to refine
- Expected conversation volume at launch (assumed low hundreds/day)
- Who maintains knowledge day to day (assumed partner staff via GUI, admin-gated)
- Exact 9router API behaviour (model listing, streaming) — verify at integration time
- Whether humans should see unmasked card/ID numbers (currently: no)
- Business hours for the pilot (stored, and read by nothing yet). Acknowledgement wording is settled: each workspace edits its own, per language
