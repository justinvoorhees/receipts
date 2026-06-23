import { readFileSync, writeFileSync } from 'fs';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { decodeTransferLogs, USDC, WETH, DENYLIST } from './tradeEndpoints.js';

/**
 * Drop diagnostic (receipt-based). Re-samples the same 500/aggregator set and
 * classifies EVERY tx into:
 *   KEPT_USDC_WETH  — genuine USDC<->WETH (both ERC-20), the extractor's "kept"
 *   LIKELY_ETH      — trader's only ERC-20 leg is USDC, AND the tx wraps/unwraps
 *                     WETH (Deposit/Withdrawal event) ⇒ the other leg is native
 *                     ETH. These are genuine USDC<->ETH trades we currently drop.
 *   ROUTING_HOP     — a third token is involved ⇒ WETH was a mid-route hop
 *   AMBIGUOUS       — multiple clean USDC/WETH anchors (batch/split/MM)
 *   OTHER           — none of the above
 *
 * Reports counts per class + the SIZE distribution of LIKELY_ETH vs KEPT — the
 * key question: are large trades truly rare, or hidden behind the ETH wrapper?
 */

const PER_AGG_SAMPLE = 500;
const IN_PATH = '/tmp/router_candidates.json';
const OUT_CSV = '/tmp/diagnosis.csv';
const CONCURRENCY = 8;

// WETH wrap/unwrap event topic0s
const WITHDRAWAL_TOPIC = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65'; // Withdrawal(address,uint256)
const DEPOSIT_TOPIC = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c'; // Deposit(address,uint256)

const USDC_DUST_RAW = 100n; // 1e-4 USDC
const WETH_DUST_RAW = 10_000_000_000n; // 1e-8 WETH
const absBI = (n: bigint) => (n < 0n ? -n : n);

interface Candidate { hash: `0x${string}`; aggregator: string; }
type Klass = 'KEPT_USDC_WETH' | 'LIKELY_ETH' | 'ROUTING_HOP' | 'AMBIGUOUS' | 'OTHER';

interface Diag {
	aggregator: string;
	klass: Klass;
	/** trade size in USDC (|USDC delta| of the chosen anchor), if determinable */
	usdcSize: number;
}

function classify(aggregator: string, transfers: ReturnType<typeof decodeTransferLogs>, hasWrap: boolean): Diag {
	// per-address per-token net deltas
	const deltas = new Map<string, Map<string, bigint>>();
	for (const t of transfers) {
		const tok = t.token.toLowerCase();
		for (const [addr, sign] of [[t.from.toLowerCase(), -1n], [t.to.toLowerCase(), 1n]] as const) {
			if (!deltas.has(addr)) deltas.set(addr, new Map());
			const m = deltas.get(addr)!;
			m.set(tok, (m.get(tok) ?? 0n) + sign * t.value);
		}
	}

	let thirdTokenSeen = false;
	const cleanUsdcWeth: { addr: string; usdc: bigint }[] = [];
	const usdcOnly: { addr: string; usdc: bigint }[] = [];

	for (const [addr, m] of deltas) {
		if (DENYLIST.has(addr)) continue;
		const usdc = m.get(USDC) ?? 0n;
		const weth = m.get(WETH) ?? 0n;
		let third = false;
		for (const [tok, v] of m) {
			if (tok === USDC || tok === WETH) continue;
			if (v !== 0n) { third = true; thirdTokenSeen = true; }
		}
		const usdcSig = absBI(usdc) >= USDC_DUST_RAW;
		const wethSig = absBI(weth) >= WETH_DUST_RAW;
		if (third) continue;
		if (usdcSig && wethSig && ((usdc > 0n) !== (weth > 0n))) {
			cleanUsdcWeth.push({ addr, usdc });
		} else if (usdcSig && !wethSig) {
			usdcOnly.push({ addr, usdc });
		}
	}

	const sizeOf = (raw: bigint) => Math.abs(Number(raw)) / 1e6;

	if (cleanUsdcWeth.length === 1) {
		return { aggregator, klass: 'KEPT_USDC_WETH', usdcSize: sizeOf(cleanUsdcWeth[0]!.usdc) };
	}
	if (cleanUsdcWeth.length > 1) {
		const big = cleanUsdcWeth.sort((a, b) => Number(absBI(b.usdc) - absBI(a.usdc)))[0]!;
		return { aggregator, klass: 'AMBIGUOUS', usdcSize: sizeOf(big.usdc) };
	}
	// No clean USDC<->WETH anchor.
	if (hasWrap && usdcOnly.length >= 1) {
		const big = usdcOnly.sort((a, b) => Number(absBI(b.usdc) - absBI(a.usdc)))[0]!;
		return { aggregator, klass: 'LIKELY_ETH', usdcSize: sizeOf(big.usdc) };
	}
	if (thirdTokenSeen) return { aggregator, klass: 'ROUTING_HOP', usdcSize: 0 };
	return { aggregator, klass: 'OTHER', usdcSize: 0 };
}

function sample(candidates: Candidate[]): Candidate[] {
	const byAgg = new Map<string, Candidate[]>();
	for (const c of candidates) {
		const arr = byAgg.get(c.aggregator) ?? [];
		arr.push(c);
		byAgg.set(c.aggregator, arr);
	}
	let seed = 1337; // same seed as the extractor → same 3,500 txns
	const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
	const out: Candidate[] = [];
	for (const [, arr] of byAgg) {
		for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [arr[i], arr[j]] = [arr[j]!, arr[i]!]; }
		out.push(...arr.slice(0, PER_AGG_SAMPLE));
	}
	return out;
}

async function main(): Promise<void> {
	const rpcUrl = process.env.TCA_RPC_URL;
	if (!rpcUrl) throw new Error('TCA_RPC_URL not set');
	const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

	const candidates = sample(JSON.parse(readFileSync(IN_PATH, 'utf8')));
	console.log(`Diagnosing ${candidates.length} txns (receipt-based)…\n`);

	const results: Diag[] = [];
	let done = 0;
	for (let i = 0; i < candidates.length; i += CONCURRENCY) {
		const batch = candidates.slice(i, i + CONCURRENCY);
		const out = await Promise.all(batch.map(async (c): Promise<Diag> => {
			try {
				const receipt = await client.getTransactionReceipt({ hash: c.hash });
				const transfers = decodeTransferLogs(receipt.logs);
				const hasWrap = receipt.logs.some(
					(l) => l.address.toLowerCase() === WETH && (l.topics[0] === WITHDRAWAL_TOPIC || l.topics[0] === DEPOSIT_TOPIC),
				);
				return classify(c.aggregator, transfers, hasWrap);
			} catch {
				return { aggregator: c.aggregator, klass: 'OTHER', usdcSize: 0 };
			}
		}));
		results.push(...out);
		done += batch.length;
		if (done % 500 === 0 || done === candidates.length) console.log(`  …${done}/${candidates.length}`);
	}

	// Tally
	const classes: Klass[] = ['KEPT_USDC_WETH', 'LIKELY_ETH', 'ROUTING_HOP', 'AMBIGUOUS', 'OTHER'];
	const overall = new Map<Klass, number>();
	for (const k of classes) overall.set(k, 0);
	for (const r of results) overall.set(r.klass, overall.get(r.klass)! + 1);

	console.log('\n=== CLASS BREAKDOWN (overall, of ' + results.length + ') ===');
	for (const k of classes) console.log(`  ${k.padEnd(16)} ${String(overall.get(k)).padStart(5)}  (${(100 * overall.get(k)! / results.length).toFixed(1)}%)`);

	const sizeDist = (klass: Klass) => {
		const sizes = results.filter((r) => r.klass === klass).map((r) => r.usdcSize);
		const at = (t: number) => sizes.filter((s) => s >= t).length;
		return { n: sizes.length, ge1k: at(1000), ge10k: at(10000) };
	};
	const ke = sizeDist('KEPT_USDC_WETH');
	const le = sizeDist('LIKELY_ETH');
	console.log('\n=== SIZE: are large trades hidden as ETH? (of 3,500 sampled) ===');
	console.log(`  KEPT_USDC_WETH : n=${ke.n}  >=\$1k ${ke.ge1k}  >=\$10k ${ke.ge10k}`);
	console.log(`  LIKELY_ETH     : n=${le.n}  >=\$1k ${le.ge1k}  >=\$10k ${le.ge10k}`);
	console.log(`  COMBINED >=\$10k: ${ke.ge10k + le.ge10k}   (vs ${ke.ge10k} with WETH-only filter)`);

	console.log('\n=== LIKELY_ETH per aggregator (>=\$1k / >=\$10k) ===');
	const aggs = [...new Set(results.map((r) => r.aggregator))].sort();
	for (const a of aggs) {
		const s = results.filter((r) => r.aggregator === a && r.klass === 'LIKELY_ETH').map((r) => r.usdcSize);
		console.log(`  ${a.padEnd(11)} n=${String(s.length).padStart(4)}  >=\$1k ${s.filter((x) => x >= 1000).length}  >=\$10k ${s.filter((x) => x >= 10000).length}`);
	}

	writeFileSync(OUT_CSV, 'aggregator,class,usdcSize\n' + results.map((r) => `${r.aggregator},${r.klass},${r.usdcSize.toFixed(2)}`).join('\n') + '\n');
	console.log(`\nCSV: ${OUT_CSV}`);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
