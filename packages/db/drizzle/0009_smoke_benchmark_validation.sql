ALTER TABLE "smoke_trades" ADD COLUMN "chainlink_price" numeric;--> statement-breakpoint
ALTER TABLE "smoke_trades" ADD COLUMN "chainlink_dev_bps" numeric;--> statement-breakpoint
ALTER TABLE "smoke_trades" ADD COLUMN "pool_divergence_bps" numeric;--> statement-breakpoint
ALTER TABLE "smoke_trades" ADD COLUMN "manipulation_flag" boolean;
