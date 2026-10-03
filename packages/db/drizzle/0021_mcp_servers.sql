CREATE TABLE "mcp_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"auth" text DEFAULT 'none' NOT NULL,
	"header_name" text,
	"credential_encrypted" text,
	"snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"last_error" text,
	"timeout_ms" integer DEFAULT 8000 NOT NULL,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_workspace_name_uq" ON "mcp_servers" USING btree ("workspace_id","name");