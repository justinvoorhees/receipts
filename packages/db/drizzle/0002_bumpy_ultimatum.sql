ALTER TABLE "swaps" ADD COLUMN "simulated_amount_out" text;--> statement-breakpoint
ALTER TABLE "swaps" ADD COLUMN "simulated_price" numeric;--> statement-breakpoint
ALTER TABLE "swaps" ADD COLUMN "price_impact_bps" numeric;--> statement-breakpoint
ALTER TABLE "swaps" ADD COLUMN "slippage_bps" numeric;