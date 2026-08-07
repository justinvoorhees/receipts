import { sql } from 'drizzle-orm';
import { schema } from '@fabric-tca/db';
import { getDb } from './db';

// ─── Receipts data layer ─────────────────────────────────────────────────────
// CRUD over the `receipts` table (Task 1 schema, Task 2 seed). Consumed by the
// API route (Task 9), Receipts page (Task 10), and History page (Task 11).

export type ReceiptRow = typeof schema.receipts.$inferSelect;
export type NewReceipt = typeof schema.receipts.$inferInsert;

/** Looks up a receipt by transaction hash, case-insensitively. Returns null if not found. */
export async function getReceiptByHash(hash: string): Promise<ReceiptRow | null> {
	const db = getDb();
	const rows = await db
		.select()
		.from(schema.receipts)
		.where(sql`lower(${schema.receipts.txHash}) = lower(${hash})`)
		.limit(1);
	return rows[0] ?? null;
}

/** Inserts a new receipt row and returns it. Idempotency is handled by the caller (API route). */
export async function insertReceipt(r: NewReceipt): Promise<ReceiptRow> {
	const db = getDb();
	const rows = await db.insert(schema.receipts).values(r).returning();
	const row = rows[0];
	if (!row) throw new Error('insertReceipt: insert returned no row');
	return row;
}
