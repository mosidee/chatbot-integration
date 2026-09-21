CREATE TYPE "public"."merge_match_key" AS ENUM('phone', 'email', 'account_id');--> statement-breakpoint
CREATE TYPE "public"."merge_suggestion_status" AS ENUM('pending', 'rejected');--> statement-breakpoint
CREATE TABLE "merge_suggestions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"other_customer_id" text NOT NULL,
	"match_key" "merge_match_key" NOT NULL,
	"match_value" text NOT NULL,
	"status" "merge_suggestion_status" DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "merge_suggestions" ADD CONSTRAINT "merge_suggestions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_suggestions" ADD CONSTRAINT "merge_suggestions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_suggestions" ADD CONSTRAINT "merge_suggestions_other_customer_id_customers_id_fk" FOREIGN KEY ("other_customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_suggestions" ADD CONSTRAINT "merge_suggestions_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merge_suggestions_pair_uq" ON "merge_suggestions" USING btree ("customer_id","other_customer_id");--> statement-breakpoint
CREATE INDEX "merge_suggestions_workspace_idx" ON "merge_suggestions" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "merge_suggestions_other_idx" ON "merge_suggestions" USING btree ("other_customer_id");