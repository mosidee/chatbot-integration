ALTER TABLE "conversations" ADD COLUMN "summarized_through_message_id" text;--> statement-breakpoint
ALTER TABLE "conversation_embeddings" ADD COLUMN "embedding_space" text;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN "embedding_space" text;--> statement-breakpoint
-- Existing vectors were made by the model on their row, with the size requested unless the
-- workspace's embedding slot said otherwise. Idempotent: only unlabelled rows are touched.
UPDATE "knowledge_chunks" c
SET "embedding_space" = c."embedding_model" || '|' || CASE
  WHEN coalesce((SELECT (ts."params"->>'sendDimensions')::boolean FROM "task_slots" ts
                 WHERE ts."workspace_id" = c."workspace_id" AND ts."task" = 'embed' LIMIT 1), true)
  THEN 'dims' ELSE 'native' END
WHERE c."embedding" IS NOT NULL AND c."embedding_model" IS NOT NULL AND c."embedding_space" IS NULL;
--> statement-breakpoint
UPDATE "conversation_embeddings" c
SET "embedding_space" = c."embedding_model" || '|' || CASE
  WHEN coalesce((SELECT (ts."params"->>'sendDimensions')::boolean FROM "task_slots" ts
                 WHERE ts."workspace_id" = c."workspace_id" AND ts."task" = 'embed' LIMIT 1), true)
  THEN 'dims' ELSE 'native' END
WHERE c."embedding" IS NOT NULL AND c."embedding_model" IS NOT NULL AND c."embedding_space" IS NULL;
--> statement-breakpoint
-- A conversation already summarised is marked as summarised up to its last indexed moment,
-- so the first incremental summary does not read and index the same messages again.
UPDATE "conversations" c
SET "summarized_through_message_id" = (
  SELECT m."id" FROM "messages" m
  WHERE m."conversation_id" = c."id"
    AND m."created_at" <= (SELECT max(e."created_at") FROM "conversation_embeddings" e
                           WHERE e."conversation_id" = c."id")
  ORDER BY m."id" DESC LIMIT 1
)
WHERE c."summarized_through_message_id" IS NULL
  AND EXISTS (SELECT 1 FROM "conversation_embeddings" e WHERE e."conversation_id" = c."id");
