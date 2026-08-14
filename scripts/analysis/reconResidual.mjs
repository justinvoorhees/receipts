/**
 * reconResidual.mjs — how far apart are the two rulers?
 *
 * `reconResidualBps` (decomposeRoute.ts:655) is the gap between the
 * REFERENCE-POOL ruler (`allInCostBps`) and the ROUTE-RELATIVE reconstruction
 * (Σ leg LP fee + Σ leg price impact, each measured against its own pool's mid).
 *
 * The point of this script is the near-identity with `slippage_bps`. It is
 * algebra, not coincidence:
 *     slippage = allIn − lpFee − aggFee
 *     recon    = allIn − (Σ legLp + Σ legPI + aggFee)
 *   ⇒ recon   = slippage − Σ legPI, and Σ legPI is small (median ~3 bps)
 *
 * ⇒ the unattributed residual IS the ruler disagreement. Switching to a
 * route-relative ruler would not explain it, it would DELETE it — and such a
 * ruler is tautological anyway (AMM output is a deterministic function of
 * reserves and amountIn). Do not "fix" the single market ruler.
 *
 * Baseline 2026-07-30: |recon| median 17.41 p90 183.75; |slippage| p90 183.68.
 * Superseded 2026-08-06 — re-measure against the corpus set (docs/qa/cases.json,
 * filtered on `corpusId != null` — NOT `source === 'corpus-v1'`, which matches
 * only 61 of the 62 entries; see the `filter` below and `_env.mjs`); this
 * baseline was measured against the live table at the time, a different row
 * set than that.
 *
 *   node scripts/analysis/reconResidual.mjs
 */
import { loadCasesDecoded, parseLimitFlag, num, quantile } from './_env.mjs';

const decoded = await loadCasesDecoded({
	limit: parseLimitFlag(),
	// The original corpus set — every entry carrying a `corpusId` — and
	// deliberately NOT the hand-written cases that were never part of it.
	// Test on `corpusId`, not `source`: entry 485 was in the original corpus
	// AND was already a hand-written case before the migration, so it carries
	// a `corpusId` but no `source: 'corpus-v1'` tag. It IS itself a
	// pathological case (tags no-route, relay, one-uncosted-leg), but it
	// belongs in the sample because it was always in the corpus baseline —
	// its inclusion is faithful, not a new bias. The bias being avoided is
	// the other six hand-written cases, which were never in the corpus.
	// Those are curated pathologies — zero-leg routes, dust reference pools,
	// truncated cyclic routes — and this script measures the RATE of exactly
	// those. Mixing them in moves every rate by changing the sample rather
	// than the code, which is indistinguishable from a real regression in
	// the output.
	filter: (c) => c.corpusId != null,
});
console.log(`sample: ${decoded.length} corpus-v1 receipts decoded (hand-written diagnostic cases excluded)`);
const rows = decoded.filter((r) => r.route_legs != null);

const withRecon = rows.filter((r) => r.recon_residual_bps != null);
console.log(`receipts with legs: ${rows.length}`);
console.log(`  recon computable (all legs priced, no RFQ): ${withRecon.length}  (${(100 * withRecon.length / rows.length).toFixed(0)}%)`);
console.log(`  NOT computable                            : ${rows.length - withRecon.length}   <- a coverage signal in itself`);

const dist = (label, xs) => {
	const a = xs.map(Math.abs).sort((x, y) => x - y);
	if (!a.length) return;
	console.log(`  ${label.padEnd(10)} median=${quantile(a, 0.5).toFixed(2)}  p75=${quantile(a, 0.75).toFixed(2)}  p90=${quantile(a, 0.9).toFixed(2)}  max=${quantile(a, 1).toFixed(1)}`);
	for (const t of [1, 5, 25, 100]) {
		const n = a.filter((v) => v > t).length;
		console.log(`      >${String(t).padStart(3)}bps: ${String(n).padStart(3)}/${a.length}  (${(100 * n / a.length).toFixed(0)}%)`);
	}
};

console.log('\n|recon_residual| = |reference-pool ruler − route-relative reconstruction|');
dist('recon', withRecon.map((r) => num(r.recon_residual_bps)));
console.log('\n|slippage_bps| (the plug) — compare the p90s, they are the same quantity');
dist('slippage', rows.map((r) => num(r.slippage_bps)).filter((v) => v != null));

console.log('\nWORST DISAGREEMENTS');
console.log(' id  shape     tier         allIn    slip    recon  conf    notional');
for (const r of withRecon.sort((a, b) => Math.abs(num(b.recon_residual_bps)) - Math.abs(num(a.recon_residual_bps))).slice(0, 10)) {
	console.log(`${String(r.id).padStart(3)}  ${String(r.route_shape).padEnd(9)} ${String(r.tier).padEnd(10)} ${String(num(r.all_in_cost_bps)?.toFixed(1)).padStart(8)} ${String(num(r.slippage_bps)?.toFixed(1)).padStart(7)} ${String(num(r.recon_residual_bps).toFixed(1)).padStart(8)}  ${String(r.decomp_confidence).padEnd(6)} $${num(r.notional_usd)?.toFixed(0)}`);
}
console.log('\n⚠️ the tail is contaminated: the worst rows are all conf=low and several are $0-$3 junk.');
console.log('   Trust the median, not the max.');
