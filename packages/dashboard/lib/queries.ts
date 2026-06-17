import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { schema } from '@fabric-tca/db';
import { getDb } from './db';

export type SwapRow = typeof schema.swaps.$inferSelect;
export type HeartbeatRow = typeof schema.ingestHeartbeats.$inferSelect;

export async function getHeartbeats(): Promise<HeartbeatRow[]> {
	const db = getDb();
	return db.select().from(schema.ingestHeartbeats);
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
