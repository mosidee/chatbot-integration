ALTER TABLE "customers" ADD COLUMN "notes" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
/*
 * Move what is already there into the right half.
 *
 * `fields` was written by two things with different ideas of what it was for: the
 * `set_customer_field` tool, which may only use five identifier keys, and the summariser,
 * whose extracted facts were merged in wholesale under whatever key the model chose. On the
 * pilot tenant that left a customer panel where a phone number sat below a paragraph about
 * which plan somebody was weighing up, listed twice under two invented keys.
 *
 * Identifiers stay; everything else becomes a note. Nothing is discarded, and running this
 * twice is a no-op because the second pass finds nothing left to move.
 */
UPDATE "customers" c
SET "notes" = c."notes" || (c."fields" - ARRAY['phone', 'email', 'order_id', 'account_id', 'company']),
    "fields" = COALESCE(
      (
        SELECT jsonb_object_agg(k, v)
        FROM jsonb_each_text(c."fields") AS t(k, v)
        WHERE k IN ('phone', 'email', 'order_id', 'account_id', 'company')
      ),
      '{}'::jsonb
    )
WHERE EXISTS (
  SELECT 1 FROM jsonb_object_keys(c."fields") AS k
  WHERE k NOT IN ('phone', 'email', 'order_id', 'account_id', 'company')
);
