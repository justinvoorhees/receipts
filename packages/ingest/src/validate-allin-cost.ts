/**
 * v2.0 Validation Gate — All-in cost validation.
 *
 * Runs the trade-endpoint extractor + market pricing over:
 *   (a) all qualifying swaps from the DB (aggregator IS NOT NULL,
 *       notional_usd >= 10000, processing_status = 'complete')
 *   (b) the 5 orientation tx hashes from orient-transfers.ts
 *
 * For each tx prints: txHash (short), aggregator, kept/dropped (+reason),
 * trader (short), direction, true USDC amount, true WETH amount,
 * realizedPrice, marketMid, allInCostBps.
 *
 * Then prints a SUMMARY of how many are kept vs dropped by reason.
 *
 * NO DB writes — read-only gate. Human reviews before any schema/dashboard work.
 *
 * Usage:
 *   TCA_RPC_URL=$(grep TCA_RPC_URL .env | cut -d= -f2) \
 *   TCA_DATABASE_URL=$(grep TCA_DATABASE_URL .env | cut -d= -f2) \
 *   npx tsx packages/ingest/src/validate-allin-cost.ts
 */

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

import { extractTradeEndpoints, type TradeEndpointResult } from './tradeEndpoints.js';
import { getReferencePrice } from './referencePrice.js';
import { signedDeviationBps } from './priceMath.js';

// ─── Config ───

const rpcUrl = process.env.TCA_RPC_URL!;
const dbUrl = process.env.TCA_DATABASE_URL!;

if (!rpcUrl) throw new Error('TCA_RPC_URL not set');
if (!dbUrl) throw new Error('TCA_DATABASE_URL not set');

// Deepest USDC/WETH pool (5bps) — market mid reference
const MARKET_POOL = '0xd0b53D9277642d899DF5C87A3966A349A798F224' as `0x${string}`;

// Orientation sample tx hashes from orient-transfers.ts
const ORIENTATION_HASHES: `0x${string}`[] = [
	'0x007a5e1233a1bce6bd41fc572619543c7503dc04b796d58bd9733f68ffcc2a3a',
	'0x5064017d39b4864d04c6cd92652444a262b5b0cca6622145eb816ce6029c51c8',
	'0xb4dee6d46bd9de6b2a78212e725c88ce8d9de76f853c9e2506da9909e9714fa8',
	'0xa5835f381792e3e561697247c63f0b6a1a5f4a6be546fdcc389814d45ec196b5',
	'0xbcaa790ee099f6f327a33438fec1020c84485733b04d2a5be421be66ca62671f',
];

// ─── Helpers ───

const short = (s: string | null) => {
	if (!s) return 'null';
	return s.slice(0, 10) + '...' + s.slice(-4);
};

const pad = (s: string, w: number) => s.padEnd(w);
const rpad = (s: string, w: number) => s.padStart(w);

// ─── Main ───

interface CandidateTx {
	txHash: `0x${string}`;
	aggregator: string | null;
	blockNumber: number;
	notionalUsd: number;
	source: 'db' | 'orientation';
}

(async () => {
	console.log('=== v2.0 All-In Cost Validation Gate ===\n');

	// ─── Fetch candidate txs from DB ───
	const client = postgres(dbUrl, { prepare: false });
	const db = drizzle(client);

	const dbRows = await db.execute<{
		tx_hash: string;
		aggregator: string | null;
		block_number: number;
		notional_usd: string | null;
	}>(sql`
		SELECT tx_hash, aggregator, block_number, notional_usd
		FROM swaps
		WHERE aggregator IS NOT NULL
		  AND CAST(notional_usd AS NUMERIC) >= 10000
		  AND processing_status = 'complete'
		ORDER BY block_number ASC
	`);

	console.log(`DB candidates: ${dbRows.length} qualifying swaps\n`);

	const candidates: CandidateTx[] = [];

	// Add DB rows
	for (const row of dbRows) {
		candidates.push({
			txHash: row.tx_hash as `0x${string}`,
			aggregator: row.aggregator,
			blockNumber: row.block_number,
			notionalUsd: Number(row.notional_usd ?? 0),
			source: 'db',
		});
	}

	// Add orientation samples (need to fetch block numbers)
	const viemClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
	for (const hash of ORIENTATION_HASHES) {
		// Skip if already in DB set
		if (candidates.some((c) => c.txHash.toLowerCase() === hash.toLowerCase())) continue;
		try {
			const receipt = await viemClient.getTransactionReceipt({ hash });
			candidates.push({
				txHash: hash,
				aggregator: '(orientation)',
				blockNumber: Number(receipt.blockNumber),
				notionalUsd: 0,
				source: 'orientation',
			});
		} catch (e) {
			console.error(`Failed to fetch receipt for orientation tx ${short(hash)}: ${e}`);
		}
	}

	console.log(`Total candidates: ${candidates.length} (${dbRows.length} DB + ${candidates.length - dbRows.length} orientation)\n`);

	// ─── Process each tx ───

	interface ResultRow {
		txHash: string;
		aggregator: string | null;
		source: 'db' | 'orientation';
		kept: boolean;
		dropReason: string | null;
		thirdTokenSeen: boolean;
		trader: string | null;
		direction: string | null;
		usdcAmount: number | null;
		wethAmount: number | null;
		realizedPrice: number | null;
		marketMid: number | null;
		allInCostBps: number | null;
		transferCount: number;
		error: string | null;
	}

	const results: ResultRow[] = [];
	let processed = 0;

	for (const c of candidates) {
		processed++;
		const progress = `[${processed}/${candidates.length}]`;

		try {
			// Step 1: Extract trade endpoints
			const ep = await extractTradeEndpoints({ rpcUrl, txHash: c.txHash });

			// Step 2: Get market mid (reference price at block N-1)
			let marketMid: number | null = null;
			let allInCostBps: number | null = null;

			if (ep.kept && ep.realizedPrice !== null && ep.direction !== null) {
				try {
					marketMid = await getReferencePrice({
						rpcUrl,
						poolAddress: MARKET_POOL,
						blockNumber: BigInt(c.blockNumber),
					});
					allInCostBps = signedDeviationBps(
						ep.direction,
						marketMid,
						ep.realizedPrice,
					);
				} catch (e) {
					console.error(`${progress} ${short(c.txHash)}: market mid fetch failed: ${e}`);
				}
			}

			const usdcAmount = ep.usdcAmountRaw !== null
				? Number(ep.usdcAmountRaw) / 1e6
				: null;
			const wethAmount = ep.wethAmountRaw !== null
				? Number(ep.wethAmountRaw) / 1e18
				: null;

			results.push({
				txHash: c.txHash,
				aggregator: c.aggregator,
				source: c.source,
				kept: ep.kept,
				dropReason: ep.dropReason,
				thirdTokenSeen: ep.thirdTokenSeen,
				trader: ep.trader,
				direction: ep.direction,
				usdcAmount,
				wethAmount,
				realizedPrice: ep.realizedPrice,
				marketMid,
				allInCostBps,
				transferCount: ep.transferCount,
				error: null,
			});

			const status = ep.kept ? 'KEPT' : `DROP(${ep.dropReason})`;
			console.log(`${progress} ${short(c.txHash)} ${c.aggregator ?? 'unknown'} => ${status}`);
		} catch (e) {
			const errMsg = e instanceof Error ? e.message : String(e);
			console.error(`${progress} ${short(c.txHash)}: ERROR: ${errMsg}`);
			results.push({
				txHash: c.txHash,
				aggregator: c.aggregator,
				source: c.source,
				kept: false,
				dropReason: `error: ${errMsg.slice(0, 100)}`,
				thirdTokenSeen: false,
				trader: null,
				direction: null,
				usdcAmount: null,
				wethAmount: null,
				realizedPrice: null,
				marketMid: null,
				allInCostBps: null,
				transferCount: 0,
				error: errMsg,
			});
		}
	}

	// ─── Print results table ───

	console.log('\n' + '='.repeat(180));
	console.log('RESULTS TABLE');
	console.log('='.repeat(180));

	// Header
	const hdr = [
		pad('txHash', 18),
		pad('aggregator', 14),
		pad('status', 8),
		pad('reason/3rdTkn', 40),
		pad('trader', 18),
		pad('direction', 10),
		rpad('USDC', 14),
		rpad('WETH', 14),
		rpad('realizedP', 12),
		rpad('marketMid', 12),
		rpad('costBps', 10),
		rpad('xfers', 5),
	].join(' | ');
	console.log(hdr);
	console.log('-'.repeat(180));

	for (const r of results) {
		const status = r.kept ? 'KEPT' : 'DROP';
		const reason = r.kept
			? ''
			: `${r.dropReason ?? ''}${r.thirdTokenSeen ? ' [3rdToken]' : ''}`;

		const row = [
			pad(short(r.txHash), 18),
			pad((r.aggregator ?? 'unknown').slice(0, 14), 14),
			pad(status, 8),
			pad(reason.slice(0, 40), 40),
			pad(short(r.trader), 18),
			pad(r.direction ?? '-', 10),
			rpad(r.usdcAmount !== null ? r.usdcAmount.toFixed(2) : '-', 14),
			rpad(r.wethAmount !== null ? r.wethAmount.toFixed(6) : '-', 14),
			rpad(r.realizedPrice !== null ? r.realizedPrice.toFixed(2) : '-', 12),
			rpad(r.marketMid !== null ? r.marketMid.toFixed(2) : '-', 12),
			rpad(r.allInCostBps !== null ? r.allInCostBps.toFixed(2) : '-', 10),
			rpad(String(r.transferCount), 5),
		].join(' | ');
		console.log(row);
	}

	// ─── Summary ───

	console.log('\n' + '='.repeat(80));
	console.log('SUMMARY');
	console.log('='.repeat(80));

	const dbResults = results.filter((r) => r.source === 'db');
	const orientResults = results.filter((r) => r.source === 'orientation');
	const keptDb = dbResults.filter((r) => r.kept);
	const droppedDb = dbResults.filter((r) => !r.kept);

	console.log(`\nDB candidates: ${dbResults.length}`);
	console.log(`  KEPT (genuine USDC<->WETH): ${keptDb.length}`);
	console.log(`  DROPPED: ${droppedDb.length}`);

	// Group drops by reason
	const reasonCounts = new Map<string, number>();
	for (const r of droppedDb) {
		const key = r.dropReason ?? 'unknown';
		// Normalize ambiguous reasons to a single category
		const normalizedKey = key.startsWith('ambiguous_multiple_anchors')
			? 'ambiguous_multiple_anchors'
			: key.startsWith('error:')
			? 'error'
			: key;
		reasonCounts.set(normalizedKey, (reasonCounts.get(normalizedKey) ?? 0) + 1);
	}
	for (const [reason, count] of reasonCounts) {
		console.log(`    ${reason}: ${count}`);
	}

	const thirdTokenDrops = droppedDb.filter((r) => r.thirdTokenSeen);
	if (thirdTokenDrops.length > 0) {
		console.log(`  (of dropped, ${thirdTokenDrops.length} had third-token involvement)`);
	}

	if (orientResults.length > 0) {
		console.log(`\nOrientation samples: ${orientResults.length}`);
		const keptOrient = orientResults.filter((r) => r.kept);
		console.log(`  KEPT: ${keptOrient.length}`);
		console.log(`  DROPPED: ${orientResults.length - keptOrient.length}`);
	}

	// Cost stats for kept trades
	if (keptDb.length > 0) {
		const costs = keptDb
			.filter((r) => r.allInCostBps !== null)
			.map((r) => r.allInCostBps!);
		if (costs.length > 0) {
			const sorted = [...costs].sort((a, b) => a - b);
			const median = sorted[Math.floor(sorted.length / 2)]!;
			const mean = costs.reduce((a, b) => a + b, 0) / costs.length;
			const min = sorted[0]!;
			const max = sorted[sorted.length - 1]!;
			console.log(`\nKept trades — all-in cost (bps):`);
			console.log(`  min: ${min.toFixed(2)}, max: ${max.toFixed(2)}, mean: ${mean.toFixed(2)}, median: ${median.toFixed(2)}`);
		}
	}

	// List all kept trades with their cost for easy review
	const allKept = results.filter((r) => r.kept);
	if (allKept.length > 0) {
		console.log(`\n--- KEPT trades detail ---`);
		for (const r of allKept) {
			console.log(
				`  ${short(r.txHash)} | ${r.aggregator ?? 'unknown'} | ${r.direction} ` +
				`| USDC=${r.usdcAmount?.toFixed(2)} | WETH=${r.wethAmount?.toFixed(6)} ` +
				`| realized=${r.realizedPrice?.toFixed(2)} | mid=${r.marketMid?.toFixed(2)} ` +
				`| cost=${r.allInCostBps?.toFixed(2)}bps`,
			);
		}
	}

	console.log('\n=== Gate complete. Review above before proceeding. ===');

	await client.end();
	process.exit(0);
})();
