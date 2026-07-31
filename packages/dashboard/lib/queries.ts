import { desc, eq, sql } from 'drizzle-orm';
import { schema } from '@fabric-tca/db';
import { getDb } from './db';
import { resolveAggregator, resolveLegRouter, type ResolvedLegRouter } from '@fabric-tca/core';

// ─── Receipts data layer ─────────────────────────────────────────────────────
// CRUD over the `receipts` table (Task 1 schema, Task 2 seed). Consumed by the
// API route (Task 9), Receipts page (Task 10), and History page (Task 11).

export type ReceiptRow = typeof schema.receipts.$inferSelect;
export type NewReceipt = typeof schema.receipts.$inferInsert;

/** All receipts, most recently created first. */
export async function listReceipts(): Promise<ReceiptRow[]> {
	const db = getDb();
	const rows = await db.select().from(schema.receipts).orderBy(desc(schema.receipts.createdAt));
	return rows.map(enrichLegRouters);
}

/** Looks up a receipt by transaction hash, case-insensitively. Returns null if not found. */
export async function getReceiptByHash(hash: string): Promise<ReceiptRow | null> {
	const db = getDb();
	const rows = await db
		.select()
		.from(schema.receipts)
		.where(sql`lower(${schema.receipts.txHash}) = lower(${hash})`)
		.limit(1);
	return rows[0] ? enrichLegRouters(rows[0]) : null;
}

/** Inserts a new receipt row and returns it. Idempotency is handled by the caller (API route). */
export async function insertReceipt(r: NewReceipt): Promise<ReceiptRow> {
	const db = getDb();
	const rows = await db.insert(schema.receipts).values(r).returning();
	const row = rows[0];
	if (!row) throw new Error('insertReceipt: insert returned no row');
	return row;
}

/** Deletes a receipt by its numeric id. */
export async function deleteReceipt(id: number): Promise<void> {
	const db = getDb();
	await db.delete(schema.receipts).where(eq(schema.receipts.id, id));
}

/** Per-leg shape persisted in receipts.route_legs jsonb. */
export interface RouteLeg {
	venue: string;
	type: string;
	tokenIn: string;
	tokenOut: string;
	feeTierBps: number;
	notionalUsdc: number;
	lpFeeBps: number | null;
	priceImpactBps: number | null;
	// Display symbols resolved + stored by core (analyzeTransaction). Optional:
	// absent on rows persisted before this was added, and on a leg token whose
	// on-chain symbol() read failed — both fall back to address-based resolution.
	tokenInSymbol?: string;
	tokenOutSymbol?: string;
	// Enclosing CALL frame addresses (outermost→innermost) for this leg's venue,
	// captured by core from the trace. Raw addresses — names are resolved on read
	// by resolveLegRouter so registry growth applies retroactively. Absent on
	// rows persisted before 2026-07-27 and on legs whose chain was ambiguous.
	frameChain?: string[];
	// False when core could not READ this pool's fee tier (the reader fell back
	// to 0). Omitted when the tier resolved, and absent on rows persisted before
	// 2026-07-30 — so only an explicit `false` suppresses the fee cell. Without
	// it a 0 bps fee would render as a confident "0.00bps", asserting the pool
	// was free rather than admitting we could not read it.
	feeResolved?: boolean;
	// The V4 singleton that emitted this leg's Swap. Present only on synthesized
	// per-pool legs, whose `venue` is `v4:<poolId>` rather than an address — link
	// to this, not to `venue`, or the Basescan URL is dead. Absent on rows
	// persisted before 2026-07-30 and on every non-V4 leg.
	v4Emitter?: string;
	// Resolved from `frameChain` on read (never persisted) — see
	// enrichLegRouters. Present only when another curated aggregator executed
	// this leg.
	router?: ResolvedLegRouter;
}

/**
 * Resolve each leg's persisted `frameChain` into a named router, on read.
 *
 * Deliberately not persisted: doing it here means adding an address to
 * configs/routers.json retroactively attributes every historical receipt,
 * with no repopulation. Runs server-side only — resolveLegRouter reads the
 * registries from disk and must never cross into a client bundle.
 *
 * Exported for tests; every query below applies it.
 */
export function enrichLegRouters(row: ReceiptRow): ReceiptRow {
	if (!Array.isArray(row.routeLegs)) return row;
	// Must resolve through the SAME registry snapshot that resolveLegRouter
	// uses for the leg side, not the label `row.aggregator` froze at analysis
	// time. Those two can diverge: an uncurated top-level address is persisted
	// as its raw lowercase string, but a later routers.json addition (or a
	// rename) changes what resolveAggregator returns for that same address
	// today. If the top line here stayed the stale label, the comparison in
	// resolveLegRouter would stop matching and a leg run by the SAME contract
	// as the top line would get wrongly tagged as a second aggregator the
	// moment the registry grows — turning a correct `null` into a false
	// attribution. Re-deriving from `routerAddress` (tx.to, persisted
	// separately and never relabeled) keeps both sides on today's registry.
	const topLevelSlug = row.routerAddress
		? resolveAggregator(row.routerAddress, []).slug
		: String(row.aggregator ?? '').toLowerCase();
	const legs = (row.routeLegs as RouteLeg[]).map((leg) => {
		const router = resolveLegRouter(leg.frameChain, topLevelSlug);
		return router ? { ...leg, router } : leg;
	});
	return { ...row, routeLegs: legs };
}

/**
 * Column key map allowed in the `/trades?sort=…` URL param. Each maps to a
 * sortable field on `ReceiptRow` (see TradesTable ACCESSORS).
 */
export const TRADES_SORT_COLUMN_KEYS = {
	block: 'blockNumber', aggregator: 'aggregator', id: 'id', side: 'direction',
	size: 'notionalUsd', accuracy: 'allInCostBps', lpFee: 'lpFeeBps',
	aggFee: 'aggFeeBps', impact: 'slippageBps', slippage: 'slippageBps',
	posSlippage: 'slippageBps', unattributed: 'slippageBps', gas: 'gasCostUsd',
} as const;
export type TradesSortColumn = keyof typeof TRADES_SORT_COLUMN_KEYS;
// Keep TRADES_SORT_COLUMNS as an alias for the trades page's VALID_SORT_COLUMNS check:
export const TRADES_SORT_COLUMNS = TRADES_SORT_COLUMN_KEYS;

export type SortDirection = 'asc' | 'desc';
export interface TradesSort {
	column: TradesSortColumn;
	direction: SortDirection;
}
