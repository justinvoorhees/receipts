import { pgTable, text, integer, numeric, bigint, jsonb, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * Staging table: every Swap event we observe, regardless of size. Promoted
 * to `swaps` only when notional ≥ current P99 threshold. Keeping the full
 * stream here lets us recompute thresholds and replay attribution without
 * scanning the chain again.
 */
export const swapsStaging = pgTable(
	'swaps_staging',
	{
		txHash: text('tx_hash').primaryKey(),
		logIndex: integer('log_index').notNull(),
		blockNumber: integer('block_number').notNull(),
		blockTimestamp: integer('block_timestamp').notNull(),
		poolAddress: text('pool_address').notNull(),
		toAddress: text('to_address').notNull(),
		amountInRaw: text('amount_in_raw').notNull(),
		amountOutRaw: text('amount_out_raw').notNull(),
		notionalUsdEstimate: numeric('notional_usd_estimate'),
		discoveredAt: timestamp('discovered_at', { withTimezone: true }).defaultNow().notNull(),
		promotedTxHash: text('promoted_tx_hash'),
	},
	(t) => ({
		byBlockTime: index('staging_block_timestamp_idx').on(t.blockTimestamp),
	}),
);

/**
 * Main TCA ledger. One row per qualifying (P99-passing) aggregator-routed
 * USDC/WETH swap, with the five-component cost decomposition resolved.
 */
export const swaps = pgTable(
	'swaps',
	{
		txHash: text('tx_hash').primaryKey(),
		blockNumber: integer('block_number').notNull(),
		blockTimestamp: integer('block_timestamp').notNull(),
		aggregator: text('aggregator'),
		direction: text('direction'),
		amountInRaw: text('amount_in_raw'),
		amountOutRaw: text('amount_out_raw'),
		notionalUsd: numeric('notional_usd'),
		referencePrice: numeric('reference_price'),
		executedPrice: numeric('executed_price'),
		simulatedAmountOut: text('simulated_amount_out'), // QuoterV2 amountOut at block N-1
		simulatedPrice: numeric('simulated_price'), // USDC/WETH derived from simulated amount
		totalCostBps: numeric('total_cost_bps'),
		lpFeeBps: numeric('lp_fee_bps'),
		aggFeeBps: numeric('agg_fee_bps'),
		gasCostUsd: numeric('gas_cost_usd'),
		gasCostBps: numeric('gas_cost_bps'),
		priceImpactBps: numeric('price_impact_bps'), // reference → simulated (pool depth)
		slippageBps: numeric('slippage_bps'), // simulated → executed (MEV/sandwich/ordering)
		executionQualityBps: numeric('execution_quality_bps'),
		gasUsed: bigint('gas_used', { mode: 'bigint' }),
		effectiveGasPrice: text('effective_gas_price'),
		poolFeeTier: integer('pool_fee_tier'),
		rawTrace: jsonb('raw_trace'),
		processingStatus: text('processing_status').notNull().default('pending'),
		processedAt: timestamp('processed_at', { withTimezone: true }),
	},
	(t) => ({
		// Time-series-per-provider queries (dashboard leaderboards, daily trends)
		byAggregatorTime: index('swaps_aggregator_block_timestamp_idx').on(
			t.aggregator,
			t.blockTimestamp,
		),
		// Size-segmented queries (small vs large buckets per direction)
		byDirectionSize: index('swaps_direction_notional_idx').on(t.direction, t.notionalUsd),
		byStatus: index('swaps_processing_status_idx').on(t.processingStatus),
	}),
);

/**
 * P99 threshold history. Recomputed weekly from the staging table. Each row
 * captures the threshold at a point in time; the threshold applies prospectively
 * to discovered swaps from that point forward.
 */
export const p99Thresholds = pgTable('p99_thresholds', {
	computedAt: timestamp('computed_at', { withTimezone: true }).primaryKey(),
	thresholdUsd: numeric('threshold_usd').notNull(),
	sampleCount: integer('sample_count').notNull(),
	windowDays: integer('window_days').notNull().default(30),
});

/**
 * Persistent poller cursor. One row keyed by `id` so we can extend to
 * per-pool cursors later if needed. Today there's a single row ('main')
 * tracking the high-water-mark block across all configured pools.
 */
export const pollState = pgTable('poll_state', {
	id: text('id').primaryKey(),
	lastBlock: integer('last_block').notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Liveness signal per ingest service. Each tick (success or failure)
 * upserts the row keyed by `service`. The dashboard reads this to show
 * staleness — if `last_tick_at` is older than a few minutes, the service
 * is effectively down regardless of what its process state looks like.
 */
export const ingestHeartbeats = pgTable('ingest_heartbeats', {
	service: text('service').primaryKey(), // 'poller' | 'promoter'
	lastTickAt: timestamp('last_tick_at', { withTimezone: true }).notNull(),
	lastBlock: integer('last_block'),
	lastStatus: text('last_status').notNull(), // 'ok' | 'error'
	lastError: text('last_error'),
});

export type SwapsStagingRow = typeof swapsStaging.$inferSelect;
export type SwapRow = typeof swaps.$inferSelect;
export type P99ThresholdRow = typeof p99Thresholds.$inferSelect;
export type PollStateRow = typeof pollState.$inferSelect;
export type IngestHeartbeatRow = typeof ingestHeartbeats.$inferSelect;
