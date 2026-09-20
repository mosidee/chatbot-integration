ALTER TABLE "conversations" ADD COLUMN "reply_token" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "reply_token_expires_at" timestamp with time zone;