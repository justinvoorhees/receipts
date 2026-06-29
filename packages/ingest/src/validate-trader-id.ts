/**
 * §0.5 FIRST-STEP GATE — Trader identification validation.
 *
 * Runs over 10–15 sampled trades (from the swaps table) and prints:
 *   - detected trader address (+ EOA/contract)
 *   - is_batch_settlement
 *   - is_single_hop
 *   - trader USDC net delta
 *   - trader WETH net delta
 *   - P_pool (executed price from Swap event)
 *   - P_user (trader's effective price from net deltas)
 *   - aggFeeBps (P_pool → P_user spread)
 *
 * Usage:
 *   TCA_RPC_URL=$(grep TCA_RPC_URL .env | cut -d= -f2) \
 *   TCA_DATABASE_URL=$(grep TCA_DATABASE_URL .env | cut -d= -f2) \
 *   npx tsx packages/ingest/src/validate-trader-id.ts
 */

import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { createDb } from '@fabric-tca/db';
import { sql } from 'drizzle-orm';
import { decodeTransaction } from './decoder.js';
import {
	identifyTraderWithCodeCheck,
	aggFeeBps as computeAggFeeBps,
	type TraderIdentificationResult_WithCodeInfo,
} from './traderIdentification.js';

// ─── Constants ───

const POOL = '0xd0b53D9277642d899DF5C87A3966A349A798F224' as `0x${string}`;
const rpcUrl = process.env.TCA_RPC_URL!;
const dbUrl = process.env.TCA_DATABASE_URL!;

if (!rpcUrl) throw new Error('TCA_RPC_URL not set');
if (!dbUrl) throw new Error('TCA_DATABASE_URL not set');

// Uniswap V3 Swap event signature (any pool)
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

// ─── Known test cases ───

// CoW batch — must be flagged
const COW_BATCH_TX = '0x0d969ce87d6154c858cd2590a658955c77f80e28e4a635df12fe01974b392ec9' as `0x${string}`;

// ─── Main ───

interface ValidationRow {
	txHash: string;
	aggregator: string | null;
	direction: string;
	notionalUsd: number;
	pPool: number;
	pUser: number | null;
	aggFeeBps: number | null;
	traderAddress: string | null;
	traderIsContract: boolean | null;
	candidateCount: number;
	isBatchSettlement: boolean;
	isSingleHop: boolean;
	traderUsdcDelta: number;
	traderWethDelta: number;
	swapCount: number;
	txFrom: string;
	label: string;
}

async function main() {
	const db = createDb(dbUrl);
	const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

	// Step 1: Gather candidate tx hashes.
	const dbRows = await db.execute<{
		tx_hash: string;
		aggregator: string;
		direction: string;
		notional_usd: string;
		executed_price: string;
	}>(sql`
		SELECT tx_hash, aggregator, direction, notional_usd, executed_price
		FROM swaps
		WHERE aggregator IS NOT NULL
		  AND notional_usd::numeric >= 10000
		  AND processing_status = 'complete'
		ORDER BY notional_usd::numeric DESC
		LIMIT 50
	`);

	console.log(`Found ${dbRows.length} candidate trades in DB.`);

	// Sample: pick ensuring aggregator diversity, plus the mandatory CoW batch tx.
	type DbRow = { tx_hash: string; aggregator: string; direction: string; notional_usd: string; executed_price: string };
	const byAgg = new Map<string, DbRow[]>();
	for (const r of dbRows) {
		const agg = r.aggregator;
		if (!byAgg.has(agg)) byAgg.set(agg, []);
		byAgg.get(agg)!.push(r);
	}

	const selected: Array<{ hash: `0x${string}`; label: string }> = [];

	// Always include the CoW batch
	selected.push({ hash: COW_BATCH_TX, label: 'CoW batch (forced)' });

	// Pick up to 3 per aggregator, prioritizing largest notional
	for (const [agg, rows] of byAgg) {
		const take = Math.min(3, rows.length);
		for (let i = 0; i < take && selected.length < 15; i++) {
			const r = rows[i]!;
			const hash = r.tx_hash as `0x${string}`;
			if (selected.some((s) => s.hash.toLowerCase() === hash.toLowerCase())) continue;
			selected.push({
				hash,
				label: `${agg} ${r.direction} $${Number(r.notional_usd).toFixed(0)}`,
			});
		}
	}

	console.log(`\nProcessing ${selected.length} trades...\n`);

	const results: ValidationRow[] = [];

	for (const { hash, label } of selected) {
		try {
			const result = await processOneTrade(client, hash, label);
			results.push(result);
		} catch (err) {
			console.error(`ERROR processing ${hash}: ${(err as Error).message}`);
			results.push({
				txHash: hash,
				aggregator: null,
				direction: '?',
				notionalUsd: 0,
				pPool: 0,
				pUser: null,
				aggFeeBps: null,
				traderAddress: null,
				traderIsContract: null,
				candidateCount: 0,
				isBatchSettlement: false,
				isSingleHop: false,
				traderUsdcDelta: 0,
				traderWethDelta: 0,
				swapCount: 0,
				txFrom: '',
				label: `${label} (ERROR: ${(err as Error).message})`,
			});
		}
	}

	// ─── Print results table ───
	console.log('\n' + '='.repeat(180));
	console.log('§0.5 GATE VALIDATION — Trader Identification Results (with getCode EOA check)');
	console.log('='.repeat(180));

	const header = [
		'#'.padStart(2),
		'Label'.padEnd(35),
		'Trader'.padEnd(14),
		'Type'.padEnd(5),
		'Cands'.padEnd(5),
		'Batch'.padEnd(5),
		'Hops'.padEnd(4),
		'USDC Delta'.padStart(14),
		'WETH Delta'.padStart(14),
		'P_pool'.padStart(10),
		'P_user'.padStart(10),
		'AggFee'.padStart(8),
	].join(' | ');
	console.log(header);
	console.log('-'.repeat(180));

	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		const traderType = r.traderIsContract === null ? '?' : r.traderIsContract ? 'SC' : 'EOA';
		const row = [
			String(i + 1).padStart(2),
			r.label.slice(0, 35).padEnd(35),
			(r.traderAddress ? `${r.traderAddress.slice(0, 6)}...${r.traderAddress.slice(-4)}` : 'NONE').padEnd(14),
			traderType.padEnd(5),
			String(r.candidateCount).padEnd(5),
			(r.isBatchSettlement ? 'YES' : '-').padEnd(5),
			String(r.swapCount).padEnd(4),
			(r.traderUsdcDelta !== 0 ? r.traderUsdcDelta.toFixed(2) : '0').padStart(14),
			(r.traderWethDelta !== 0 ? r.traderWethDelta.toFixed(6) : '0').padStart(14),
			r.pPool.toFixed(2).padStart(10),
			(r.pUser !== null ? r.pUser.toFixed(2) : 'N/A').padStart(10),
			(r.aggFeeBps !== null ? `${r.aggFeeBps.toFixed(1)}bp` : 'N/A').padStart(8),
		].join(' | ');
		console.log(row);
	}

	console.log('='.repeat(180));
	console.log('Type: EOA = externally owned account, SC = smart contract wallet');
	console.log('Cands: number of two-sided non-denied candidate addresses');
	console.log('Hops: number of Swap events (1 = single-hop)');

	// ─── Pass criteria assessment ───
	console.log('\n' + '='.repeat(80));
	console.log('§0.5 PASS CRITERIA ASSESSMENT');
	console.log('='.repeat(80));

	// Criterion 1: Every CoW/batch tx flagged
	const batchTxs = results.filter((r) => r.isBatchSettlement);
	const cowTx = results.find((r) => r.txHash.toLowerCase() === COW_BATCH_TX.toLowerCase());
	const cowFlagged = cowTx?.isBatchSettlement ?? false;
	console.log(`\n1. CoW/batch detection:`);
	console.log(`   Known CoW tx flagged as batch: ${cowFlagged ? 'PASS' : 'FAIL'}`);
	console.log(`   Total batch-flagged trades: ${batchTxs.length}`);

	// Criterion 2: For kept (non-batch, single-hop) trades, trader is real EOA
	const keptTrades = results.filter((r) => !r.isBatchSettlement && r.isSingleHop);
	console.log(`\n2. Trader identification on kept trades (non-batch, single-hop = ${keptTrades.length} trades):`);
	for (const r of keptTrades) {
		const twoSided = r.traderUsdcDelta !== 0 && r.traderWethDelta !== 0 &&
			((r.traderUsdcDelta > 0 && r.traderWethDelta < 0) ||
			 (r.traderUsdcDelta < 0 && r.traderWethDelta > 0));
		const typeStr = r.traderIsContract ? 'CONTRACT' : 'EOA';
		if (!r.traderAddress) {
			console.log(`   FAIL: ${r.label} — no trader found`);
		} else if (!twoSided) {
			console.log(`   WARN: ${r.label} — trader ${r.traderAddress.slice(0, 10)} (${typeStr}) not cleanly two-sided`);
		} else if (r.traderIsContract) {
			console.log(`   WARN: ${r.label} — trader ${r.traderAddress.slice(0, 10)} is a CONTRACT (${r.candidateCount} candidates). May be SC wallet or intermediary.`);
		} else {
			console.log(`   OK: ${r.label} — trader ${r.traderAddress.slice(0, 10)} (EOA) two-sided swap`);
		}
	}

	// Criterion 3: P_user within a few % of P_pool
	console.log(`\n3. P_user vs P_pool sanity (kept trades):`);
	for (const r of keptTrades) {
		if (r.pUser === null || r.pPool === 0) {
			console.log(`   SKIP: ${r.label} — no P_user`);
			continue;
		}
		const pctDiff = Math.abs(r.pUser - r.pPool) / r.pPool * 100;
		const status = pctDiff > 3.0 ? 'OUTLIER' : pctDiff > 0.5 ? 'MARGINAL' : 'OK';
		console.log(`   ${status}: ${r.label} — P_pool=${r.pPool.toFixed(2)} P_user=${r.pUser.toFixed(2)} diff=${pctDiff.toFixed(4)}% aggFee=${r.aggFeeBps?.toFixed(1)}bps`);
	}

	// Criterion 4: Multi-hop and excluded trades summary
	const multiHopTrades = results.filter((r) => !r.isBatchSettlement && !r.isSingleHop);
	console.log(`\n4. Multi-hop trades (would be excluded in v2 single-hop filter):`);
	console.log(`   Multi-hop count: ${multiHopTrades.length} of ${results.length} total`);
	for (const r of multiHopTrades) {
		const typeStr = r.traderIsContract === null ? '?' : r.traderIsContract ? 'SC' : 'EOA';
		console.log(`   ${r.swapCount}-hop: ${r.label} — trader=${r.traderAddress?.slice(0, 10) ?? 'NONE'} (${typeStr}), P_user diff=${r.pUser !== null && r.pPool !== 0 ? (Math.abs(r.pUser - r.pPool) / r.pPool * 100).toFixed(2) + '%' : 'N/A'}`);
	}

	// ─── Detailed breakdowns for problem trades ───
	console.log(`\n${'='.repeat(80)}`);
	console.log('DETAILED BREAKDOWN — all trades');
	console.log('='.repeat(80));
	for (const r of results) {
		const typeStr = r.traderIsContract === null ? '?' : r.traderIsContract ? 'CONTRACT' : 'EOA';
		console.log(`\n--- ${r.label} (${r.txHash.slice(0, 18)}...) ---`);
		console.log(`  tx.from: ${r.txFrom.slice(0, 14)}...`);
		console.log(`  Batch: ${r.isBatchSettlement} | Swap events: ${r.swapCount} | Single-hop: ${r.isSingleHop}`);
		console.log(`  Trader: ${r.traderAddress ?? 'NONE'} (${typeStr}) [${r.candidateCount} candidates]`);
		console.log(`  USDC delta: ${r.traderUsdcDelta.toFixed(2)} | WETH delta: ${r.traderWethDelta.toFixed(6)}`);
		console.log(`  P_pool: ${r.pPool.toFixed(4)} | P_user: ${r.pUser?.toFixed(4) ?? 'N/A'}`);
		if (r.pUser !== null && r.pPool !== 0) {
			const pctDiff = ((r.pUser - r.pPool) / r.pPool * 100);
			console.log(`  Price diff: ${pctDiff >= 0 ? '+' : ''}${pctDiff.toFixed(4)}% (aggFee: ${r.aggFeeBps?.toFixed(2)}bps)`);
		}
		// Classification summary
		const kept = !r.isBatchSettlement && r.isSingleHop;
		console.log(`  VERDICT: ${kept ? 'KEPT for v2' : r.isBatchSettlement ? 'EXCLUDED (batch)' : 'EXCLUDED (multi-hop)'}`);
	}

	console.log('\n--- VALIDATION COMPLETE ---\n');
	process.exit(0);
}

// ─── Per-trade processing ───

async function processOneTrade(
	client: ReturnType<typeof createPublicClient>,
	txHash: `0x${string}`,
	label: string,
): Promise<ValidationRow> {
	console.log(`Processing: ${label} (${txHash.slice(0, 14)}...)`);

	// Decode the transaction using the existing decoder
	const decoded = await decodeTransaction({
		rpcUrl,
		txHash,
		context: {
			aggregator: null,
			poolAddress: POOL,
			poolFeeTier: 500,
		},
	});

	// Count Swap events in receipt
	const receipt = await client.getTransactionReceipt({ hash: txHash });
	let swapEventCount = 0;
	for (const log of receipt.logs) {
		if (log.topics[0] === SWAP_TOPIC) {
			swapEventCount++;
		}
	}

	// Run enhanced trader identification with getCode check
	const traderResult = await identifyTraderWithCodeCheck({
		transfers: decoded.transfers,
		txFrom: decoded.from,
		poolAddress: POOL,
		swapEventCount,
		txTo: decoded.to,
		rpcUrl,
	});

	// Compute P_pool from the Swap event
	const pPool = computePPool(decoded.direction, decoded.amountInRaw, decoded.amountOutRaw);

	// Compute aggFeeBps if we have P_user
	let aggFee: number | null = null;
	if (traderResult.pUser !== null) {
		aggFee = computeAggFeeBps(decoded.direction, pPool, traderResult.pUser);
	}

	return {
		txHash,
		aggregator: decoded.aggregator,
		direction: decoded.direction,
		notionalUsd: computeNotional(decoded.direction, decoded.amountInRaw, decoded.amountOutRaw),
		pPool,
		pUser: traderResult.pUser,
		aggFeeBps: aggFee,
		traderAddress: traderResult.traderAddress,
		traderIsContract: traderResult.traderIsContract,
		candidateCount: traderResult.candidateCount,
		isBatchSettlement: traderResult.isBatchSettlement,
		isSingleHop: traderResult.isSingleHop,
		traderUsdcDelta: traderResult.traderUsdcDelta,
		traderWethDelta: traderResult.traderWethDelta,
		swapCount: swapEventCount,
		txFrom: decoded.from,
		label,
	};
}

function computePPool(direction: string, amountInRaw: bigint, amountOutRaw: bigint): number {
	if (direction === 'buy_weth') {
		const usdcIn = Number(amountInRaw) / 1e6;
		const wethOut = Number(amountOutRaw) / 1e18;
		return usdcIn / wethOut;
	}
	const wethIn = Number(amountInRaw) / 1e18;
	const usdcOut = Number(amountOutRaw) / 1e6;
	return usdcOut / wethIn;
}

function computeNotional(direction: string, amountInRaw: bigint, amountOutRaw: bigint): number {
	return direction === 'buy_weth'
		? Number(amountInRaw) / 1e6
		: Number(amountOutRaw) / 1e6;
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
