ALTER TABLE "router_trades" ADD COLUMN "gas_used" bigint;--> statement-breakpoint
ALTER TABLE "router_trades" ADD COLUMN "effective_gas_price" text;--> statement-breakpoint
ALTER TABLE "router_trades" ADD COLUMN "gas_cost_usd" numeric;--> statement-breakpoint
ALTER TABLE "router_trades" ADD COLUMN "lp_fee_bps" numeric;--> statement-breakpoint
ALTER TABLE "router_trades" ADD COLUMN "agg_fee_bps" numeric;--> statement-breakpoint
ALTER TABLE "router_trades" ADD COLUMN "slippage_bps" numeric;