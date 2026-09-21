CREATE TYPE "public"."feedback_rating" AS ENUM('up', 'down');--> statement-breakpoint
CREATE TYPE "public"."feedback_reason" AS ENUM('wrong_answer', 'fabricated', 'missing_knowledge', 'wrong_tone_or_language', 'should_have_handed_off');--> statement-breakpoint
CREATE TYPE "public"."feedback_target" AS ENUM('message', 'suggestion');--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"target_type" "feedback_target" NOT NULL,
	"target_id" text NOT NULL,
	"user_id" text NOT NULL,
	"rating" "feedback_rating" NOT NULL,
	"reason" "feedback_reason",
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "reviewed_by_user_id" text;--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "sent_message_id" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_target_user_uq" ON "feedback" USING btree ("target_type","target_id","user_id");--> statement-breakpoint
CREATE INDEX "feedback_workspace_idx" ON "feedback" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "feedback_conversation_idx" ON "feedback" USING btree ("conversation_id");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_reviewed_by_user_id_user_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_sent_message_id_messages_id_fk" FOREIGN KEY ("sent_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_workspace_reviewed_idx" ON "conversations" USING btree ("workspace_id","reviewed_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_sender_idx" ON "messages" USING btree ("conversation_id","sender_type","created_at");