# UX/UI audit

Written 2026-09-24 by an external review of the console and the widget, moved here from
`recommendation.md` so that file stays about security and reliability. Every item has a
status below; the original text of each item follows unchanged, as the record of what was
asked for.

## Status (2026-09-24)

| Item | Status | What was done |
| --- | --- | --- |
| U01 Failure visible at the action | Done | Failed loads and actions show an `ErrorNote` with retry beside what failed: inbox list, conversation, send, take over, hand back, resolve, rating, knowledge sources and entries, test search, widget origins, members, tenants. Invite tells a dead link from an unreachable server. 4xx responses are not retried. `e2e/resilience.spec.ts` |
| U02 Drafts survive | Done | Drafts and attachments are kept per conversation; a send clears only what it sent; one guarded submit path; Enter during IME composition is ignored (inbox, simulator, widget). Client message ids with server de-duplication for the widget. `e2e/resilience.spec.ts` |
| U03 Everything reachable | Done, search deferred | Selected conversation in the address (`?c=`), load-more on the queue (total order, offset paging), history paged upward by cursor with no cap. Customer and message search is not built. |
| U04 Keep the reader's place | Done | Follows only at the bottom or after one's own send; "New messages" pill; instant landing on open; older pages load only when scrolling up; widget follows only at the bottom. |
| U05 Connection freshness | Done | One socket in the shell with a status pill, full refetch on reconnect, stop on 4401/4403, workspace status refreshes the session. Server re-validates live sockets (finding 18). |
| U06 Controls match the role | Done | `lib/capabilities.ts`; read-only notes for viewers in the inbox, knowledge and settings; admin-only queries not issued; simulator not offered to viewers. `e2e/roles.spec.ts` |
| U07 Keyboard and assistive tech | Done for the listed defects | `Dialog` (focus in, trap, Escape, inert background, focus return) for lightbox, trace, promote and the More sheet; labels tied to fields; pressed state on tabs and language; delivery states announced; launcher focus ring, `aria-expanded`, unread in its name. Automated critical-level axe pass in `e2e/accessibility.spec.ts`; a manual screen-reader pass has not been done. |
| U08 Widget language and recovery | Done | Thai/English copy from `data-lang`, then the workspace language; `lang` on the document; Retry after a failed start; session renewal with backoff; "taking longer" line after the typing budget. `e2e/widget-embed.spec.ts` |
| U09 Delivery outcomes | Done, resend deferred | Failed, withdrawn (`canceled`) and uncertain deliveries are named on the bubble with the reason; the widget shows only delivered replies. A retry button is not built. |
| U10 Contrast and responsive | Done | Text on the brand colour is the better of black and white (`apps/widget/src/contrast.ts`, tested); dark-mode error colour; desktop navigation from `md`; inbox metadata at 11px. A real-device soft-keyboard check has not been done. |
| U11 Autosave ordering | Done, revisions deferred | Save status follows the newest request only; knowledge entry editors are controlled and refresh their own entry; workspace settings merge under a row lock. Per-record revision conflicts and an "indexed and ready" state are not built. |
| U12 Path to a first answer | Done | Admin setup checklist on the dashboard from real configuration; the simulator links to the conversation it created; test search leads with the answer, scores behind a disclosure. |
| U13 Deliberate irreversible actions | Done | `ConfirmButton` ignores a confirm within 400 ms of arming; customer erasure is a separate step naming the customer; erasure progress is recorded in `blob_deletions`. |
| U14 Dashboard definitions | Done | Each figure states what it counts; days are the workspace's timezone and say so; answered and response times count delivered replies only (finding 23). |
| U15 Regression coverage | Done | `failNext` and `signInAs` helpers; resilience, roles, cross-origin embed, phone-width and dark/Thai projects selected by tag; axe checks. |

## What is already working and should be retained

| Area | Implemented improvement |
| --- | --- |
| Navigation | Inbox/settings tabs persist in search parameters; dashboard waiting/review cards link to the corresponding queue; mobile navigation has a More sheet. |
| Conversation reading | Latest-message window, older-message loading, day separators, channel/mode labels, interleaved notes, attachment previews and image lightbox. These do not solve unlimited history or live-scroll disruption. |
| Human handoff | Localized handoff and still-waiting acknowledgments, editable copy, and a note when returning a conversation to AI. |
| Widget feedback | Optimistic bubbles, restoration after ordinary send failure, offline/suspended/unconfigured messages, bounded typing animation, unread badge, mobile layout, reduced-motion rule for typing dots. |
| Editing and administration | `SaveStatus`/`ErrorNote`, local save feedback in several editors, confirmation before destructive actions, typed tenant-slug deletion, single-use link copy/select behavior. Coverage is incomplete. |
| Knowledge and diagnosis | Source processing/error status, ingestion polling, model verification, knowledge search diagnostics, trace detail, and feedback reasons. |
| Localization and theme | Console Thai/English strings, locale-aware date formatting, document language updates, and shared light/dark surface tokens. Widget interface copy still needs localization. |

## UX/UI recommendations

Priority: **P1** = lost work, blocked core task, misleading state, or inaccessible core interaction; **P2** = next usability iteration. Size is relative implementation scope: S = local/shared component change, M = cross-component flow, L = API/state/lifecycle work. These are not delivery estimates.

### U01 — Make failure and recovery visible at the action (P1, M)

**Evidence:** [Inbox](apps/web/src/routes/Inbox.tsx), `ConversationPane` mutations; [Knowledge](apps/web/src/routes/Knowledge.tsx), source queries and `TestSearch`; [WidgetPanel](apps/web/src/components/WidgetPanel.tsx); [Admin](apps/web/src/routes/Admin.tsx); [Platform](apps/web/src/routes/Platform.tsx); [Invite](apps/web/src/routes/Invite.tsx).

Inbox send/takeover/resolve/feedback mutations have no rendered failure state. An inbox or knowledge list request can fail and look empty; member/tenant queries fall back to empty arrays. Knowledge search can leave the previous results visible after a failed new search. Widget origin save has no error output. Invitation lookup treats network/server failure as an invalid invitation.

**Recommend:** Explicit loading, successful-empty, stale-data, and failed states. Use the existing `ErrorNote` beside the affected action, retain user input, offer retry, and name what did not happen (“Reply wasn't sent”). For stale search/results, show which query succeeded. Distinguish an expired link from an unavailable service. Provide an intentional forbidden/session-expired screen instead of empty admin panels.

**Acceptance:** Inject 403/500/network failures into each flow; there is no false empty queue, silent click, misleading old result, or false invalid-link message. Recovery works without a page reload and does not duplicate a send.

### U02 — Preserve drafts and prevent in-flight edits from disappearing (P1, M)

**Evidence:** [Inbox](apps/web/src/routes/Inbox.tsx), keyed `ConversationPane`, local `draft`/attachment state and send `onSuccess`; [Simulator](apps/web/src/routes/Simulator.tsx); [widget app](apps/widget/src/app.ts), submit/catch handlers.

Changing selected conversation remounts the pane and discards the draft/attachment. While send is pending, the console composer remains editable but success unconditionally clears it, including text typed after submission. Widget failure restores the old message with `input.value = text`, overwriting a newer draft. The widget has no explicit pending guard in its submit handler; Simulator's Enter handler bypasses the button's pending protection. Chat Enter handlers do not check IME composition.

**Recommend:** Keep drafts keyed by workspace and conversation, with an explicit discard action. Capture the submitted revision and clear only that revision; keep new input independent from pending messages. Use one guarded submit path for mouse/keyboard/suggestion send, respect composition events, and add client request IDs with server deduplication for ambiguous retries. If drafts survive reload, define expiry and clear them on logout/workspace removal.

**Acceptance:** Type in A, visit B, return to A; text and attachment remain with A. Delay a send, type the next reply, then succeed/fail the first; the second draft remains. Enter during composition or an in-flight submission creates no unintended request.

### U03 — Make all conversations and history reachable (P1, L)

**Evidence:** [Inbox](apps/web/src/routes/Inbox.tsx), list query and `MAX_MESSAGE_WINDOW`; [conversation routes](apps/api/src/routes/conversations.ts), list ordering/limit/preview query. Related original finding: **22**.

A queue can report more work than its first 50 visible rows expose. There is no conversation search or list paging, and selected conversation lives only in component state, so refresh/share/back cannot restore the exact thread. Historical traversal stops at the maximum message window.

**Recommend:** First implement cursor paging aligned with the server's full sort order and bounded preview reads. Add customer/message search and practical owner/channel filters. Put selected conversation in the URL with authorization checked on load; retain queue/filter context and scroll position. Use stable history cursors instead of expanding a capped window.

**Acceptance:** With 120 mixed-owner conversations and tied timestamps, every row is reachable once; a long thread can reach its oldest message. A copied authorized link opens that thread; browser Back restores the queue position. Search respects tenant boundaries.

### U04 — Keep a reader's place when new messages arrive (P1, M)

**Evidence:** [Inbox](apps/web/src/routes/Inbox.tsx), effect on `newestMessageId`; [widget app](apps/widget/src/app.ts), `append`/`setTyping`.

The console scrolls to the bottom for every newest-message change even when the agent is reading history. The widget also scrolls on every appended bubble and when typing starts. Existing prepend restoration helps only the older-page path.

**Recommend:** Follow new messages only when already near the bottom or after the user's own send. Otherwise retain the anchor and show “New messages” with a jump action. Preserve scroll on image load and after loading older content. Respect reduced-motion preference for programmatic scrolling, not just CSS animations.

**Acceptance:** Scroll into history, receive several replies and an image, and remain on the same content. Jump-to-latest clears the indicator; loading old messages preserves position.

### U05 — Show connection freshness and resynchronize on reconnect (P1, M)

**Evidence:** [client WebSocket](apps/web/src/lib/ws.ts), `socket.onopen`; [Inbox](apps/web/src/routes/Inbox.tsx), detail query; [Layout](apps/web/src/components/Layout.tsx); original finding **18**.

The socket reconnects silently. Its `ready` event has no conversation ID, so Inbox's event callback does not invalidate the selected thread. The list polls, but the open detail has no periodic recovery query. An agent can therefore see a plausible but stale conversation after missing events.

**Recommend:** Expose connected/reconnecting/offline status centrally, show the last successful sync, invalidate active conversation/list/counts on reconnect, and handle session/workspace status centrally. Preserve drafts during recovery. Complete server authorization revalidation as part of this work.

**Acceptance:** Disconnect, create messages elsewhere, reconnect without changing tabs; the open thread, ownership and counts catch up. A revoked session or suspended workspace gets an explicit state rather than an endless reconnect loop.

### U06 — Match visible controls to the user's capabilities (P1, M)

**Evidence:** [Inbox](apps/web/src/routes/Inbox.tsx), `canWrite` versus ungated header/composer; [Knowledge](apps/web/src/routes/Knowledge.tsx); [Settings](apps/web/src/routes/Settings.tsx); [API role guards](apps/api/src/routes/settings.ts).

Some feedback/ownership controls respect `canWrite`, but takeover, resolve and the composer do not. Knowledge editors are shown to viewers. Settings hides Integrations from non-admins while other admin-only editors/queries remain. Simulator is in navigation for viewers although its API requires agent access.

**Recommend:** Establish one capability map for navigation, queries and controls. Show useful readable content with a clear read-only explanation; hide unavailable management actions and avoid issuing forbidden queries. Handle role changes while the page is open. Keep API enforcement authoritative.

**Acceptance:** Exercise viewer, agent, workspace admin and platform admin in every route, including direct URLs. No role is invited to perform an action the API predictably refuses; readable content stays available where allowed.

### U07 — Complete keyboard and assistive-technology support (P1, M)

**Evidence:** [Lightbox](apps/web/src/components/Lightbox.tsx); [Inbox](apps/web/src/routes/Inbox.tsx), trace/promote overlays; [Layout](apps/web/src/components/Layout.tsx), More sheet; [Settings](apps/web/src/routes/Settings.tsx), ToolEditor labels; [Knowledge](apps/web/src/routes/Knowledge.tsx), EntryEditor; [widget loader](apps/widget/src/loader.ts).

Lightbox has dialog semantics and Escape, but no initial focus, focus containment or restoration. Trace/promote overlays have no dialog semantics/focus management. More sheet lacks equivalent lifecycle behavior. Numerous labels omit `htmlFor`/input IDs; entry textareas rely on context. Inbox filter selection is visual only. Launcher `all:initial` resets its outline without supplying a focus style, and launcher expanded/unread state is not exposed in its accessible name/state.

**Recommend:** Share an accessible overlay primitive with name, initial focus, containment where modal, Escape, background inertness and focus return. Associate every field's persistent label/hint/error. Expose selected filter state with suitable semantics; add launcher focus styling, expanded state and localized unread announcement. Label queued/failed delivery indicators independently of hover titles.

**Acceptance:** Keyboard-only users can open, use and close each overlay and return to its trigger without reaching background controls. Screen-reader checks identify each field and selected queue, and announce failure/connection/unread state. Validate actual behavior, not only the presence of ARIA attributes.

### U08 — Make the widget language and recovery experience complete (P1, M)

**Evidence:** [widget app](apps/widget/src/app.ts), hardcoded Thai shell/refusal/failure copy and `main`; [widget loader](apps/widget/src/loader.ts); [widget HTML](apps/widget/index.html); original findings **15–16**.

The console supports English and the API can return English handoff text, but the widget's greeting, Send, labels and errors remain Thai, with `lang="th"`. After five startup failures it permanently disables the session for that page with “try again” copy but no retry action. A failure renewing an expired session can leave `session = null`, after which later polls return immediately. Typing stops at 60 seconds without a corresponding “taking longer” state.

**Recommend:** Resolve a documented locale from embed option/visitor preference/workspace fallback and use it for all widget text and document language. Add explicit retry/reconnect states for startup and renewal, with bounded network timeouts. Show a truthful waiting/recovery message after the typing budget expires. Fix the cross-origin bootstrap, Unicode signing and attachment history requirements in **15–16** alongside this work.

**Acceptance:** A genuinely cross-origin English and Thai embed with a nonempty allowlist can start, send, receive a file and reconnect. Fail session creation/renewal once, recover the service, and resume without reloading or losing the visitor's text/history.

### U09 — Make delivery outcomes understandable and recoverable (P1, M/L)

**Evidence:** [DeliveryTicks](apps/web/src/components/DeliveryTicks.tsx); [Inbox](apps/web/src/routes/Inbox.tsx), `MessageBubble`; [outbound processor](apps/worker/src/processors/outbound.ts); [widget polling](apps/api/src/routes/widget.ts); original findings **7, 9, 16, 23**.

A failed message gets a small `!` with a hover title, without a visible reason or recovery action in its bubble. Canceled AI delivery after human takeover is stored as generic `failed`. Widget polling can display queued/failed outbound rows without explaining their delivery state. This makes “what the customer actually received” hard to establish.

**Recommend:** Distinguish generating, queued, sending, accepted, delivered/read where supported, canceled, failed and uncertain outcomes. Show actionable errors inline with message time and retry eligibility; do not offer blind resend for ambiguous provider acceptance. Use durable message/part identities before adding retry UI. Explain channel-specific limits in the composer when known.

**Acceptance:** Fail before platform send, after acceptance, and after takeover. Operators can distinguish each outcome; retries do not knowingly resend completed parts; widget visibility follows a defined delivery contract.

### U10 — Finish contrast, density and responsive validation (P1 contrast; P2 layout, M)

**Evidence:** [widget app](apps/widget/src/app.ts), `applyAccent`; [widget styles](apps/widget/src/styles.css); [Layout](apps/web/src/components/Layout.tsx), desktop `sm:flex` navigation; [Inbox](apps/web/src/routes/Inbox.tsx), header/sidebar and 10–11px metadata; [shared styles](apps/web/src/styles.css).

The accent chooser uses a luminance cutoff of 0.45 instead of comparing foreground contrast: `#808080` gets white at 3.95:1. Widget errors retain `#b42318` in dark mode. Dense metadata and multiple no-wrap navigation/header actions merit testing at intermediate widths, particularly seven destinations plus workspace/language/sign-out controls starting at the small breakpoint. These overflow risks have not been visually reproduced.

**Recommend:** Compare contrast for both candidate foregrounds and select a passing color; test error/focus/pending colors on actual light/dark surfaces. Keep conversation text prominent and reduce low-value metadata before shrinking text. Collapse navigation based on available space; allow header actions to wrap or move secondary actions into a menu. Validate fonts actually available to Thai users. Test soft-keyboard behavior on real mobile browsers rather than assuming `100dvh` alone guarantees visibility.

**Acceptance:** Color samples including mid-gray, saturated colors and pale accents meet the chosen text target. At 320, 390, 768, 1024 and 1440 CSS pixels, Thai/English and enlarged text, primary actions remain reachable with no page-wide horizontal overflow. Mobile keyboard does not hide the active composer.

### U11 — Make autosave ordering and indexing status trustworthy (P1, M/L)

**Evidence:** [ui.tsx](apps/web/src/components/ui.tsx), `useSaveState`; [Knowledge](apps/web/src/routes/Knowledge.tsx), `EntryEditor`; [Settings](apps/web/src/routes/Settings.tsx), blur/change saves; [settings API](apps/api/src/routes/settings.ts), read/merge/write of settings.

Local SaveStatus is a good improvement but tracks one state without request identity. Concurrent completions can overwrite the most recent status. Uncontrolled `defaultValue` fields do not synchronize with server changes; knowledge entry save invalidates source metadata rather than the entry query. The server settings read/merge/write also permits concurrent updates to overwrite one another. “Saved” does not mean the changed knowledge has finished indexing.

**Recommend:** Serialize/coalesce edits per record and use server revisions for conflict detection. Track dirty/saving/saved/failed per edited entity, retry retained drafts, refresh the correct entry query, and prevent old responses from replacing newer state. Distinguish “Saved; indexing” from “Ready for answers”; keep the last usable index during replacement (**20**).

**Acceptance:** Delay/reorder two edits, reject one, and update the same record from a second session. The UI and server agree on the latest accepted revision; unsaved work remains recoverable and “Ready” is shown only after successful indexing.

### U12 — Give new operators a short path to a working conversation (P2, M)

**Evidence:** [Settings](apps/web/src/routes/Settings.tsx), task/provider/channel editors; [Simulator](apps/web/src/routes/Simulator.tsx); [Knowledge](apps/web/src/routes/Knowledge.tsx), empty state and search diagnostics; [README](README.md), manual setup sequence.

Working setup is spread across provider, task slot, channel, knowledge and simulator pages. Existing connection/model tests are valuable but do not form a single readiness view. Simulator confirms a sent count without presenting the resulting support conversation. Knowledge diagnostics foreground fused/dense/keyword internals rather than the operator's question of whether an answer is ready.

**Recommend:** Provide an optional setup checklist derived from actual configuration: configure/test answering model, add knowledge, connect/test channel, run a sample conversation, then open that conversation. Link each failed step to its exact editor. In knowledge search, lead with matched answer/source and indexing readiness; put retrieval scores behind an advanced details control. Preserve optional knowledge for deployments that do not need it.

**Acceptance:** A new admin reaches a successful test reply using only in-product guidance; missing provider, failed index and unconnected channel each lead to a specific corrective action.

### U13 — Make irreversible actions deliberate and progress observable (P2, M)

**Evidence:** [ui.tsx](apps/web/src/components/ui.tsx), `ConfirmButton`; [EraseCustomer](apps/web/src/components/EraseCustomer.tsx); [MergeSuggestions](apps/web/src/components/MergeSuggestions.tsx); [Platform](apps/web/src/routes/Platform.tsx); original finding **13**.

Two clicks on the same target within five seconds are better than one, but a double-click can immediately confirm and the short timer can frustrate slower readers. Customer erasure displays “queued” without durable completion/progress. Merging shows the survivor and identity match, but limited detail about conflicting fields/ownership that will be kept or dropped.

**Recommend:** Keep lightweight confirmation for reversible low-impact actions. For customer erasure and irreversible merge, show a separate confirmation step naming the affected person and consequences, with explicit cancel. Explain merge conflict outcomes. Expose requested/running/completed/failed deletion states backed by resumable jobs; do not claim completed deletion when blobs remain.

**Acceptance:** A double-click on the initial destructive control cannot execute the operation. Keyboard users can read consequences without a disappearing deadline. Failed deletion resumes and reports completion only when the defined work is done.

### U14 — Define dashboard measures in operator language (P2, M/L)

**Evidence:** [Dashboard](apps/web/src/routes/Dashboard.tsx); [dashboard aggregation](packages/infra/src/dashboard.ts); [agent accounting](packages/core/src/ai/agent.ts); original finding **23**.

The dashboard already links waiting/review counts to useful actions and distinguishes unpriced work. But generated answers can be counted as successful before delivery, and cost/token scope is incomplete. Operators need to distinguish current backlog from activity in the selected reporting window.

**Recommend:** Define each numerator/denominator, time window and timezone beside the metric or in an accessible explanation. Separate generation from delivery success; label cost as an estimate with its scope until accounting is complete. Prioritize waiting age, unanswered handoffs and delivery failures, with filtered links to the underlying work. Offer a textual/table equivalent for chart details.

**Acceptance:** A failed delivery does not improve answered/response-time metrics; a boundary-date fixture lands in the stated timezone bucket; each operational number can be traced to matching records.

### U15 — Close the UX regression coverage gaps (P2, M)

**Evidence:** [Playwright config](playwright.config.ts); [browser tests](e2e/); [widget API tests](apps/api/test/widget-poll.test.ts).

There is meaningful workflow coverage for takeover, handback, images/files, invites, tools, review, merge and history paging. The configured browser project is desktop Chromium; existing widget chat tests open the iframe app directly on the API origin, which does not exercise a real host page plus restrictive embedding policy.

**Recommend:** Add targeted scenarios for the defects above: API failures, slow/reordered sends, draft switching, reconnect, read-only roles, keyboard overlays, contrast samples, and cross-origin widget embedding. Add a small representative mobile/light/dark/Thai/English screenshot matrix and supported mobile-browser checks. Use automated accessibility checks plus manual keyboard/screen-reader verification. Avoid multiplying every test across every configuration.

**Acceptance:** Each P1 issue has a behavior-focused regression scenario; visual baselines cover dense real content, long names, long messages, empty/error/loading states, and mobile keyboard interactions.

## Recommended delivery sequence

1. **Protect work and truthful state:** U01, U02, U05, U06 and U09. Address the remaining authorization/storage/takeover risks in original findings 2, 6 and 7 before widening production exposure.
2. **Finish the customer channel:** U08, U10's contrast correction, and original findings 15–16. Verify a real allowed cross-origin embed with Unicode identity and attachments.
3. **Make daily work scalable and accessible:** U03, U04, U07 and U11; complete pagination, stable drafts, overlays and save ordering.
4. **Improve setup and supervision:** U12–U14, with targeted U15 checks added alongside each change. Continue original engineering work on deadlines, fallback isolation, data lifecycle and release verification.

Keep the current React/Bun/package boundaries and reuse the existing UI primitives. Preserve the compact support-workbench character: one accent for primary actions, semantic colors for operational state, readable conversation text, and quieter secondary metadata. Do not spend this iteration on decorative animation, a framework replacement, or a wholesale component-library migration.
