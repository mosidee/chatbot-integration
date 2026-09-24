# Embedding the chat widget

The widget is two files served from the same domain as the console: a loader a host page
embeds, and a chat application that runs inside an iframe.

```html
<script
  src="https://chat.mosidee.com/widget/loader.js"
  data-channel="<web channel id>"
  data-colour="#2563eb"
  data-title="แชทกับเรา"
  data-lang="th"
  defer
></script>
```

`data-lang` (`th` or `en`) chooses the language of the widget's own words — its greeting,
buttons and error lines. Without it the workspace's default language is used. Text on the
brand colour is black or white, whichever reads better on it.

The channel id comes from **Settings → Channels**, on the web channel. The loader adds a
launcher in the corner and nothing else until somebody clicks it.

## Trying it

**Settings → Channels → the web channel → Configure.** That panel generates the snippet
above with your own channel id, lists the sites allowed to embed it, and previews the real
widget against the same channel. A conversation started in the preview arrives in the inbox
like any other, so it is a test of the whole path rather than of the appearance.

## Why an iframe

Everything a customer types lives on our origin, not the host page's. The host application
cannot read the conversation, and we cannot read the host page. It also means the widget's
own requests are same-origin, so there is no cross-origin configuration to get wrong.

The loader must stay a classic script, because that is how host pages embed it. It may not
import anything the chat app also imports: the build would put the shared code in a chunk
and turn `loader.js` into a module whose `import` a host page cannot run.

## Identifying a logged-in user

Anonymous works with no further setup: a browser id is generated, kept in local storage, and
the same person returning to the same browser continues their conversation.

To link a conversation to a salon-saas account instead, set a shared secret on the channel
and have the host application sign a short-lived token for its logged-in user:

```ts
// In salon-saas, server side. The secret is the channel's visitor token secret.
const token = await signVisitorToken(
  {
    sub: user.id,                 // becomes the channel identity
    name: user.name,
    email: user.email,
    attributes: { plan: user.plan, paidUntil: user.paidUntil },
    exp: Math.floor(Date.now() / 1000) + 300,
  },
  process.env.CHAT_WIDGET_SECRET,
)
```

Render it into the script tag as `data-token`. Keep the expiry short: it is presented once,
when the widget starts a session, and a fresh page load mints a new one.

A token that is invalid or expired degrades to anonymous rather than refusing. Somebody with
a stale session still deserves support.

`sub` and `attributes` are kept as a **proof** of identity, not merely as a label: they are
stored on the channel identity and are what a tool binds to when it needs to know whose
account to read. That is worth exploiting before writing any tool at all. Put `plan` and
`paidUntil` in `attributes` and the AI can answer "what plan am I on?" from
`get_customer_profile`, with no endpoint and no credential anywhere.

These are a snapshot taken when the session is minted, not a live read. A session lasts
twelve hours, so a customer who upgrades mid-conversation is still answered from the plan
they had when the widget started, until the page is loaded again and a fresh token is
presented. For anything that has to be current at the moment of asking, give the AI a tool
that reads it rather than putting it in the token.

Whether the token counts as proof is a workspace setting (**Settings → Integrations →
Proving who a customer is**). Switching it off leaves identification working — the same person still keeps
one history across browsers — while withdrawing every tool bound to it.

This is one of two ways to prove who a customer is, and the only one available inside the
widget. On LINE and Messenger there is no token to present, so a one-time verification link
does the same job: see [IDENTITY-VERIFICATION.md](IDENTITY-VERIFICATION.md), which also
describes the page you have to build for it.

## What the widget may see

A session token is minted by us after we decide who the visitor is, signed with the
channel's own secret, and carries the identity it belongs to. Every later request is
answered only for that identity's conversation. No endpoint accepts a conversation id, so a
guessed id reaches nothing.

## Restricting who may embed it

Leave the allowed origins empty and any site may embed the widget, which suits development.
List them in the channel's configuration for production. The rule is enforced at the frame:
the widget page is served with `Content-Security-Policy: frame-ancestors 'self' <origins>`,
so a browser refuses to render it inside any other site. The session request comes from
inside the iframe, on our own origin, and is accepted; a host page calling the session
endpoint directly is still held to the list.

## Polling, not sockets

The widget polls every three seconds. The console holds a socket because an agent keeps it
open all day; a widget is open for a few minutes, and a poll works through every corporate
proxy without a reconnection story. If a session expires while the widget sits open, it
starts a new one rather than going quiet.

## What the widget is told

`GET /api/widget/:channel/messages?since=<iso>` with the `x-widget-session` header answers:

```json
{
  "conversationId": "…",
  "state": "ai | waiting | human",
  "stateText": "Passing you to a colleague. One moment.",
  "messages": [
    { "id": "…", "sender": "you | ai | agent | system", "from": "you | support",
      "text": "…", "attachments": [{ "url": "…", "mime": "…", "fileName": "…" }], "at": "…" }
  ]
}
```

- `state` says who is answering. `ai_supervised` reads as `ai`: a customer does not need to
  know a colleague approves each reply.
- `stateText` is null while the AI answers, and otherwise one line composed by the server in
  the language the visitor last typed in (a photo's placeholder text does not count), so the
  widget carries no copy of its own for it.
- `sender` says who wrote each message; `system` is the product itself, such as the holding
  message sent on a handoff. `from` is kept for a loader cached on a host page from before
  `sender` existed.
- Only what reached the visitor: inbound messages, and replies whose status is `sent`,
  `delivered` or `read`. A reply still queued, or one withheld because a colleague took over,
  is never shown.
- `at` is when a row became part of the visitor's conversation — when a reply was sent,
  not when it was written — and `since` pages by it. A reply that is sent after a later row
  has moved the cursor still arrives. `at` is rounded to milliseconds, so a row may come back
  twice; the widget drops repeats by id.
- Attachments are signed links made at read time from the stored file, valid for
  `MEDIA_LINK_TTL_DAYS`; a history reopened later gets fresh links.
- Without `since`, the newest thirty messages; with it, up to a hundred after that instant,
  oldest first. Internal events are never returned.

A 401 starts a new session, retried with backoff if that fails. A 403 with
`code: "workspace_suspended"`, or a 404, shuts the widget with a message and disables the box;
repeated failed polls show an offline line; a start that failed offers **Try again**. After a
minute of waiting on the AI the dots give way to a line saying it is taking longer.

`POST /api/widget/:channel/messages` takes `{ text, clientMessageId }`. The id is chosen by
the browser once per message; a request retried after a lost response is stored once.

## Talking to the host page

The loader and the iframe speak through `postMessage`, and the loader checks the origin of
everything it receives.

| Direction | Message | Meaning |
|---|---|---|
| iframe → host | `{ type: 'chat-widget:close' }` | The close button or Escape was pressed |
| iframe → host | `{ type: 'chat-widget:unread', count }` | Replies arrived while the chat was shut; the loader badges the launcher |
| host → iframe | `{ type: 'chat-widget:open' }` | The chat was opened; reset the unread count and focus the box |
| host → iframe | `{ type: 'chat-widget:hidden' }` | The chat was shut; count replies as unread |

Whether the chat is open is remembered for the tab in `sessionStorage['chat-widget:open']`,
so it survives the host moving between its own pages. At 480px wide or less the frame takes
the whole viewport (`100dvh`, so the box is not under the keyboard) and the launcher hides
while it is open. The widget follows the visitor's light or dark preference, and the text on
the brand colour is chosen by its luminance, so a pale `data-colour` stays readable.
