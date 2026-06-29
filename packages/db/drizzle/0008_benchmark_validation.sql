ALTER TABLE "router_trades_gated" ADD COLUMN "chainlink_price" numeric;--> statement-breakpoint
ALTER TABLE "router_trades_gated" ADD COLUMN "chainlink_dev_bps" numeric;--> statement-breakpoint
ALTER TABLE "router_trades_gated" ADD COLUMN "pool_divergence_bps" numeric;--> statement-breakpoint
ALTER TABLE "router_trades_gated" ADD COLUMN "manipulation_flag" boolean;
