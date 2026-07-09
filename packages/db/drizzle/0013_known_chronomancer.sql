ALTER TABLE "receipts" ADD COLUMN "fee_recipient" text;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "fee_sink_source" text;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "integrator_fee_bps" numeric;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "fabric_fee_bps" numeric;