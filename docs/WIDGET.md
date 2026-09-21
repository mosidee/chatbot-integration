# Embedding the chat widget

The widget is two files served from the same domain as the console: a loader a host page
embeds, and a chat application that runs inside an iframe.

```html
<script
  src="https://chat.mosidee.com/widget/loader.js"
  data-channel="<web channel id>"
  data-colour="#2563eb"
  data-title="แชทกับเรา"
  defer
></script>
```

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

Re-read on every message, so a customer who upgrades mid-conversation is not answered from
the plan they were on when they opened the widget.

Whether the token counts as proof is a workspace setting (**Settings → Proving who a
customer is**). Switching it off leaves identification working — the same person still keeps
one history across browsers — while withdrawing every tool bound to it.

## What the widget may see

A session token is minted by us after we decide who the visitor is, signed with the
channel's own secret, and carries the identity it belongs to. Every later request is
answered only for that identity's conversation. No endpoint accepts a conversation id, so a
guessed id reaches nothing.

## Restricting who may embed it

Leave the allowed origins empty and any site may embed the widget, which suits development.
List them in the channel's configuration for production and the session endpoint refuses any
other origin.

## Polling, not sockets

The widget polls every three seconds. The console holds a socket because an agent keeps it
open all day; a widget is open for a few minutes, and a poll works through every corporate
proxy without a reconnection story. If a session expires while the widget sits open, it
starts a new one rather than going quiet.
