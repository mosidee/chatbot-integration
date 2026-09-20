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
    attributes: { plan: user.plan },
    exp: Math.floor(Date.now() / 1000) + 300,
  },
  process.env.CHAT_WIDGET_SECRET,
)
```

Render it into the script tag as `data-token`. Keep the expiry short: it is presented once,
when the widget starts a session, and a fresh page load mints a new one.

A token that is invalid or expired degrades to anonymous rather than refusing. Somebody with
a stale session still deserves support.

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
