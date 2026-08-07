/**
 * preTxRulerError.mjs — is the N−1 block lag actually costing us anything?
 *                       And what did the trade itself move?  [needs RPC]
 *
 * Mids sample at block N−1 (end of the prior block), so intra-block ordering and
 * same-block flow ahead of the trade are invisible. This rolls each V3-style leg
 * back to its EXACT pre-tx sqrtPriceX96 — via the pool's own Swap logs in block
 * N, split at our own logIndex — and compares.
 *
 * ⚡ NEGATIVE RESULT, 2026-07-30: ruler error is median 0.00 bps, max 6.9,
 * only 2/75 legs over 1 bps. The N−1 lag is NOT a source of the residual.
 * Do not build 3-block (N−1/N/N+1) sampling to "fix" it — there is nothing to fix.
 *
 * What IS worth having is the second number: own footprint (post-tx vs pre-tx on
 * the pool we traded) = median 2.96 bps, max 586.7. That is an isolated
 * "your trade moved this pool X bps", and the post-tx price is FREE — every Swap
 * decoder already decodes sqrtPriceX96 and discards it (tradeDecoders.ts:71).
 *
 * Superseded 2026-08-06 — re-measure against the frozen 62-receipt corpus
 * (docs/qa/corpus.json); the figures above were measured over a ≤40-receipt
 * (75-leg) sample from the old default `--limit`, not the full 62-receipt
 * corpus this script now runs over by default.
 *
 * The corpus (docs/qa/corpus.json) is frozen — it no longer grows — so
 * --limit is now a convenience for spot checks rather than a bound on an
 * unbounded table. It defaults to the full corpus and, when set, takes the
 * most recent N rows by id.
 *
 *   node scripts/analysis/preTxRulerError.mjs [--limit=N]
 */
import { loadCorpus, core, env, median } from './_env.mjs';

const CORPUS = loadCorpus();
const limit = Number((process.argv.find((a) => a.startsWith('--limit=')) ?? `--limit=${CORPUS.length}`).slice(8));

const UNI_V3_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const PANCAKE_V3_SWAP = '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83';
const isV3Swap = (l) => [UNI_V3_SWAP, PANCAKE_V3_SWAP].includes(l.topics?.[0]?.toLowerCase());
/** sqrtPriceX96 is the 3rd 32-byte word of the Swap payload (amount0, amount1, sqrtPriceX96, …). */
const sqrtFromData = (d) => BigInt('0x' + d.slice(2).slice(128, 192));

const { createPublicClient, http } = await import('viem');
const { base } = await import('viem/chains');
const { readSlot0 } = await core('poolDiscovery.js');
const client = createPublicClient({ chain: base, transport: http(env.TCA_RPC_URL) });

const rows = limit === 0 ? [] : CORPUS.filter((r) => r.route_legs != null && r.block_number != null).slice(-limit);

const rulerErrs = [], footprints = [], flagged = [];
let examined = 0, withNeighbours = 0;

for (const r of rows) {
	const N = BigInt(r.block_number);
	const receipt = await client.getTransactionReceipt({ hash: r.tx_hash });
	for (const ourLog of receipt.logs.filter(isV3Swap)) {
		const pool = ourLog.address.toLowerCase();
		const swaps = (await client.getLogs({ address: pool, fromBlock: N, toBlock: N }))
			.filter(isV3Swap).sort((a, b) => Number(a.logIndex) - Number(b.logIndex));
		const i = swaps.findIndex((s) => Number(s.logIndex) === Number(ourLog.logIndex));
		if (i < 0) continue;
		examined++;

		const before = swaps.slice(0, i), after = swaps.slice(i + 1);
		if (before.length || after.length) withNeighbours++;

		const sqrtPrev = await readSlot0(client, pool, N - 1n);        // what the ruler uses today
		if (sqrtPrev === null) continue;
		const sqrtPre = before.length ? sqrtFromData(before.at(-1).data) : sqrtPrev; // EXACT pre-tx
		const sqrtPost = sqrtFromData(ourLog.data);                    // EXACT post-tx, free

		const bps = (a, b) => Number(a - b) / Number(b) * 10000 * 2;   // price ~ sqrt², hence ×2
		const rulerErr = bps(sqrtPre, sqrtPrev);
		const footprint = bps(sqrtPost, sqrtPre);
		rulerErrs.push(rulerErr); footprints.push(footprint);
		if (Math.abs(rulerErr) > 1) {
			flagged.push({ tx: r.tx_hash.slice(0, 10), pool: pool.slice(0, 10), before: before.length, after: after.length, rulerErr, footprint, slip: r.slippage_bps == null ? null : Number(r.slippage_bps) });
		}
	}
}

const abs = (a) => a.map(Math.abs);
console.log(`V3-style legs examined: ${examined}`);
console.log(`legs sharing their block-N pool with OTHER swaps: ${withNeighbours}/${examined}\n`);
console.log(`ruler error (exact pre-tx vs the N−1 mid): median=${median(abs(rulerErrs)).toFixed(2)}bps  max=${Math.max(...abs(rulerErrs)).toFixed(1)}  >1bps: ${abs(rulerErrs).filter((v) => v > 1).length}/${rulerErrs.length}`);
console.log(`own footprint (post-tx vs pre-tx)        : median=${median(abs(footprints)).toFixed(2)}bps  max=${Math.max(...abs(footprints)).toFixed(1)}`);

if (flagged.length) {
	console.log('\nlegs where the N−1 ruler was off by >1bps');
	console.log('tx          pool        before after  rulerErr  footprint  receipt_slip');
	for (const f of flagged) {
		console.log(`${f.tx}  ${f.pool}  ${String(f.before).padStart(6)} ${String(f.after).padStart(5)} ${f.rulerErr.toFixed(2).padStart(9)} ${f.footprint.toFixed(2).padStart(10)} ${String(f.slip?.toFixed(1) ?? '·').padStart(13)}`);
	}
	console.log('\n⚠️ before/after neighbours are NOT proof of a sandwich — the strongest');
	console.log('   candidate in the corpus had 4 distinct EOAs. 0 confirmed cases in 75 legs.');
}
