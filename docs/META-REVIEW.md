# Meta App Review for `pages_messaging`

Approval is what lets the app receive messages from members of the public rather than only
from people with a role on it. Until then Messenger is a demo.

**Treat this as the schedule's long pole.** Review turnaround is measured in days to weeks and
rejections are common, so submit as soon as the webhook works rather than when everything else
is finished. The product can pilot on the web widget and LINE meanwhile, neither of which needs
anyone's approval.

## What to request

Only `pages_messaging`, at **Advanced Access**.

Requesting permissions the app does not visibly use is one of the most common rejection
reasons. Reviewers check that every permission asked for is exercised in the screencast. Do
not add `pages_read_engagement`, `pages_manage_metadata` or anything else unless a feature
here actually needs it.

## Prerequisites

| Item | Who produces it | Notes |
|---|---|---|
| Business Verification | You | Legal name, address, and corroborating document, phone or domain. Start it early; it has its own queue. |
| Privacy policy URL | You | Must be publicly reachable and must name the customer data collected through Meta's APIs. A generic template is a frequent rejection reason. |
| Screencast | You | See below. |
| Working app | Done | The webhook, the console and the reply path all work. |
| App icon and category | You | Small but blocking. |

## The screencast

This is what most submissions fail on. Reviewers want to see the permission doing real work,
not a slide deck.

Record one continuous screen capture showing, in order:

1. A customer opening the Facebook Page and sending a message. Show the Page, not just the chat.
2. The message arriving in this console's inbox, with the customer's name and the text.
3. The AI answering, and the answer arriving back in Messenger on the customer's side.
4. An agent clicking **Take over** and replying by hand, and that reply arriving in Messenger.
5. The conversation being resolved.

Narrate what each step is for. Show both sides of the conversation, ideally side by side.
Keep it under three minutes.

## The use-case description

Say plainly what the app does and why it needs the permission. Something close to:

> This app provides customer support for businesses using the salon-saas platform. When a
> customer messages the business Page, the app receives the message, answers common questions
> about pricing, onboarding and billing from the business's own knowledge base, and hands the
> conversation to a human colleague when it cannot answer or when the customer asks for a
> person. `pages_messaging` is required to receive those messages and to reply to them.
> Messages are stored so that agents can see the conversation history and so the assistant can
> reference what was discussed before.

Avoid words like "marketing", "bulk" or "broadcast". Those read as promotional messaging, which
is governed by different rules and a stricter review.

## Before submitting, check

- [ ] Business Verification is complete, not merely started.
- [ ] The privacy policy URL loads publicly and names the data collected through Meta's APIs.
- [ ] Only `pages_messaging` is requested.
- [ ] The screencast shows a real message arriving and a real reply going back.
- [ ] The app is in the state the screencast shows, so a reviewer can reproduce it.
- [ ] Webhook fields subscribed: `messages`, `messaging_postbacks`, `messaging_optins`,
      `message_deliveries`, `message_reads`, `messaging_referrals`.
- [ ] Test credentials or instructions are supplied if a reviewer needs to try it themselves.

## After approval

- The Page can receive messages from anyone.
- The 24-hour customer-service window applies: outside it, only an approved message tag may
  be sent. This system refuses the send and explains why rather than returning a Graph error
  code, so an agent sees what happened.
- Message tags are restricted, and Meta withdrew several in April 2026. Do not assume an older
  guide's tag list still works.

## If it is rejected

Rejections name a policy section. The usual causes, in order:

1. The screencast does not show the permission in use.
2. The privacy policy is generic.
3. Permissions were requested that the app does not use.
4. The app was not reproducible in the state described.

Fix the specific point, then resubmit. Resubmission does not restart Business Verification.
