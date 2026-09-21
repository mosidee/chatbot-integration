# chatbot-integration — Requirements and Feature List

Status: draft v0.1, shaped 2026-09-20. Edit freely; this is the living source of truth for scope.

## 1. Purpose

An AI customer-chat harness that talks to customers over **Facebook Messenger**, **LINE**, and an **embeddable web widget**, answers from a **RAG knowledge base** and **customer history**, and lets **human agents take over** (or the AI hand off) per conversation through a **web GUI**. Any **OpenAI-compatible model/provider** can be used.

Pilot tenant: **salon-saas** (the operator's own SaaS). Pilot customers are salon owners and prospects asking about the salon-saas platform (pricing, onboarding, features, billing, bugs). Not end-consumers of individual salons.

## 2. Decisions taken (with rationale)

| # | Decision | Choice | Why |
|---|---|---|---|
| 1 | Tenancy | Single business now, **tenant-ready schema** (`workspace_id` on every table), one workspace of UI | Cheap now, keeps SaaS door open |
| 2 | Build vs fork | **Build ourselves**, reuse libraries only | AI+human loop lives in the GUI; bolting it onto Chatwoot's Rails UI is painful. Chatwoot remains the fallback |
| 3 | Deployment | **Docker Compose on operator's VPS** (public IP, Nginx Proxy Manager, Let's Encrypt). Scale-up via containers (Fly.io / Cloud Run / k3s / Cloudflare Containers), not Workers | Long LLM calls, WebSockets and ingestion jobs fit containers |
| 4 | Stack | **Elysia on Bun**, Drizzle ORM, Postgres + pgvector, Redis (BullMQ + pub/sub), MinIO (S3 API), **Vite React SPA** with shadcn/ui + Tailwind, Bun workspaces monorepo, Zod/TypeBox schemas shared, Eden Treaty typed client | Team preference; thin HTTP layer keeps core framework-free |
| 5 | Customer identity | Contact per channel identity → `customers` record; **merge suggested** by shared phone / order ID, **human confirms**; never auto-merge | Avoid leaking one customer's history to another |
| 6 | Conversation modes | `ai` (default for pilot), `ai_supervised`, `human`, `waiting_human`; selectable per workspace / channel / conversation. **AI never sends while mode is `human`** | Trusted pilot partner; supervised mode ready for later |
| 7 | AI capabilities | **Tool-using agent, internal tools now**, registry designed for HTTP tools + MCP later. Fallback to answer-only for models without function calling | Option 3 is "register another tool" |
| 8 | Knowledge sources | Q&A entries, articles, PDF/DOCX upload (parser behind interface), promote human replies to knowledge, external-retrieval adapter; website crawl later. **Hybrid search** (pgvector + trigram keyword, RRF, optional rerank) | Thai product terms need keyword match |
| 9 | Memory & retention | Recent window + per-customer rolling summary always on; semantic search over past conversations as a tool. Default retention 2 years, per-workspace; one-job "delete customer". **Redact card numbers and Thai 13-digit ID numbers** before storage and before any model call | PDPA |
| 10 | Model providers | **Provider profiles + per-task model slots + fallback**. Pilot providers: OpenAI, OpenRouter, operator's self-hosted 9router. Every call logged with provider/model/tokens/latency/cost | Outages must not become silence |
| 11 | GUI v1 | Inbox, conversation view, AI sidebar, customer panel, knowledge management, settings, minimal dashboard, **canned responses**, **mobile-friendly** | Cut list ordered by importance |
| 12 | Channel onboarding | Manual credential paste for LINE and Messenger in pilot; Meta App Review started as soon as webhook works; OAuth connect flow only for second tenant | Review is on the critical path |
| 13 | Message types | All inbound types stored/rendered for humans; **images to vision model** (on); other media → configurable handoff. Outbound: text (per-channel splitting), images, files, quick replies. Rich templates later | Salon-saas screenshots |
| 14 | Dev/test | Internal **test channel** (simulator) from sprint 1 → grows into **web widget with signed-token identification** of logged-in salon-saas users. Staging on VPS for real webhooks; fixture-based adapter tests | Pilot can start on widget before Meta approval |
| 15 | Languages | GUI Thai + English (i18n, Thai default). AI matches customer's dominant language, workspace default Thai. Per-language knowledge variants. Trigram search for Thai | Thai has no word spaces |
| 16 | Quality loop | Thumbs feedback + implicit corrections (draft vs sent), review queue for unsupervised AI conversations, full per-turn trace in v1; automatic grading next; regression evals once knowledge stabilises | Pilot must end with numbers |
| 17 | Phasing | M1 skeleton+loop → M2 knowledge+memory → M3 real channels → M4 pilot readiness → M5 salon-saas tools. v1 = M1–M4 | Architecture proven before features pile on |
| 18 | Tool extensibility | The agent takes tool **sources**, not tools. `http_tool` (one configured endpoint) and an **MCP client** (a connected server's whole set) are two sources behind one interface; both are **tenant-facing**, configured per workspace by an admin. `http_tool` first | `http_tool` is the low floor: any tenant with an endpoint, no server to run. MCP is the ceiling: the tenant owns the definitions and adds tools without us shipping. A source interface from the start keeps the agent loop untouched when the second arrives |
| 19 | Tool identity | A tool definition separates **arguments the model fills** from **values the system binds** (verified customer, workspace, conversation). The model can neither name nor override a bound value, and a tool needing identity cannot run in a conversation where identity was never proven | Letting a model choose whose account to read is the cross-customer leak in a new place. `get_customer_profile` already does this with an empty input schema; the config format promotes it |
| 20 | Tenant-defined egress | A tenant-defined tool is fetched through a **restricted client**: HTTPS only, hostname resolved and the resolved address checked, loopback / private / link-local / CGNAT refused, re-checked on redirect. Operator-level provider config keeps the unrestricted client | A tenant typing a URL gets a request origin inside our network: the worker shares a network with Postgres, Redis and MinIO, and the model gateway answers on a private address. Checking the hostname alone survives neither a name that resolves inward nor one that changes answer after the check |

Pilot success metrics: share of conversations fully handled by AI with no negative rating and no repeat question within 24 h; median first-response time.

## 3. Feature list

Legend: **[v1]** in version 1 (M1–M4), **[M5]** milestone 5, **[later]** backlog.

### 3.1 Channels
- [v1] Normalised message model; every adapter translates to/from it
- [v1] LINE Messaging API adapter (webhook signature verify, reply-token first, push fallback, follow/unfollow, postback, unsend, stickers, media download)
- [v1] Facebook Messenger adapter via Graph API (webhook verify + X-Hub-Signature-256, page token, quick replies, referral params, read receipts, media)
- [v1] Internal test channel / simulator page
- [v1] Embeddable web chat widget (script tag), anonymous or **signed-token (JWT) identified** user
- [v1] Channel settings: paste credentials, show webhook URL, signature status, "send test message"
- [v1] Webhook ingestion: verify → persist raw event → enqueue → 200 within ms; idempotency on platform message IDs
- [later] "Connect Facebook Page" OAuth flow; LINE Login
- [later] Additional channels, in order of ease: **Instagram DM** (Meta Graph API, same review as Messenger), **Telegram** (Bot API, no review), **WhatsApp** (Meta Cloud API; needs business number, Business Verification, 24 h customer-service window and paid templates outside it), **TikTok** (Business Messaging API is partner-gated via TikTok Business Center, region-restricted in EEA/CH/UK; TikTok Shop Customer Service API is a separate, harder approval). Design hooks now: per-conversation messaging-window expiry, and a template outbound message type
- [later] Rich templates (LINE Flex, Messenger generic template) via channel-neutral card schema

### 3.2 Conversation and handoff
- [v1] Modes `ai` / `ai_supervised` / `human` / `waiting_human`, defaults per workspace and per channel
- [v1] AI→human handoff triggers: `handoff_to_human` tool with reason, low retrieval confidence, customer asks for human, negative sentiment, keyword/intent rules
- [v1] Handoff reason posted as internal note; acknowledgement message to customer (configurable text, business hours aware)
- [v1] One-click take over; one-click return to AI with optional instruction note the AI reads
- [v1] `waiting_human` queue; optional fallback to AI after N minutes outside business hours
- [v1] Assignment to agent; status open / snoozed / resolved; tags
- [next] Debounce AI turns so a burst of customer messages produces one considered reply
  rather than one per message. Needs care: a deterministic job id alone would drop a message
  that arrived mid-turn
- [later] Auto-return to AI after human inactivity; assignment rules / round-robin; SLA timers

### 3.3 AI harness
- [v1] Provider profiles (name, base URL, key, headers), keys encrypted at rest, never returned to browser
- [v1] Task slots: `agent_chat`, `suggestion_for_human`, `summarize`, `classify_intent_and_handoff`, `embed`, `rerank`, `vision`; each with primary + fallback provider/model
- [v1] Agent loop on Vercel AI SDK `openai-compatible` provider; tool registry with typed schemas
- [v1] Internal tools: `search_knowledge`, `get_customer_profile`, `search_past_conversations`, `handoff_to_human`, `tag_conversation`, `set_customer_field`, `propose_merge`, `schedule_follow_up`
- [v1] Answer-only fallback path (retrieval pre-injected) for models without function calling
- [v1] Structured output for quick replies / buttons, translated per channel
- [v1] Image understanding when the assigned model supports vision
- [v1] Language matching (Thai/English), workspace default language
- [v1] Full trace per AI turn: prompt, chunks + scores, tool calls, model, tokens, latency, cost
- [v1] Redaction of card numbers and Thai ID numbers before storage and model calls
- [M5] Tool **sources** behind one registry interface, so the agent loop does not know where a tool came from
- [M5] `http_tool`: one endpoint configured per workspace by an admin — URL, method, model-filled arguments, system-bound values, encrypted credential, timeout
- [M5] MCP client: a tenant connects their own server and brings its whole tool set; per-workspace allowlist, because every exposed tool costs prompt budget
- [M5] Restricted egress for tenant-defined tools (see decision 20); `tool_error` handoff when a tool fails or times out
- [M5] A tool that writes records intent and fires after the turn, as every other side effect does
- [M5] salon-saas tools: account lookup, subscription status, ticket creation
- [later] Per-tenant budgets / rate limits; prompt versioning with A/B

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
- [v1] `channel_identities` → `customers`; profile, avatar, custom fields (phone, order IDs, salon-saas account ID)
- [v1] Extraction of phone / order ID from messages; merge suggestions; human accept/reject; merge repoints identities
- [v1] Rolling per-customer summary and facts (background job), shown to humans and injected into prompts
- [v1] Embedded past conversations for semantic recall tool
- [v1] Retention policy per workspace (default 2 years); delete-customer job erases messages, media, embeddings, summaries
- [v1] Provider audit: which provider received which message

### 3.6 Agent GUI
- [v1] Inbox list: filters by mode/channel/assignee/tags/status, unread counts, real-time via WebSocket over Redis pub/sub
- [v1] Conversation view: channel-specific rendering, internal notes, composer with images/files, canned responses with shortcuts
- [v1] AI sidebar: take over / return to AI, live suggested reply (insert, insert & send), retrieved chunks with sources, customer summary, cost so far, feedback thumbs
- [v1] Customer panel: identities, fields, merge suggestions, past conversations
- [v1] Knowledge management screens
- [v1] Settings: channels, providers + task slots, mode defaults, handoff rules, business hours, retention, redaction, users/roles, canned responses
- [v1] Minimal dashboard: volume per channel, AI vs human handled, handoff reasons, first-response time, cost/day
- [v1] Review queue for unsupervised AI conversations
- [v1] Roles `admin` / `agent` / `viewer`; email+password, optional Google sign-in; invite-only
- [v1] Thai + English i18n; mobile-friendly responsive layout
- [later] Charts dashboard; agent performance; CSAT survey to customer

### 3.7 Quality and observability
- [v1] Thumbs up/down with reason on AI replies and suggestions; implicit corrections (AI draft vs human final)
- [v1] Structured logs, request IDs, job metrics; per-call cost accounting
- [next] Automatic grading job (groundedness, resolution, tone) feeding review queue
- [later] Regression eval set run on knowledge change; alerting

### 3.8 Platform / ops
- [v1] Bun workspaces monorepo: `apps/api`, `apps/worker`, `apps/web`, `apps/widget`, `packages/core` (framework-free domain), `packages/channels`, `packages/db`, `packages/shared`
- [v1] Docker Compose: api, worker, web (static via nginx or served by api), postgres+pgvector, redis, minio; `.env.example`
- [v1] Drizzle migrations; seed script for a workspace, admin user, test channel
- [v1] Stateless API, BullMQ queues, S3-compatible storage client, PgBouncer-ready connection handling
- [v1] Staging on VPS behind Nginx Proxy Manager (WebSocket enabled)
- [v1] CI: typecheck, lint, unit tests incl. webhook fixture replay
- [later] Multi-workspace UI, billing, Cloudflare Containers / Fly.io deployment recipes

## 3.9 Milestone status

**M1 is complete.** The skeleton and the AI/human loop run end to end, locally and as
container images. Delivered:

- Monorepo, Docker Compose infrastructure, CI running lint, typecheck, migrations, 147
  tests and the web build.
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

  The `propose_merge` AI tool listed in §3.3 is deliberately not built. A model is given one
  customer and never sees another, which is what stops recall leaking across people, so it
  has no way to name the other half of a merge. Deterministic matching on extracted
  identifiers does the same job without that access.

**M4's own list is done.** Two internal tools named in §3.3 are still outstanding, and
neither belongs to a milestone that has closed:

- `schedule_follow_up` has never been built. Nothing else depends on it and no pilot
  conversation has needed it yet, but it is listed as v1 and is not there.
- `propose_merge` is deliberately not built, and should be struck from §3.3 rather than
  scheduled. See the merge suggestions entry above: a model is handed one customer and
  never sees another, which is exactly what stops recall leaking between people, so it has
  no way to name the other half of a merge.

## 3.10 M5 design intent

M5 is not yet built. What follows is decided rather than discovered, so that it is not
re-argued at implementation time. Decisions 18 to 20 carry the short form; this is the
reasoning.

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

**The salon-saas tools are the first consumers**, and only one of the three is reachable
today. Subscription status can be answered with no new credential at all by putting `plan`
and `paidUntil` into the widget token's existing attributes. Account lookup is blocked:
every platform route is guarded by a check that refuses any bearer header before it
evaluates a session, deliberately, so it needs a narrow read-only support credential on the
salon-saas side. Ticket creation has nothing to call, and should not be built: a conversation
in this console already has an assignee, a status, tags, notes and a history, which is what a
ticket is.

## 4. Open questions / to refine
- Expected conversation volume at launch (assumed low hundreds/day)
- Who maintains knowledge day to day (assumed partner staff via GUI, admin-gated)
- Exact 9router API behaviour (model listing, streaming) — verify at integration time
- Whether humans should see unmasked card/ID numbers (currently: no)
- Business hours and acknowledgement wording for the pilot
