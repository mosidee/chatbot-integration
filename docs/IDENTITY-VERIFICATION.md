# Proving who a customer is

A customer writing from LINE or Messenger is a platform id and nothing more. Anyone can
open a chat and claim to be anyone, so the AI is not allowed to read an account on the
strength of a name typed into a conversation. Before it can, somebody has to prove the
person is who they say.

There are two ways to do that, and a workspace accepts each one separately in
**Settings → Integrations → Proving who a customer is**.

| | Where it works | What you build |
|---|---|---|
| Widget token | The embedded web widget | Sign a token for your logged-in user; see [WIDGET.md](WIDGET.md) |
| Verification link | LINE, Messenger, anywhere | A page on your site, described below |

Switching a proof off leaves identification working — the same person still keeps one
history — and withdraws every tool bound to it. It is a safe thing to do in an emergency.

## Before writing any of this

Check whether you need it. If the question is "what plan am I on?", put `plan` and
`paidUntil` into the widget token's `attributes` and the AI can answer from
`get_customer_profile` with no page, no endpoint and no credential. The verification link
is for the channels where no token exists, and for tools that read something the token
cannot carry.

## How the link works

1. The AI decides it cannot answer without knowing whose account this is, or an agent
   presses **Send a verification link** in the conversation sidebar.
2. We mint a single-use code and send the customer a message containing your URL with
   `?code=` appended. The code expires after the lifetime set in settings, fifteen minutes
   by default.
3. The customer opens the link. **Your page requires them to log in**, exactly as any other
   page of yours would. That login is the whole proof; everything else is plumbing.
4. Your page signs a short-lived token naming the logged-in user and posts it to us with
   the code.
5. We bind that account to the channel identity, tell the customer it worked, and give the
   AI another turn so the question they asked before proving themselves gets answered.

The code is the only thing tying step 4 back to a conversation, and it travels through a
chat message the customer can read. That is why it is not enough on its own: the token,
signed with a secret only you hold, is what makes the pair trustworthy.

## Configure it

In **Settings → Integrations → Proving who a customer is**:

- Switch on **One-time verification link**.
- **Your verification page URL** — we append `?code=`, so query strings you add are kept.
- **Secret you sign the confirmation with** — any string of sixteen characters or more.
  Write-only: we encrypt it and never show it again.
- **Link lifetime** — minutes, fifteen by default. Short is good; the customer is holding
  their phone when it arrives.

> This secret is **not** the widget's visitor token secret. That one lives on the web
> channel and signs tokens your front end presents. This one lives on the workspace and
> signs confirmations your server sends us. Two different secrets for two different
> directions; reusing one for both means a leak of either compromises both.

## What your page does

```
GET  https://salon.example.com/verify?code=<code>   ← the customer opens this
POST https://chat.mosidee.com/api/identity/confirm  ← your server calls this
```

The POST body is JSON:

```json
{ "code": "<the code from the query string>", "token": "<an HS256 JWT you signed>" }
```

The token's claims:

| Claim | Required | Meaning |
|---|---|---|
| `sub` | yes | Your id for the logged-in user. This becomes the verified account. |
| `name` | no | Display name. |
| `email` | no | Stored alongside the attributes. |
| `attributes` | no | Flat string-to-string map, such as `{"plan":"pro"}`. Anything over 2 KB in total is dropped, so send what the AI needs and not the whole user record. |
| `exp` | no | Seconds since the epoch. Keep it short; the token is used once, immediately. |

Answers:

| Status | Body | Means |
|---|---|---|
| 200 | `{"ok":true}` | Bound. Tell the person to return to their chat. |
| 404 | `{"error":"That link is not valid any more"}` | The code is unknown, expired, already used, or the workspace has switched the link off. |
| 401 | `{"error":"That confirmation could not be verified"}` | The token did not verify against the configured secret. **The code is not spent**, so fixing the signature and retrying works. |
| 422 | `{"error":"Validation failed", ...}` | The body is not the shape above. |

Only a successful confirmation spends the code. A bad token leaves it usable, which matters
because a bug in this page would otherwise destroy the customer's only link and leave them
waiting on a chat that can no longer help them.

## Signing the token

HS256 over Web Crypto, with no dependency, so it runs on Cloudflare Workers, Node, Bun and
Deno alike:

```ts
async function signConfirmation(sub: string, attributes: Record<string, string>) {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  const header = encode({ alg: 'HS256', typ: 'JWT' })
  const payload = encode({
    sub,
    attributes,
    exp: Math.floor(Date.now() / 1000) + 120,
  })

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(process.env.CHAT_VERIFICATION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`)),
  )

  let binary = ''
  for (const byte of signature) binary += String.fromCharCode(byte)
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  return `${header}.${payload}.${encoded}`
}
```

The whole page, in a framework of your choosing:

```ts
export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get('code')
  const user = await requireLogin(request) // your own session check; this is the proof

  if (!code) return render('That link is incomplete.')

  const response = await fetch('https://chat.mosidee.com/api/identity/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code,
      token: await signConfirmation(user.id, {
        plan: user.plan,
        paidUntil: user.paidUntil,
      }),
    }),
  })

  return render(
    response.ok
      ? 'Thanks. You can go back to your chat now.'
      : 'That link has expired. Ask for a new one in the chat.',
  )
}
```

Send the confirmation from your server, never from the browser: the secret is the only
thing standing between a stranger and somebody else's account.

## Points worth getting right

**Require a real login.** A page that accepts whoever arrives proves nothing, and the AI
will then read account details out to whoever followed the link. If the person is already
logged in, that session is the proof; if they are not, send them through the ordinary login
and back.

**Do not reuse the code.** It is spent on success. A customer who needs to prove themselves
again gets a fresh link, and asking for one invalidates any earlier link for that person,
so two live links can never bind two different accounts to one conversation.

**Attributes are a snapshot, not a live read.** What you sign is stored and read into the
prompt on every turn, but it is only refreshed when a new proof arrives. For a verification
link that means the moment of confirmation and not again, so an account that changes plan an
hour later is still answered from the plan it had when the link was followed. If a value
matters more than that, do not put it in the token: give the AI a tool that reads it, which
is what tools are for. Keep what you do send small, since it is in the prompt all day.

**What the AI may do with this.** The verified account is bound into tool calls by us; the
model can neither name it nor override it, and a tool that needs it is not offered at all in
a conversation where nobody proved anything. See
[TOOLS.md](TOOLS.md) for defining one, and
[adr/0004-restricted-egress-for-tenant-tools.md](adr/0004-restricted-egress-for-tenant-tools.md)
for what it may reach once it is called.
