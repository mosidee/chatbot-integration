# Open-source reuse research (verified 2026-09-20)

Two research passes over GitHub. Stars/licenses/activity checked via the GitHub API on the date above. Anything marked *unverified* was seen only in search results.

## Verdicts for this project (TypeScript / Bun build)

| Need | Use | Notes |
|---|---|---|
| LINE adapter | **`@line/bot-sdk`** (line/line-bot-sdk-nodejs, Apache-2.0, active) | Official. Also line/line-bot-mcp-server as a reference for exposing LINE as agent tools |
| Messenger adapter | **Meta Graph API directly**, fbsamples/messenger-platform-samples as reference | No maintained official Node SDK. Copy webhook/signature patterns from botpress/botpress `integrations/messenger` (MIT) |
| Payload normalisation | Read **Yoctol/bottender** (MIT, unmaintained since 2024) and **botpress `integrations/line`** | Copy patterns, do not depend |
| LINE OA inbox patterns | **Shudesu/line-harness-oss** (MIT, 2026) | Young; mine for LINE inbox UX and MCP design |
| Provider abstraction | **Vercel AI SDK** `@ai-sdk/openai-compatible` (Apache-2.0, very active) | In-process; base URL + key + model per profile. OpenRouter via `@openrouter/ai-sdk-provider` or plain OpenAI-compatible |
| Gateway sidecar (optional, later) | **maximhq/bifrost** (Go, Apache-2.0) or **BerriAI/litellm** (Python, MIT) | Only if per-tenant budgets/keys need to move out of process. Portkey slower; Helicone ai-gateway GPL + stale |
| Agent loop | Vercel AI SDK tool calling; **mastra-ai/mastra** as reference for memory + suspend/resume | No TS framework has conversation-level handoff; we own the state machine |
| Retrieval | **Own implementation on Postgres + pgvector + pg_trgm** | Nothing TS is a drop-in service. Reference: SciPhi-AI/R2R (Postgres-only design, stale), deepset haystack pipelines |
| External knowledge adapter | **Dify** `POST /v1/datasets/{id}/retrieve`, **RAGFlow** `POST /api/v1/retrieval` | Both heavy Python platforms; support as adapters only. RAGFlow deep-doc parsing is the strongest if Thai PDFs defeat our parser |
| Embeddings (Thai+EN) | **bge-m3** self-hosted (via TEI/Ollama, OpenAI-compatible), **Qwen3-Embedding-8B** if GPU, **OpenAI text-embedding-3-large** hosted | All behind the same provider layer |
| Vector store | **pgvector** (one DB for history + vectors, fine to ~10M vectors) | Qdrant if sparse+dense hybrid at scale is needed |
| Long-term memory layer | Own summaries in Postgres for v1 | mem0ai/mem0 is the lowest-friction external option but Python |
| Fallback product | **chatwoot/chatwoot** (MIT core) | Only mature OSS inbox with LINE + Messenger verified in source; Agent Bot API does `pending → open` handoff. Its AI feature "Captain" is proprietary (paid self-host) |

## Do not build on
Flowise (archived 2026-08), Microsoft Bot Framework / Botkit (archived), Botfront (archived), Botpress OSS v12 (dormant), Rasa CALM (proprietary), Tiledesk (server repo gone), Rocket.Chat (Messenger is paid add-on, no LINE), Chaskiq (Commons Clause), Papercups (maintenance mode), Verba / Cognita (archived), R2R (no commits ~10 months), Zep CE (deprecated), Helicone ai-gateway (GPL, stale).

## Category tables

### Omnichannel inboxes
| Repo | Stack | License | Stars | Messenger | LINE | Handoff | Verdict |
|---|---|---|---|---|---|---|---|
| chatwoot/chatwoot | Rails + Vue | MIT core | 37k | Yes | Yes | Agent Bot API | Fallback product |
| botpress/botpress | TS (cloud runtime) | MIT | 15k | Yes | Yes | hitl plugin | Borrow integration code |
| Shudesu/line-harness-oss | TS | MIT | 0.6k | No | Yes | Operator reply | Borrow patterns |
| RocketChat/Rocket.Chat | TS/Meteor | mixed | 46k | Paid | No | Yes | Reference |
| zammad/zammad | Rails | AGPL | 6k | Yes | No | Ticketing | Reference |
| RasaHQ/rasa | Python | Apache | 21k | Yes | Community | No inbox | Reference |
| Tiledesk | Node + Angular | MIT | small | Claimed | No | Yes | At risk |

### Channel libraries
| Repo | Lang | License | Maintained | Note |
|---|---|---|---|---|
| line/line-bot-sdk-nodejs | TS | Apache | Yes | Use |
| line/line-bot-mcp-server | TS | Apache | Yes | Reference |
| fbsamples/messenger-platform-samples | JS | Meta sample | Yes | Reference |
| Yoctol/bottender | TS | MIT | No (2024) | Copy normalisation |
| microsoft/botbuilder-js | TS | MIT | Archived | Skip |
| microsoft/Agents | TS | MIT | Yes | Azure-coupled, skip |

### LLM gateways
| Repo | Lang | License | Stars | Form |
|---|---|---|---|---|
| vercel/ai | TS | Apache | 27k | Library — use |
| BerriAI/litellm | Python | MIT+ent | 59k | Sidecar |
| maximhq/bifrost | Go | Apache | 8k | Sidecar, single binary |
| Portkey-AI/gateway | TS | MIT | 13k | Sidecar, slowing |

### RAG engines
| Repo | Lang | License | Stars | Retrieval API | Stores | Verdict |
|---|---|---|---|---|---|---|
| langgenius/dify | TS/Py | mod. Apache | 157k | Yes | many incl. pgvector | Adapter target |
| infiniflow/ragflow | Go/Py | Apache | 91k | Yes | ES/Infinity | Adapter target; best parsing |
| Mintplex-Labs/anything-llm | JS | MIT | 66k | Yes | many | Simplest service; less control |
| HKUDS/LightRAG | Py | MIT | 40k | Yes | PG/Qdrant/Milvus | Graph RAG later |
| neuml/txtai | Py | Apache | 13k | Yes | Faiss/pgvector | Lightweight |
| SciPhi-AI/R2R | Py | MIT | 8k | Yes | pgvector | Stale; design reference |
| run-llama/llama_index, langchain, haystack | Py | MIT/Apache | large | Library | many | Pipeline references |

### Agent frameworks / memory
| Repo | Lang | Handoff primitive | Memory |
|---|---|---|---|
| emcie-co/parlant | Py | Session manual mode, human_agent events (first-class) | Event log |
| mastra-ai/mastra | TS | Workflow suspend/resume | Built-in memory, semantic recall on pgvector |
| openai/openai-agents-js | TS | Tool approval | Sessions |
| pydantic/pydantic-ai, agno | Py | Tool approval | Sessions/user memory |
| mem0ai/mem0 | Py | n/a | Self-hostable memory layer |
| getzep/graphiti | Py | n/a | Temporal knowledge graph |
