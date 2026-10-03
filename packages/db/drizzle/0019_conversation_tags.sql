-- Tags become one spelling each (normaliseTag in packages/shared/src/tags.ts, which this
-- repeats): commas and runs of whitespace become one space, trimmed, lowercased, cut to 40
-- characters, empties dropped, duplicates merged keeping first position. The limit of 20 a
-- conversation applies to adding, not here: nothing already stored is dropped.
-- A second run finds nothing to change.
UPDATE "conversations" AS c
SET "tags" = n."tags"
FROM (
  SELECT c2."id",
    coalesce((
      SELECT array_agg(y.t ORDER BY y.first_pos)
      FROM (
        SELECT x.t, min(x.ord) AS first_pos
        FROM (
          SELECT btrim(left(lower(btrim(regexp_replace(replace(u.raw, ',', ' '), '\s+', ' ', 'g'))), 40)) AS t,
                 u.ord
          FROM unnest(c2."tags") WITH ORDINALITY AS u(raw, ord)
        ) AS x
        WHERE x.t <> ''
        GROUP BY x.t
      ) AS y
    ), '{}'::text[]) AS "tags"
  FROM "conversations" AS c2
) AS n
WHERE c."id" = n."id" AND c."tags" IS DISTINCT FROM n."tags";
--> statement-breakpoint
CREATE INDEX "conversations_tags_idx" ON "conversations" USING gin ("tags");
