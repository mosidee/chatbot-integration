# Deploying to a VPS

The target is a single VPS running Docker, with Nginx Proxy Manager terminating TLS. The
same images run unchanged on Fly.io, Cloud Run, Kubernetes or Cloudflare Containers when
traffic justifies moving.

## Prerequisites

- Docker and the Compose plugin.
- A DNS record pointing at the VPS, for example `chat.example.com`.
- Nginx Proxy Manager, or any reverse proxy that can terminate TLS and forward WebSockets.

## First deployment

```bash
git clone git@github.com:mosidee/chatbot-integration.git
cd chatbot-integration
cp .env.example .env
```

Fill in `.env`. Generate the two secrets with:

```bash
bun -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'))"
```

`APP_SECRET_KEY` encrypts provider keys and channel credentials. **If it is lost, every
stored credential becomes unreadable and has to be re-entered.** Back it up somewhere the
server itself is not the only copy.

Also set, for production:

```
NODE_ENV=production
POSTGRES_PASSWORD=<a strong password>
PUBLIC_API_URL=https://chat.example.com
PUBLIC_WEB_URL=https://chat.example.com
BETTER_AUTH_URL=https://chat.example.com
WEBHOOK_BASE_URL=https://chat.example.com
S3_PUBLIC_URL=https://chat.example.com/media
```

Then:

```bash
docker compose up -d --build
docker compose exec api bun run packages/db/src/seed.ts
```

The seed creates the workspace, the admin user from `SEED_ADMIN_EMAIL` and
`SEED_ADMIN_PASSWORD`, and the test and web channels. Change the admin password after the
first sign-in. Migrations run automatically when the API container starts.

## Nginx Proxy Manager

Add a proxy host:

- Domain: `chat.example.com`
- Scheme `http`, forward to the host running the stack, port `3000`
- **Enable "Websockets Support"** — the agent console will not receive live updates without it
- Request a Let's Encrypt certificate and force SSL

Webhook URLs then take the form `https://chat.example.com/api/v1/webhooks/<channel-id>`,
which the settings screen displays per channel.

## Checks after deploying

```bash
curl -s https://chat.example.com/healthz     # {"status":"ok","db":true,"redis":true}
docker compose ps                            # every service up, api healthy
docker compose logs -f worker                # jobs completing
```

Sign in, open Settings, add a provider with its base URL and key, point the `agent_chat`
slot at a model, then use the Simulator to send a message and confirm a reply.

## Updating

```bash
git pull
docker compose up -d --build
```

Migrations apply on API start. The worker waits for the API to report healthy, so a schema
change lands before any job runs against it.

## Backups

What matters is Postgres and `APP_SECRET_KEY`.

```bash
docker compose exec -T postgres pg_dump -U ci chatbot_integration | gzip > backup-$(date +%F).sql.gz
```

Media lives in the `miniodata` volume; back it up too once customers start sending images.

## Scaling beyond one box

The application is already stateless, with Redis for fan-out and queues, and S3-compatible
storage for media. To grow:

1. Run more `api` and `worker` containers behind the proxy. No sticky sessions are needed.
2. Put PgBouncer in front of Postgres; several replicas multiply connections.
3. Move media to R2 or S3 by changing the `S3_*` variables only.
4. When one machine is no longer enough, push the same images to Fly.io, Cloud Run or a
   Kubernetes cluster. Nothing in the code assumes a single host.
