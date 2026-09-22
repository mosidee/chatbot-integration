# ADR 0007: what identifies a customer is kept apart from what is known about them

Accepted 2026-09-23.

## Context

`customers.fields` had two writers with different ideas of what it was for.

`set_customer_field` is an internal tool the model may call, and its `key` is a closed enum:
`phone`, `email`, `order_id`, `account_id`, `company`. Five business identifiers, chosen
because those are the things a customer types that later let somebody find them again. Three
of them — phone, email, account id — are what `suggestMergesFor` compares when it proposes
that two records are the same person.

The summarize processor also wrote to it, and its input is not constrained at all:
`facts: z.record(z.string(), z.string())`, described to the model as "durable details worth
remembering, such as plan, company or timezone". Whatever the model returned was merged into
the same column, under whatever key it chose that turn.

On the pilot tenant the result was a customer panel where a phone number sat in a list
beside a paragraph about which package somebody was weighing up; the same idea appeared
under `ผลิตภัณฑ์` twice with different wording; and a `ราคา` key held the entire price list
rather than anything about that customer. The panel exists so an agent can check at a glance
that they have the right person in front of them, and it had stopped being scannable.

The deeper problem is that the two kinds of value have different rules. An identifier is
something the customer asserted about themselves and that the product matches on: it is
worth surfacing prominently, it must not be invented, and a wrong one merges two strangers'
histories. A note is the model's impression: useful context for the next turn, wrong often
enough that nothing should key off it, and unbounded in shape.

## Decision

Two columns.

`customers.fields` holds identifiers, and only the five keys `set_customer_field` accepts. It
is what merge matching reads and what the sidebar lists first, with real labels.

`customers.notes` holds everything the summariser extracted. It is shown under its own
heading, keyed however the model keyed it, and nothing matches on it.

The summarize processor writes `notes`; `mergeCustomerFields` remains the only writer of
`fields`. Both merge under what is already there, so a person correcting a detail outranks
the model re-deriving it.

Migration 0010 moves existing non-identifier keys across rather than discarding them, and is
a no-op on a second run.

## Consequences

`notes` is a column on `customers`, so it is not covered by the repoint list in `merge.ts`
and has to be named in the survivor-wins block or it dies with the absorbed row. It is.
Erasure needs no change: deleting the customer row takes the column with it.

The summariser can still invent a key per turn, and `notes` will accumulate near-duplicates
the way `fields` did. That is now confined to a panel where it reads as the AI's notes rather
than as facts about the person, which is an honest description of what it is. Constraining
the summariser's keys to a vocabulary is a separate decision and is not taken here: the value
of that extraction is precisely that it is not limited to what we thought to ask for.

A tenant who had been reading a note out of the identifier list will find it one heading
lower. Nothing is lost and nothing needs re-extracting.
