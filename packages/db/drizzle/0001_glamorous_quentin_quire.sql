CREATE TABLE IF NOT EXISTS "ingest_heartbeats" (
	"service" text PRIMARY KEY NOT NULL,
	"last_tick_at" timestamp with time zone NOT NULL,
	"last_block" integer,
	"last_status" text NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "poll_state" (
	"id" text PRIMARY KEY NOT NULL,
	"last_block" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
