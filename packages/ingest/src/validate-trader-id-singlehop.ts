/**
 * §0.5 supplemental validation — focused on finding actual single-hop trades
 * where the heuristic can work well. The main validation showed most trades
 * are multi-hop; this script scans all trades to find genuinely single-hop
 * ones where the trader can be cleanly identified.
 *
 * Usage: same as validate-trader-id.ts
 */

import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { createDb } from '@fabric-tca/db';
import { sql } from 'drizzle-orm';
import { decodeTransaction } from './decoder.js';
import {
	identifyTraderWithCodeCheck,
	aggFeeBps as computeAggFeeBps,
} from './traderIdentification.js';

const POOL = '0xd0b53D9277642d899DF5C87A3966A349A798F224' as `0x${string}`;
const rpcUrl = process.env.TCA_RPC_URL!;
const dbUrl = process.env.TCA_DATABASE_URL!;

if (!rpcUrl) throw new Error('TCA_RPC_URL not set');
if (!dbUrl) throw new Error('TCA_DATABASE_URL not set');

const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const COW_BATCH_TX = '0x0d969ce87d6154c858cd2590a658955c77f80e28e4a635df12fe01974b392ec9';

async function main() {
	const db = createDb(dbUrl);
	const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

	// Get ALL qualifying trades
	const dbRows = await db.execute<{
		tx_hash: string;
		aggregator: string;
		direction: string;
		notional_usd: string;
	}>(sql`
		SELECT tx_hash, aggregator, direction, notional_usd
		FROM swaps
		WHERE aggregator IS NOT NULL
		  AND notional_usd::numeric >= 10000
		  AND processing_status = 'complete'
		ORDER BY notional_usd::numeric DESC
	`);

	console.log(`Scanning ${dbRows.length} trades for single-hop...\n`);

	// Phase 1: Quick scan — count Swap events per tx (receipt only, no trace decode)
	const singleHopTxs: typeof dbRows = [];
	const multiHopTxs: typeof dbRows = [];

	for (const r of dbRows) {
		const hash = r.tx_hash as `0x${string}`;
		if (hash.toLowerCase() === COW_BATCH_TX.toLowerCase()) {
			console.log(`  SKIP: CoW batch`);
			continue;
		}
		try {
			const receipt = await client.getTransactionReceipt({ hash });
			let swapCount = 0;
			for (const log of receipt.logs) {
				if (log.topics[0] === SWAP_TOPIC) swapCount++;
			}
			if (swapCount === 1) {
				singleHopTxs.push(r);
				console.log(`  1-hop: ${r.aggregator} ${r.direction} $${Number(r.notional_usd).toFixed(0)} (${hash.slice(0, 14)}...)`);
			} else {
				multiHopTxs.push(r);
			}
		} catch (err) {
			console.log(`  ERROR: ${hash.slice(0, 14)}... ${(err as Error).message}`);
		}
	}

	console.log(`\nResults: ${singleHopTxs.length} single-hop, ${multiHopTxs.length} multi-hop out of ${dbRows.length} total`);

	if (singleHopTxs.length === 0) {
		console.log('\nNo single-hop trades found. The v2 single-hop filter would exclude the entire dataset.');
		process.exit(0);
	}

	// Phase 2: Full decode + trader identification on single-hop trades
	console.log(`\nFull decode on ${singleHopTxs.length} single-hop trades...\n`);

	console.log([
		'#'.padStart(2),
		'Aggregator'.padEnd(12),
		'Dir'.padEnd(9),
		'Notional'.padStart(10),
		'Trader'.padEnd(14),
		'Type'.padEnd(5),
		'USDC Delta'.padStart(14),
		'WETH Delta'.padStart(14),
		'P_pool'.padStart(10),
		'P_user'.padStart(10),
		'AggFee'.padStart(8),
		'Status'.padEnd(10),
	].join(' | '));
	console.log('-'.repeat(160));

	for (let i = 0; i < singleHopTxs.length; i++) {
		const r = singleHopTxs[i];
		const hash = r.tx_hash as `0x${string}`;
		try {
			const decoded = await decodeTransaction({
				rpcUrl,
				txHash: hash,
				context: { aggregator: null, poolAddress: POOL, poolFeeTier: 500 },
			});

			const traderResult = await identifyTraderWithCodeCheck({
				transfers: decoded.transfers,
				txFrom: decoded.from,
				poolAddress: POOL,
				swapEventCount: 1,
				txTo: decoded.to,
				rpcUrl,
			});

			const pPool = decoded.direction === 'buy_weth'
				? (Number(decoded.amountInRaw) / 1e6) / (Number(decoded.amountOutRaw) / 1e18)
				: (Number(decoded.amountOutRaw) / 1e6) / (Number(decoded.amountInRaw) / 1e18);

			let aggFee: number | null = null;
			if (traderResult.pUser !== null) {
				aggFee = computeAggFeeBps(decoded.direction, pPool, traderResult.pUser);
			}

			const pctDiff = traderResult.pUser !== null && pPool !== 0
				? Math.abs(traderResult.pUser - pPool) / pPool * 100
				: null;
			const status = traderResult.traderAddress === null
				? 'NO_TRADER'
				: pctDiff !== null && pctDiff > 3
					? 'OUTLIER'
					: pctDiff !== null && pctDiff > 0.5
						? 'MARGINAL'
						: 'OK';

			const typeStr = traderResult.traderIsContract === null ? '?' : traderResult.traderIsContract ? 'SC' : 'EOA';

			console.log([
				String(i + 1).padStart(2),
				r.aggregator.padEnd(12),
				decoded.direction.padEnd(9),
				`$${Number(r.notional_usd).toFixed(0)}`.padStart(10),
				(traderResult.traderAddress ? `${traderResult.traderAddress.slice(0, 6)}...${traderResult.traderAddress.slice(-4)}` : 'NONE').padEnd(14),
				typeStr.padEnd(5),
				(traderResult.traderUsdcDelta !== 0 ? traderResult.traderUsdcDelta.toFixed(2) : '0').padStart(14),
				(traderResult.traderWethDelta !== 0 ? traderResult.traderWethDelta.toFixed(6) : '0').padStart(14),
				pPool.toFixed(2).padStart(10),
				(traderResult.pUser !== null ? traderResult.pUser.toFixed(2) : 'N/A').padStart(10),
				(aggFee !== null ? `${aggFee.toFixed(1)}bp` : 'N/A').padStart(8),
				status.padEnd(10),
			].join(' | '));
		} catch (err) {
			console.log(`  ERROR on ${hash.slice(0, 14)}...: ${(err as Error).message}`);
		}
	}

	console.log('\n--- DONE ---');
	process.exit(0);
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
