# Repository recommendations

Reviewed against the working tree on **2026-09-24**; status updated the same day after the fixes landed.

The product has a useful foundation for a Thai/English support team: a compact inbox, human takeover, knowledge management, and a lightweight customer widget. The next pass should make everyday work dependable: show failed actions, preserve drafts, make every conversation reachable, recover missed updates, and complete the widget experience. A visual redesign is lower value than those corrections.

This file holds the engineering findings, with their numbers preserved and a status for each. The UX/UI audit that accompanied them is in [docs/UX-AUDIT.md](docs/UX-AUDIT.md).

## Scope and confidence

This was a repository-wide **source audit**, covering all console routes and shared UI components, the widget app/loader/styles, API authorization and response paths, worker workflows, channel adapters, shared/domain/infrastructure packages, schema and migrations, browser-test coverage, deployment configuration, and product/architecture documentation. Backend review focused on behavior visible to customers and operators and on rechecking the existing 24 findings. Generated migration snapshots and dependency lockfiles were not audited line by line; secrets, dependencies, runtime data, and generated assets were excluded.

No authenticated browser session, screenshots, screen-reader session, database integration suite, production image build, or live provider delivery was run. Layout concerns below are source-level risks requiring visual validation, not observed screenshots. Existing tests were inspected, not rerun. The previous document's typecheck/lint/320-test results belong to the earlier review and are **not evidence of validation in this audit**.

Two in-memory checks were run with synthetic values and no external service calls (both defects are fixed since; see finding 15 and U10):

- Importing the current `signPayload` and signing a Thai/emoji subject throws `The string contains invalid characters.`
- Applying the widget's current color-selection calculation to `#808080` selects white, producing approximately **3.95:1** contrast. Its automatic foreground selection is therefore not sufficient for a 4.5:1 normal-text design target.

“Resolved in source” means the original defect has a corresponding implementation, not a certification of production behavior. “Partial” means a useful fix exists but part of the original finding remains. Proposed acceptance checks are future work unless explicitly described above as executed.

## Status of every finding (2026-09-24)

Fixed in source means the defect has a corresponding implementation and a regression test
named below; it is not a certification of production behaviour. Residual items are stated
rather than rounded away.

| Finding | Status | What was done, and what remains |
| --- | --- | --- |
| 1. Public web/simulator identity injection | Fixed | Public route serves only signature-verifying adapters; widget and simulator use `ingestInternal`; proved identity travels outside the body. |
| 2. Global password recovery | Fixed | Links carry `issuer_scope`; a workspace-issued reset is refused at redemption once the account reaches another workspace, administers the platform, or has left (`apps/api/test/invitations.test.ts`). |
| 3. Uploaded active content | Fixed by serving policy; separate origin deferred | `mediaServingHeaders` on both routes (attachment for active types, `nosniff`, sandbox CSP); uploads accept raster images by exact type and check magic bytes. A separate media origin needs a second hostname. |
| 4. Provider/retrieval egress | Fixed | Every tenant-typed URL goes through the restricted client; private gateways approved per tenant by a platform admin; connections go to the address the check approved (`pinnedRequest`), closing the DNS race (`packages/infra/test/pinned-transport.test.ts`). |
| 5. Redirect credential forwarding | Fixed | Header allowlist across origins; cross-origin 307/308 with a body refused. |
| 6. Attachment ownership | Fixed | `isWorkspaceKey` judges keys canonically (no `..`, `.`, empty segments, backslashes) at every read, association, signature and deletion; the public media route re-checks signed keys. |
| 7. Authoritative human takeover | Fixed | Learned fields and tags are written only while the AI still owns the conversation; the reply is committed under a row lock, so a takeover is either seen or waits; outbound re-checks the mode and records `canceled`. A turn steps aside when a newer customer message has its own turn owed — before the model call, after it and under the commit lock, the last only if none of its writes fired — so two quick messages get one answer (`apps/worker/test/loop.integration.test.ts`, migration 0015). |
| 8. Outbox and durable steps | Fixed; external write keys residual | Transactional outbox; stable event ids for internal ingestion; widget client message ids; inbound media keyed by event. A retried model call that asks for different write arguments still gets a new idempotency key. |
| 9. Delivery and multipart | Fixed; Messenger idempotency deferred | Unit checkpoints inside one message, every platform id kept, LINE `X-Line-Retry-Key`, `uncertain` status never resent blindly. Messenger offers no idempotency key. |
| 10. Fallback attempt isolation | Fixed | A scratchpad per attempt; only the winning attempt's intents count (`packages/core/test/agent.test.ts`). |
| 11. Turn deadlines and final failure | Fixed | Per-attempt deadlines (slot `timeoutMs`) inside a 150 s turn deadline; bounded repair buffer; an AI turn that fails its last attempt hands off. |
| 12. Redaction and retention breadth | Fixed | Raw events keep only the body, are emptied once processed, go with the customer's identity on erasure and are pruned by retention. Traces (prompt, tool calls, retrieved text, errors), drafts, AI and agent notes, summaries and their facts, field updates and vision descriptions are masked with the workspace's rules (`recordTrace` requires them; `redactDeep`). |
| 13. Resumable blob deletion | Fixed | `blob_deletions` queued in the deleting transaction for retention, customer erasure and knowledge sources; nightly drain; abandoned uploads swept after a day; `.mime` sidecars removed. |
| 14. Last-admin and membership uniqueness | Fixed | Checks and mutations share transactions; `member_org_user_uq` (in migration 0012, since `auth.ts` is generated); acceptance is conflict-safe. |
| 15. Widget origins and Unicode | Fixed | UTF-8 token signing; embedding enforced by CSP `frame-ancestors` per channel; the iframe's own session request is accepted (`e2e/widget-embed.spec.ts`). |
| 16. Widget attachments and history | Fixed | Only delivered replies are shown (a reply withheld by a takeover used to appear); files signed at read time from storage keys; cursor on when a row became visible (`messages.sent_at`). |
| 17. Provider cache refresh | Fixed | Profiles carry a revision (`updatedAt`); caches rebuild on change. |
| 18. Live socket authorisation | Fixed | Origin check; re-validation on `auth.changed`/`workspace.status` and every five minutes; typing scoped to workspace and role; no join race; client refetches on reconnect and stops on 4401/4403. |
| 19. Embedding-space identity | Fixed | `embedding_space` stored and matched on dense search and recall. |
| 20. Index replacement | Fixed | File reindex and recall embed first and swap in one transaction; transient failures retried. An entry index re-checks the entry under a lock and stores nothing if it changed while embedding; file swaps lock the source row, so concurrent reindexes cannot index a document twice (`packages/infra/test/retrieval.integration.test.ts`). |
| 21. Persistent-thread memory | Fixed | Newest notes; incremental summaries from a cursor; new facts win; recall excludes only the visible window. |
| 22. Pagination and bounded reads | Fixed | Total order and offset paging with load-more; lateral previews; history by cursor without a cap. Offset paging can repeat or skip a row that moves while paging a live queue. |
| 23. Reporting semantics | Fixed; accounting scope stated | Answered and response times count delivered replies; workspace timezone. Cost excludes failed primary attempts and embedding/rerank usage, and the dashboard says so. |
| 24. Deployment images and failure states | Fixed; restore rehearsal not done | Worker manifest; CI builds both images and requires them healthy; MinIO pinned by digest; console failure states (see the UX audit). A backup restore rehearsal has not been performed. |

## UX/UI recommendations

Moved to [docs/UX-AUDIT.md](docs/UX-AUDIT.md), with the status of every item.

## Original engineering findings — preserved context

The numbered findings below retain their original problem descriptions and acceptance criteria for traceability. Some describe **pre-hardening behavior that no longer exists**. Read the current status immediately under each heading and the verification table above before treating a paragraph as a present defect. Existing implementation notes for 3–5 are retained as historical notes, not new runtime validation.

## P0 — Authorization boundaries

### 1. Stop accepting web and simulator payloads through the public webhook route

**Status (2026-09-24):** Fixed; retain regression coverage.

**Evidence:** [webhooks.ts](apps/api/src/routes/webhooks.ts), [ingest.ts](packages/infra/src/ingest.ts), [web-channel.ts](packages/channels/src/adapters/web-channel.ts), [test-channel.ts](packages/channels/src/adapters/test-channel.ts), [repo.ts](packages/infra/src/repo.ts), [identity.ts](packages/infra/src/identity.ts).

The unauthenticated generic webhook route accepts every channel type. The web adapter accepts requests without a signature when `allowedOrigins` is empty, and its parser trusts the body’s `verified.subject`, `verified.attributes`, and `verified.via`. Those values are persisted as verified identity and subsequently used to bind account-specific tools. The test adapter also accepts unsigned requests.

A public widget channel ID is available in the embed code. A caller can therefore submit a chosen visitor ID with fabricated identity proof directly to the generic webhook, bypassing the widget session’s verification flow. A nonempty origin allowlist does not establish identity: a nonbrowser client can supply an `Origin` header.

**Change:** Restrict public platform webhooks to adapters that verify platform signatures. Send authenticated widget and simulator events through a separate internal ingestion function. Keep externally supplied payloads distinct from server-created verified identity; do not deserialize trusted identity proof from arbitrary webhook JSON. Preserve signature verification for LINE and Messenger.

**Acceptance test:** An unsigned request to a web/test channel’s generic webhook is refused, including one with an allowed-looking `Origin`. A forged `verified` field never changes identity or authorizes a tool. Valid widget sessions and signed platform webhooks continue working.

### 2. Separate workspace membership administration from global account recovery

**Status (2026-09-24):** Fixed: issuer scope re-checked at redemption.

**Evidence:** [admin.ts](apps/api/src/routes/admin.ts), `POST /members/:userId/reset-link`; [invitations.ts](apps/api/src/routes/invitations.ts), password-reset acceptance and `setPassword`; [auth schema](packages/db/src/schema/auth.ts); [seed.ts](packages/db/src/seed.ts).

A workspace admin can mint and receive a usable password-reset link for any member of that workspace. Redeeming it changes the member’s global account password and signs the redeemer in. Users and credentials are shared across workspaces. A tenant admin can consequently take over a member’s access to other tenants; if that member is a platform admin, the exposure extends to platform administration. The seed makes the initial platform admin a workspace member, so this is a relevant configuration.

**Change:** Keep tenant-admin powers scoped to invitations, roles, and membership removal. Make account recovery require proof controlled by the account owner, or a separately authorized platform recovery process. Do not solve only the platform-admin case: ordinary multi-workspace accounts need the same boundary. Preserve self-service password changes with appropriate reauthentication. Update ADR 0005 and deployment instructions, which currently endorse the reset-link flow.

**Acceptance test:** In two workspaces sharing a user, an admin of one cannot obtain a credential that signs in as that user. Include a shared platform admin and an ordinary shared user. Verify legitimate recovery and session revocation independently.

## P1 — Security and reliable operation

### 3. Isolate uploaded active content from the console’s origin

**Status (2026-09-24):** Fixed by serving policy and content checks; a separate origin is deferred.

**Evidence:** [uploads.ts](apps/api/src/routes/uploads.ts), [media.ts](apps/api/src/routes/media.ts), [app.ts](apps/api/src/app.ts).

The upload allowlist accepts `text/*` and `image/*`, including HTML and SVG, and trusts the submitted MIME type. Both authenticated uploads and signed media links serve the stored MIME type inline on the application’s origin. Opening a malicious HTML/SVG attachment can execute script with that origin’s privileges, including authenticated API requests. An HTTP-only cookie alone does not prevent those requests.

**Change:** Serve user-controlled media from a separate origin without console authentication cookies. Define a narrow inline-preview policy for safe media, force downloads for active documents, and add appropriate `Content-Disposition`, `X-Content-Type-Options`, and restrictive sandbox/CSP headers. Validate content rather than relying solely on `file.type`. Apply the policy to inbound media and knowledge files as well as agent uploads.

**Acceptance test:** Upload HTML and script-bearing SVG, then open their authenticated and signed URLs as a privileged operator. They must not execute with the console’s origin or issue authorized console requests.

**Earlier implementation note — serving-policy mitigation, 2026-09-24.** Both routes serve through `mediaServingHeaders` (`packages/infra/src/media-serving.ts`), whatever path the file arrived by (agent upload, inbound LINE/Messenger media, knowledge document). Raster images, audio, video and PDF are inline. Everything else, including HTML and SVG, is `Content-Disposition: attachment`. Every response is `nosniff`. All but PDF carry `Content-Security-Policy: default-src 'none'; …; sandbox`, so anything rendered anyway runs in an opaque origin with no script. PDF is left unsandboxed because Chrome refuses to render a sandboxed PDF, and its viewer does not run in our origin. Uploads accept raster images by exact type (SVG and HTML are refused with 415), and the storage key keeps only a sanitised extension or name, which also closes a path segment injection through the file name. Tests: `packages/infra/test/media-serving.test.ts` and `apps/api/test/uploads.test.ts`. A separate media origin remains the stronger design if the deployment ever gets a second hostname.

### 4. Apply the tenant egress boundary to providers and external retrieval too

**Status (2026-09-24):** Fixed, including the DNS check-then-connect race (pinned connections).

**Evidence:** [settings.ts](apps/api/src/routes/settings.ts), [registry.ts](packages/core/src/ai/registry.ts), [retrieval-external.ts](packages/infra/src/retrieval-external.ts), [egress.ts](packages/infra/src/egress.ts), [ADR 0004](docs/adr/0004-restricted-egress-for-tenant-tools.md).

The tool transport restricts internal destinations, but tenant admins can also configure provider and external-retrieval URLs. Provider discovery, model calls, and external retrieval use unrestricted transports. ADR 0004 treats these endpoints as operator-controlled; `auth: 'admin'` now means a tenant admin, which invalidates that assumption. The provider `/models` check alone gives a tenant-controlled URL a server-side request path.

**Change:** Route every tenant-selected URL through the same egress policy, including redirects. If private model gateways are a requirement, let platform operators approve specific endpoints separately from tenant configuration. Consider a network egress proxy for the deployment boundary.

ADR 0004 also acknowledges a DNS check/connection race. Close that gap before treating the check as a strong isolation boundary, using an egress proxy or a transport that connects to the validated address while preserving hostname verification and TLS SNI. Do not disable TLS verification.

**Acceptance test:** Provider discovery, chat, embedding, and each external-retrieval adapter refuse loopback, private IPv4/IPv6, metadata addresses, and redirects to them. Test approved private gateways through the explicit operator policy.

**Implementation note, 2026-09-24.**
- **What goes through the guard:** model calls, embeddings, rerank, `/models` discovery, model verification and all three external-retrieval adapters use the same restricted client as tools (`workspaceProviderFetch`). `ProviderProfile.fetch` and `ExternalRetrievalConfig.fetch` are required, so no builder can fall back to the global `fetch`.
- **How a private gateway is approved:** only a platform admin can approve one, per tenant, in `workspaces.private_egress_origins`. It is a column, not a setting, because tenant admins write settings, and it is edited from the Platform page. The match is on the exact origin, and a redirect from an approved origin is checked again. Migration 0011 approved each tenant's already-configured plain-http and IP-literal origins once, so that upgrading did not cut off the live gateway.
- **Tests:** "approved origins" in `packages/infra/test/egress.test.ts`, and "approved private endpoints" in `apps/api/test/platform.test.ts`.
- **Closed later the same day:** the check-then-connect DNS race. `pinnedRequest` connects to the address the check approved while TLS still verifies the hostname.

### 5. Do not forward custom tool credentials across origins

**Status (2026-09-24):** Fixed; retain cross-origin redirect regression coverage.

**Evidence:** [egress.ts](packages/infra/src/egress.ts), `CREDENTIAL_HEADERS` and `strippedHeaders`; [http-tool.ts](packages/core/src/ai/http-tool.ts).

Tools support a custom authentication header, but redirect handling strips only `authorization`, `cookie`, and `proxy-authorization`. An `x-api-key` credential survives a cross-origin redirect; this was reproduced with a fake transport. A 307/308 can also forward a request body containing account data to another origin.

**Change:** Prefer refusing cross-origin redirects for credentialed tool calls. If redirects are necessary, require an explicit destination policy and forward only explicitly safe headers/body data. The transport must know all credential-bearing headers instead of maintaining a short generic denylist.

**Acceptance test:** Cross-origin 301/302/303/307/308 responses never disclose custom credentials or sensitive bodies. Same-origin behavior remains intentional and tested.

**Earlier implementation note — resolved in source, 2026-09-24.**
- **Headers:** on a cross-origin hop, only an allowlist of headers that identify nobody is forwarded: `accept`, `accept-encoding`, `accept-language`, `content-type` and `user-agent`.
- **Bodies:** a cross-origin 307 or 308 that would resend a body is refused. 301, 302 and 303 become a GET with no body.
- **Tests:** a table test in `packages/infra/test/egress.test.ts` covers all five codes, both cross-origin and same-origin.

### 6. Validate attachment ownership at every storage boundary

**Status (2026-09-24):** Fixed: canonical key validation at every boundary.

**Evidence:** [message schemas](packages/shared/src), [conversations.ts](apps/api/src/routes/conversations.ts), [simulator.ts](apps/api/src/routes/simulator.ts), [media.ts](packages/infra/src/media.ts), [ai-turn.ts](apps/worker/src/processors/ai-turn.ts), [retention.ts](packages/infra/src/retention.ts).

Attachment input accepts a `storageKey` without establishing ownership. Inbound media resolution skips an attachment that already has a key, image processing can read that key, and retention deletes keys extracted from stored message content. A prefix check exists when generating media links, but that does not protect these other read/delete paths. Knowing another tenant’s key must not authorize access to the object.

**Change:** Represent uploaded objects with workspace-owned asset records and resolve attachment IDs through those records, or consistently validate canonical keys against the workspace before every read, association, signing, and deletion. Reject caller-supplied storage references on external inbound paths. Ensure deletion collects keys only from rows proven to belong to the requested workspace.

**Acceptance test:** A message/simulator payload naming another workspace’s object cannot attach it, pass its bytes to vision, sign a link to it, or delete it during erasure. Include both valid-looking and noncanonical keys.

### 7. Make human takeover authoritative throughout an AI turn

**Status (2026-09-24):** Fixed, including overlapping turns for quick successive messages.

**Evidence:** [ai-turn.ts](apps/worker/src/processors/ai-turn.ts), [outbound.ts](apps/worker/src/processors/outbound.ts), [effect-ports.ts](packages/infra/src/effect-ports.ts), [worker startup](apps/worker/src/index.ts).

The AI processor checks `aiMaySend` before the model call. It does not revalidate conversation ownership before executing pending writes or committing the reply. The outbound processor checks workspace status but not whether an AI message is still permitted by the conversation’s current mode. A human takeover during inference or queue delay can therefore be followed by AI actions and an AI send. Concurrent AI jobs can also answer overlapping context because jobs are not serialized per conversation or tied to a stable input version.

**Change:** Give turns a stable triggering message ID and conversation version. Serialize or deliberately coalesce work per conversation. Compare the expected version/mode when committing an AI result, and cancel stale AI delivery intents after takeover. Coordinate external tool writes with the same ownership protocol; a single additional read still leaves a race. Define the boundary for a platform request already in flight so the UI makes an accurate promise.

**Acceptance test:** Pause a model, take over the conversation, then release it: no new AI reply or tool write is committed. Repeat with an already queued reply. Send a burst of messages with multiple workers and verify intentional, ordered responses without duplicate turns.

### 8. Introduce a transactional outbox and durable step identities

**Status (2026-09-24):** Fixed for event ids, widget sends and inbound media; external write keys residual.

**Evidence:** [ingest.ts](packages/infra/src/ingest.ts), [inbound.ts](apps/worker/src/processors/inbound.ts), [effect-ports.ts](packages/infra/src/effect-ports.ts), [ai-turn.ts](apps/worker/src/processors/ai-turn.ts), [platform.ts](packages/infra/src/platform.ts).

Several workflows commit database state and then enqueue required work separately:

- Webhook ingestion inserts the inbound event before adding its job. If Redis fails, the webhook retry finds the event and returns `duplicate` without repairing the missing job.
- Inbound processing stores a message before publishing and applying effects. A retry can encounter the stored duplicate and skip the effects that never completed. Conversation updates also occur before message deduplication.
- AI processing can execute writes and store a reply before a later failure causes the whole turn to retry with a new reply ID.
- Workspace erasure marks the workspace `deleting` before queue submission; a failed enqueue can leave it stuck, with a repeated request refusing the existing state.

**Change:** Commit domain changes and durable work intents together in Postgres, then relay those intents to BullMQ with stable IDs. Record completion per logical effect/turn, make retries resume incomplete steps, and add recovery for unfinished work. Timestamp-based job IDs and random note/reply IDs are not idempotency keys. A Redis transaction cannot make a Postgres commit atomic with queue submission.

**Acceptance test:** Inject failure after each database commit, before/after enqueue, and before notification. Replay the same request/job. There must be one logical inbound message, one intended transition/reply, and eventual completion or a visible recoverable failure. Tool retries must reuse a stable operation key where the downstream API supports it.

### 9. Separate delivery success from notification success and track multipart sends

**Status (2026-09-24):** Fixed; Messenger idempotency unavailable.

**Evidence:** [outbound.ts](apps/worker/src/processors/outbound.ts), [LINE adapter](packages/channels/src/adapters/line.ts), [Messenger adapter](packages/channels/src/adapters/messenger.ts).

The outbound processor sends the message, marks it `sent`, and publishes the UI update inside one `try`. If publishing fails, the catch marks the already-sent message `failed` and throws, allowing a retry to resend it. Its early return covers `sent` and `delivered` but omits `read`. Split messages and attachment sends have no durable per-part checkpoint, and only the last platform ID is retained. LINE reply-token read/clear is also not an atomic claim.

**Change:** Keep delivery state monotonic, and treat publication failures separately from platform failures. Track each platform send unit and its receipt ID, resume unsent parts, and atomically claim single-use reply tokens. Use provider idempotency keys when supported. Represent ambiguous timeout outcomes honestly; do not claim universal exactly-once delivery when the provider cannot support it.

**Acceptance test:** Fail publication after a successful send and verify no resend. Retry a `read` message. Fail part two after part one succeeds and verify part one is not knowingly resent. Run concurrent sends against one LINE reply token.

### 10. Isolate side effects between primary and fallback model attempts

**Status (2026-09-24):** Fixed.

**Evidence:** [agent.ts](packages/core/src/ai/agent.ts), `createScratchpad` outside `runWithFallback`; [tools.ts](packages/core/src/ai/tools.ts).

The primary and fallback share one mutable scratchpad. A primary attempt can queue a write, add fields/tags, or request handoff and then fail. The fallback result can inherit those intents even if it never requested them. The successful attempt’s trace does not necessarily explain the inherited actions.

**Change:** Create a fresh scratchpad per provider attempt, return it with that attempt’s successful result, and commit only the winning attempt’s intents. Preserve failed-attempt traces separately. Keep the existing rule that externally mutating tools are deferred until the result is accepted.

**Acceptance test:** Make the primary queue a write and then fail; make the fallback answer without that write. The primary’s pending operation, field changes, and handoff must not survive.

### 11. Bound model work and provide recovery after terminal job failure

**Status (2026-09-24):** Fixed.

**Evidence:** [agent.ts](packages/core/src/ai/agent.ts), [vision.ts](packages/core/src/ai/vision.ts), [embed.ts](packages/core/src/rag/embed.ts), [compat.ts](packages/core/src/ai/compat.ts), [worker startup](apps/worker/src/index.ts).

The model paths have retry counts but lack an application-owned overall deadline propagated through inference and body consumption. A hung request need not throw, so fallback may never start and worker capacity can remain occupied. The compatibility transport also buffers response text. Failures outside the agent’s handled model-error path can exhaust job retries with logging but no customer-facing recovery or handoff.

**Change:** Define per-attempt and whole-turn deadlines, propagate cancellation, and bound response sizes. Include retrieval, vision, and tool calls in the turn budget. Handle terminal failures with a deduplicated recovery action: mark the conversation as needing attention, notify agents, and send an appropriate acknowledgment when possible. Persist recovery intent if Redis or delivery is unavailable.

**Acceptance test:** Use a provider that never completes headers or its body. The turn must finish within its budget, release worker capacity, and fall back or hand off once. Exercise configuration/decryption/database errors before the main model call too.

### 12. Extend redaction and retention beyond the message table

**Status (2026-09-24):** Fixed: raw events and the redaction inventory.

**Evidence:** [ingest.ts](packages/infra/src/ingest.ts), [repo.ts](packages/infra/src/repo.ts), [ai-turn.ts](apps/worker/src/processors/ai-turn.ts), [summarize.ts](apps/worker/src/processors/summarize.ts), [retention.ts](packages/infra/src/retention.ts), [app schema](packages/db/src/schema/app.ts).

`storeMessage` redacts normalized messages, but `inbound_events.payload` first persists the raw body, headers, and query. Raw events are not linked to a customer/conversation for customer erasure and are not removed by the conversation retention sweep. Other storage/model paths include trace prompts and tool results, drafts, notes, summaries, fields, and vision-derived text. Redacting the final message therefore does not satisfy the documented “before persistence” promise, even when redaction is enabled.

**Change:** Inventory the actual persistence and model-input boundaries. Verify signatures using transient raw bytes, then persist a minimized/redacted processing envelope. If raw replay data is necessary, give it an explicit protected store, short retention, and erasure linkage. Avoid storing arbitrary request headers. Apply the configured policy to text entering traces, drafts, notes, summaries, and tool/model context; define a separate policy for image bytes and OCR.

**Acceptance test:** With redaction enabled, send synthetic sensitive values through inbound text, tools, notes, drafts, and OCR. Inspect every durable representation and captured model request. Customer erasure and retention must also remove the associated raw payloads according to the stated policy.

### 13. Make all blob deletion resumable, including orphaned uploads

**Status (2026-09-24):** Fixed.

**Evidence:** [retention.ts](packages/infra/src/retention.ts), [retention worker](apps/worker/src/processors/retention.ts), [knowledge.ts](packages/infra/src/knowledge.ts), [blob-fs.ts](packages/infra/src/blob-fs.ts).

Conversation retention and customer erasure collect keys, delete database rows, then attempt blob removal. A failed removal loses its durable reference; repeating the operation cannot rediscover the deleted rows. Customer erasure reports `mediaFailed` without making the job fail for retry. Knowledge source deletion removes rows but does not delete its original object. Uploaded files that never become message/source attachments are outside the current erasure manifests. The filesystem implementation also leaves MIME sidecar files behind on removal.

**Change:** Reuse the durable manifest/checkpoint pattern already present for workspace erasure for customer, conversation, and knowledge deletion. Retain failed keys until deletion succeeds and distinguish “requested” from “completed” in the API/UI. Track upload ownership independently of attachment rows and garbage-collect abandoned uploads after a defined grace period. Remove filesystem sidecars with their objects.

**Acceptance test:** Fail object deletion, restart the worker, and retry after the database rows are gone. All objects and sidecars must eventually disappear. Include deleted knowledge files, never-attached uploads, and tenant-isolation checks from recommendation 6.

### 14. Keep last-admin checks and mutations in the same transaction

**Status (2026-09-24):** Fixed.

**Evidence:** [admin.ts](apps/api/src/routes/admin.ts), `wouldStrandWorkspace` and the member update/delete routes; [platform.ts](apps/api/src/routes/platform.ts); [auth schema](packages/db/src/schema/auth.ts).

The workspace guard uses a transaction and row locks to calculate whether a change strands the workspace, but the actual update/delete happens after that transaction returns. The lock has already been released. Concurrent requests can both pass and remove/demote the final administrators. Review the equivalent platform-admin removal flow under the same rule. Membership rows also lack a database uniqueness constraint on `(organizationId, userId)`.

**Change:** Lock a stable workspace row (or use a suitable advisory lock), then check, mutate, and audit within the same transaction. Apply a shared locking protocol to platform-admin revocation. Add membership uniqueness after reconciling any existing duplicates, and handle invitation races through that constraint.

**Acceptance test:** Concurrently demote/remove two remaining admins; exactly one request may succeed. Concurrent acceptance of invitations for one user must produce one membership. Test the platform-admin invariant separately.

### 15. Fix widget origin enforcement and Unicode token signing

**Status (2026-09-24):** Fixed.

**Evidence:** [widget routes](apps/api/src/routes/widget.ts), [web-channel.ts](packages/channels/src/adapters/web-channel.ts), [widget loader](apps/widget/src/loader.ts), [jwt.ts](packages/channels/src/jwt.ts), [identity documentation](docs/IDENTITY-VERIFICATION.md).

Two independent failures affect the supported widget flow:

- The widget runs in an iframe served by the chat application. Its requests do not establish the embedding parent’s origin in the way the allowlist check expects. Furthermore, the message route calls ingestion with empty headers, so the web adapter rejects it whenever `allowedOrigins` is nonempty. The latter was confirmed directly.
- `signPayload` applies `btoa` to a JavaScript JSON string rather than UTF-8 bytes. Thai characters and emoji cause it to throw; a Thai-name fixture reproduced this. This affects server-minted sessions containing Unicode verified claims, not just the documentation helper.

**Change:** Define embedding restrictions at the iframe boundary, for example with channel-specific `frame-ancestors` policy, and use a verified bootstrap/session flow where needed. Do not trust a parent-origin query parameter as authentication. Separate trusted widget ingestion from platform webhook verification as in recommendation 1. Encode JSON with `TextEncoder` before base64url signing and update copied documentation examples.

**Acceptance test:** Embed the widget on a genuinely different allowed origin with a nonempty allowlist and complete session, send, and poll flows; a disallowed parent must fail the intended embedding policy. Round-trip Thai and emoji subjects/attributes through visitor verification and server session signing.

### 16. Deliver widget attachments and history from durable, authorized state

**Status (2026-09-24):** Fixed.

**Evidence:** [widget routes](apps/api/src/routes/widget.ts), [outbound.ts](apps/worker/src/processors/outbound.ts), [media-links.ts](packages/infra/src/media-links.ts), [widget app](apps/widget/src/app.ts).

The outbound processor generates signed attachment URLs only in a temporary message passed to the adapter. It does not persist those URLs. Widget polling expects `sourceUrl` already present in stored content and drops attachments without it, so uploads stored by key can disappear from the visitor’s view. Polling also exposes outbound rows without filtering delivery state. Its timestamp-only cursor can skip equal-timestamp messages, and filtering internal events after the 100-row limit can prevent progress through a page containing only events.

**Change:** Resolve owned storage keys into fresh signed URLs when serving widget history. Keep storage keys as durable references. Define when a web-channel reply becomes visible and handle queued/failed states consistently. Filter customer-visible rows in SQL before pagination and use a stable `(createdAt, id)` cursor with an explicit next cursor.

**Acceptance test:** Send an uploaded file to a real widget and download it without a console session, including after reopening history beyond the original link TTL. Test queued/failed replies, tied timestamps, and more than 100 internal events between visible messages.

## P2 — Quality, scale, and maintainability

### 17. Refresh cached providers when credentials or headers change

**Status (2026-09-24):** Fixed.

**Evidence:** [registry.ts](packages/core/src/ai/registry.ts), [embed.ts](packages/core/src/rag/embed.ts), [settings.ts](apps/api/src/routes/settings.ts).

Chat model caching keys on provider ID/base URL/model; embedding caching keys on provider ID/base URL. Neither includes the provider’s credential or headers. Updating a key can leave a long-running worker using the old credential indefinitely. A direct probe confirmed that changing only the key returns the same model instance.

**Change:** Include a provider configuration revision in cache keys, invalidate on updates across processes, or use a bounded cache with explicit refresh semantics. Do not put plaintext secrets in logs or observable cache keys. Cover both chat and embedding clients.

**Acceptance test:** Warm both caches, rotate the provider credential/headers, and verify the next intended request uses the new configuration without restarting the worker.

### 18. Revalidate live socket authorization and handle reconnects centrally

**Status (2026-09-24):** Fixed.

**Evidence:** [ws.ts](apps/api/src/ws.ts), [client ws.ts](apps/web/src/lib/ws.ts), [Layout.tsx](apps/web/src/components/Layout.tsx), [Inbox.tsx](apps/web/src/routes/Inbox.tsx).

Socket authorization happens at open. Existing sockets remain in a workspace after logout/session revocation, membership changes, or suspension. Client-side handling of a status event is not an authorization boundary, and the current inbox event handling does not implement a general workspace-status response. Typing messages do not check the current role or conversation membership. Separately, concurrent first joins can both create a subscriber before either installs the room in the map.

**Change:** Close or revalidate connections on relevant authorization changes, validate the WebSocket origin, authorize typing events, and centralize workspace-status handling. Share an in-flight room-creation promise and handle disconnects during joining. On reconnect, invalidate/refetch relevant queries because Redis pub/sub does not replay missed events.

**Acceptance test:** Keep sockets open while removing membership, revoking sessions, and suspending the workspace. They must stop receiving/producing authorized activity. Connect and disconnect multiple clients concurrently, confirm subscriber cleanup, and verify missed messages appear after reconnect.

### 19. Treat embedding identity as part of the index contract

**Status (2026-09-24):** Fixed.

**Evidence:** [embed.ts](packages/core/src/rag/embed.ts), [retrieval.ts](packages/infra/src/retrieval.ts), [knowledge.ts](packages/infra/src/knowledge.ts), [knowledge schema](packages/db/src/schema/knowledge.ts).

The dimension check is useful but insufficient: two different embedding models can produce 1024-dimensional vectors that occupy unrelated spaces. Embedding fallback and model changes can mix those vectors, while retrieval does not constrain comparisons by the stored embedding model identity.

**Change:** Version each embedding space using provider/model/configuration identity, filter vector searches to a compatible version, and stage reindexing before switching the active version. Allow transparent fallback only when both endpoints implement the same embedding space. Keep lexical search available while reindexing.

**Acceptance test:** Index with one model, switch/fall back to a different same-dimension model, and verify incompatible vectors are not compared. Add a small Thai/English retrieval evaluation set covering exact account/product terms, paraphrases, channel restrictions, and tenant/customer isolation.

### 20. Preserve the last usable knowledge index during replacement

**Status (2026-09-24):** Fixed, including concurrent reindexes.

**Evidence:** [knowledge-ingest.ts](apps/worker/src/processors/knowledge-ingest.ts), [knowledge.ts](packages/infra/src/knowledge.ts), [summarize.ts](apps/worker/src/processors/summarize.ts).

`indexEntry` already embeds before transactionally replacing chunks, which is a good pattern. File ingestion defeats that protection by deleting the old entries first; cascading deletion removes their chunks before the replacement embedding succeeds. The processor catches all failures as terminal document problems, including transient provider/storage failures. Concurrent reindexing can also publish results for an older entry revision. Conversation recall indexing similarly deletes old vectors before building replacements.

**Change:** Parse and build a complete replacement generation before atomically switching it into service. Check the source revision before committing, serialize/coalesce reindex jobs per source, and distinguish permanent parsing errors from retryable dependency failures. Apply the same replacement discipline to conversation embeddings.

**Acceptance test:** Fail embedding during a file reindex and verify the previous index still answers queries. Edit while a slow reindex runs and confirm the old revision cannot replace the new one. A temporary provider failure should be retried; an unsupported document should remain visibly failed without an endless retry loop.

### 21. Make memory match the permanent-conversation model

**Status (2026-09-24):** Fixed.

**Evidence:** [repo.ts](packages/infra/src/repo.ts), [summarize.ts](apps/worker/src/processors/summarize.ts), [rag-context.ts](packages/infra/src/rag-context.ts).

Conversation resolution/reopening reuses the same conversation, but summarization selects the earliest 200 messages. Once the conversation is longer than that, later exchanges are never included by that query. Past-conversation retrieval excludes the entire current conversation, which also excludes previous resolved interactions on the same persistent thread. Turn context selects the earliest 20 internal notes, so later notes cease entering the model’s context.

**Change:** Define explicit support episodes or maintain a last-summarized message cursor and summarize new ranges incrementally. Allow recall of older ranges in the same persistent conversation while excluding the active context window. Select recent internal notes in descending order, then restore chronological order for prompting. Use a source revision/cursor to prevent concurrent summaries overwriting newer memory.

**Acceptance test:** Resolve, reopen, and continue past 200 messages. A new fact and a note added after the first 20 notes must reach the next relevant context/summary; an older resolved interaction on the same channel must remain recallable without leaking another customer’s data.

### 22. Implement bounded inbox queries and complete pagination

**Status (2026-09-24):** Fixed (offset paging over a total order).

**Evidence:** [conversations.ts](apps/api/src/routes/conversations.ts), [Inbox.tsx](apps/web/src/routes/Inbox.tsx), [message paging tests](e2e/message-paging.spec.ts).

The list defaults to 50 conversations without a complete load-more flow. Its `before` filter uses only `lastMessageAt`, while sorting also considers ownership and waiting state, so it is not a valid cursor for the actual order. Preview loading fetches all messages for the selected conversations and discards all but the latest per thread. Long histories also ultimately hit the detail-query/UI message limit rather than offering unbounded traversal through older pages.

**Change:** Return a stable cursor matching the complete sort order and expose list pagination in the console. Fetch one latest message per conversation in SQL using an indexed lateral query or equivalent. Page history by `(createdAt, id)` instead of repeatedly increasing a capped window; preserve scroll position and merge live updates by ID.

**Acceptance test:** Use more than 50 conversations with mixed owners/waiting states, tied timestamps, and long histories beyond the current maximum window. Every row must be reachable without skips/duplicates. Verify the preview query returns roughly one row per conversation rather than the full transcript.

### 23. Make operational reporting reflect delivery and complete AI work

**Status (2026-09-24):** Fixed; cost scope stated.

**Evidence:** [agent.ts](packages/core/src/ai/agent.ts), [ai-turn.ts](apps/worker/src/processors/ai-turn.ts), [dashboard.ts](packages/infra/src/dashboard.ts), [Dashboard.tsx](apps/web/src/routes/Dashboard.tsx).

AI traces can label an answer `sent` before outbound delivery completes. Chat accounting reads `result.usage`, which does not represent all steps of a multistep tool turn; failed primary attempts and auxiliary vision/retrieval work also need explicit accounting if totals are presented as total cost. Response-time calculations based on message creation can count queued/failed attempts as replies.

**Change:** Distinguish generation, queued delivery, successful delivery, and failed delivery. Store actual delivery timestamps and calculate response metrics from their defined event. Aggregate multistep usage and account for fallback/auxiliary work, or label the displayed estimate’s limited scope. Apply workspace timezone semantics consistently to date buckets.

**Acceptance test:** A reply whose delivery fails does not improve response-time/success metrics. A multistep primary-plus-fallback fixture produces the expected usage accounting. Test a date boundary in the workspace timezone.

### 24. Build the actual deployment images in CI and polish failure states

**Status (2026-09-24):** Fixed; restore rehearsal not done.

**Evidence:** [worker Dockerfile](apps/worker/Dockerfile), [API Dockerfile](apps/api/Dockerfile), [CI workflow](.github/workflows/ci.yml), [deployment guide](docs/DEPLOY.md), [console routes](apps/web/src/routes).

The worker dependency stage omits `apps/widget/package.json`, although the widget is a locked workspace and the API Dockerfile copies it. This is a concrete manifest mismatch to fix and verify with a clean frozen-lockfile build; an image build was not run during this review. Current CI builds frontend assets and runs tests, but does not build both release images. Source-level success therefore does not establish that the deployable artifact works.

**Change:** Add the missing workspace manifest, build both images in CI, and smoke-test their startup with migrations and required services. Pin mutable infrastructure image tags/digests deliberately. Extend the existing backup instructions with an actual restore rehearsal covering Postgres, media, and encryption-key recovery. Follow the deployment guide’s existing requirement to separate migrations before adding API replicas.

For the console, consistently show failed queries/mutations instead of empty-looking screens or silent failed actions, hide/disable controls unavailable to viewers, and prevent duplicate submit paths while a request is pending. Add shared response DTOs where handwritten frontend/API shapes have drifted. Split large route components opportunistically when making these changes, around stable responsibilities such as composer, history, and settings sections.

**Acceptance test:** A clean CI build produces runnable API and worker images, followed by a real inbound-to-outbound smoke test. Browser tests cover an API failure during send, a rejected upload, viewer permissions, and reconnect. A restore rehearsal recovers an encrypted channel/provider credential and an attachment.

## Changes I would defer

- Replacing Bun/Elysia/React, adopting a larger agent framework, introducing another vector database, or splitting into more services. The current boundaries can support the fixes above.
- Broad component/file rewrites before correcting authorization and retry behavior. Large files are a maintenance cost, but they are not the leading production risk here.
- Adding more fallback providers before defining timeouts, attempt isolation, and compatible embedding spaces.
- Treating documentation claims as guarantees. After the fixes, update comments and docs about idempotency, redaction, widget delivery, and immediate suspension to describe the behavior actually covered by tests.
