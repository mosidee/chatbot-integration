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
- **Giving the AI a tool of your own**: [docs/TOOLS.md](docs/TOOLS.md)
- **Letting the AI read a customer's account**: [docs/IDENTITY-VERIFICATION.md](docs/IDENTITY-VERIFICATION.md)
- **The security and reliability review, and its status**: [recommendation.md](recommendation.md)
- **The console and widget UX audit, and its status**: [docs/UX-AUDIT.md](docs/UX-AUDIT.md)

## What works today

Milestones one to six are delivered, and one to four are running in a pilot on the operator's own product.

| | |
|---|---|
| Channels | LINE, Messenger, an embeddable web widget, and a simulator for testing |
| AI | Any OpenAI-compatible provider, per-task model slots with a fallback, vision, tool calling |
| Knowledge | Hybrid retrieval over Postgres with pgvector and trigram search, Thai and English |
| Memory | Rolling per-customer summaries, plus recall over that customer's past conversations |
| Console | Inbox with open and waiting badges, search, takeover, suggested replies, resend of failed deliveries, knowledge, tabbed settings, dashboard; usable on a phone |
| Tools | Tenant-defined HTTP tools the AI can call, with restricted egress and proved identity |
| Security | Every URL a tenant types goes through restricted egress; a private model gateway is approved per tenant by a platform admin. Stored files are served as downloads or inert media |
| Quality | Thumbs and reasons on AI replies, and a review queue of conversations nobody has read |
| Privacy | Card and national-ID redaction before storage, retention sweeps, erasure on request |
| People | Invite a colleague with a single-use link, change roles, reset a password they lost |
| Tenants | Create, suspend, restore and erase a whole workspace, and approve its private endpoints, from a page only a platform admin sees |

Milestone five added tools: an admin describes an endpoint of their own, and the AI can
call it during a conversation. What the model fills in and what the system supplies are
separate parts of the definition, so a model can never choose whose account to read, and a
tool that needs a proved identity is not offered in a conversation where nobody proved one.

Milestone six made the product multi-tenant in practice rather than only in the schema. An
admin adds colleagues themselves, with a link they pass on; a platform admin creates and
deletes whole workspaces; and a workspace can be suspended, which locks its people out and
quietly drops its queued work while keeping every row.

A UX pass after milestone six made the product honest with the customer. A handoff now
tells them a person is coming, in their own language, and apologises if nobody has picked up
in time; the widget shows who is answering and says so when it cannot work. Replies are
plain text, because every channel renders markdown as punctuation. A conversation the
customer walked away from closes itself after a day, which is also what makes the AI
remember it next time.

Still to come: an MCP client, so a tenant can connect their own server and bring a whole
tool set without us shipping anything. Billing, self-service sign-up and emailed invitations
are deliberately absent.

## Requirements

- [Bun](https://bun.sh) 1.4 or newer. There is no Node build.
- Docker, for Postgres and Redis. Media is stored on disk locally (`.data/media`) and in
  Cloudflare R2 in production (ADR 0008).

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
bun run infra:up      # Postgres with pgvector and Redis; media goes to ./.data/media
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

In **Settings → AI models**, add a provider with that base URL and any non-empty key, then
point the "Answering customers" (`agent_chat`) slot at the model `mock-model`. Open **Simulator**, send a message,
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
workers/line-media A Cloudflare Worker that fetches LINE media (optional, ADR 0009).
e2e/               Playwright browser tests.
```

`packages/core` has no framework in it: no HTTP server, no React, no database client. It
defines ports that the apps implement, which is what keeps the domain testable with fakes
and the worker portable.

## Contributing

[CLAUDE.md](CLAUDE.md) is the working guide. It carries the rules that are easy to break by
accident, and a long list of things that cost somebody a day to find out. Worth reading
before a first change.

Feature branches into `main`. CI runs lint, typecheck, migrations, the web and widget builds,
the unit and integration tests and the browser tests, and builds both release images and
requires them to start healthy.

## Licence

[MIT](LICENSE). Use it, change it, ship it, sell it. The only condition is that the
copyright notice travels with substantial portions of the code, and it comes with no
warranty.
