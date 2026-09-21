CREATE TYPE "public"."identity_proof" AS ENUM('widget_token', 'verification_link');--> statement-breakpoint
CREATE TYPE "public"."tool_kind" AS ENUM('http');--> statement-breakpoint
CREATE TABLE "identity_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"channel_identity_id" text NOT NULL,
	"code" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tools" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" "tool_kind" NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb NOT NULL,
	"credential_encrypted" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_identities" ADD COLUMN "verified_subject" text;--> statement-breakpoint
ALTER TABLE "channel_identities" ADD COLUMN "verified_attributes" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_identities" ADD COLUMN "verified_via" "identity_proof";--> statement-breakpoint
ALTER TABLE "channel_identities" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "identity_verifications" ADD CONSTRAINT "identity_verifications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_verifications" ADD CONSTRAINT "identity_verifications_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_verifications" ADD CONSTRAINT "identity_verifications_channel_identity_id_channel_identities_id_fk" FOREIGN KEY ("channel_identity_id") REFERENCES "public"."channel_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_verifications_code_uq" ON "identity_verifications" USING btree ("code");--> statement-breakpoint
CREATE INDEX "identity_verifications_identity_idx" ON "identity_verifications" USING btree ("channel_identity_id");--> statement-breakpoint
CREATE INDEX "identity_verifications_workspace_idx" ON "identity_verifications" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tools_workspace_name_uq" ON "tools" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "tools_workspace_idx" ON "tools" USING btree ("workspace_id");