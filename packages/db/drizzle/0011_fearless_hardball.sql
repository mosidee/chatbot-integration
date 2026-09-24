ALTER TABLE "workspaces" ADD COLUMN "private_egress_origins" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
-- Grandfather what each tenant already uses. Before this column, provider and external
-- retrieval URLs were fetched unrestricted, so a tenant's working gateway on a private
-- address would stop answering the moment this deploys. Approve the private or plain-http
-- origins configured right now, once; a platform admin can prune them from the Platform page. Idempotent:
-- only a workspace whose list is still empty is touched.
UPDATE "workspaces" w
SET "private_egress_origins" = found.origins
FROM (
  SELECT workspace_id, array_agg(DISTINCT origin ORDER BY origin) AS origins
  FROM (
    SELECT p.workspace_id, lower(substring(p.base_url FROM '^(https?://[^/?#]+)')) AS origin
    FROM "providers" p
    UNION
    SELECT ws.id, lower(substring(ws.settings->'externalRetrieval'->>'baseUrl' FROM '^(https?://[^/?#]+)'))
    FROM "workspaces" ws
  ) configured
  -- Only what needs approving: plain http, or an address typed as a literal IP. An https
  -- hostname passes the guard on its own whenever it resolves publicly, and approving one
  -- would exempt it from the DNS check if its owner later pointed it inward.
  WHERE origin ~ '^http://'
     OR origin ~ '^https://(\[[0-9a-f:.]+\]|[0-9.]+)(:[0-9]+)?$'
  GROUP BY workspace_id
) found
WHERE w.id = found.workspace_id AND w."private_egress_origins" = '{}';
