# ADR 0011: Tenants connect their own MCP servers

Accepted 2026-10-03.

## Context

Decision 18 in REQUIREMENTS made tools a *source*: the internal registry is one, a tenant's
HTTP tools are another, and an MCP client was to be the third, so a tenant could connect a
server they run and bring its whole tool set without us shipping anything. The seam
(`ToolSource`, `createWorkspaceToolSources`) was built for it. This records how the third
source is built.

## Decision

- **A table of its own, `mcp_servers`**, not rows in `tools`. Every reader of `tools` takes
  the config to be an HTTP tool's, and a server is a set of tools rather than one. The plan
  had said "a `tools` row with `kind = 'mcp'`"; that was changed before any of it shipped.
  The row holds the URL, how to authenticate, the encrypted credential, the **snapshot** of
  the tool list as last fetched, and the **allowlist**.
- **Nothing is offered that an admin did not tick.** An admin fetches the list, ticks tools
  and chooses for each whether it reads or writes. The server's own hint decides where it
  can: `readOnlyHint: true` defaults to read; `readOnlyHint: false` or `destructiveHint: true`
  can only be a write; anything the server does not say has no default, and the allowlist
  cannot be saved until the admin chooses. A read runs during the turn and its answer
  reaches the model; a write is recorded and fired after the turn, like an HTTP write, with
  the turn's idempotency key in the call's `_meta`.
- **What the model sees is the stored snapshot**, never a live listing. A server that changes
  a description after approval changes nothing until an admin fetches again. Descriptions
  are cut to 1,000 characters, a schema over 8 KB is kept but cannot be allowed, and a
  listing stops at 100 tools or 10 pages. The card shows roughly what the allowed tools add
  to every turn's prompt.
- **Names are `<server>_<tool>`**, lowercased with anything else made an underscore. Two
  tools can sanitise alike, so uniqueness is checked when the allowlist is saved — against
  the built-in names, every HTTP tool and every other server — and when an HTTP tool is
  created or renamed, against what MCP servers expose. `mergeToolSources` would otherwise
  keep one and drop the other with only a log line.
- **Bindings as for HTTP tools.** An admin can bind any argument the server declares to the
  proved subject, the customer, the conversation or the workspace. A bound argument is taken
  out of the schema the model sees (properties and required), and the bound values are laid
  over the model's arguments last, because `jsonSchema()` does not validate and a model can
  send keys outside its schema. A tool binding a subject nobody proved is not offered.
- **Every request goes through restricted egress** (`runtime.toolFetch`): fetching the list,
  testing a tool, and every call in a turn. The URL is tenant-typed, the same SSRF surface as
  an HTTP tool. The restricted client follows redirects itself and strips credentials across
  origins.
- **One connection per call.** Connect, call, close. Calls are rare and short, and nothing
  opened by a turn can outlive it. The SDK (`@modelcontextprotocol/sdk`, pinned) lives in
  `packages/infra` only and is imported by deep path, so the worker does not load its server
  half; `packages/core` holds a pure source fed by an injected `McpCaller`.
- **Draft mode offers no write tools**, as for HTTP tools. A server's `isError` result is a
  tool error: the turn hands off rather than answering around a lookup that did not happen.

### Authentication

`none`; a token in a header the admin names (stored encrypted, `hasCredential` only); or
OAuth, an admin signing in to a hosted server once.

**OAuth** follows the MCP authorization spec: protected-resource metadata, authorization
server discovery, dynamic client registration, PKCE. The SDK's `auth()` runs in exactly two
places, both with a person present:

- `POST /settings/mcp/:id/oauth/start` (admin) discovers, registers, and returns the URL to
  send the admin to. Its `state` is HMAC-signed with `APP_SECRET_KEY` and names the
  workspace, the server and the admin, for ten minutes. The URL comes from the server's
  metadata and the console navigates to it, so anything but `https:` is refused.
- `GET /api/mcp/oauth/callback` is public, because it is a redirect from somebody else's
  site, and so proves everything itself: the state is ours, unexpired, and names the person
  whose session arrived; they are still an admin of that workspace and it is active. It
  swaps the code and redirects to a fixed console path. `redirect_uri` is built from
  `PUBLIC_WEB_URL`, never from the request. Better Auth's cookie is `SameSite=Lax`, so the
  session arrives on that top-level redirect.

Everything the sign-in leaves — the client registration, the tokens with their expiry, the
discovery results — is one encrypted JSON document in `credential_encrypted`.

**A turn never calls `auth()`.** On a failed refresh it falls through to "start a new
sign-in", and it swallows a 5xx or a network error on the way, so in a worker a passing
outage would become a server needing an admin. The worker sends `Authorization: Bearer`
itself and refreshes with the SDK's `refreshAuthorization` directly, from the stored
discovery, when the token is within a minute of expiring — **under a row lock, re-reading
after taking it**, so two turns cannot both spend a single-use refresh token (the second
finds the first one's token). A call answered 401 gets one forced refresh and one retry.
Only `invalid_grant` marks the server `needs_reconnect`; its tools then leave every turn
until an admin signs in again, rather than handing every conversation off. A server that is
down during a refresh is an ordinary tool failure.

The AI acts as whoever signed in, for every customer. The card says so and suggests an
account made for the purpose.

## Consequences

- A tenant's server is code we do not run and cannot inspect. The allowlist and the
  read/write choice are the controls; an admin who marks a writing tool as a read lets it run
  mid-turn. The settings card says what each choice means.
- A connection per call costs an initialize round trip each time. If tool calls become
  frequent, a per-turn client closed in the turn's `finally` is the next step.
- The browser tests run the SDK's own server as a process (`mcp-server-cli.ts`), because
  Playwright runs on Node; the integration tests run it on `Bun.serve`.
