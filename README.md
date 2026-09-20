# chatbot-integration

AI customer-chat harness for Facebook Messenger, LINE and an embeddable web widget, with RAG knowledge, customer memory, and a human-takeover web GUI. Any OpenAI-compatible model/provider.

- Requirements and feature list: [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Open-source reuse research: [docs/RESEARCH-REUSE.md](docs/RESEARCH-REUSE.md)

Stack: Elysia on Bun, Drizzle, Postgres + pgvector, Redis, MinIO, Vite React SPA. Docker Compose on a VPS; container-based scale-up.

Status: requirements phase. Milestone M1 (skeleton and the AI/human loop) is next.
