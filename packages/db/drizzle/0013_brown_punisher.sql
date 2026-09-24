ALTER TYPE "public"."message_status" ADD VALUE 'canceled';--> statement-breakpoint
ALTER TYPE "public"."message_status" ADD VALUE 'uncertain';--> statement-breakpoint
CREATE TABLE "blob_deletions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"reason" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inbound_events" ADD COLUMN "channel_identity_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "platform_message_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "blob_deletions" ADD CONSTRAINT "blob_deletions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "blob_deletions_key_uq" ON "blob_deletions" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "blob_deletions_workspace_idx" ON "blob_deletions" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_channel_identity_id_channel_identities_id_fk" FOREIGN KEY ("channel_identity_id") REFERENCES "public"."channel_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- The one id each delivered message kept becomes the first of its list. Idempotent: only
-- rows whose list is still empty are touched. (Replies withheld by a takeover before this
-- migration stay `failed`; the new `canceled` value cannot be used in the transaction that
-- adds it.)
UPDATE "messages" SET "platform_message_ids" = jsonb_build_array("platform_message_id")
WHERE "platform_message_id" IS NOT NULL AND "platform_message_ids" = '[]'::jsonb;
