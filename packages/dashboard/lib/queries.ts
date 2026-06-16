import { desc, eq } from 'drizzle-orm';
import { schema } from '@fabric-tca/db';
import { getDb } from './db';

export type SwapRow = typeof schema.swaps.$inferSelect;

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
