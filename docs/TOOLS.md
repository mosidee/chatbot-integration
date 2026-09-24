# Giving the AI a tool

Out of the box the AI answers from your knowledge base and from what it remembers about a
customer. A tool lets it call an API of yours during the conversation, so it can answer
about the customer's own account instead of only about the documentation.

You describe the tool in **Settings → Integrations → Your tools**. It is configuration, not code: nothing
is deployed and we ship nothing on your behalf.

## What the AI is told

A tool is a name, a sentence describing when to use it, and a list of arguments. That
sentence is the only guidance the model has, so write it the way you would brief a new
colleague: *"Look up which plan this customer is on"* beats *"plan endpoint"*.

Arguments split in two, and the split is the part worth understanding.

**Arguments the AI fills in** are chosen by the model from the conversation: an order
reference the customer just quoted, a date they asked about. Give each one a description
and, where the values are from a fixed set, list them — models follow an enumerated list far
more reliably than a described one.

**Values the system supplies** are filled in by us and the model never sees them in the
tool's schema: the verified account, the customer, the conversation, the workspace. It
cannot name one, cannot override one, and cannot ask for a different customer's. Anything
that decides *whose* data comes back belongs here and never in the first list. A tool bound
to the verified account is not offered at all in a conversation where nobody has proved who
they are; see [IDENTITY-VERIFICATION.md](IDENTITY-VERIFICATION.md).

## What your endpoint has to satisfy

| | |
|---|---|
| Scheme | HTTPS only. Loopback, private, link-local and carrier-NAT addresses are refused, after resolving the name and checking every address it answers with, and again on each redirect. At most three redirects. See [ADR 0004](adr/0004-restricted-egress-for-tenant-tools.md) |
| Method | `GET` or `POST`. A `GET` receives arguments and bound values as query parameters; a `POST` receives them as a flat JSON object |
| Path | May contain `{{name}}`, which is replaced by that argument or bound value, URL-encoded. A value used in the path is not repeated in the query or body |
| Timeout | Between 1 and 15 seconds, 8 by default. It covers the response body as well as the headers, so an endpoint that answers quickly and then trickles is still cut off |
| Status | Anything outside 2xx is a failure. The conversation goes to one of your colleagues with the status and the first part of your body in the note |
| Size | We read at most 64 KB and show the model at most 8 KB of it, JSON included. A larger answer is cut and the model is told it was cut, so return what answers the question rather than a whole record |
| Types | An argument declared as a number or a boolean reaches a JSON body as one. A query string and a path are text, as they have to be |
| Auth | Either a bearer token or a header you name. The value is encrypted at rest and never shown again, here or through the API |

Every request carries `x-ci-tool` naming the tool, so you can see in your own logs which one
called. Every write carries `idempotency-key`, built from the turn, the tool and the
arguments: the same operation asked for twice carries the same key however our retries
reorder it, so honouring it means a retry cannot double-charge anybody.

If your endpoint redirects to a different origin, only `accept`, `accept-encoding`,
`accept-language`, `content-type` and `user-agent` go with it: your credential never does,
whichever header you put it in. A 301, 302 or 303 turns a `POST` into a `GET` without its
body, and a 307 or 308 to another origin — which would resend the body — is refused and the
call fails. Redirect within your own origin and headers and body both survive.

The same egress rules apply to the AI providers and external retrieval your workspace
configures. A provider on a private address or plain http, such as a gateway on your own
network, has to be approved for your workspace by the platform operator; the model list in
settings says so when that is why it failed.

## Reading and writing are different

Mark a tool **reads only** and it runs while the AI is composing its reply, so the answer
shapes what the customer is told.

Mark it **writes something** and it does not run then. The intent is recorded, the turn
finishes, and the write fires before the reply is sent. If it fails, the reply is thrown
away and a colleague picks the conversation up instead — because a customer who has been
told "done" for something that did not happen is a worse outcome than a customer who waits.
For the same reason a writing tool is never offered while the AI is only drafting a reply
for a person to approve, and a turn that ends in a handoff for any other reason abandons its
pending writes unfired.

If a write is not safely repeatable, use the `idempotency-key`.

## Test it before a customer does

The **Test** button calls your endpoint through exactly the same code and the same network
restrictions a real conversation uses, and shows you the status, how long it took and the
body we would have given the model. An endpoint that works there works in front of a
customer; a URL that is wrong fails here instead of turning into a handoff at eleven at
night.

## Things that go wrong

**The model never calls the tool.** Almost always the description. Say when to use it, in
the words a customer would use.

**It calls it with nonsense.** Enumerate the values where you can, and describe each
argument. An argument the model gets wrong is handed back to it to correct within the same
turn, so this usually self-corrects; if it does not, the description is the fix.

**Everything hands off.** Check the trace on the conversation: it records what each tool was
asked and what it answered. A refused address, a timeout or a non-2xx status will be there
in the note.

**The test button disagrees with a real conversation.** It should not: it validates the
arguments against the same schema and calls through the same code and the same network
rules. The one difference is that a tool bound to a conversation or a customer is tested
with a placeholder, since there is no conversation to speak of.

**It reads the wrong customer's data.** It cannot. If a tool is returning the wrong person's
account, the binding is wrong — check that the account is a supplied value and not an
argument the model was allowed to fill in.
