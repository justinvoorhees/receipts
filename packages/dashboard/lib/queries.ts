import { asc, desc, sql } from 'drizzle-orm';
import { schema } from '@fabric-tca/db';
import { getDb } from './db';

export type SwapRow = typeof schema.swaps.$inferSelect;
export type RouterTradeRow = typeof schema.routerTradesGated.$inferSelect;
export type HeartbeatRow = typeof schema.ingestHeartbeats.$inferSelect;

export async function getHeartbeats(): Promise<HeartbeatRow[]> {
	const db = getDb();
	return db.select().from(schema.ingestHeartbeats);
}

/**
 * Column keys allowed in the `/trades?sort=…` URL param. Each maps to a
 * concrete `router_trades_gated` column; anything else falls back to `block`.
 */
export const TRADES_SORT_COLUMNS = {
	block: schema.routerTradesGated.blockNumber,
	aggregator: schema.routerTradesGated.aggregator,
	side: schema.routerTradesGated.direction,
	size: schema.routerTradesGated.usdcAmount,
	accuracy: schema.routerTradesGated.allInCostBps,
	lpFee: schema.routerTradesGated.lpFeeBps,
	aggFee: schema.routerTradesGated.aggFeeBps,
	slippage: schema.routerTradesGated.slippageBps,
	gas: schema.routerTradesGated.gasCostUsd,
} as const;

export type TradesSortColumn = keyof typeof TRADES_SORT_COLUMNS;
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
 * v2.1 per-aggregator rollup over `router_trades_gated` (gated, decomposed).
 */
export async function getAggregatorSummary(): Promise<AggregatorSummaryRow[]> {
	const db = getDb();
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
		FROM router_trades_gated
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
 * v2.1 trades from `router_trades_gated` (gated, decomposed). Every row
 * is a genuine user-identified USDC↔WETH/ETH aggregator trade with
 * decomposition columns populated.
 */
export async function getRecentTrades(
	sort: TradesSort = { column: 'block', direction: 'desc' },
	limit = 500,
): Promise<RouterTradeRow[]> {
	const db = getDb();
	const column = TRADES_SORT_COLUMNS[sort.column];
	const orderFn = sort.direction === 'asc' ? asc : desc;
	return db
		.select()
		.from(schema.routerTradesGated)
		.orderBy(orderFn(column))
		.limit(limit);
}

/**
 * (aggregator, costBps) samples from `router_trades_gated` — every gated
 * genuine user trade. Feeds the trust-matrix metric layer.
 */
export async function getCostByAggregator(): Promise<
	{ aggregator: string; costBps: number }[]
> {
	const db = getDb();
	const rows = await db
		.select({
			aggregator: schema.routerTradesGated.aggregator,
			allInCostBps: schema.routerTradesGated.allInCostBps,
		})
		.from(schema.routerTradesGated);
	return rows.map((r) => ({
		aggregator: r.aggregator,
		costBps: Number(r.allInCostBps),
	}));
}
