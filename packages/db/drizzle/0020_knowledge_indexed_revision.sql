ALTER TABLE "knowledge_entries" ADD COLUMN "indexed_revision" timestamp with time zone;--> statement-breakpoint
-- Entries already indexed are taken as current: an entry with chunks, or one that has none
-- because it is switched off. An enabled entry with no chunks yet stays "indexing" until
-- its next index. A second run finds nothing to change.
UPDATE "knowledge_entries" AS e
SET "indexed_revision" = e."updated_at"
WHERE e."indexed_revision" IS NULL
  AND (
    NOT e."enabled"
    OR EXISTS (SELECT 1 FROM "knowledge_chunks" k WHERE k."entry_id" = e."id")
  );
