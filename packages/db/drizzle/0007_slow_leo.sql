ALTER TABLE "smoke_trades" ADD COLUMN "route_shape" text;--> statement-breakpoint
ALTER TABLE "smoke_trades" ADD COLUMN "hop_count" integer;--> statement-breakpoint
ALTER TABLE "smoke_trades" ADD COLUMN "route_legs" jsonb;--> statement-breakpoint
ALTER TABLE "smoke_trades" ADD COLUMN "recon_residual_bps" numeric;--> statement-breakpoint
ALTER TABLE "smoke_trades" ADD COLUMN "decomp_confidence" text;