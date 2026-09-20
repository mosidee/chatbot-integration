# Connecting LINE and Messenger

Both platforms need a reachable HTTPS webhook before they will accept anything, so deploy to
staging first. See [DEPLOY.md](./DEPLOY.md). Everything below assumes the console is running
at your domain and you can sign in as an admin.

The pattern is the same for both: create the channel here to get its webhook URL, put that
URL into the platform, then paste the platform's secrets back here.

---

## LINE

LINE has no review process. You can be live with real customers the same day.

### 1. Create the Official Account and channel

1. Create a LINE Official Account at [manager.line.biz](https://manager.line.biz).
2. In **Settings → Messaging API**, enable the Messaging API. This creates a provider and a
   channel in the LINE Developers Console.
3. In [LINE Developers](https://developers.line.biz) open that channel.

### 2. Create the channel here

In the console, **Settings → Channels → Connect LINE**. Give it a name. It appears with no
credentials and a webhook URL of the form:

```
https://chat.example.com/api/v1/webhooks/<channel-id>
```

### 3. Point LINE at it

In the LINE Developers Console, **Messaging API** tab:

- **Webhook URL**: paste the URL above, then press **Verify**. It should report success.
- **Use webhook**: on.
- **Auto-reply messages** and **Greeting messages**: off. LINE answers before we do otherwise,
  and customers see two replies.

### 4. Paste the secrets back

From the same console:

- **Channel secret** is on the **Basic settings** tab.
- **Channel access token (long-lived)** is on the **Messaging API** tab; issue one if there is
  none.

Put both into **Configure** on the channel here and save, then press **Check connection**. It
asks LINE whether the access token works.

The channel secret is not covered by that check: it is only exercised when LINE signs a real
webhook. If it is wrong, deliveries arrive and are rejected, which shows up as nothing
happening when you message the account. Send a test message to confirm.

### 5. Test

Add the Official Account as a friend using the QR code on the LINE Developers Console, send it
a message, and watch the conversation appear in the inbox.

### Costs worth knowing

Replying inside LINE's reply window is free; a push message counts against the account's
monthly quota. This system uses a reply token whenever it is still valid, which it usually is,
and pushes otherwise. A busy account may still need a paid LINE plan.

---

## Messenger

Messenger has a review process, and it is the long pole in the schedule. Start it as soon as
the webhook works.

### 1. What you need before starting

- A Facebook **Page** for the business.
- A **Meta Business Portfolio** that owns the Page.
- A **privacy policy URL** that is publicly reachable and specifically mentions what customer
  data you collect through Meta's APIs. A generic policy is a common rejection reason.
- Ability to complete **Business Verification**: legal business name, address, and a document
  or phone or domain that corroborates it.

The first three are things only you can produce.

### 2. Create the app

1. At [developers.facebook.com](https://developers.facebook.com/apps), create an app of type
   **Business**.
2. Add the **Messenger** product.
3. Under **Messenger → Settings**, connect your Page and generate a **page access token**.

### 3. Create the channel here

**Settings → Channels → Connect Messenger**. Note its webhook URL and its **verify token**,
both shown under **Configure**.

### 4. Subscribe the webhook

Under **Messenger → Settings → Webhooks → Add callback URL**:

- **Callback URL**: the webhook URL from here.
- **Verify token**: the verify token from here.

Meta immediately calls the URL with a challenge; the console answers it. Then subscribe the
Page to these fields:

`messages`, `messaging_postbacks`, `messaging_optins`, `message_deliveries`, `message_reads`,
`messaging_referrals`

### 5. Paste the secrets back

- **App secret**: App settings → Basic.
- **Page ID**: shown on the Page, or from the Messenger settings.
- **Page access token**: from step 2.

Save, then **Check connection**. It asks Meta for the page name using the token.

### 6. Development mode

Until the app is approved, it only delivers messages from people with a **role on the app**
(admin, developer or tester). Add yourself and anyone testing under **App roles**.

This is enough to verify the whole pipeline. It is not enough to serve customers.

### 7. App Review

See [META-REVIEW.md](./META-REVIEW.md).
