# Deploying to a VPS

One VPS running Docker, with Nginx Proxy Manager terminating TLS. The same images run on
Fly.io, Cloud Run, Kubernetes or Cloudflare Containers when traffic justifies moving.

The stack is five long-running containers, `api`, `worker`, `postgres`, `redis` and `minio`,
plus `minio-init`, which creates the bucket once and exits. The API also serves the built
console and the widget, so one hostname fronts the whole product.

## Prerequisites

- Docker and the Compose plugin.
- A DNS record pointing at the VPS, for example `chat.example.com`.
- Nginx Proxy Manager, or any reverse proxy that terminates TLS and forwards WebSockets.

## First deployment

```bash
git clone git@github.com:mosidee/chatbot-integration.git
cd chatbot-integration
cp .env.example .env
```

Generate the two secrets:

```bash
bun -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'))"
```

`APP_SECRET_KEY` encrypts provider keys and channel credentials. **If it is lost, every
stored credential becomes unreadable and must be re-entered.** Keep a copy somewhere the
server is not the only holder.

Set these in `.env` for a real deployment:

```
NODE_ENV=production
POSTGRES_PASSWORD=<a strong password>
APP_SECRET_KEY=<generated>
BETTER_AUTH_SECRET=<generated>

PUBLIC_API_URL=https://chat.example.com
PUBLIC_WEB_URL=https://chat.example.com
BETTER_AUTH_URL=https://chat.example.com
WEBHOOK_BASE_URL=https://chat.example.com

# How long a link to a file an agent sent stays valid. LINE and Messenger fetch outbound
# media from a URL rather than taking the bytes, so the link has to work without a session;
# it is signed and expires. They cache what they fetch, so a customer keeps the file after
# the link dies. Seven days if unset. A change applies to links minted afterwards: one
# already sent keeps the lifetime it was signed with, which is how signed URLs work.
MEDIA_LINK_TTL_DAYS=7

SEED_ADMIN_EMAIL=you@example.com
SEED_ADMIN_PASSWORD=<a strong password you will change>
```

`PUBLIC_WEB_URL` and `BETTER_AUTH_URL` must both be the public origin. Authentication
rejects requests from origins it does not know, so a mismatch makes sign-in fail with
"Forbidden" while everything else looks fine.

Leave the `S3_*` values alone. The compose file points them at the bundled MinIO.

Then:

```bash
docker compose up -d --build
docker compose exec api bun run packages/db/src/seed.ts
```

**Use `--build`.** Plain `docker compose up -d` reuses whatever image exists, so a pull that
changed the Dockerfile silently runs the old code.

The seed creates the workspace, the admin user and the test and web channels, and grants
that admin **platform admin**, which is what makes the Platform page visible and is the only
way a second tenant can ever be created: nothing in the running API can sign anybody up.

Change the admin password after first sign-in, from **Platform → Account recovery**, giving
your own address. Not from People: that page issues a link only for a member who belongs to
one workspace and is not a platform admin, and the seeded account is both. A reset sets the
password on the account itself, so only a platform admin may issue one for an account that
reaches further than a single tenant.

The seed is idempotent, so **an installation that predates M6 must run it again** to receive
the platform-admin grant; re-running it changes nothing else.

Migrations run automatically when the API container starts.

Everybody after that first admin is added from the console: People → invite, which produces
a single-use link the admin copies and sends. Nothing is emailed, by design; see ADR 0005.

## Nginx Proxy Manager

Add a proxy host:

- Domain: `chat.example.com`
- Scheme `http`, forward to the host running the stack, port `3000`
- **Enable "Websockets Support"** — without it the console never updates live
- Request a Let's Encrypt certificate and force SSL

### Keeping the app off the public internet

Forwarding to the host on port 3000 means the app is also reachable directly on that port,
without TLS, unless a firewall stops it. If Nginx Proxy Manager runs in Docker on the same
host, a better arrangement is to put the API on the proxy's own network and bind its port to
loopback. Create `docker-compose.override.yml` beside the compose file, which stays out of
the repository because it describes one host's topology:

```yaml
services:
  api:
    ports: !override
      - "127.0.0.1:3000:3000"
    networks:
      - default
      - nginx_default   # the network Nginx Proxy Manager is on

networks:
  nginx_default:
    external: true
```

Find the proxy's network with
`docker inspect <proxy-container> --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'`.

The proxy host then forwards to the **container name** and port 3000, for example
`chatbot-integration-api-1`, rather than to the host address. Nothing else reaches the app.

Webhook URLs then take the form `https://chat.example.com/api/v1/webhooks/<channel-id>`, which
the settings screen shows per channel.

## Tenant-defined tools

Leave `TOOL_EGRESS_ALLOW_PRIVATE` unset or `false` in production. It exists so a tool
endpoint can run on localhost during development, and the API and worker **refuse to
start** with it set while `NODE_ENV=production`: the worker shares a Docker network with
Postgres, Redis and MinIO, so a tenant admin who could aim a tool inward would have the
product fetch an internal service and read the answer out to a customer. See
[docs/adr/0004-restricted-egress-for-tenant-tools.md](adr/0004-restricted-egress-for-tenant-tools.md).

A tenant whose own API is not reachable over public HTTPS cannot be served by a tool. That
is the intended trade, and the test button in settings reports the refusal plainly.

The same rule covers **model providers and external retrieval**, because a tenant admin
types those URLs too. A self-hosted gateway on a private address or plain http is reachable
only once a platform admin approves its origin for that tenant: Platform page → the tenant's
row → *Approved private endpoints*, one origin per line (`http://10.0.0.5:8080`). Only
the scheme, host and port are kept, and only that tenant may use it. Migration 0011 approved
every tenant's already-configured plain-http and IP-literal provider origins once so upgrading does not cut a working
gateway off; review that list after deploying it. A provider that stops answering with
"not a public address" or "only https" in its error needs this approval, not a code change.

## Checks after deploying

```bash
curl -s https://chat.example.com/healthz   # {"status":"ok","db":true,"redis":true}
docker compose ps                          # five up, minio-init exited, api and worker healthy
docker compose logs -f worker              # jobs completing
```

Then sign in, open **Settings**, add an AI provider with its base URL and key, point the
`agent_chat` slot at a model, and use the **Simulator** to send a message. A reply should
arrive within seconds.

The worker has its own health endpoint on port 3001 inside the network, reporting whether the
database and Redis are reachable and how many queues it is consuming.

## Connecting LINE and Messenger

See [CHANNEL-SETUP.md](./CHANNEL-SETUP.md). Both need this deployment reachable over HTTPS
first, because each platform calls the webhook URL before it will accept it.

Messenger additionally needs Meta's App Review before it can receive messages from the
public. See [META-REVIEW.md](./META-REVIEW.md) and start it early: review takes weeks, and the
pilot can run on LINE and the web widget meanwhile.

## Updating

```bash
git pull
docker compose up -d --build
```

Migrations apply on API start, and the worker waits for the API to report healthy, so a
schema change lands before any job runs against it.

### One-off: taking markdown out of replies already sent

Replies the AI wrote before the plain-text conversion landed still carry `**bold**` and
`- bullets` in `messages.text`, which is what the console shows an agent. The customer has
already read whatever they read; this only tidies the record and the inbox.

```bash
docker compose exec api bun run backfill:plain-text            # counts and one example
docker compose exec api bun run backfill:plain-text --write    # applies it
```

It rewrites only rows the AI wrote. What a customer typed is evidence and is never
touched, an agent's own words are left as they wrote them, and `content` keeps the
original in every case. Safe to run twice: a row already converted does not change again. It can run at any time
after the deploy, and a fresh installation never needs it.

### Private model gateways after migration 0011

Before 0011, provider and external-retrieval URLs were fetched without the egress guard.
The migration approves each tenant's already-configured plain-http and IP-literal origins
once, so a working gateway keeps answering. Review them afterwards on the Platform page
under *Approved private endpoints*. A gateway typed as an https hostname that resolves
privately was not grandfathered; approve it there, or its tenant's AI hands every
conversation off.

Take a `pg_dump` before deploying it, as for any migration that writes data.

### Migrations 0012 to 0014 (the review fixes)

All three add columns and write data, so take a `pg_dump` first.

- **0012** adds `invitation_issuer`, `messages.sent_at` (back-filled from `created_at` for
  sent messages), and the unique membership index `member_org_user_uq`, deleting any
  duplicate memberships first (the oldest is kept). Reset links issued before it read as
  workspace-issued, so one sent by a platform admin to somebody in two workspaces is refused
  and has to be issued again.
- **0013** adds the `canceled` and `uncertain` message statuses, `platform_message_ids`,
  `inbound_events.channel_identity_id` and the `blob_deletions` table.
- **0014** adds `embedding_space` to both embedding tables, labelled from each workspace's
  embedding slot, and `conversations.summarized_through_message_id`, set for conversations
  already summarised so their next summary does not index the same messages again.

Nothing needs running by hand afterwards. The nightly retention job now also drains
`blob_deletions` and queues agent uploads nobody sent after a day.

### Migrations 0015 and 0016 (the second group)

Both only add indexes and write no data: `outbox_job_id_idx`, which an AI turn uses to ask
whether a newer customer message has its own turn owed, and `messages_text_trgm_idx`, for
inbox search. On a large `messages` table the second takes a while to build and holds a lock
that blocks writes to the table meanwhile; at the pilot's size it is instant.

A message now reads `failed` only after the outbound job's last attempt. Rows that failed
before the deploy keep that status and can be resent from the console.

### Settings that arrive switched on

A deploy can add a workspace setting with a default, and existing workspaces take that
default without anybody saving it. Two are worth knowing before the first deploy that carries
them:

- **Closing quiet conversations** (`autoResolveAfterHours`, 24 by default). The first pass,
  within fifteen minutes of the worker starting, closes every AI conversation that has been
  quiet for a day since our last message — each with an internal note and a summary job, so
  a backlog becomes a burst of summarize calls to the model. To avoid it, empty the box in
  Settings → General before deploying, or accept it: nothing is deleted, and a customer who
  writes again reopens their conversation.
- **Holding messages** (`acknowledgementText`, `stillWaitingText`). A handoff now sends the
  first to the customer at once, and the fallback timer the second. Read both in Settings →
  General in your own voice; the defaults are polite and generic.

## Backups

What matters is Postgres and `APP_SECRET_KEY`.

```bash
docker compose exec -T postgres pg_dump -U ci chatbot_integration | gzip > backup-$(date +%F).sql.gz
```

Media lives in the `miniodata` volume. Back it up once customers start sending images, since
the platform links those were fetched from expire.

## Scaling beyond one box

The application is stateless, with Redis for fan-out and queues and S3-compatible storage for
media. To grow:

1. **Move migrations out of the API's start command first.** The image runs `migrate` before
   the server, which is right for one replica and a race for several. Run migrations as a
   one-shot job, then start the replicas.
2. Run more `api` and `worker` containers behind the proxy. No sticky sessions are needed.
3. Put PgBouncer in front of Postgres; several replicas multiply connections.
4. Move media to R2 or S3 by changing the `S3_*` variables only.
5. When one machine is not enough, push the same images to Fly.io, Cloud Run or Kubernetes.
   Nothing in the code assumes a single host.

## Troubleshooting

**Sign-in returns "Forbidden".** `PUBLIC_WEB_URL` or `BETTER_AUTH_URL` does not match the
origin the browser is using.

**The console never updates live.** WebSocket support is off on the proxy host.

**A LINE message arrives at the platform but nothing appears.** The channel secret is wrong,
so deliveries are being rejected as unsigned. The credential check does not cover it, because
the secret is only exercised when LINE signs a real webhook.

**`docker compose up` appears to succeed but runs old code.** It was run without `--build`.
