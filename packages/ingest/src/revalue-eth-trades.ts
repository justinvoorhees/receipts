import { readFileSync } from 'fs';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { schema } from '@fabric-tca/db';
import { extractTradeEndpoints } from './tradeEndpoints.js';
import { signedDeviationBps } from './priceMath.js';

/**
 * v2.1 — re-value the ETH-settled trades with the trace-based native-ETH delta
 * (exact), replacing the wrap-net proxy. Re-uses each trade's block + market mid
 * from the harvest CSV (no extra pricing calls). Applies the ±100 bps gate, then
 * upserts into router_trades: recovers trades the proxy mis-valued, refines the
 * rest, leaves the genuinely un-valuable (native=0 AND bad proxy) rejected.
 */

const CSV = '/tmp/router_trades.csv';
const MAX_PLAUSIBLE_BPS = 100;

async function main(): Promise<void> {
	const rpcUrl = process.env.TCA_RPC_URL;
	const dbUrl = process.env.TCA_DATABASE_URL;
	if (!rpcUrl || !dbUrl) throw new Error('TCA_RPC_URL / TCA_DATABASE_URL not set');
	const db = drizzle(postgres(dbUrl));

	const lines = readFileSync(CSV, 'utf8').trim().split(/\r?\n/);
	const h = lines[0]!.split(',');
	const ix = (k: string) => h.indexOf(k);
	const ethRows = lines.slice(1).map((l) => l.split(',')).filter((c) => c[ix('settledIn')] === 'ETH');

	console.log(`Re-valuing ${ethRows.length} ETH trades (trace-based native delta)…\n`);
	let recovered = 0, refined = 0, stillRejected = 0;

	for (const c of ethRows) {
		const txHash = c[ix('txHash')] as `0x${string}`;
		const aggregator = c[ix('aggregator')]!;
		const marketMid = Number(c[ix('marketMid')]);
		const blockNumber = Number(c[ix('block')]);
		const oldCost = Number(c[ix('allInCostBps')]);
		const wasInDb = Math.abs(oldCost) <= 100; // clean CSV (loaded set) used ≤100

		const r = await extractTradeEndpoints({ rpcUrl, txHash });
		if (!r.kept || r.settledIn !== 'ETH') { stillRejected++; continue; }
		const newCost = signedDeviationBps(r.direction!, marketMid, r.realizedPrice!);

		if (Math.abs(newCost) > MAX_PLAUSIBLE_BPS) {
			if (wasInDb) {
				// previously kept on proxy but now correctly flagged bad → remove
				await db.delete(schema.routerTrades).where(eq(schema.routerTrades.txHash, txHash));
			}
			stillRejected++;
			console.log(`  REJECT ${aggregator.padEnd(9)} ${txHash.slice(0, 12)}  old ${oldCost.toFixed(1)} → new ${newCost.toFixed(1)} bps (unfixable)`);
			continue;
		}

		const row = {
			txHash, aggregator, trader: r.trader!, direction: r.direction!, settledIn: 'ETH',
			usdcAmount: (Math.abs(Number(r.usdcAmountRaw)) / 1e6).toFixed(2),
			wethAmount: (Math.abs(Number(r.wethAmountRaw)) / 1e18).toFixed(8),
			realizedPrice: r.realizedPrice!.toFixed(4),
			marketMid: marketMid.toFixed(4),
			allInCostBps: newCost.toFixed(4),
			blockNumber,
		};
		await db.insert(schema.routerTrades).values(row).onConflictDoUpdate({
			target: schema.routerTrades.txHash,
			set: { usdcAmount: row.usdcAmount, wethAmount: row.wethAmount, realizedPrice: row.realizedPrice, allInCostBps: row.allInCostBps, trader: row.trader, direction: row.direction },
		});

		if (!wasInDb) { recovered++; console.log(`  RECOVER ${aggregator.padEnd(9)} ${txHash.slice(0, 12)}  old ${oldCost.toFixed(1)} → new ${newCost.toFixed(1)} bps`); }
		else refined++;
	}

	console.log(`\nrecovered ${recovered}, refined ${refined}, still rejected ${stillRejected}`);
	const tot = await db.execute<{ n: string; eth: string }>(
		sql`SELECT COUNT(*) n, SUM((settled_in='ETH')::int) eth FROM router_trades`,
	);
	console.log(`router_trades now: ${tot[0]!.n} rows (ETH ${tot[0]!.eth})`);
	process.exit(0);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
