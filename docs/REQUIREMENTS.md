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
- [M5] `http_tool` type (endpoint + schema + auth) configurable by admin; MCP client
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

## 4. Open questions / to refine
- Expected conversation volume at launch (assumed low hundreds/day)
- Who maintains knowledge day to day (assumed partner staff via GUI, admin-gated)
- Exact 9router API behaviour (model listing, streaming) — verify at integration time
- Whether humans should see unmasked card/ID numbers (currently: no)
- Business hours and acknowledgement wording for the pilot
