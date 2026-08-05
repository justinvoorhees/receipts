/**
 * snapshotReceipts.mjs — dump every column of every receipt to JSON.
 *
 *   node scripts/snapshotReceipts.mjs /tmp/arm0-backup.json
 *   node scripts/snapshotReceipts.mjs --diff /tmp/arm1.json /tmp/arm2.json
 *
 * Read-only, no RPC. This is the corpus BACKUP and the restore path if a
 * repopulation --commit goes wrong.
 *
 * --diff compares two snapshots on EVERY column, not the repopulator's 10-column
 * WATCH list. It classifies each row as CHANGED / ONLY-IN-A / ONLY-IN-B, and
 * reports per-column change counts so an expected column (market_mid_before)
 * is distinguishable from an unexpected one (all_in_cost_bps).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createDb, schema } from '@fabric-tca/db';
import { asc } from 'drizzle-orm';

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
for (const line of env.split('\n')) {
	const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/);
	if (m) process.env[m[1]] = m[2];
}

const args = process.argv.slice(2);

if (args[0] === '--diff') {
	const [, aPath, bPath] = args;
	if (!aPath || !bPath) { console.error('usage: --diff <a.json> <b.json>'); process.exit(1); }
	const a = new Map(JSON.parse(readFileSync(aPath, 'utf8')).map((r) => [r.id, r]));
	const b = new Map(JSON.parse(readFileSync(bPath, 'utf8')).map((r) => [r.id, r]));

	const columnHits = new Map();
	let changed = 0;
	for (const [id, rowA] of a) {
		const rowB = b.get(id);
		// A row present in A but absent from B is a FINDING, not silence: the
		// repopulator skips rows whose re-analysis returns null, so a receipt
		// that stops resolving would otherwise vanish without a diff line.
		if (!rowB) { console.log(`id ${id}  ⚠ ONLY-IN-A (dropped or skipped)`); changed++; continue; }
		const cols = [...new Set([...Object.keys(rowA), ...Object.keys(rowB)])]
			.filter((k) => JSON.stringify(rowA[k]) !== JSON.stringify(rowB[k]));
		if (!cols.length) continue;
		changed++;
		for (const c of cols) columnHits.set(c, (columnHits.get(c) ?? 0) + 1);
		console.log(`id ${String(id).padStart(3)}  Δ ${cols.join(' ')}`);
	}
	for (const id of b.keys()) if (!a.has(id)) console.log(`id ${id}  ⚠ ONLY-IN-B (new row)`);

	console.log(`\nrows changed: ${changed} / ${a.size}`);
	console.log('per-column:');
	for (const [c, n] of [...columnHits].sort((x, y) => y[1] - x[1])) console.log(`  ${String(n).padStart(4)}  ${c}`);
	process.exit(0);
}

const out = args[0];
if (!out) { console.error('usage: snapshotReceipts.mjs <out.json> | --diff <a> <b>'); process.exit(1); }
const db = createDb(process.env.TCA_DATABASE_URL);
const rows = await db.select().from(schema.receipts).orderBy(asc(schema.receipts.id));
writeFileSync(out, JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 2));
console.log(`wrote ${rows.length} receipts to ${out}`);
process.exit(0);
