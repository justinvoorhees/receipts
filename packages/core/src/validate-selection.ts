/**
 * validate-selection.ts — Validates the §C Selection Gate on 7 curated txns
 * and estimates survival rate on a random sample from router_trades.
 *
 * READ-ONLY — no DB writes, no schema changes, no dashboard edits.
 *
 * Run: set -a && source .env && set +a && npx tsx packages/core/src/validate-selection.ts
 */

import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import postgres from 'postgres';
import { applySelectionGateWithSplitDetection } from './selectionGate.js';
import type { SelectionGateResult } from './selectionGate.js';

// ─── Curated transactions with §C oracle verdicts ───

interface OracleEntry {
	hash: `0x${string}`;
	label: string;
	expectedInScope: boolean;
	expectedReason: string;         // reason substring (may be one of several acceptable)
	acceptableReasons: string[];    // all acceptable reason strings
	expectedSwapperPrefix?: string; // lowercase prefix of expected swapper address
	expectedDirection?: 'buy_weth' | 'sell_weth' | null;
}

const CURATED_TXS: OracleEntry[] = [
	{
		hash: '0x55513d402ecdbc00fea0eaf68642442193aeff6385b48e9339745fedd66e965a',
		label: '#1 1inch — REJECT (no_user_swapper)',
		expectedInScope: false,
		expectedReason: 'no_user_swapper',
		acceptableReasons: ['no_user_swapper'],
		expectedDirection: null,
	},
	{
		hash: '0x89628ee8e6b3a1b7c4c8ab8af5a5752c6de2ba7024ea0ff78a155a044c59aa8c',
		label: '#2 Odos — VALID (swapper 0x65da09, buy)',
		expectedInScope: true,
		expectedReason: 'ok',
		acceptableReasons: ['ok'],
		expectedSwapperPrefix: '0x65da09',
		expectedDirection: 'buy_weth',
	},
	{
		hash: '0xce4dbac465b0538d1d484f2c1c0553861301248dbb6596dd448adfbfc6d31686',
		label: '#3 Velora — REJECT (split_recipient)',
		expectedInScope: false,
		expectedReason: 'split_recipient',
		acceptableReasons: ['split_recipient'],
		expectedDirection: null,
	},
	{
		hash: '0x5bd00e22bab13fdf083525bb68633e6bf5dd581ae00a0f8b89329ada7065c2e9',
		label: '#4 Fabric — REJECT (no_user_swapper / wrong_pair)',
		expectedInScope: false,
		expectedReason: 'no_user_swapper',
		acceptableReasons: ['no_user_swapper', 'wrong_pair_or_third_token'],
		expectedDirection: null,
	},
	{
		hash: '0x850df6157d218bfb6cdfc2bb35cb59da640c6795447c0a89484b781a12a5cfcf',
		label: '#5 KyberSwap — REJECT (pool_as_trader / wrong_pair / split)',
		expectedInScope: false,
		expectedReason: 'pool_as_trader',
		acceptableReasons: ['pool_as_trader', 'wrong_pair_or_third_token', 'split_recipient'],
		expectedDirection: null,
	},
	{
		hash: '0x8503cccf97055770c778183859da64a19983a9014185a29b0a30f6845cc1d86e',
		label: '#6 Relay — VALID (swapper 0x1dbe67c11c, buy)',
		expectedInScope: true,
		expectedReason: 'ok',
		acceptableReasons: ['ok'],
		expectedSwapperPrefix: '0x1dbe67c11c',
		expectedDirection: 'buy_weth',
	},
	{
		hash: '0x15290f78247cf614f0531f8075d0949f572ae7ae22fd7bb19409f21435b9e282',
		label: '#7 1inch — VALID (swapper 0xa3a9be, buy)',
		expectedInScope: true,
		expectedReason: 'ok',
		acceptableReasons: ['ok'],
		expectedSwapperPrefix: '0xa3a9be',
		expectedDirection: 'buy_weth',
	},
];

// ─── Helpers ───

interface TraceNode {
	from?: `0x${string}`;
	to?: `0x${string}`;
	value?: `0x${string}`;
	logs?: {
		address: `0x${string}`;
		data: `0x${string}`;
		topics: [`0x${string}`, ...`0x${string}`[]] | [];
	}[];
	calls?: TraceNode[];
}

async function fetchTraceAndReceipt(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	rpc: any,
	txHash: `0x${string}`,
): Promise<{ trace: TraceNode; receipt: { from: `0x${string}`; logs: readonly { address: `0x${string}`; data: `0x${string}`; topics: readonly `0x${string}`[] }[] } }> {
	const rawTrace = await (
		rpc.request as unknown as (req: { method: string; params: unknown[] }) => Promise<unknown>
	)({
		method: 'debug_traceTransaction',
		params: [
			txHash,
			{ tracer: 'callTracer', tracerConfig: { withLog: true, onlyTopCall: false } },
		],
	});

	const receipt = await rpc.getTransactionReceipt({ hash: txHash });

	return {
		trace: rawTrace as TraceNode,
		receipt: {
			from: receipt.from as `0x${string}`,
			logs: receipt.logs,
		},
	};
}

// ─── Main ───

async function main(): Promise<void> {
	const rpcUrl = process.env.TCA_RPC_URL;
	const dbUrl = process.env.TCA_DATABASE_URL;
	if (!rpcUrl) throw new Error('TCA_RPC_URL not set');
	if (!dbUrl) throw new Error('TCA_DATABASE_URL not set');

	const sql = postgres(dbUrl);
	const rpc = createPublicClient({ chain: base, transport: http(rpcUrl) });

	// ═══════════════════════════════════════════════════════
	// Part 1: Curated 7-txn handful — §C oracle assertions
	// ═══════════════════════════════════════════════════════

	console.log('╔═══════════════════════════════════════════════════════════════════╗');
	console.log('║  §C Selection Gate — Validation (7 curated txns)                 ║');
	console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

	let passCount = 0;
	let failCount = 0;

	for (const oracle of CURATED_TXS) {
		console.log('───────────────────────────────────────────────────────────────────');
		console.log(`  ${oracle.label}`);
		console.log(`  ${oracle.hash}`);

		let result: SelectionGateResult;
		try {
			const { trace, receipt } = await fetchTraceAndReceipt(rpc, oracle.hash);
			result = applySelectionGateWithSplitDetection({ trace, receipt });
		} catch (e) {
			console.log(`  ERROR: ${e instanceof Error ? e.message : String(e)}`);
			failCount++;
			console.log('');
			continue;
		}

		const scopeMatch = result.inScope === oracle.expectedInScope;
		const reasonMatch = oracle.acceptableReasons.includes(result.reason);
		const swapperMatch = !oracle.expectedSwapperPrefix || (
			result.swapper !== null &&
			result.swapper.toLowerCase().startsWith(oracle.expectedSwapperPrefix.toLowerCase())
		);
		const dirMatch = oracle.expectedDirection === undefined ||
			result.direction === oracle.expectedDirection;

		const allMatch = scopeMatch && reasonMatch && swapperMatch && dirMatch;

		console.log(`  Gate result:`);
		console.log(`    inScope:   ${result.inScope}  (expected: ${oracle.expectedInScope}) ${scopeMatch ? 'OK' : 'MISMATCH'}`);
		console.log(`    reason:    ${result.reason}  (expected: ${oracle.acceptableReasons.join(' | ')}) ${reasonMatch ? 'OK' : 'MISMATCH'}`);
		console.log(`    swapper:   ${result.swapper ?? '(none)'}${oracle.expectedSwapperPrefix ? `  (expected prefix: ${oracle.expectedSwapperPrefix}) ${swapperMatch ? 'OK' : 'MISMATCH'}` : ''}`);
		console.log(`    direction: ${result.direction ?? '(none)'}${oracle.expectedDirection !== undefined ? `  (expected: ${oracle.expectedDirection ?? 'null'}) ${dirMatch ? 'OK' : 'MISMATCH'}` : ''}`);
		console.log(`  Verdict: ${allMatch ? 'PASS' : 'FAIL'}`);

		if (allMatch) passCount++;
		else failCount++;

		console.log('');
	}

	console.log('═══════════════════════════════════════════════════════════════════');
	console.log(`  Curated handful: ${passCount} PASS / ${failCount} FAIL out of ${CURATED_TXS.length}`);
	console.log('═══════════════════════════════════════════════════════════════════\n');

	// ═══════════════════════════════════════════════════════
	// Part 2: Random sample from router_trades — survival estimate
	// ═══════════════════════════════════════════════════════

	console.log('╔═══════════════════════════════════════════════════════════════════╗');
	console.log('║  §C Selection Gate — Survival estimate (~50 random sample)       ║');
	console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

	// Pull a random sample of ~50 tx_hashes from router_trades
	const sampleRows = await sql`
		SELECT tx_hash, trader, aggregator, direction
		FROM router_trades
		ORDER BY random()
		LIMIT 50
	`;

	const sampleSize = sampleRows.length;
	console.log(`  Sample size: ${sampleSize}\n`);

	let samplePass = 0;
	let sampleFail = 0;
	const reasonCounts: Record<string, number> = {};
	let reanchorCount = 0;
	let errorCount = 0;

	for (const row of sampleRows) {
		const txHash = row.tx_hash as `0x${string}`;
		const dbTrader = (row.trader as string).toLowerCase();

		let result: SelectionGateResult;
		try {
			const { trace, receipt } = await fetchTraceAndReceipt(rpc, txHash);
			result = applySelectionGateWithSplitDetection({ trace, receipt });
		} catch (e) {
			errorCount++;
			console.log(`  ERROR on ${txHash}: ${e instanceof Error ? e.message : String(e)}`);
			continue;
		}

		if (result.inScope) {
			samplePass++;
			// Check if swapper differs from recorded trader
			if (result.swapper && result.swapper.toLowerCase() !== dbTrader) {
				reanchorCount++;
			}
		} else {
			sampleFail++;
		}

		const reason = result.reason;
		reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
	}

	const totalProcessed = samplePass + sampleFail;
	const passRate = totalProcessed > 0 ? ((samplePass / totalProcessed) * 100).toFixed(1) : '0.0';

	console.log('───────────────────────────────────────────────────────────────────');
	console.log(`  Results (${totalProcessed} processed, ${errorCount} errors):`);
	console.log(`    PASS (inScope):  ${samplePass}  (${passRate}%)`);
	console.log(`    FAIL (rejected): ${sampleFail}  (${(totalProcessed > 0 ? (sampleFail / totalProcessed) * 100 : 0).toFixed(1)}%)`);
	console.log('');
	console.log('  Reject reason breakdown:');
	for (const [reason, count] of Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])) {
		console.log(`    ${reason.padEnd(30)} ${String(count).padStart(4)}  (${((count / totalProcessed) * 100).toFixed(1)}%)`);
	}
	console.log('');
	console.log(`  Re-anchored swappers (swapper != DB trader): ${reanchorCount} of ${samplePass} passing`);
	console.log('═══════════════════════════════════════════════════════════════════\n');

	await sql.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
