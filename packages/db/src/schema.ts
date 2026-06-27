import { boolean, pgTable, text, integer, numeric, bigint, jsonb, timestamp, index } from 'drizzle-orm/pg-core';

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
 * v2.0 cost model (trade-centric, router-centric). One row per genuine USDC↔WETH
 * or USDC↔ETH aggregator trade ≥ the notional floor, discovered by scanning
 * aggregator routers (not pools). `all_in_cost_bps` = realized price vs market mid
 * at block N-1 — the top-line cost the v2.1 decomposition must sum to.
 * Distinct from the v1 `swaps` table (pool-centric, superseded).
 */
export const routerTrades = pgTable(
	'router_trades',
	{
		txHash: text('tx_hash').primaryKey(),
		aggregator: text('aggregator').notNull(),
		trader: text('trader').notNull(),
		direction: text('direction').notNull(), // 'buy_weth' | 'sell_weth'
		settledIn: text('settled_in').notNull(), // 'WETH' (exact) | 'ETH' (wrap-net proxy)
		usdcAmount: numeric('usdc_amount').notNull(), // trader's net USDC leg
		wethAmount: numeric('weth_amount').notNull(), // trader's net WETH-equivalent leg
		realizedPrice: numeric('realized_price').notNull(), // USDC per WETH, trader's rate
		marketMid: numeric('market_mid').notNull(), // deepest pool slot0 mid @ N-1
		allInCostBps: numeric('all_in_cost_bps').notNull(),
		blockNumber: integer('block_number').notNull(),
		// v2.1 decomposition (nullable — enriched after initial load)
		gasUsed: bigint('gas_used', { mode: 'bigint' }),
		effectiveGasPrice: text('effective_gas_price'), // wei
		gasCostUsd: numeric('gas_cost_usd'),
		lpFeeBps: numeric('lp_fee_bps'),
		aggFeeBps: numeric('agg_fee_bps'),
		slippageBps: numeric('slippage_bps'),
		loadedAt: timestamp('loaded_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => ({
		byAggregator: index('router_trades_aggregator_idx').on(t.aggregator),
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

/**
 * v2.1 gated dataset. Subset of router_trades that passed the §C selection gate
 * (genuine user trades, re-anchored where needed). Enriched with the §B
 * decomposition: LP fee, agg fee, slippage (pure routes) or execution (impure),
 * plus gas in USD. The original router_trades table is untouched.
 */
export const routerTradesGated = pgTable(
	'router_trades_gated',
	{
		txHash: text('tx_hash').primaryKey(),
		aggregator: text('aggregator').notNull(),
		trader: text('trader').notNull(),
		originalTrader: text('original_trader').notNull(),
		reAnchored: boolean('re_anchored').notNull(),
		direction: text('direction').notNull(),
		settledIn: text('settled_in').notNull(),
		usdcAmount: numeric('usdc_amount').notNull(),
		wethAmount: numeric('weth_amount').notNull(),
		realizedPrice: numeric('realized_price').notNull(),
		marketMid: numeric('market_mid').notNull(),
		allInCostBps: numeric('all_in_cost_bps').notNull(),
		blockNumber: integer('block_number').notNull(),
		gateReason: text('gate_reason').notNull(),
		loadedAt: timestamp('loaded_at', { withTimezone: true }).defaultNow().notNull(),
		// v2.1 decomposition columns
		lpFeeBps: numeric('lp_fee_bps'),
		aggFeeBps: numeric('agg_fee_bps'),
		slippageBps: numeric('slippage_bps'),
		executionBps: numeric('execution_bps'),
		gasCostUsd: numeric('gas_cost_usd'),
		routePure: boolean('route_pure'),
		// v2.2 benchmark validation (nullable — backfilled)
		chainlinkPrice: numeric('chainlink_price'),
		chainlinkDevBps: numeric('chainlink_dev_bps'),
		poolDivergenceBps: numeric('pool_divergence_bps'),
		manipulationFlag: boolean('manipulation_flag'),
	},
);

/**
 * Smoke-test validation set (ETL orientation). One row per controlled v1
 * "Aggregator Benchmark" swap, re-normalized into the v2 cost framework.
 * Mirrors router_trades_gated's cost columns so the dashboard reads it the
 * same way; adds v1 ground-truth + settlement-signature provenance.
 * Bypasses the notional floor and ±100bps gate by design.
 */
export const smokeTrades = pgTable('smoke_trades', {
	txHash: text('tx_hash').primaryKey(),
	aggregator: text('aggregator').notNull(),
	trader: text('trader').notNull(),
	direction: text('direction').notNull(),
	settledIn: text('settled_in').notNull(),
	usdcAmount: numeric('usdc_amount').notNull(),
	wethAmount: numeric('weth_amount').notNull(),
	realizedPrice: numeric('realized_price').notNull(),
	marketMid: numeric('market_mid').notNull(),
	allInCostBps: numeric('all_in_cost_bps').notNull(),
	blockNumber: integer('block_number').notNull(),
	// v2.1 decomposition (same columns as router_trades_gated)
	lpFeeBps: numeric('lp_fee_bps'),
	aggFeeBps: numeric('agg_fee_bps'),
	slippageBps: numeric('slippage_bps'),
	executionBps: numeric('execution_bps'),
	gasCostUsd: numeric('gas_cost_usd'),
	routePure: boolean('route_pure'),
	routeShape: text('route_shape'),
	hopCount: integer('hop_count'),
	routeLegs: jsonb('route_legs'),
	reconResidualBps: numeric('recon_residual_bps'),
	decompConfidence: text('decomp_confidence'),
	batch: text('batch').notNull().default('smoke-01'),
	// provenance / ground-truth from v1
	experimentSlug: text('experiment_slug').notNull(),
	runId: text('run_id').notNull(),
	v1Status: text('v1_status').notNull(),
	v1QuoteAmountUsd: numeric('v1_quote_amount_usd'),
	v1RealizedAmountUsd: numeric('v1_realized_amount_usd'),
	// settlement-signature provenance
	settlementEventName: text('settlement_event_name'),
	settlementEventTopic0: text('settlement_event_topic0'),
	settlementEventSeen: boolean('settlement_event_seen').notNull().default(false),
	normalizeFlags: jsonb('normalize_flags'),
	// v2.2 benchmark validation (nullable)
	chainlinkPrice: numeric('chainlink_price'),
	chainlinkDevBps: numeric('chainlink_dev_bps'),
	poolDivergenceBps: numeric('pool_divergence_bps'),
	manipulationFlag: boolean('manipulation_flag'),
	loadedAt: timestamp('loaded_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
	byAggregator: index('smoke_trades_aggregator_idx').on(t.aggregator),
}));

export type SwapsStagingRow = typeof swapsStaging.$inferSelect;
export type SwapRow = typeof swaps.$inferSelect;
export type RouterTradeRow = typeof routerTrades.$inferSelect;
export type RouterTradeGatedRow = typeof routerTradesGated.$inferSelect;
export type P99ThresholdRow = typeof p99Thresholds.$inferSelect;
export type PollStateRow = typeof pollState.$inferSelect;
export type IngestHeartbeatRow = typeof ingestHeartbeats.$inferSelect;
export type SmokeTradeRow = typeof smokeTrades.$inferSelect;
