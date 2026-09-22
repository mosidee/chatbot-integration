CREATE TYPE "public"."outbox_op" AS ENUM('add', 'remove');--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"op" "outbox_op" DEFAULT 'add' NOT NULL,
	"queue" text NOT NULL,
	"name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"job_id" text NOT NULL,
	"delay_ms" integer,
	"options" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"relayed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "turn_key" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sent_parts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox" USING btree ("id") WHERE "outbox"."relayed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_turn_key_uq" ON "messages" USING btree ("workspace_id","turn_key");