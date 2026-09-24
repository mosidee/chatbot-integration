# 0004 — Restricted egress for tenant-defined tools

Date: 2026-09-21, extended 2026-09-24 to providers and external retrieval
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

~~Operator-level configuration — provider base URLs, external retrieval — keeps the ordinary
client.~~ Superseded 2026-09-24; see "Providers are tenant-typed too" below.

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

## One spelling is not one address

The first version of this check read a v4-mapped address only in its dotted form,
`::ffff:127.0.0.1`. The same host also spells as `::ffff:7f00:1`, and a URL keeps whichever
the tenant typed, so the hex form reached loopback while the rule above claimed it could
not. Addresses are now expanded into their eight groups and judged there, which covers the
hex form, `::ffff:0:a.b.c.d`, the deprecated `::a.b.c.d`, and NAT64's `64:ff9b::/96`.

An address the expander cannot read is refused. This decides whether to send a request, so
the safe answer to "I do not understand this" is no.

## Providers are tenant-typed too (2026-09-24)

The exemption above assumed the person typing a provider URL runs the infrastructure. Since
M6 a workspace admin is a tenant's own admin, and the provider form, the `/models` discovery
button and the external-retrieval settings are all theirs. Discovery alone was a way to make
the server GET any address and read back the answer.

So every URL a tenant types goes through the restricted client: tools (`Runtime.toolFetch`),
and model providers, embeddings, rerank and external retrieval (`workspaceProviderFetch`).
`ProviderProfile.fetch` and `ExternalRetrievalConfig.fetch` are required fields, so no
builder can fall back to the global `fetch` by forgetting.

A self-hosted gateway on a private address is still legitimate — the pilot's is on
a private range — but approving one is not the tenant's call. `workspaces.private_egress_origins`
lists the origins one tenant's providers may reach although private or plain http. It is a
column, not a key in `settings`, because tenant admins write `settings`; only the
`platform: true` tenant PATCH writes it, from the Platform page. Matching is on the whole
origin, so approving a gateway approves nothing else on that machine, and a redirect from an
approved origin is checked afresh. Tools never consult the list.

Migration 0011 approved each tenant's already-configured plain-http and IP-literal provider and
retrieval origins once,
so deploying it did not cut off a working gateway. A platform admin prunes them from there.

## Redirects are followed by hand, so their rules must be too

`redirect: 'manual'` is what lets each hop be checked, and it also switches off everything
else `fetch` does with a redirect. Two of those matter. A credential is scoped to the host it
was configured for, so replaying the headers would hand a tenant's API key to whatever their
endpoint redirected to — an expired domain, or somebody else's server. And 303, along with
301 and 302 in practice, means "go and GET this instead", so replaying a write's body is how
one cancellation becomes two. Both are now done explicitly.

Which headers cross is an allowlist (`accept`, `accept-encoding`, `accept-language`,
`content-type`, `user-agent`), not a list of credential headers to strip. The first version
stripped `authorization`, `cookie` and `proxy-authorization`, and a tool whose credential
travelled as `x-api-key` — the header name is the tenant's choice — handed it to the redirect
target. A cross-origin 307 or 308, which replays the body by definition, is refused.

## The DNS race, closed (2026-09-24)

Between the check and the connection, a name can change its answer: the resolver says
`93.184.216.34`, and by the time the socket opens it says `127.0.0.1`. This was accepted as
a residual risk until the check could hand its answer to the connection.

`pinnedRequest` (`packages/infra/src/pinned-transport.ts`) does that: it makes the request
with Node's `https.request`, giving it a `lookup` that returns the addresses the check
approved, so the socket goes where the check looked while TLS still verifies the certificate
against the hostname and sends it as SNI. `agent: false` matters — a pooled connection skips
`lookup` entirely. The restricted fetch uses it whenever it resolved a name itself; an origin
a platform admin approved, and private egress allowed for development, use the plain fetch.

## Residual risk, accepted

What is recorded below was the reasoning while the race was open.

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
- A tenant with a genuinely private tool endpoint cannot use it. That is the intended trade,
  and the settings test button reports the refusal in the tenant's own words rather than
  failing silently in front of a customer.
- A tenant with a private model gateway needs a platform admin to approve its origin. The
  `/models` button says so when that is the refusal. Every AI turn reads the list from the
  workspace row, one indexed lookup.
- `TOOL_EGRESS_ALLOW_PRIVATE` now opens providers as well as tools, which is what local
  development and the test suites need, since their mock provider is on localhost.
- Tests and local development need `TOOL_EGRESS_ALLOW_PRIVATE=true`; `playwright.config.ts`
  sets it for the servers it starts. A reused dev server started without it refuses the
  loopback endpoint, and the failure reads like a product bug, which the config comment
  and the browser spec both warn about.
