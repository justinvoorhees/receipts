/**
 * reextract-gated.ts — Re-extract the router_trades dataset through the §C
 * selection gate, writing cleaned/re-anchored results to router_trades_gated.
 *
 * READ-ONLY w.r.t. router_trades. Only writes to router_trades_gated (new table).
 *
 * Two additional filtering layers (on top of the pure selection gate):
 *   Fix A — On-chain pool/LP-token exclusion: reject swappers that are AMM pools
 *            or LP tokens (token0+token1, fee(), or pool/LP symbol pattern).
 *   Fix B — Multi-aggregator-contract filler filter: after inserting survivors,
 *            delete any swapper that is a CONTRACT appearing across 2+ aggregators
 *            (filler/solver, not a user). EOAs and single-aggregator contracts kept.
 *
 * Run: set -a && source .env && set +a && npx tsx packages/ingest/src/reextract-gated.ts
 */

import postgres from 'postgres';
import { createPublicClient, http, parseAbiItem } from 'viem';
import { base } from 'viem/chains';
import {
	USDC,
	WETH,
	decodeTransferLogs,
	collectNativeEthDeltas,
} from './tradeEndpoints.js';
import { applySelectionGate } from './selectionGate.js';
import type { GateDirection } from './selectionGate.js';
import { getReferencePrice } from './referencePrice.js';
import { signedDeviationBps } from './priceMath.js';
import type { Direction } from './decoder.js';

// ─── Constants ───

const POOL_5BPS = '0xd0b53D9277642d899DF5C87A3966A349A798F224' as `0x${string}`;
const MIN_NOTIONAL = 1000;
const MAX_PLAUSIBLE_BPS = 100;
const CONCURRENCY = 6;

// ─── ABI fragments for on-chain pool detection (Fix A) ───

const TOKEN0_ABI = parseAbiItem('function token0() view returns (address)');
const TOKEN1_ABI = parseAbiItem('function token1() view returns (address)');
const FEE_ABI = parseAbiItem('function fee() view returns (uint24)');
const SYMBOL_ABI = parseAbiItem('function symbol() view returns (string)');

/** Case-insensitive pool/LP symbol substrings */
const POOL_SYMBOL_PATTERNS = ['usdc', 'weth', 'eth', 'crv', '-lp', 'lp-', 'clob', 'pool'];

// ─── Trace types ───

interface TraceNode {
	from?: `0x${string}`;
	to?: `0x${string}`;
	value?: `0x${string}`;
	input?: `0x${string}`;
	output?: `0x${string}`;
	type?: string;
	logs?: {
		address: `0x${string}`;
		data: `0x${string}`;
		topics: [`0x${string}`, ...`0x${string}`[]] | [];
	}[];
	calls?: TraceNode[];
}

interface LogLike {
	address: `0x${string}`;
	data: `0x${string}`;
	topics: readonly `0x${string}`[];
}

// ─── Helpers ───

function absBI(n: bigint): bigint {
	return n < 0n ? -n : n;
}

/** Flatten every log from a callTracer trace tree into a single ordered list. */
function collectTraceLogs(trace: TraceNode): LogLike[] {
	const out: LogLike[] = [];
	const visit = (node: TraceNode) => {
		if (node.logs) out.push(...(node.logs as unknown as LogLike[]));
		if (node.calls) {
			for (const child of node.calls) visit(child);
		}
	};
	visit(trace);
	return out;
}

// ─── Fix A: On-chain pool/LP-token detection cache ───

/** Cache: address → true (is pool/LP, reject) | false (not pool/LP, keep) */
const poolCheckCache = new Map<string, boolean>();

/**
 * Check if an address is an AMM pool or LP token on-chain.
 * Returns true if ANY of:
 *   - token0() AND token1() both succeed
 *   - fee() returns a valid uint24
 *   - symbol() matches a pool/LP pattern
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function isPoolOrLpToken(rpc: any, address: string): Promise<boolean> {
	const key = address.toLowerCase();
	if (poolCheckCache.has(key)) return poolCheckCache.get(key)!;

	const addr = key as `0x${string}`;
	let isPool = false;

	// Check token0() + token1()
	try {
		const [t0, t1] = await Promise.all([
			rpc.readContract({ address: addr, abi: [TOKEN0_ABI], functionName: 'token0' }),
			rpc.readContract({ address: addr, abi: [TOKEN1_ABI], functionName: 'token1' }),
		]);
		if (t0 && t1) {
			isPool = true;
		}
	} catch {
		// Not a pool with token0/token1
	}

	// Check fee()
	if (!isPool) {
		try {
			const fee = await rpc.readContract({
				address: addr,
				abi: [FEE_ABI],
				functionName: 'fee',
			});
			if (typeof fee === 'bigint' || typeof fee === 'number') {
				isPool = true;
			}
		} catch {
			// No fee() method
		}
	}

	// Check symbol() for pool/LP pattern
	if (!isPool) {
		try {
			const sym = await rpc.readContract({
				address: addr,
				abi: [SYMBOL_ABI],
				functionName: 'symbol',
			}) as string;
			if (sym && typeof sym === 'string') {
				const lower = sym.toLowerCase();
				if (POOL_SYMBOL_PATTERNS.some(p => lower.includes(p))) {
					isPool = true;
				}
			}
		} catch {
			// No symbol() or not readable
		}
	}

	poolCheckCache.set(key, isPool);
	return isPool;
}

// ─── Fix B: Bytecode cache for contract detection ───

/** Cache: address → true (has bytecode = contract) | false (EOA) */
const bytecodeCache = new Map<string, boolean>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function isContract(rpc: any, address: string): Promise<boolean> {
	const key = address.toLowerCase();
	if (bytecodeCache.has(key)) return bytecodeCache.get(key)!;

	try {
		const code = await rpc.getCode({ address: key as `0x${string}` });
		const result = !!code && code !== '0x' && code.length > 2;
		bytecodeCache.set(key, result);
		return result;
	} catch {
		bytecodeCache.set(key, false);
		return false;
	}
}

// ─── Per-row result type ───

interface GatedRow {
	tx_hash: string;
	aggregator: string;
	trader: string;
	original_trader: string;
	re_anchored: boolean;
	direction: string;
	settled_in: string;
	usdc_amount: number;
	weth_amount: number;
	realized_price: number;
	market_mid: number;
	all_in_cost_bps: number;
	block_number: number;
	gate_reason: string;
}

// ─── Processing one tx ───

interface ProcessResult {
	status: 'inserted' | 'gate_reject' | 'below_floor' | 'implausible' | 'pool_swapper_onchain' | 'error';
	aggregator: string;
	reason?: string;
	row?: GatedRow;
	errorMsg?: string;
	poolSwapperAddress?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processOne(
	rpc: any,
	rpcUrl: string,
	txHash: string,
	aggregator: string,
	originalTrader: string,
	blockNumber: number,
): Promise<ProcessResult> {
	try {
		// Fetch receipt + trace
		const [receipt, rawTrace] = await Promise.all([
			rpc.getTransactionReceipt({ hash: txHash as `0x${string}` }),
			(rpc.request as unknown as (req: { method: string; params: unknown[] }) => Promise<unknown>)({
				method: 'debug_traceTransaction',
				params: [
					txHash,
					{ tracer: 'callTracer', tracerConfig: { withLog: true, onlyTopCall: false } },
				],
			}),
		]);

		const trace = rawTrace as TraceNode;

		// ── Apply selection gate ──
		const gateResult = applySelectionGate({
			trace,
			receipt: {
				from: receipt.from.toLowerCase() as `0x${string}`,
				logs: receipt.logs.map((l: { address: string; data: `0x${string}`; topics: readonly `0x${string}`[] }) => ({
					address: l.address.toLowerCase() as `0x${string}`,
					data: l.data,
					topics: l.topics.map((t: string) => t.toLowerCase()) as `0x${string}`[],
				})),
			},
		});

		if (!gateResult.inScope) {
			return {
				status: 'gate_reject',
				aggregator,
				reason: gateResult.reason,
			};
		}

		const swapper = gateResult.swapper!.toLowerCase();
		const direction = gateResult.direction!;

		// ── Fix A: On-chain pool/LP-token exclusion ──
		const swapperIsPool = await isPoolOrLpToken(rpc, swapper);
		if (swapperIsPool) {
			return {
				status: 'pool_swapper_onchain',
				aggregator,
				poolSwapperAddress: swapper,
			};
		}

		// ── Compute swapper's net token positions from trace/receipt ──
		// Use trace logs for ERC-20 deltas (consistent with the gate)
		const traceLogs = collectTraceLogs(trace);
		const transfers = decodeTransferLogs(traceLogs);
		const nativeEthDeltas = collectNativeEthDeltas(trace);

		// Build per-address, per-token deltas (same as the gate does internally)
		let usdcNet = 0n;
		let wethErc20Net = 0n;

		for (const t of transfers) {
			const tokenLower = t.token.toLowerCase();
			const fromLower = t.from.toLowerCase();
			const toLower = t.to.toLowerCase();

			if (fromLower === swapper) {
				if (tokenLower === USDC) usdcNet -= t.value;
				else if (tokenLower === WETH) wethErc20Net -= t.value;
			}
			if (toLower === swapper) {
				if (tokenLower === USDC) usdcNet += t.value;
				else if (tokenLower === WETH) wethErc20Net += t.value;
			}
		}

		const ethNet = nativeEthDeltas.get(swapper) ?? 0n;
		const wethEquivNet = wethErc20Net + ethNet;

		// settled_in: 'WETH' if the swapper has a nonzero ERC-20 WETH delta, else 'ETH'
		const settledIn = absBI(wethErc20Net) > 10_000_000_000n ? 'WETH' : 'ETH';

		// USDC normalized by 1e6, WETH/ETH by 1e18
		const usdcAmount = Math.abs(Number(usdcNet)) / 1e6;
		const wethAmount = Math.abs(Number(wethEquivNet)) / 1e18;

		// ── Notional floor ──
		if (usdcAmount < MIN_NOTIONAL) {
			return { status: 'below_floor', aggregator };
		}

		// realized_price = |usdc|/1e6 / |wethEquiv|/1e18
		if (wethAmount === 0) {
			return { status: 'error', aggregator, errorMsg: 'wethAmount is zero' };
		}
		const realizedPrice = usdcAmount / wethAmount;

		// ── Market mid ──
		const marketMid = await getReferencePrice({
			rpcUrl,
			poolAddress: POOL_5BPS,
			blockNumber: BigInt(blockNumber),
		});

		// ── all_in_cost_bps ──
		const allInCostBps = signedDeviationBps(
			direction as Direction,
			marketMid,
			realizedPrice,
		);

		// ── Implausible guard ──
		if (Math.abs(allInCostBps) > MAX_PLAUSIBLE_BPS) {
			return { status: 'implausible', aggregator };
		}

		const reAnchored = swapper !== originalTrader.toLowerCase();

		const row: GatedRow = {
			tx_hash: txHash,
			aggregator,
			trader: swapper,
			original_trader: originalTrader,
			re_anchored: reAnchored,
			direction,
			settled_in: settledIn,
			usdc_amount: usdcAmount,
			weth_amount: wethAmount,
			realized_price: realizedPrice,
			market_mid: marketMid,
			all_in_cost_bps: allInCostBps,
			block_number: blockNumber,
			gate_reason: 'ok',
		};

		return { status: 'inserted', aggregator, row };
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		return { status: 'error', aggregator, errorMsg: msg };
	}
}

// ─── Main ───

async function main(): Promise<void> {
	const rpcUrl = process.env.TCA_RPC_URL;
	const dbUrl = process.env.TCA_DATABASE_URL;
	if (!rpcUrl) throw new Error('TCA_RPC_URL not set');
	if (!dbUrl) throw new Error('TCA_DATABASE_URL not set');

	const sql = postgres(dbUrl);
	const rpc = createPublicClient({ chain: base, transport: http(rpcUrl) });

	// ── Step 0: Verify router_trades is untouched ──
	const beforeCount = await sql`SELECT count(*)::int as n FROM router_trades`;
	console.log(`router_trades row count (before): ${beforeCount[0]!.n}`);

	// ── Step 1: Create output table ──
	await sql`
		CREATE TABLE IF NOT EXISTS router_trades_gated (
			tx_hash         text PRIMARY KEY,
			aggregator      text NOT NULL,
			trader          text NOT NULL,
			original_trader text NOT NULL,
			re_anchored     boolean NOT NULL DEFAULT false,
			direction       text NOT NULL,
			settled_in      text NOT NULL,
			usdc_amount     numeric NOT NULL,
			weth_amount     numeric NOT NULL,
			realized_price  numeric NOT NULL,
			market_mid      numeric NOT NULL,
			all_in_cost_bps numeric NOT NULL,
			block_number    integer NOT NULL,
			gate_reason     text NOT NULL DEFAULT 'ok',
			loaded_at       timestamptz NOT NULL DEFAULT now()
		)
	`;
	// Clear any previous run data upfront so the output is a clean regeneration
	await sql`TRUNCATE router_trades_gated`;
	console.log('router_trades_gated table ensured (truncated for clean re-run).\n');

	// ── Step 2: Read all rows from router_trades ──
	const rows = await sql`
		SELECT tx_hash, aggregator, trader, block_number
		FROM router_trades
		ORDER BY block_number ASC
	`;
	console.log(`Total rows to process: ${rows.length}\n`);

	// ── Step 3: Process with concurrency (gate + Fix A per trade) ──
	const inserted: GatedRow[] = [];
	const gateRejects = new Map<string, number>();
	let belowFloorCount = 0;
	let implausibleCount = 0;
	let poolSwapperOnchainCount = 0;
	let errorCount = 0;
	let reAnchoredCount = 0;
	const perAggBefore = new Map<string, number>();
	const perAggAfter = new Map<string, number>();
	const poolSwapperAddresses = new Set<string>();

	// Count before per-aggregator
	for (const r of rows) {
		perAggBefore.set(r.aggregator as string, (perAggBefore.get(r.aggregator as string) ?? 0) + 1);
	}

	let done = 0;

	for (let i = 0; i < rows.length; i += CONCURRENCY) {
		const batch = rows.slice(i, i + CONCURRENCY);
		const results = await Promise.all(
			batch.map(r =>
				processOne(
					rpc,
					rpcUrl,
					r.tx_hash as string,
					r.aggregator as string,
					r.trader as string,
					r.block_number as number,
				),
			),
		);

		for (const res of results) {
			if (res.status === 'inserted' && res.row) {
				inserted.push(res.row);
				perAggAfter.set(res.aggregator, (perAggAfter.get(res.aggregator) ?? 0) + 1);
				if (res.row.re_anchored) reAnchoredCount++;
			} else if (res.status === 'gate_reject') {
				const reason = res.reason ?? 'unknown';
				gateRejects.set(reason, (gateRejects.get(reason) ?? 0) + 1);
			} else if (res.status === 'below_floor') {
				belowFloorCount++;
			} else if (res.status === 'implausible') {
				implausibleCount++;
			} else if (res.status === 'pool_swapper_onchain') {
				poolSwapperOnchainCount++;
				if (res.poolSwapperAddress) poolSwapperAddresses.add(res.poolSwapperAddress);
			} else if (res.status === 'error') {
				errorCount++;
				if (done < 5) console.log(`  ERROR on ${batch[done % batch.length]?.tx_hash}: ${res.errorMsg}`);
			}
		}

		done += batch.length;
		if (done % 60 === 0 || done === rows.length) {
			console.log(`  ...${done}/${rows.length}  (inserted so far: ${inserted.length})`);
		}
	}

	// ── Step 4: Bulk insert into router_trades_gated ──
	console.log(`\nInserting ${inserted.length} rows into router_trades_gated (pre-Fix-B)...`);

	for (const row of inserted) {
		await sql`
			INSERT INTO router_trades_gated (
				tx_hash, aggregator, trader, original_trader, re_anchored,
				direction, settled_in, usdc_amount, weth_amount, realized_price,
				market_mid, all_in_cost_bps, block_number, gate_reason
			) VALUES (
				${row.tx_hash}, ${row.aggregator}, ${row.trader}, ${row.original_trader},
				${row.re_anchored}, ${row.direction}, ${row.settled_in},
				${row.usdc_amount}, ${row.weth_amount}, ${row.realized_price},
				${row.market_mid}, ${row.all_in_cost_bps}, ${row.block_number},
				${row.gate_reason}
			)
			ON CONFLICT (tx_hash) DO NOTHING
		`;
	}
	console.log('Insert complete.');

	// ── Step 5: Fix B — Multi-aggregator-contract filler filter (dataset-level pass) ──
	console.log('\n── Fix B: Multi-aggregator-contract filler filter ──');

	// Build per-swapper aggregator sets from the inserted rows
	const swapperAggs = new Map<string, Set<string>>();
	for (const row of inserted) {
		const trader = row.trader.toLowerCase();
		if (!swapperAggs.has(trader)) swapperAggs.set(trader, new Set());
		swapperAggs.get(trader)!.add(row.aggregator);
	}

	// Check each distinct swapper with 2+ aggregators
	const multiAggFillerAddresses: string[] = [];
	let multiAggFillerRowCount = 0;

	for (const [addr, aggs] of swapperAggs) {
		if (aggs.size < 2) continue;

		// Check if it's a contract
		const contract = await isContract(rpc, addr);
		if (!contract) {
			console.log(`  EOA on ${aggs.size} aggregators (kept): ${addr}`);
			continue;
		}

		// It's a contract on 2+ aggregators — filler/solver, delete
		multiAggFillerAddresses.push(addr);
		const rowsForAddr = inserted.filter(r => r.trader.toLowerCase() === addr);
		multiAggFillerRowCount += rowsForAddr.length;

		console.log(`  FILLER contract dropped: ${addr} (${rowsForAddr.length} rows across ${aggs.size} aggregators: ${[...aggs].join(', ')})`);

		// Delete from DB
		await sql`DELETE FROM router_trades_gated WHERE trader = ${addr}`;
	}

	console.log(`\n  Fix B summary: ${multiAggFillerAddresses.length} filler contracts, ${multiAggFillerRowCount} rows deleted.`);

	// Compute post-Fix-B per-aggregator counts
	const perAggFinal = new Map<string, number>();
	const finalRows = await sql`SELECT aggregator, count(*)::int as n FROM router_trades_gated GROUP BY aggregator`;
	for (const r of finalRows) {
		perAggFinal.set(r.aggregator as string, r.n as number);
	}

	const finalCount = await sql`SELECT count(*)::int as n FROM router_trades_gated`;
	const totalFinal = finalCount[0]!.n as number;

	// ── Step 6: Verify router_trades unchanged ──
	const afterCount = await sql`SELECT count(*)::int as n FROM router_trades`;
	console.log(`\nrouter_trades row count (after): ${afterCount[0]!.n}`);

	// ── Step 7: Report ──
	const totalProcessed = rows.length;
	const totalGateRejects = [...gateRejects.values()].reduce((a, b) => a + b, 0);

	console.log('\n══════════════════════════════════════════════════════════');
	console.log('  RE-EXTRACTION REPORT: router_trades → router_trades_gated');
	console.log('══════════════════════════════════════════════════════════');
	console.log(`\n  Total processed:           ${totalProcessed}`);
	console.log(`  Gate rejects:              ${totalGateRejects}`);
	console.log(`  Pool swapper (on-chain):   ${poolSwapperOnchainCount}   [Fix A]`);
	console.log(`  Below-floor drops:         ${belowFloorCount}`);
	console.log(`  Implausible drops:         ${implausibleCount}`);
	console.log(`  Errors:                    ${errorCount}`);
	console.log(`  Pre-Fix-B survivors:       ${inserted.length}`);
	console.log(`  Multi-agg filler (Fix B):  ${multiAggFillerRowCount}   [Fix B]`);
	console.log(`  ─────────────────────────────────`);
	console.log(`  FINAL survivors:           ${totalFinal}  (${(totalFinal / totalProcessed * 100).toFixed(1)}%)`);
	console.log(`  Re-anchored:               ${reAnchoredCount}`);

	console.log('\n  Gate reject breakdown:');
	for (const [reason, n] of [...gateRejects.entries()].sort((a, b) => b[1] - a[1])) {
		console.log(`    ${reason.padEnd(30)} ${n}`);
	}

	console.log('\n  Fix A — Pool/LP swapper addresses rejected on-chain:');
	for (const addr of [...poolSwapperAddresses].sort()) {
		console.log(`    ${addr}`);
	}

	console.log('\n  Fix B — Multi-aggregator filler contracts deleted:');
	for (const addr of multiAggFillerAddresses.sort()) {
		const aggs = swapperAggs.get(addr);
		const rowCount = inserted.filter(r => r.trader.toLowerCase() === addr).length;
		console.log(`    ${addr}  (${rowCount} rows, aggregators: ${[...(aggs ?? [])].join(', ')})`);
	}

	// Confirm 0x770004fe… is gone
	const target = '0x770004fe4411e42ea51a7fcaca32b267d791f3d4';
	const targetCheck = await sql`SELECT count(*)::int as n FROM router_trades_gated WHERE trader = ${target}`;
	console.log(`\n  Confirm 0x770004fe… gone: ${targetCheck[0]!.n === 0 ? 'YES (0 rows)' : `NO (${targetCheck[0]!.n} rows remain!)`}`);

	console.log('\n  Per-aggregator before → after (final):');
	const allAggs = new Set([...perAggBefore.keys(), ...perAggFinal.keys()]);
	for (const agg of [...allAggs].sort()) {
		const before = perAggBefore.get(agg) ?? 0;
		const after = perAggFinal.get(agg) ?? 0;
		const pct = before > 0 ? (after / before * 100).toFixed(1) : '0.0';
		console.log(`    ${agg.padEnd(12)} ${String(before).padStart(4)} → ${String(after).padStart(4)}  (${pct}%)`);
	}

	// ── Spot-print re-anchored rows ──
	const reAnchoredRows = inserted.filter(r => r.re_anchored);
	console.log(`\n  Re-anchored rows (${reAnchoredRows.length} total, showing up to 3):`);
	for (const r of reAnchoredRows.slice(0, 3)) {
		console.log(`    tx: ${r.tx_hash}`);
		console.log(`      original_trader: ${r.original_trader}`);
		console.log(`      new trader:      ${r.trader}`);
		console.log(`      direction: ${r.direction}  usdc: $${r.usdc_amount.toFixed(2)}  weth: ${r.weth_amount.toFixed(6)}  all_in_cost: ${r.all_in_cost_bps.toFixed(2)} bps`);
		console.log('');
	}

	// ── Handful confirmation ──
	const handfulHashes: Record<string, { num: string; agg: string; shouldPass: boolean }> = {
		'0x89628ee8e6b3a1b7c4c8ab8af5a5752c6de2ba7024ea0ff78a155a044c59aa8c': { num: '#2', agg: 'Odos', shouldPass: true },
		'0x8503cccf97055770c778183859da64a19983a9014185a29b0a30f6845cc1d86e': { num: '#6', agg: 'Relay', shouldPass: true },
		'0x15290f78247cf614f0531f8075d0949f572ae7ae22fd7bb19409f21435b9e282': { num: '#7', agg: '1inch', shouldPass: true },
		'0x55513d402ecdbc00fea0eaf68642442193aeff6385b48e9339745fedd66e965a': { num: '#1', agg: '1inch', shouldPass: false },
		'0xce4dbac465b0538d1d484f2c1c0553861301248dbb6596dd448adfbfc6d31686': { num: '#3', agg: 'Velora', shouldPass: false },
		'0x5bd00e22bab13fdf083525bb68633e6bf5dd581ae00a0f8b89329ada7065c2e9': { num: '#4', agg: 'Fabric', shouldPass: false },
		'0x850df6157d218bfb6cdfc2bb35cb59da640c6795447c0a89484b781a12a5cfcf': { num: '#5', agg: 'KyberSwap', shouldPass: false },
	};

	console.log('  Handful confirmation (7 curated txns):');
	for (const [hash, info] of Object.entries(handfulHashes)) {
		const found = await sql`SELECT * FROM router_trades_gated WHERE tx_hash = ${hash}`;
		const status = found.length > 0 ? 'PRESENT' : 'ABSENT';
		const expected = info.shouldPass ? 'PRESENT' : 'ABSENT';
		const ok = status === expected ? 'OK' : 'MISMATCH';
		const detail = found.length > 0
			? `trader=${(found[0]!.trader as string).slice(0, 10)}… re_anchored=${found[0]!.re_anchored}`
			: '';
		console.log(`    ${info.num} ${info.agg.padEnd(10)} ${status.padEnd(8)} expected=${expected.padEnd(8)} ${ok}  ${detail}`);
	}

	// ── Top-15 recurring-swapper report on final table ──
	console.log('\n  ── Top-15 recurring swappers (final table) ──');
	const top15 = await sql`
		SELECT trader, count(*)::int as trade_count,
		       array_agg(DISTINCT aggregator) as aggregators
		FROM router_trades_gated
		GROUP BY trader
		ORDER BY count(*) DESC
		LIMIT 15
	`;

	console.log(`  ${'Rank'.padEnd(5)} ${'Address'.padEnd(44)} ${'Trades'.padStart(6)} ${'Contract?'.padStart(10)} ${'#Aggs'.padStart(6)}  Aggregators`);
	console.log(`  ${'─'.repeat(5)} ${'─'.repeat(44)} ${'─'.repeat(6)} ${'─'.repeat(10)} ${'─'.repeat(6)}  ${'─'.repeat(30)}`);

	for (let idx = 0; idx < top15.length; idx++) {
		const r = top15[idx]!;
		const addr = r.trader as string;
		const count = r.trade_count as number;
		const aggs = r.aggregators as string[];
		const contract = await isContract(rpc, addr);

		console.log(`  ${String(idx + 1).padEnd(5)} ${addr.padEnd(44)} ${String(count).padStart(6)} ${(contract ? 'CONTRACT' : 'EOA').padStart(10)} ${String(aggs.length).padStart(6)}  ${aggs.join(', ')}`);
	}

	await sql.end();
	console.log('\nDone.');
}

main().catch(e => {
	console.error('Fatal:', e);
	process.exit(1);
});
