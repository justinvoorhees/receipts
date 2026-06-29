ALTER TABLE "router_trades_gated" ADD COLUMN "offchain_price" numeric;--> statement-breakpoint
ALTER TABLE "router_trades_gated" ADD COLUMN "offchain_dev_bps" numeric;--> statement-breakpoint
ALTER TABLE "router_trades_gated" ADD COLUMN "chainlink_staleness_secs" numeric;--> statement-breakpoint
ALTER TABLE "smoke_trades" ADD COLUMN "offchain_price" numeric;--> statement-breakpoint
ALTER TABLE "smoke_trades" ADD COLUMN "offchain_dev_bps" numeric;--> statement-breakpoint
ALTER TABLE "smoke_trades" ADD COLUMN "chainlink_staleness_secs" numeric;
