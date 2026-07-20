ALTER TABLE "receipts" ADD COLUMN "tier" text;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "methodology" text;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "market_price_flags" jsonb;