# 0004 — Restricted egress for tenant-defined tools

Date: 2026-09-21
Status: accepted

## Context

M5 lets a workspace admin type a URL and have the AI call it during a conversation. That
turns a text field in a settings form into a request origin inside our network.

The worker shares a Docker network with Postgres, Redis and MinIO, each reachable by
container name. The model gateway answers on a private address. Nothing about a tool call
is suspicious to the machine making it: the worker fetches the URL, gets a body, and the
model reads that body out to a customer. A tool pointed at `http://postgres:5432` or at a
cloud metadata endpoint is an exfiltration channel with a friendly form in front of it.

The tenant does not have to be hostile for this to matter. A copied URL, a staging address
left in a field, or an endpoint that redirects to an internal load balancer all produce the
same request.

## Decision

Tenant-defined tools are fetched through `createRestrictedFetch` in
`packages/infra/src/egress.ts`, which:

- refuses anything but `https:`;
- refuses credentials embedded in the URL;
- resolves the hostname and checks **every** address it answers with, not the string;
- refuses 0/8, 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, 100.64/10, 224/4, 240/4,
  `::1`, `::`, `fc00::/7`, `fe80::/10`, and v4-mapped forms of any of those;
- follows redirects by hand, at most three, applying the same check to each hop.

Operator-level configuration — provider base URLs, external retrieval — keeps the ordinary
client. A self-hosted gateway on a private address is the legitimate case there, and the
person who configures it is the person who runs the infrastructure.

`TOOL_EGRESS_ALLOW_PRIVATE` relaxes the rule for local development and tests, where the
tool endpoint is on localhost. `createRuntime` throws at startup if it is set while
`NODE_ENV=production`, the same refusal `db:reset` makes against a production database: a
switch that is harmless locally and hands over the internal network in production should
not be one nobody notices.

## Why the string check is not enough

Two failures survive it. A hostname can resolve to a private address, so
`internal.example.com` pointing at `10.0.0.5` passes a check on the text and fails the one
that matters. And a public host can answer with a redirect, so the first hop passes while
the second reaches inward; browsers follow redirects transparently and so does `fetch`
unless told otherwise, which is why `redirect: 'manual'` is not an optimisation here.

`dns.promises.lookup` returns a single record unless asked for all of them. A name with
one public and one private address would pass a check that only read the first, so the
default resolver passes `{ all: true }` and a test pins that the real resolver is the one
used when none is injected.

## Residual risk, accepted

Between the check and the connection, a name can change its answer: the resolver says
`93.184.216.34`, and by the time the socket opens it says `127.0.0.1`. Closing that window
means connecting to the address we resolved rather than to the name.

We do not do that, because it breaks TLS. A certificate is presented for a hostname; a
connection opened to a literal address either fails verification or has to be told to skip
it, and skipping certificate verification to close an SSRF hole trades a narrow race for a
wider hole. The proper fix is a socket-level hook that validates the peer address after
connection while leaving the TLS handshake addressed by name, which Bun's `fetch` does not
expose today.

The window is short, requires a hostile DNS server the tenant controls, and yields one
request whose body the tenant could have read anyway by pointing the tool at their own
server. It is recorded here so that the next person to look does not assume it was missed.

## Consequences

- A tenant cannot reach our infrastructure through a tool, including via redirect.
- A tenant with a genuinely private endpoint cannot use it. That is the intended trade, and
  the settings test button reports the refusal in the tenant's own words rather than
  failing silently in front of a customer.
- Tests and local development need `TOOL_EGRESS_ALLOW_PRIVATE=true`; `playwright.config.ts`
  sets it for the servers it starts. A reused dev server started without it refuses the
  loopback endpoint, and the failure reads like a product bug, which the config comment
  and the browser spec both warn about.
