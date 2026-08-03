DROP INDEX IF EXISTS "receipts_user_tx_chain_idx";--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_user_tx_chain_uq" UNIQUE NULLS NOT DISTINCT("user_id","tx_hash","chain_id");