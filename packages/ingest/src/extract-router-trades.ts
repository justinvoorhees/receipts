import { readFileSync, writeFileSync } from 'fs';
import { extractTradeEndpointsFromReceipt } from './tradeEndpoints.js';
import { getBenchmarkMid } from './benchmarkPrice.js';
import { signedDeviationBps } from './priceMath.js';

/**
 * Stage 2 of router-centric discovery (spends Alchemy CU, but receipt-based —
 * no debug_trace). Reads the candidate hashes from stage 1, runs the
 * trade-endpoint extractor on each, keeps genuine USDC<->WETH trades, and prices
 * the all-in cost vs the market mid. Writes kept trades to CSV and prints a
 * per-aggregator survival summary.
 *
 * Cost guard: set MAX_CANDIDATES env to cap a trial run.
 */

const IN_PATH = '/tmp/router_candidates.json';
const OUT_CSV = '/tmp/router_trades.csv';
const CONCURRENCY = 8;
const MIN_NOTIONAL = process.env.MIN_NOTIONAL ? Number(process.env.MIN_NOTIONAL) : 1000;
// A genuine USDC↔WETH/ETH trade on a liquid pair can't plausibly cost more than
// this vs the market mid. Larger magnitudes are extraction artifacts — chiefly the
// ETH wrap-net proxy failing on routes with offsetting Deposit/Withdrawal events.
// (Proper native-ETH attribution needs the trace; deferred to v2.1.)
// Empirically, every exact-valuation (WETH) trade in the harvest fell within
// ±100 bps; only ETH wrap-net artifacts exceeded it. 100 cleanly separates real
// from artifact for this pair without clipping any genuine WETH trade.
const MAX_PLAUSIBLE_BPS = process.env.MAX_PLAUSIBLE_BPS ? Number(process.env.MAX_PLAUSIBLE_BPS) : 100;

interface Candidate {
	hash: `0x${string}`;
	aggregator: string;
}
interface KeptTrade {
	aggregator: string;
	txHash: string;
	trader: string;
	direction: string;
	settledIn: string;
	usdcAmount: number;
	wethAmount: number;
	realizedPrice: number;
	marketMid: number;
	allInCostBps: number;
	block: number;
}

async function processOne(rpcUrl: string, c: Candidate): Promise<
	| { status: 'kept'; trade: KeptTrade }
	| { status: 'below_floor'; aggregator: string }
	| { status: 'implausible'; aggregator: string }
	| { status: 'dropped'; aggregator: string; reason: string }
	| { status: 'error'; aggregator: string }
> {
	try {
		const r = await extractTradeEndpointsFromReceipt({ rpcUrl, txHash: c.hash });
		if (!r.kept) {
			const reason = (r.dropReason ?? 'unknown').replace(/ \(.*\)$/, ''); // strip counts
			return { status: 'dropped', aggregator: c.aggregator, reason };
		}
		const usdcAmount = Math.abs(Number(r.usdcAmountRaw)) / 1e6;
		// Apply the notional floor BEFORE pricing — saves the market-mid call on dust.
		if (usdcAmount < MIN_NOTIONAL) return { status: 'below_floor', aggregator: c.aggregator };
		const { marketMid } = await getBenchmarkMid({ rpcUrl, blockNumber: r.blockNumber });
		const allInCostBps = signedDeviationBps(r.direction!, marketMid, r.realizedPrice!);
		// Non-physical magnitude ⇒ extraction artifact (mostly ETH wrap-net proxy errors).
		if (Math.abs(allInCostBps) > MAX_PLAUSIBLE_BPS) return { status: 'implausible', aggregator: c.aggregator };
		return {
			status: 'kept',
			trade: {
				aggregator: c.aggregator,
				txHash: c.hash,
				trader: r.trader!,
				direction: r.direction!,
				settledIn: r.settledIn!,
				usdcAmount,
				wethAmount: Math.abs(Number(r.wethAmountRaw)) / 1e18,
				realizedPrice: r.realizedPrice!,
				marketMid,
				allInCostBps,
				block: Number(r.blockNumber),
			},
		};
	} catch {
		return { status: 'error', aggregator: c.aggregator };
	}
}

async function main(): Promise<void> {
	const rpcUrl = process.env.TCA_RPC_URL;
	if (!rpcUrl) throw new Error('TCA_RPC_URL not set');

	let candidates: Candidate[] = JSON.parse(readFileSync(IN_PATH, 'utf8'));

	// Per-aggregator random sampling (cost guard). PER_AGG_SAMPLE caps how many
	// candidates we process per aggregator; a deterministic seeded shuffle keeps
	// runs reproducible. Falls back to MAX_CANDIDATES (global head cap) if unset.
	const perAggSample = process.env.PER_AGG_SAMPLE ? Number(process.env.PER_AGG_SAMPLE) : null;
	if (perAggSample) {
		const byAgg = new Map<string, Candidate[]>();
		for (const c of candidates) {
			const arr = byAgg.get(c.aggregator) ?? [];
			arr.push(c);
			byAgg.set(c.aggregator, arr);
		}
		const sampled: Candidate[] = [];
		let seed = 1337;
		const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
		for (const [agg, arr] of byAgg) {
			// Fisher–Yates partial shuffle
			for (let i = arr.length - 1; i > 0; i--) {
				const j = Math.floor(rand() * (i + 1));
				[arr[i], arr[j]] = [arr[j]!, arr[i]!];
			}
			const take = arr.slice(0, perAggSample);
			sampled.push(...take);
			console.log(`  sample ${agg.padEnd(10)} ${take.length}/${arr.length}`);
		}
		candidates = sampled;
		console.log('');
	} else {
		const cap = process.env.MAX_CANDIDATES ? Number(process.env.MAX_CANDIDATES) : null;
		if (cap && candidates.length > cap) {
			console.log(`Capping ${candidates.length} → ${cap} candidates (MAX_CANDIDATES)\n`);
			candidates = candidates.slice(0, cap);
		}
	}
	console.log(`Extracting ${candidates.length} candidate txns (receipt-based)…\n`);

	const kept: KeptTrade[] = [];
	const droppedByReason = new Map<string, number>();
	const perAgg = new Map<string, { processed: number; kept: number; belowFloor: number; implausible: number; errors: number }>();
	let done = 0;

	for (let i = 0; i < candidates.length; i += CONCURRENCY) {
		const batch = candidates.slice(i, i + CONCURRENCY);
		const results = await Promise.all(batch.map((c) => processOne(rpcUrl, c)));
		for (const res of results) {
			const agg = res.status === 'kept' ? res.trade.aggregator : res.aggregator;
			const a = perAgg.get(agg) ?? { processed: 0, kept: 0, belowFloor: 0, implausible: 0, errors: 0 };
			a.processed++;
			if (res.status === 'kept') { a.kept++; kept.push(res.trade); }
			else if (res.status === 'below_floor') a.belowFloor++;
			else if (res.status === 'implausible') a.implausible++;
			else if (res.status === 'error') a.errors++;
			else droppedByReason.set(res.reason, (droppedByReason.get(res.reason) ?? 0) + 1);
			perAgg.set(agg, a);
		}
		done += batch.length;
		if (done % 200 === 0 || done === candidates.length) {
			console.log(`  …${done}/${candidates.length}  (kept so far: ${kept.length})`);
		}
	}

	// Write CSV
	const header = 'aggregator,txHash,trader,direction,settledIn,usdcAmount,wethAmount,realizedPrice,marketMid,allInCostBps,block\n';
	const body = kept
		.map((t) => `${t.aggregator},${t.txHash},${t.trader},${t.direction},${t.settledIn},${t.usdcAmount.toFixed(2)},${t.wethAmount.toFixed(8)},${t.realizedPrice.toFixed(4)},${t.marketMid.toFixed(4)},${t.allInCostBps.toFixed(4)},${t.block}`)
		.join('\n');
	writeFileSync(OUT_CSV, header + body + '\n');

	console.log(`\n=== SURVIVAL BY AGGREGATOR (kept = genuine USDC↔WETH/ETH ≥ $${MIN_NOTIONAL}) ===`);
	for (const [agg, s] of perAgg) {
		console.log(`  ${agg.padEnd(10)} processed ${String(s.processed).padStart(6)}  kept ${String(s.kept).padStart(5)}  belowFloor ${String(s.belowFloor).padStart(5)}  implausible ${String(s.implausible).padStart(3)}  errors ${s.errors}`);
	}
	console.log('\n=== DROP REASONS ===');
	for (const [reason, n] of [...droppedByReason.entries()].sort((a, b) => b[1] - a[1])) {
		console.log(`  ${reason.padEnd(30)} ${n}`);
	}

	const wethN = kept.filter((t) => t.settledIn === 'WETH').length;
	const ethN = kept.filter((t) => t.settledIn === 'ETH').length;
	const costs = kept.map((t) => t.allInCostBps).sort((a, b) => a - b);
	const median = costs.length ? costs[Math.floor(costs.length / 2)]! : 0;
	const mean = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : 0;
	console.log(`\n=== KEPT TRADES ≥ $${MIN_NOTIONAL}: ${kept.length}  (WETH ${wethN}, ETH ${ethN}) ===`);
	console.log(`  all-in cost bps — median ${median.toFixed(2)}, mean ${mean.toFixed(2)}, min ${costs[0]?.toFixed(2) ?? '-'}, max ${costs[costs.length - 1]?.toFixed(2) ?? '-'}`);
	console.log(`  CSV: ${OUT_CSV}`);
}

main().catch((e) => {
	console.error('Fatal:', e);
	process.exit(1);
});
