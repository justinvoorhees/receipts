CREATE TABLE IF NOT EXISTS "router_trades" (
	"tx_hash" text PRIMARY KEY NOT NULL,
	"aggregator" text NOT NULL,
	"trader" text NOT NULL,
	"direction" text NOT NULL,
	"settled_in" text NOT NULL,
	"usdc_amount" numeric NOT NULL,
	"weth_amount" numeric NOT NULL,
	"realized_price" numeric NOT NULL,
	"market_mid" numeric NOT NULL,
	"all_in_cost_bps" numeric NOT NULL,
	"block_number" integer NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "router_trades_aggregator_idx" ON "router_trades" USING btree ("aggregator");