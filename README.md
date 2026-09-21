# chatbot-integration

An AI customer-support harness for Facebook Messenger, LINE and an embeddable web widget,
with a retrieval knowledge base, per-customer memory, and a console where a person takes
over from the AI or the AI hands off to them. Any OpenAI-compatible model and provider.

It is built around one rule: **the AI never goes silent.** Every path out of an AI turn ends
in a message to the customer or a handoff to a colleague, because a reply nobody knows is
owed is worse than a reply that says "let me fetch someone".

- **What it does and why**: [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)
- **How it is put together**: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Decisions taken while building**: [docs/adr/](docs/adr/)
- **Running it on a server**: [docs/DEPLOY.md](docs/DEPLOY.md)

## What works today

Milestones one to four are delivered and running in a pilot on the operator's own product.

| | |
|---|---|
| Channels | LINE, Messenger, an embeddable web widget, and a simulator for testing |
| AI | Any OpenAI-compatible provider, per-task model slots with a fallback, vision, tool calling |
| Knowledge | Hybrid retrieval over Postgres with pgvector and trigram search, Thai and English |
| Memory | Rolling per-customer summaries, plus recall over that customer's past conversations |
| Console | Inbox, takeover, suggested replies, knowledge management, settings, dashboard |
| Quality | Thumbs and reasons on AI replies, and a review queue of conversations nobody has read |
| Privacy | Card and national-ID redaction before storage, retention sweeps, erasure on request |

Still to come: tools that call the operator's own product, so the AI can answer questions
about a customer's account rather than only about the documentation.

## Requirements

- [Bun](https://bun.sh) 1.4 or newer. There is no Node build.
- Docker, for Postgres, Redis and object storage.

## Getting it running

```bash
bun install
cp .env.example .env
```

Two secrets in `.env` have no default, because a shipped default is not a secret. Generate
each one and paste it in:

```bash
bun -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'))"
```

`APP_SECRET_KEY` encrypts provider keys and channel credentials at rest. **Losing it makes
every stored credential unreadable**, so keep a copy somewhere other than the machine that
uses it. `BETTER_AUTH_SECRET` signs sessions and can be any string of sixteen characters or
more.

Then bring up the infrastructure and the schema:

```bash
bun run infra:up      # Postgres with pgvector, Redis, MinIO
bun run db:migrate    # creates the extensions, then applies migrations
bun run db:seed       # a workspace, an admin user, a simulator channel and a web channel
bun run build:widget  # the API serves the widget from disk; without this its routes 404
bun run dev           # API, worker and console together, with reload
```

The console is at <http://localhost:5173>. Sign in with the address and password from
`SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`.

### Answering without an API key

Nothing above needs a model provider. `scripts/mock-provider.ts` is an OpenAI-compatible
stand-in that answers locally, so the whole loop can be driven without spending money:

```bash
bun run scripts/mock-provider.ts    # serves on http://localhost:4010/v1
```

In **Settings → Providers**, add a provider with that base URL and any non-empty key, then
point the `agent_chat` slot at the model `mock-model`. Open **Simulator**, send a message,
and a reply should arrive within a second or two.

To use a real provider instead, add its base URL and key in the same screen. Each task slot
has a test button that calls the model through the same path a real conversation uses, so a
model that a gateway lists but will not serve fails there rather than in front of a customer.

### Connecting real channels

LINE and Messenger need this running somewhere with a public HTTPS address, because each
platform calls the webhook before it will accept it. See
[docs/CHANNEL-SETUP.md](docs/CHANNEL-SETUP.md), and
[docs/META-REVIEW.md](docs/META-REVIEW.md) for Meta's review, which takes weeks and is worth
starting early. The widget needs neither and is the fastest way to see the product working:
[docs/WIDGET.md](docs/WIDGET.md).

## Checks

```bash
bun run test        # unit and integration; needs infra:up
bun run test:e2e    # browser tests, which start the app themselves
bun run typecheck
bun run lint
```

The integration tests run against real Postgres and Redis with only the model mocked,
because the things most likely to break are the queries and the queue rather than the
prompt. `./scripts/smoke.sh` drives the whole loop end to end: sign in, configure the mock
provider, assert that the AI answers.

## Layout

```
apps/api       HTTP, WebSocket, webhooks. Thin.
apps/worker    Queue processors. Where the real work happens.
apps/web       The agent console, a Vite React app.
apps/widget    The embeddable widget: a loader script and an iframe app. No framework.
packages/core      Framework-free domain: state machine, AI harness, redaction, ports.
packages/channels  One adapter per platform, over a normalised message model.
packages/db        Drizzle schema, migrations, auth config, encryption.
packages/infra     Runtime wiring: Redis, queues, storage, repository.
packages/shared    Schemas and types shared with the browser.
packages/config    Environment parsing.
```

`packages/core` has no framework in it: no HTTP server, no React, no database client. It
defines ports that the apps implement, which is what keeps the domain testable with fakes
and the worker portable.

## Contributing

[CLAUDE.md](CLAUDE.md) is the working guide. It carries the rules that are easy to break by
accident, and a long list of things that cost somebody a day to find out. Worth reading
before a first change.

Feature branches into `main`. CI runs lint, typecheck, migrations, the tests and the console
build.

## Licence

[MIT](LICENSE). Use it, change it, ship it, sell it. The only condition is that the
copyright notice travels with substantial portions of the code, and it comes with no
warranty.
