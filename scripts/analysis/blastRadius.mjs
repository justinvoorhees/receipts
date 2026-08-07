/**
 * blastRadius.mjs — if every fix on the worklist landed, how many bps move?
 *
 * Answer, measured: almost none. This script exists so that is not re-derived.
 *
 * Only a leg with priceImpactBps == null AND a non-null slippage_bps can shift
 * anything out of Slippage. RFQ legs can NEVER move (no on-chain mid exists by
 * construction), and the twin venues move SIDEWAYS into LP Fee with Slippage
 * algebraically unchanged — lpFeeBps = feeTier × share and
 * weightedPI = (legTotalCost − feeTier) × share use the SAME share, so raising
 * the tier by F adds X to LP Fee and subtracts the same X from ΣPI.
 *
 * The prior for an unpriced leg's impact is taken from the legs that ARE priced,
 * de-weighted back to a raw per-leg figure. ⚠️ That prior is enormously
 * dispersed (p25 0.80 / median 7.26 / p75 108.52 — a 135× spread), so treat any
 * projection as an order of magnitude, never a figure.
 *
 * Baseline 2026-07-30: 4 receipts / $2,913 can move, ~6.7 bps summed at median.
 * Superseded 2026-08-06 — re-measure against the frozen 62-receipt corpus
 * (docs/qa/corpus.json); the old figures describe a 62-row set that is NOT this one.
 *
 *   node scripts/analysis/blastRadius.mjs
 */
import { loadCorpus, costedLegs, num, quantile } from './_env.mjs';

const V4_POOLMANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b';
const TWINS = new Set([
	'0x0fcbb3f9aecc556de81ee756f01191d94a3d085e',
	'0xef05e733970c37b6a2f863de0db9378ea49447cc',
]);

const rows = loadCorpus().filter((r) => r.route_legs != null);

// 1. Empirical prior: raw per-leg impact, recovered from the weighted values.
const raws = [];
for (const r of rows) {
	const legs = costedLegs(r);
	const total = legs.reduce((s, l) => s + (Number(l.notionalUsdc) || 0), 0);
	if (!(total > 0)) continue;
	for (const l of legs) {
		if (l.priceImpactBps == null) continue;
		const share = (Number(l.notionalUsdc) || 0) / total;
		if (share > 0) raws.push(Math.abs(Number(l.priceImpactBps) / share));
	}
}
raws.sort((a, b) => a - b);
const P50 = quantile(raws, 0.5), P75 = quantile(raws, 0.75);
console.log(`prior |raw per-leg impact| over ${raws.length} PRICED legs`);
console.log(`  p25=${quantile(raws, 0.25).toFixed(2)}  median=${P50.toFixed(2)}  p75=${P75.toFixed(2)}  p90=${quantile(raws, 0.9).toFixed(2)}bps`);
console.log(`  ⚠️ ${(P75 / quantile(raws, 0.25)).toFixed(0)}× spread p25→p75 — projections below are order-of-magnitude only\n`);

// 2. Classify every unpriced leg and project its weighted contribution.
const cats = {};
const perReceipt = [];
for (const r of rows) {
	const legs = costedLegs(r);
	const total = legs.reduce((s, l) => s + (Number(l.notionalUsdc) || 0), 0);
	if (!(total > 0)) continue;
	const notDecomp = (r.normalize_flags ?? []).some((f) => String(f).includes('ROUTE_NOT_DECOMPOSED'));
	const shift = { rfq: 0, v4pm: 0, twin: 0, notdecomp: 0, other: 0 };
	for (const l of legs) {
		if (l.priceImpactBps != null) continue;
		const share = (Number(l.notionalUsdc) || 0) / total;
		const v = (l.venue ?? '').toLowerCase();
		const k = l.type === 'rfq' ? 'rfq' : TWINS.has(v) ? 'twin' : v === V4_POOLMANAGER ? 'v4pm' : notDecomp ? 'notdecomp' : 'other';
		(cats[k] ??= []).push({ id: r.id, share, notional: num(r.notional_usd) ?? 0 });
		shift[k] += share;
	}
	if (Object.values(shift).some((v) => v > 0)) {
		perReceipt.push({ id: r.id, tier: r.tier, notional: num(r.notional_usd) ?? 0, slip: num(r.slippage_bps), shift });
	}
}

console.log('UNPRICED LEGS BY CAUSE');
for (const [k, v] of Object.entries(cats).sort((a, b) => b[1].length - a[1].length)) {
	const ids = new Set(v.map((x) => x.id));
	console.log(`  ${k.padEnd(10)} legs=${String(v.length).padStart(2)}  receipts=${String(ids.size).padStart(2)}  trade $ affected=${[...ids].reduce((s, id) => s + (v.find((x) => x.id === id)?.notional ?? 0), 0).toFixed(0)}`);
}

// rfq EXCLUDED: it can never be priced, so it can never shift.
const fixable = (o) => o.shift.v4pm + o.shift.twin + o.shift.notdecomp + o.shift.other;
console.log('\nPROJECTED SHIFT out of the displayed Slippage row');
console.log(' id  tier        notional  fixable  proj@median  proj@p75   slip_bps');
let sumMed = 0;
const movable = perReceipt.filter((o) => fixable(o) > 0 && o.slip != null && Math.abs(o.slip) > 1e-9);
for (const o of perReceipt.filter((o) => fixable(o) > 0).sort((a, b) => fixable(b) - fixable(a))) {
	const f = fixable(o);
	const note = o.slip == null || Math.abs(o.slip) < 1e-9 ? '  <- slip NULL/0: nothing to shift out of' : '';
	if (!note) sumMed += f * P50;
	console.log(`${String(o.id).padStart(3)}  ${String(o.tier).padEnd(10)} ${String(o.notional.toFixed(0)).padStart(9)} ${(100 * f).toFixed(0).padStart(7)}% ${(f * P50).toFixed(2).padStart(12)} ${(f * P75).toFixed(2).padStart(9)} ${String(o.slip?.toFixed(1) ?? '·').padStart(10)}${note}`);
}
console.log(`\nreceipts that can ACTUALLY shift: ${movable.length}  ($${movable.reduce((s, o) => s + o.notional, 0).toFixed(0)} combined, ~${sumMed.toFixed(1)} bps summed at the median prior)`);

const rfqIds = new Set((cats.rfq ?? []).map((x) => x.id));
console.log(`RFQ-only, STRUCTURALLY unable to shift: ${rfqIds.size} receipts, $${[...rfqIds].reduce((s, id) => s + (cats.rfq.find((x) => x.id === id)?.notional ?? 0), 0).toFixed(0)}`);
console.log('\n⇒ the residual is not recoverable measurement. It is reference-pool-vs-traded-pool');
console.log('  divergence, which is structural. The honest fix is the relabel, not the recovery.');
