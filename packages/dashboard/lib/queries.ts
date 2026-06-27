import { asc, desc, eq, sql } from 'drizzle-orm';
import { schema } from '@fabric-tca/db';
import { getDb } from './db';
import { DEFAULT_DATASET, DATASET_TABLE, DATASET_TABLE_NAME, DATASET_BATCH, type Dataset } from './datasets';

export type SwapRow = typeof schema.swaps.$inferSelect;
export type RouterTradeRow = typeof schema.routerTradesGated.$inferSelect;
export type HeartbeatRow = typeof schema.ingestHeartbeats.$inferSelect;

/** Per-leg shape persisted in smoke_trades.route_legs jsonb. */
export interface RouteLeg {
	venue: string;
	type: string;
	tokenIn: string;
	tokenOut: string;
	feeTierBps: number;
	notionalUsdc: number;
	lpFeeBps: number;
	priceImpactBps: number | null;
}

/**
 * Widened trade row that includes the optional multi-hop decomposition
 * columns present only on smoke datasets. Funnel rows leave these undefined.
 */
export type TradeRow = RouterTradeRow &
	Partial<
		Pick<
			typeof schema.smokeTrades.$inferSelect,
			| 'routeShape'
			| 'hopCount'
			| 'routeLegs'
			| 'reconResidualBps'
			| 'decompConfidence'
			| 'normalizeFlags'
		>
	>;

export async function getHeartbeats(): Promise<HeartbeatRow[]> {
	const db = getDb();
	return db.select().from(schema.ingestHeartbeats);
}

/**
 * Column key map allowed in the `/trades?sort=…` URL param. Each maps to a
 * column name string that exists on both `router_trades_gated` and `smoke_trades`.
 */
export const TRADES_SORT_COLUMN_KEYS = {
	block: 'blockNumber', aggregator: 'aggregator', side: 'direction',
	size: 'usdcAmount', accuracy: 'allInCostBps', lpFee: 'lpFeeBps',
	aggFee: 'aggFeeBps', impact: 'slippageBps', slippage: 'slippageBps', gas: 'gasCostUsd',
} as const;
export type TradesSortColumn = keyof typeof TRADES_SORT_COLUMN_KEYS;
// Keep TRADES_SORT_COLUMNS as an alias for the trades page's VALID_SORT_COLUMNS check:
export const TRADES_SORT_COLUMNS = TRADES_SORT_COLUMN_KEYS;

export type SortDirection = 'asc' | 'desc';
export interface TradesSort {
	column: TradesSortColumn;
	direction: SortDirection;
}

export interface AggregatorSummaryRow {
	aggregator: string;
	tradeCount: number;
	medianCostBps: number;
	stdevCostBps: number;
	medianLpFeeBps: number;
	medianAggFeeBps: number;
	medianSlippageBps: number;
	medianGasUsd: number;
	wethCount: number;
	ethCount: number;
}

/**
 * v2.1 per-aggregator rollup over the selected dataset table (gated, decomposed).
 */
export async function getAggregatorSummary(dataset: Dataset = DEFAULT_DATASET): Promise<AggregatorSummaryRow[]> {
	const db = getDb();
	const table = sql.raw(DATASET_TABLE_NAME[dataset]);
	const batch = DATASET_BATCH[dataset];
	const rows = await db.execute<{
		aggregator: string;
		trade_count: string;
		median_cost_bps: string | null;
		stdev_cost_bps: string | null;
		median_lp_fee_bps: string | null;
		median_agg_fee_bps: string | null;
		median_slippage_bps: string | null;
		median_gas_usd: string | null;
		weth_count: string;
		eth_count: string;
	}>(sql`
		SELECT
			aggregator,
			COUNT(*) AS trade_count,
			percentile_cont(0.5) WITHIN GROUP (ORDER BY all_in_cost_bps::numeric) AS median_cost_bps,
			STDDEV_POP(all_in_cost_bps::numeric) AS stdev_cost_bps,
			percentile_cont(0.5) WITHIN GROUP (ORDER BY lp_fee_bps::numeric) AS median_lp_fee_bps,
			percentile_cont(0.5) WITHIN GROUP (ORDER BY agg_fee_bps::numeric) AS median_agg_fee_bps,
			percentile_cont(0.5) WITHIN GROUP (ORDER BY slippage_bps::numeric) AS median_slippage_bps,
			percentile_cont(0.5) WITHIN GROUP (ORDER BY gas_cost_usd::numeric) AS median_gas_usd,
			SUM((settled_in = 'WETH')::int) AS weth_count,
			SUM((settled_in = 'ETH')::int) AS eth_count
		FROM ${table}
		${batch ? sql`WHERE batch = ${batch}` : sql``}
		GROUP BY aggregator
		ORDER BY trade_count DESC
	`);
	return rows.map((r) => ({
		aggregator: r.aggregator,
		tradeCount: Number(r.trade_count),
		medianCostBps: Number(r.median_cost_bps ?? 0),
		stdevCostBps: Number(r.stdev_cost_bps ?? 0),
		medianLpFeeBps: Number(r.median_lp_fee_bps ?? 0),
		medianAggFeeBps: Number(r.median_agg_fee_bps ?? 0),
		medianSlippageBps: Number(r.median_slippage_bps ?? 0),
		medianGasUsd: Number(r.median_gas_usd ?? 0),
		wethCount: Number(r.weth_count ?? 0),
		ethCount: Number(r.eth_count ?? 0),
	}));
}

/**
 * Trades from the selected dataset table (gated, decomposed). Every row
 * is a genuine user-identified USDC<>WETH/ETH aggregator trade with
 * decomposition columns populated.
 */
export async function getRecentTrades(
	sort: TradesSort = { column: 'block', direction: 'desc' },
	limit = 500,
	dataset: Dataset = DEFAULT_DATASET,
): Promise<TradeRow[]> {
	const db = getDb();
	const table = DATASET_TABLE[dataset];
	const column = (table as typeof schema.routerTradesGated)[TRADES_SORT_COLUMN_KEYS[sort.column]];
	const orderFn = sort.direction === 'asc' ? asc : desc;
	const batch = DATASET_BATCH[dataset];
	const q = db.select().from(table);
	const filtered = batch ? q.where(eq(schema.smokeTrades.batch, batch)) : q;
	return filtered.orderBy(orderFn(column)).limit(limit) as unknown as Promise<TradeRow[]>;
}

/**
 * (aggregator, costBps) samples from the selected dataset — every gated
 * genuine user trade. Feeds the trust-matrix metric layer.
 */
export async function getCostByAggregator(dataset: Dataset = DEFAULT_DATASET): Promise<
	{ aggregator: string; costBps: number }[]
> {
	const db = getDb();
	const table = DATASET_TABLE[dataset];
	const batch = DATASET_BATCH[dataset];
	const q = db.select({ aggregator: table.aggregator, allInCostBps: table.allInCostBps }).from(table);
	const filtered = batch ? q.where(eq(schema.smokeTrades.batch, batch)) : q;
	const rows = await filtered;
	return rows.map((r) => ({
		aggregator: r.aggregator,
		costBps: Number(r.allInCostBps),
	}));
}
