/**
 * prune-stale-flags.ts — Cross-validates normalize_flags against stored row
 * data and removes any flag whose triggering condition is contradicted by the
 * current columns/route_legs. Writes updated flags back to the database.
 *
 * Validations performed:
 *   PI_IMPLAUSIBLE: leg <prefix> pi=…  → stale if that leg's priceImpactBps is NOT null
 *   MID_NULL: leg <prefix> …           → stale if that leg's priceImpactBps is NOT null
 *   LEG_FEE_IMPLAUSIBLE: leg <prefix>  → stale if that leg's lpFeeBps ≤ LEG_FEE_CAP_BPS
 *   SETTLEMENT_EVENT_MISSING: …        → stale if settlement_event_seen = true
 *   ROUTE_NOT_DECOMPOSED: …            → stale if lp_fee_bps is NOT null
 *
 * Flags that cannot be validated from stored data alone (AERO_FEE_DEFAULTED,
 * AMOUNT_IN_ZERO, NO_SIGNATURE) are left untouched.
 *
 * Run: set -a && source .env && set +a && npx tsx packages/ingest/src/prune-stale-flags.ts
 */
import postgres from 'postgres';

const LEG_FEE_CAP_BPS = 300;

interface RouteLeg {
	venue: string;
	lpFeeBps?: number | null;
	priceImpactBps?: number | null;
}

function legByPrefix(legs: RouteLeg[], prefix: string): RouteLeg | undefined {
	return legs.find((l) => l.venue.startsWith(prefix));
}

/** Extract the venue prefix (first 10 chars) from flags like "PI_IMPLAUSIBLE: leg 0xabcdef1234 …" */
function extractLegPrefix(flag: string): string | null {
	const m = flag.match(/leg (0x[0-9a-fA-F]+)/);
	return m ? (m[1] ?? null) : null;
}

interface FlagRow {
	lp_fee_bps: unknown;
	settlement_event_seen: unknown;
	route_legs: unknown;
}

function isStale(flag: string, row: FlagRow): boolean {
	const legs: RouteLeg[] = row.route_legs == null
		? []
		: (typeof row.route_legs === 'string' ? JSON.parse(row.route_legs) : row.route_legs) as RouteLeg[];

	if (flag.startsWith('PI_IMPLAUSIBLE:') || flag.startsWith('MID_NULL:')) {
		const prefix = extractLegPrefix(flag);
		if (!prefix) return false;
		const leg = legByPrefix(legs, prefix);
		// Flag says this leg has no valid impact — stale if the leg now has a non-null value
		return leg != null && leg.priceImpactBps != null;
	}

	if (flag.startsWith('LEG_FEE_IMPLAUSIBLE:')) {
		const prefix = extractLegPrefix(flag);
		if (!prefix) return false;
		const leg = legByPrefix(legs, prefix);
		// Flag says fee was implausibly high — stale if it's now within cap
		return leg != null && leg.lpFeeBps != null && leg.lpFeeBps <= LEG_FEE_CAP_BPS;
	}

	if (flag.startsWith('SETTLEMENT_EVENT_MISSING:')) {
		// Stale if the event is now seen
		return row.settlement_event_seen === true;
	}

	if (flag.startsWith('ROUTE_NOT_DECOMPOSED:')) {
		// Stale if decomposition succeeded (lp_fee_bps is populated)
		return row.lp_fee_bps != null;
	}

	return false;
}

async function main(): Promise<void> {
	const dbUrl = process.env.TCA_DATABASE_URL;
	if (!dbUrl) throw new Error('TCA_DATABASE_URL not set');
	const sql = postgres(dbUrl);

	const rows = await sql`
		SELECT tx_hash, aggregator, batch,
		       lp_fee_bps, settlement_event_seen, route_legs,
		       normalize_flags
		FROM smoke_trades
		WHERE normalize_flags IS NOT NULL
		  AND jsonb_array_length(normalize_flags) > 0
		ORDER BY batch, aggregator
	`;

	console.log(`Checking ${rows.length} rows with flags…\n`);

	let totalRemoved = 0;
	let rowsUpdated = 0;

	for (const row of rows) {
		const flags = (Array.isArray(row.normalize_flags) ? row.normalize_flags : []) as string[];
		const pruned = flags.filter((f) => !isStale(f, row as unknown as FlagRow));
		const removed = flags.filter((f) => isStale(f, row as unknown as FlagRow));

		if (removed.length === 0) continue;

		const txShort = (row.tx_hash as string).slice(0, 12);
		console.log(`  ${row.batch} ${String(row.aggregator).padEnd(11)} ${txShort}`);
		for (const f of removed) console.log(`    - REMOVED: ${f}`);
		for (const f of pruned)   console.log(`    ✓ kept:    ${f}`);

		await sql`
			UPDATE smoke_trades
			SET normalize_flags = ${JSON.stringify(pruned)}
			WHERE tx_hash = ${row.tx_hash as string}
		`;

		totalRemoved += removed.length;
		rowsUpdated++;
	}

	console.log(`\nDone. ${totalRemoved} stale flag(s) removed across ${rowsUpdated} row(s).`);
	await sql.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
