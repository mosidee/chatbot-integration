# ADR 0010: Notifications reach agents' devices through Web Push

Accepted 2026-09-25.

## Context

Until now an agent learned about a waiting customer only through an open console tab: the
socket refreshed the inbox and the navigation badge turned red. Nobody was told once the tab
was closed or the laptop was asleep, so a handoff could wait an hour for somebody to happen to
look. The operator asked for notifications in Chrome and Safari that work with the browser
closed, with a count on the app icon when the console is saved to a phone's home screen.

## Decision

Standard Web Push, with our own VAPID key pair. No third-party notification service.

- **The console is an installable web app.** It has `manifest.webmanifest`, icons, an
  `apple-touch-icon`, and a service worker at `/sw.js`. The worker handles `push` and
  `notificationclick` and nothing else. It has **no fetch handler**, because a caching worker
  pins the console to an old build, and on an iPhone's home screen there is nobody to clear
  it. The API serves `/sw.js` with `Cache-Control: no-cache`.
- **A subscription is a row per workspace and device** (`push_subscriptions`, migration
  0018). A device holds one endpoint for the whole origin, and somebody in two workspaces
  turns each on separately. Only agents and admins may subscribe; viewers cannot answer.
  The settings card lives under Settings → General, outside the workspace settings and their
  revision machinery, because it is personal.
- **Sends go through the outbox.** `notifyAgents` queues a `push` job alongside the realtime
  nudge. The job id comes from the occasion: the trigger message where there is one,
  otherwise the instant the effect carries. A replayed effect list therefore notifies nobody
  twice. The insert runs under a savepoint, because `applyEffects` swallows a failure there
  and a failed statement left in the surrounding transaction would silently turn its commit
  into a rollback.
- **When:** a handoff (AI or unsupported media), the waiting-human timer, a draft waiting for
  approval, and a customer writing to a conversation a person holds or is waiting for
  (`customer_message`, a new effect on those two modes). Nothing is sent while the AI is
  answering.
- **Who, decided when the job runs:** the conversation must still be open and still owed.
  A handoff that a colleague has already taken is not sent. A customer message in a held
  conversation goes to the colleague holding it. Everything else goes to every agent and
  admin. Membership is read at send time; removing a member and resetting a password also
  delete their rows, and signing out deletes the device's rows everywhere.
- **What:** the customer's name and the workspace in the title. The body is the reason, plus
  the customer's own words for a message or a handoff: `typedText`, redacted as stored, cut
  to 120 characters. Notifications are tagged by conversation, so the newest replaces the
  last. The payload is encrypted end to end (aes128gcm), so Apple and Google carry it without
  reading it. The badge is the workspace's waiting count.
- **Egress:** the endpoint arrives in a request body and the worker posts to it, so it is
  restricted to the push services' hosts (`isPushServiceEndpoint`: FCM, Apple, Mozilla,
  Windows). The check runs when the endpoint is saved and again before every send, and the
  send uses `redirect: 'error'`.
- **Retries:** 404 and 410 delete the row. A job is retried only when nothing arrived
  anywhere and every failure might pass (429, 5xx, network), since a retry sends to every
  device again.
- **VAPID:** `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`, both or neither, generated with
  `bun run push:keys`. Without them push is off and the card is hidden. The `sub` claim is
  `PUBLIC_WEB_URL`, never a person's email. Changing the keys strands every subscribed
  device.

## Platforms

| Where | Browser closed | Icon count |
| --- | --- | --- |
| Chrome, Edge (Windows, macOS, Linux) | Yes while the browser process runs. On macOS, closing the windows leaves Chrome running; after Cmd+Q, notifications arrive at the next launch | Only when the console is installed as an app |
| Safari on macOS Ventura or later | Yes, even when Safari is not running (`webpushd`) | On the Dock icon when added to the Dock |
| iPhone and iPad, iOS/iPadOS 16.4 or later | Only for the app added to the Home Screen; Safari tabs cannot subscribe | Yes, on the Home Screen icon |
| Android, Chrome | Yes | No number: Android has no badging API for web apps, and the launcher shows a dot while a notification is unread |

## Consequences

- Every push must show a notification. Safari withdraws a subscription that receives silent
  pushes, so there is no "already looking" suppression; the per-conversation tag keeps the
  noise down instead.
- Customer text appears on lock screens. That is the point of the feature and also the
  reason a password reset deletes the account's subscriptions.
- A browser under automation cannot subscribe, so the browser tests stub `PushManager`, and
  the service worker is unit-tested in a fake worker scope. Whether a phone actually buzzes
  is checked on a phone.
