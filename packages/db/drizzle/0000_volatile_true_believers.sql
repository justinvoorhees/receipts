CREATE TABLE IF NOT EXISTS "p99_thresholds" (
	"computed_at" timestamp with time zone PRIMARY KEY NOT NULL,
	"threshold_usd" numeric NOT NULL,
	"sample_count" integer NOT NULL,
	"window_days" integer DEFAULT 30 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "swaps" (
	"tx_hash" text PRIMARY KEY NOT NULL,
	"block_number" integer NOT NULL,
	"block_timestamp" integer NOT NULL,
	"aggregator" text,
	"direction" text,
	"amount_in_raw" text,
	"amount_out_raw" text,
	"notional_usd" numeric,
	"reference_price" numeric,
	"executed_price" numeric,
	"total_cost_bps" numeric,
	"lp_fee_bps" numeric,
	"agg_fee_bps" numeric,
	"gas_cost_usd" numeric,
	"gas_cost_bps" numeric,
	"execution_quality_bps" numeric,
	"gas_used" bigint,
	"effective_gas_price" text,
	"pool_fee_tier" integer,
	"raw_trace" jsonb,
	"processing_status" text DEFAULT 'pending' NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "swaps_staging" (
	"tx_hash" text PRIMARY KEY NOT NULL,
	"log_index" integer NOT NULL,
	"block_number" integer NOT NULL,
	"block_timestamp" integer NOT NULL,
	"pool_address" text NOT NULL,
	"to_address" text NOT NULL,
	"amount_in_raw" text NOT NULL,
	"amount_out_raw" text NOT NULL,
	"notional_usd_estimate" numeric,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"promoted_tx_hash" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "swaps_aggregator_block_timestamp_idx" ON "swaps" USING btree ("aggregator","block_timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "swaps_direction_notional_idx" ON "swaps" USING btree ("direction","notional_usd");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "swaps_processing_status_idx" ON "swaps" USING btree ("processing_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staging_block_timestamp_idx" ON "swaps_staging" USING btree ("block_timestamp");