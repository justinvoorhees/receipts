/**
 * attributionCoverage.mjs — what fraction of each route did we actually price?
 *
 * The prototype for worklist item 1 in docs/attribution-worklist.md. Pure
 * arithmetic over persisted legs; no RPC. Reports BOTH dimensions, because they
 * are different sets and conflating them is what produced the false "coverage is
 * saturated" reading:
 *
 *   LP fee       — feeTierBps > 0, or the explicit feeResolved flag when present
 *   price impact — priceImpactBps != null
 *
 * ⚠️ Test `feeTierBps > 0`, NEVER `!= null`. A leg with feeTierBps: 0 passes a
 * null check and reads as "measured" when it is exactly the failure case.
 *
 * Also reports the `.some()` vs `.every()` defect: receiptDisplay.tsx gates the
 * price-impact subtraction on SOME leg being priced, so a partially-priced route
 * silently treats its unpriced legs as exactly zero impact.
 *
 * Baseline at 2026-07-30 (62 receipts): LP fee 76.6%, price impact 83.5%,
 * 13 receipts with no leg priced, 7 partially priced (silently wrong), 42 clean.
 * Superseded 2026-08-06 — re-measure against the corpus-v1 case set
 * (docs/qa/cases.json, source: 'corpus-v1'); the old figures describe a
 * 62-row set that is NOT this one.
 *
 *   node scripts/analysis/attributionCoverage.mjs
 */
import { loadCasesDecoded, parseLimitFlag, costedLegs, priceImpactCoverage, num } from './_env.mjs';

const decoded = await loadCasesDecoded({
	limit: parseLimitFlag(),
	// The v1 corpus set, and deliberately NOT the hand-written cases. Those are
	// curated pathologies — zero-leg routes, dust reference pools, truncated
	// cyclic routes — and this script measures the RATE of exactly those. Mixing
	// them in moves every rate by changing the sample rather than the code, which
	// is indistinguishable from a real regression in the output.
	filter: (c) => c.source === 'corpus-v1',
});
console.log(`sample: ${decoded.length} corpus-v1 receipts decoded (hand-written diagnostic cases excluded)`);
const rows = decoded.filter((r) => r.route_legs != null);

const pct = (v) => `${(100 * v).toFixed(0).padStart(3)}%`;
const out = [];

for (const r of rows) {
	const legs = costedLegs(r);
	const total = legs.reduce((s, l) => s + (Number(l.notionalUsdc) || 0), 0);
	if (!(total > 0)) continue;
	const share = (ls) => ls.reduce((s, l) => s + (Number(l.notionalUsdc) || 0), 0) / total;

	// Prefer explicit provenance where core recorded it; fall back to the value.
	const feeOk = legs.filter((l) => (l.feeResolved === false ? false : Number(l.feeTierBps) > 0));

	out.push({
		id: r.id, tier: r.tier, agg: r.aggregator, notional: num(r.notional_usd) ?? 0,
		nlegs: legs.length, feeCov: share(feeOk), piCov: priceImpactCoverage(legs) ?? 0,
		rfq: share(legs.filter((l) => l.type === 'rfq')),
		unknown: share(legs.filter((l) => l.type === 'unknown')),
		conf: r.decomp_confidence, slip: num(r.slippage_bps),
	});
}

const wTotal = out.reduce((s, o) => s + o.notional, 0);
const wFee = out.reduce((s, o) => s + o.notional * o.feeCov, 0);
const wPi = out.reduce((s, o) => s + o.notional * o.piCov, 0);

console.log(`receipts with legs: ${out.length}\n`);
console.log('NOTIONAL-WEIGHTED COVERAGE (corpus-wide)');
console.log(`  LP fee       ${(100 * wFee / wTotal).toFixed(1)}%`);
console.log(`  price impact ${(100 * wPi / wTotal).toFixed(1)}%   ($${(wTotal - wPi).toFixed(0)} of $${wTotal.toFixed(0)} unattributed)`);

console.log('\nUI SUBTRACTION REGIMES (receiptDisplay.tsx gates on .some(), not .every())');
const none = out.filter((o) => o.piCov <= 1e-4);
const part = out.filter((o) => o.piCov > 1e-4 && o.piCov < 0.999);
const all = out.filter((o) => o.piCov >= 0.999);
console.log(`  no leg priced    ${String(none.length).padStart(3)}  nothing subtracted — mislabelled, not corrupted`);
console.log(`  SOME legs priced ${String(part.length).padStart(3)}  SILENTLY WRONG — unpriced legs treated as zero impact`);
console.log(`  all legs priced  ${String(all.length).padStart(3)}  correct`);
if (part.length) {
	console.log('\n  the silently-wrong ones:');
	for (const o of part.sort((a, b) => b.notional - a.notional)) {
		console.log(`    id ${String(o.id).padStart(3)}  cov=${pct(o.piCov)}  $${o.notional.toFixed(0).padStart(7)}  slip=${o.slip?.toFixed(1).padStart(8)}  conf=${o.conf}`);
	}
}

console.log('\nDISAGREEMENT WITH decompConfidence (which scores CHAINING, not PRICING)');
for (const c of ['high', 'medium', 'low']) {
	const g = out.filter((o) => o.conf === c);
	if (!g.length) continue;
	console.log(`  conf=${c.padEnd(6)} n=${String(g.length).padStart(2)}  of which coverage<100%: ${String(g.filter((o) => o.piCov < 0.999).length).padStart(2)}  worst ${pct(Math.min(...g.map((o) => o.piCov)))}`);
}

console.log('\nWORST COVERAGE — what the metric would caveat');
console.log(' id  tier       aggregator       notional  legs  feeCov  piCov    rfq  unknown  conf');
for (const o of out.sort((a, b) => a.piCov - b.piCov).slice(0, 14)) {
	console.log(`${String(o.id).padStart(3)}  ${String(o.tier).padEnd(10)} ${String(o.agg).slice(0, 15).padEnd(15)} ${String(o.notional.toFixed(0)).padStart(9)} ${String(o.nlegs).padStart(5)}  ${pct(o.feeCov)}   ${pct(o.piCov)}  ${pct(o.rfq)}   ${pct(o.unknown)}   ${o.conf}`);
}
