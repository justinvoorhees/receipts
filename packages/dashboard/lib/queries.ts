import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { schema } from '@fabric-tca/db';
import { getDb } from './db';

export type SwapRow = typeof schema.swaps.$inferSelect;
export type HeartbeatRow = typeof schema.ingestHeartbeats.$inferSelect;

export async function getHeartbeats(): Promise<HeartbeatRow[]> {
	const db = getDb();
	return db.select().from(schema.ingestHeartbeats);
}

export interface AggregatorSummaryRow {
	aggregator: string;
	tradeCount: number;
	avgTotalCostBps: number;
	avgLpFeeBps: number;
	avgAggFeeBps: number;
	avgGasCostBps: number;
	variabilityBps: number;
}

/**
 * Per-aggregator rollup feeding the summary table. STDDEV_POP over
 * executionQualityBps is the variability ± column; the others are simple
 * means of their respective ledger components. Filtered to completed swaps
 * with a non-null aggregator (un-attributed staging promotions are excluded).
 */
export async function getAggregatorSummary(): Promise<AggregatorSummaryRow[]> {
	const db = getDb();
	const rows = await db.execute<{
		aggregator: string;
		trade_count: string;
		avg_total_cost_bps: string | null;
		avg_lp_fee_bps: string | null;
		avg_agg_fee_bps: string | null;
		avg_gas_cost_bps: string | null;
		variability_bps: string | null;
	}>(sql`
		SELECT
			aggregator,
			COUNT(*) AS trade_count,
			AVG(total_cost_bps::numeric) AS avg_total_cost_bps,
			AVG(lp_fee_bps::numeric) AS avg_lp_fee_bps,
			AVG(agg_fee_bps::numeric) AS avg_agg_fee_bps,
			AVG(gas_cost_bps::numeric) AS avg_gas_cost_bps,
			STDDEV_POP(execution_quality_bps::numeric) AS variability_bps
		FROM swaps
		WHERE processing_status = 'complete' AND aggregator IS NOT NULL
		GROUP BY aggregator
		ORDER BY aggregator
	`);
	return rows.map((r) => ({
		aggregator: r.aggregator,
		tradeCount: Number(r.trade_count),
		avgTotalCostBps: Number(r.avg_total_cost_bps ?? 0),
		avgLpFeeBps: Number(r.avg_lp_fee_bps ?? 0),
		avgAggFeeBps: Number(r.avg_agg_fee_bps ?? 0),
		avgGasCostBps: Number(r.avg_gas_cost_bps ?? 0),
		variabilityBps: Number(r.variability_bps ?? 0),
	}));
}

/**
 * Most-recent completed swaps for the trades table. Limit is intentionally
 * generous — the table is the data anchor for the dashboard, so the design
 * favors "see everything" over pagination ergonomics at this stage.
 */
export async function getRecentSwaps(limit = 500): Promise<SwapRow[]> {
	const db = getDb();
	return db
		.select()
		.from(schema.swaps)
		.where(eq(schema.swaps.processingStatus, 'complete'))
		.orderBy(desc(schema.swaps.blockTimestamp))
		.limit(limit);
}

/**
 * (aggregator, executionQualityBps) pairs for every completed swap. Feeds the
 * trust-matrix metric layer. Numeric coercion is done here so callers never
 * see raw string numerics from Postgres.
 */
export async function getResidualsByAggregator(): Promise<
	{ aggregator: string; executionQualityBps: number }[]
> {
	const db = getDb();
	const rows = await db
		.select({
			aggregator: schema.swaps.aggregator,
			executionQualityBps: schema.swaps.executionQualityBps,
		})
		.from(schema.swaps)
		.where(
			and(
				eq(schema.swaps.processingStatus, 'complete'),
				isNotNull(schema.swaps.aggregator),
				isNotNull(schema.swaps.executionQualityBps),
			),
		);
	return rows
		.filter((r): r is { aggregator: string; executionQualityBps: string } =>
			r.aggregator !== null && r.executionQualityBps !== null,
		)
		.map((r) => ({
			aggregator: r.aggregator,
			executionQualityBps: Number(r.executionQualityBps),
		}));
}
