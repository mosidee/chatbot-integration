# Architecture (v0.1)

## Processes (Docker Compose)
- **api** — Elysia on Bun. HTTP + WebSocket. Stateless. Webhook endpoints verify signature, persist raw event, enqueue, return 200.
- **worker** — Bun. BullMQ consumers: inbound message processing, AI turns, summaries, ingestion, retention jobs.
- **web** — Vite React SPA (agent GUI), static.
- **widget** — embeddable script + iframe app.
- **postgres** (pgvector, pg_trgm), **redis** (queues + pub/sub), **minio** (S3 API for media).

## Monorepo
```
apps/api  apps/worker  apps/web  apps/widget
packages/core      framework-free domain: conversation state machine, AI harness, retrieval, memory, redaction, tool registry
packages/channels  normalised message model + adapters: line, messenger, web, test
packages/db        Drizzle schema + migrations (workspace_id everywhere)
packages/shared    Zod/TypeBox schemas, types shared with web/widget via Eden Treaty
```
Rule: `apps/*` are thin. Nothing in `packages/core` imports Elysia, Bun-only APIs, or React.

## Inbound flow
channel webhook → adapter.verify + adapter.normalise → `inbound_events` (raw, idempotent on platform id) → queue `inbound` → worker: upsert identity/customer/conversation → redact → store message → publish realtime → decide by `conversation.mode`:
- `ai` → queue `ai_turn` → agent loop → send via adapter → store → trace
- `ai_supervised` → agent loop → store draft → notify humans
- `human` → queue `suggestion` → store suggestion (never send)
- `waiting_human` → optional acknowledgement / fallback timer

## Agent loop (packages/core/ai)
Context = system prompt (workspace persona, language rule) + customer summary + recent window + retrieved chunks (pre-fetched) + tools. Model via Vercel AI SDK `openai-compatible` provider chosen from task slot `agent_chat` with fallback. Tools: internal registry now; `http_tool` and MCP later. Structured output for quick replies. Every turn writes `ai_traces`.

## Retrieval (packages/core/rag)
Chunks table with `embedding vector`, `tsv`/trigram index, workspace + language + source filters. Query: dense top-k ∪ keyword top-k → RRF → optional rerank slot → threshold → chunks with scores. Same function serves the AI and the human suggestion panel. External adapters implement the same `retrieve(query, opts)` interface.

## Key tables (all with workspace_id)
workspaces, users, memberships, channels, channel_identities, customers, customer_fields, merge_suggestions, conversations, messages, attachments, internal_notes, inbound_events, ai_traces, suggestions, feedback, knowledge_sources, knowledge_entries, knowledge_chunks, customer_summaries, providers, task_slots, canned_responses, handoff_rules, audit_log.

## Scale path
Same images on Fly.io / Cloud Run / k3s / Cloudflare Containers. Requirements already met: stateless api, Redis fan-out, separate worker, S3 client, pooled Postgres.
