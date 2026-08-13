/**
 * referenceDepthDistribution.mjs — how deep is the pool the Market Price ruler
 * actually uses, across the whole corpus?  [needs RPC]
 *
 * Written to calibrate the reference-pool depth floor
 * (docs/superpowers/specs/2026-08-11-reference-pool-depth-floor-design.md).
 * That spec proposes an absolute $1,000 USD floor on the ranked winner, but the
 * only datum near the threshold was receipt 253 at $183 — every other known case
 * ($0.216, $0.0113) is caught by any floor above a dollar. A constant that
 * silently turns receipts off should be set from a distribution, not one point.
 *
 * For each case this re-runs the SELECTION half of the bridged estimator
 * at the receipt's own refBlock (block_number - 1) and values the winner's
 * `balanceOf(refToken)` depth in USD:
 *
 *   anchor  = midViaDeepest(WETH, USDC)      -> wethUsd, and its own depth
 *   perSide = getDeepestPoolWithDepth(tok, WETH) for each non-anchored side
 *   direct  = getDeepestPoolWithDepth(in, out)
 *
 * The BINDING depth is the minimum across the pools that receipt actually
 * needed, because `usdRef` gates each side independently — a receipt is only as
 * well-benchmarked as its thinnest required pool. That is the number the floor
 * would be compared against, so that is the number to build the histogram from.
 *
 * Read-only. The input/output token pair, tier and notional are decoder output
 * (not on a case), so this now runs a full decode per case via
 * loadCasesDecoded() before doing its own discovery + balanceOf round trips —
 * slower than the old frozen-corpus-annotations version, and that is correct:
 * a stale pair would silently benchmark the wrong depth.
 *
 * ⚠️ SERIAL on purpose. Concurrency makes discovery reads fail transiently and
 * `catch -> null` turns that into "no such pool", which would silently understate
 * depth — the same trap decodeGolden.mjs documents at length.
 *
 *   node scripts/analysis/referenceDepthDistribution.mjs [--limit=N] [--json=out.json]
 */
import { writeFileSync } from 'node:fs';
import { env, core, loadCasesDecoded, parseLimitFlag } from './_env.mjs';

const flag = (name, dflt) => {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : dflt;
};

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const NATIVE = '0x0000000000000000000000000000000000000000';
const isAnchor = (t) => [WETH, USDC, NATIVE, 'native'].includes(String(t).toLowerCase());

const { createPublicClient, http } = await import('viem');
const { base } = await import('viem/chains');
const { getDeepestPoolWithDepth } = await core('poolDiscovery.js');
const { midViaDeepest, makeRpcDecimalsCache } = await core('tokenPricing.js');
const { readSlot0, readV2Reserves } = await core('poolDiscovery.js');
const { pickReferenceToken } = await core('poolFamilies.js');

if (!env.TCA_RPC_URL) throw new Error('TCA_RPC_URL missing from the repo-root .env');
const client = createPublicClient({ chain: base, transport: http(env.TCA_RPC_URL) });
const decimals = makeRpcDecimalsCache(client);

const readers = {
	getDeepestPoolWithDepth: async (a, b, block) => {
		const best = await getDeepestPoolWithDepth(client, a, b, block);
		return best ? { address: best.pool.address, depth: best.depth, kind: best.pool.kind } : null;
	},
	readSlot0: (p, b) => readSlot0(client, p, b),
	readV2Reserves: (p, b) => readV2Reserves(client, p, b),
	readDecimals: decimals,
};

/** Value a balanceOf(refToken) depth in USD. Null when refToken isn't free-priceable. */
const depthUsd = (refToken, raw, wethUsd) => {
	const t = String(refToken).toLowerCase();
	if (t === USDC) return Number(raw) / 1e6;
	if (t === WETH || t === NATIVE) return (Number(raw) / 1e18) * wethUsd;
	return null; // volatile refToken -> DEPTH_UNVERIFIED
};

const norm = (t) => (String(t).toLowerCase() === 'native' ? NATIVE : String(t).toLowerCase());

const rows = (await loadCasesDecoded({ limit: parseLimitFlag() })).filter(
	(r) => r.block_number != null && r._receipt?.inputToken && r._receipt?.outputToken,
);

const out = [];
let n = 0;
for (const r of rows) {
	const receipt = r._receipt;
	const refBlock = BigInt(r.block_number) - 1n;
	const inTok = norm(receipt.inputToken);
	const outTok = norm(receipt.outputToken);
	const rec = {
		id: r.id ?? '·', tx: r.tx_hash, pair: `${receipt.inputSymbol}->${receipt.outputSymbol}`,
		tier: r.tier, allInCostBps: r.all_in_cost_bps == null ? null : Number(r.all_in_cost_bps),
		notionalUsd: r.notional_usd == null ? null : Number(r.notional_usd),
		sides: [], bindingUsd: null, unverifiable: false, error: null,
	};
	try {
		const anchor = await midViaDeepest(readers, WETH, USDC, refBlock);
		if (!anchor) throw new Error('anchor null');
		const wethUsd = anchor.price;
		const anchorDisc = await readers.getDeepestPoolWithDepth(WETH, USDC, refBlock);
		rec.wethUsd = wethUsd;
		rec.anchorUsd = anchorDisc ? depthUsd(pickReferenceToken(WETH, USDC), anchorDisc.depth, wethUsd) : null;

		const needed = [];
		for (const [label, tok] of [['in', inTok], ['out', outTok]]) {
			if (isAnchor(tok)) { rec.sides.push({ label, tok, kind: 'anchored', usd: null }); continue; }
			const disc = await readers.getDeepestPoolWithDepth(tok, WETH, refBlock);
			if (!disc) { rec.sides.push({ label, tok, kind: 'no-pool', usd: null }); continue; }
			const ref = pickReferenceToken(tok, WETH);
			const usd = depthUsd(ref, disc.depth, wethUsd);
			rec.sides.push({ label, tok, kind: 'bridged', pool: disc.address, poolKind: disc.kind, rawDepth: String(disc.depth), usd });
			if (usd == null) rec.unverifiable = true; else needed.push(usd);
		}

		const direct = await readers.getDeepestPoolWithDepth(inTok, outTok, refBlock);
		if (direct) {
			const ref = pickReferenceToken(inTok, outTok);
			const usd = depthUsd(ref, direct.depth, wethUsd);
			rec.direct = { pool: direct.address, poolKind: direct.kind, rawDepth: String(direct.depth), refToken: ref, usd };
		} else {
			rec.direct = null;
		}

		rec.bindingUsd = needed.length ? Math.min(...needed) : null;
	} catch (e) {
		rec.error = String(e).slice(0, 120);
	}
	out.push(rec);
	process.stderr.write(`${++n}/${rows.length} id=${rec.id} ${rec.pair} binding=${rec.bindingUsd == null ? '·' : '$' + rec.bindingUsd.toFixed(2)}\n`);
}

// ── report ───────────────────────────────────────────────────────────────────
const gated = out.filter((r) => r.bindingUsd != null).sort((a, b) => a.bindingUsd - b.bindingUsd);
const anchoredOnly = out.filter((r) => r.bindingUsd == null && !r.error);
const errored = out.filter((r) => r.error);

console.log(`\ncorpus rows            : ${out.length}`);
console.log(`both sides anchored    : ${anchoredOnly.length}  (no bridged pool needed; floor never applies)`);
console.log(`errored                : ${errored.length}`);
console.log(`depth-gated receipts   : ${gated.length}\n`);

console.log('BINDING reference depth, ascending:');
console.log('  id     pair                       binding_usd     notional_usd   allInCostBps  tier');
for (const r of gated) {
	console.log(
		`  ${String(r.id).padEnd(6)} ${String(r.pair).slice(0, 25).padEnd(25)} ` +
		`${('$' + r.bindingUsd.toFixed(2)).padStart(14)} ${(r.notionalUsd == null ? '·' : '$' + r.notionalUsd.toFixed(2)).padStart(14)} ` +
		`${(r.allInCostBps == null ? '·' : r.allInCostBps.toFixed(1)).padStart(13)}  ${r.tier}`,
	);
}

const CUTS = [1, 10, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 50_000];
console.log('\nfloor candidate -> receipts that would LOSE their market price (of the depth-gated set):');
for (const c of CUTS) {
	const hit = gated.filter((r) => r.bindingUsd < c);
	const pctGated = (100 * hit.length / (gated.length || 1)).toFixed(0);
	const pctAll = (100 * hit.length / out.length).toFixed(0);
	console.log(`  $${String(c).padEnd(7)} ${String(hit.length).padStart(3)}/${gated.length} gated (${pctGated.padStart(3)}%)   ${String(hit.length).padStart(3)}/${out.length} corpus (${pctAll.padStart(3)}%)`);
}

const q = (p) => gated.length ? gated[Math.floor(p * (gated.length - 1))].bindingUsd : NaN;
console.log(`\nquantiles of binding depth: p0 $${q(0).toFixed(2)}  p10 $${q(0.1).toFixed(2)}  p25 $${q(0.25).toFixed(2)}  ` +
	`p50 $${q(0.5).toFixed(2)}  p75 $${q(0.75).toFixed(2)}  p90 $${q(0.9).toFixed(2)}  p100 $${q(1).toFixed(2)}`);

const unver = out.filter((r) => r.unverifiable);
console.log(`\ndepth UNVERIFIABLE (volatile refToken, would emit DEPTH_UNVERIFIED): ${unver.length}` +
	(unver.length ? ` — ids ${unver.map((r) => r.id).join(', ')}` : ''));

const jsonOut = flag('json', null);
if (jsonOut) { writeFileSync(jsonOut, JSON.stringify(out, null, 2)); console.log(`\nwrote ${jsonOut}`); }
