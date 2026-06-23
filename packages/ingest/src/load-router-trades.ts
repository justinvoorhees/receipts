import { readFileSync } from 'fs';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { schema } from '@fabric-tca/db';

/**
 * Loads the v2.0 clean dataset (router-centric harvest, post sanity-gate) into the
 * `router_trades` table. Idempotent on tx_hash. Input is the CSV emitted by
 * extract-router-trades.ts, filtered to |allInCostBps| ≤ 100.
 */

const IN_PATH = process.env.IN_PATH ?? '/tmp/router_trades_clean.csv';

async function main(): Promise<void> {
	const dbUrl = process.env.TCA_DATABASE_URL;
	if (!dbUrl) throw new Error('TCA_DATABASE_URL not set');
	const client = postgres(dbUrl);
	const db = drizzle(client);

	// Tolerate CRLF (the clean CSV was written by Python's csv.writer → \r\n).
	const lines = readFileSync(IN_PATH, 'utf8').trim().split(/\r?\n/);
	const header = lines[0]!.split(',');
	const idx = (k: string) => header.indexOf(k);
	const rows = lines.slice(1).map((line) => {
		const c = line.split(',');
		return {
			txHash: c[idx('txHash')]!,
			aggregator: c[idx('aggregator')]!,
			trader: c[idx('trader')]!,
			direction: c[idx('direction')]!,
			settledIn: c[idx('settledIn')]!,
			usdcAmount: c[idx('usdcAmount')]!,
			wethAmount: c[idx('wethAmount')]!,
			realizedPrice: c[idx('realizedPrice')]!,
			marketMid: c[idx('marketMid')]!,
			allInCostBps: c[idx('allInCostBps')]!,
			blockNumber: Number(c[idx('block')]),
		};
	});

	console.log(`Loading ${rows.length} trades from ${IN_PATH}…`);
	// Insert in chunks; idempotent on the tx_hash primary key.
	const CHUNK = 200;
	let inserted = 0;
	for (let i = 0; i < rows.length; i += CHUNK) {
		const batch = rows.slice(i, i + CHUNK);
		const res = await db.insert(schema.routerTrades).values(batch).onConflictDoNothing();
		inserted += res.count ?? 0;
	}
	console.log(`Done. Inserted ${inserted} new rows (existing tx_hashes skipped).`);

	const total = await db.execute<{ count: string }>(sql`SELECT COUNT(*) AS count FROM router_trades`);
	console.log(`router_trades now holds ${total[0]!.count} rows.`);
	await client.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
