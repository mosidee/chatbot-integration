import { z } from 'zod'

/**
 * Proposing that two customer records are the same person.
 *
 * The product never merges on its own. A wrong merge puts one customer's history in front
 * of another, which is the single leak this product refuses to accept, and it cannot be
 * undone by anybody who notices afterwards. So the machine proposes and a person decides.
 */

/**
 * The saved identifiers strong enough to suggest one person behind two records.
 *
 * Deliberately not `order_id` or `company`. Both name something other than a person: an
 * owner and their staff can quote the same invoice and certainly share an employer, and
 * merging those two is exactly the mistake that matters.
 */
export const mergeMatchKeySchema = z.enum(['phone', 'email', 'account_id'])
export type MergeMatchKey = z.infer<typeof mergeMatchKeySchema>

export const mergeSuggestionStatusSchema = z.enum(['pending', 'rejected'])
export type MergeSuggestionStatus = z.infer<typeof mergeSuggestionStatusSchema>
