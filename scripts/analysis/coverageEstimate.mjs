/**
 * coverageEstimate.mjs — how many receipts would the coverage gate catch?
 *
 * Scoping aid for worklist item 1. Counts, over EVERY receipt (not just those
 * with route_legs), how many would fall below 100% price-impact coverage and
 * therefore lose their bare Slippage number under the proposed gate — split by
 * whether the receipt currently prints a number at all.
 *
 *   node scripts/analysis/coverageEstimate.mjs
 */
import { loadCasesDecoded, parseLimitFlag, costedLegs, isFullyPriced, priceImpactCoverage, num } from './_env.mjs';

const rows = await loadCasesDecoded({
	limit: parseLimitFlag(),
	// The v1 corpus set, and deliberately NOT the hand-written cases. Those are
	// curated pathologies — zero-leg routes, dust reference pools, truncated
	// cyclic routes — and this script measures the RATE of exactly those. Mixing
	// them in moves every rate by changing the sample rather than the code, which
	// is indistinguishable from a real regression in the output.
	filter: (c) => c.source === 'corpus-v1',
});
console.log(`sample: ${rows.length} corpus-v1 receipts decoded (hand-written diagnostic cases excluded)`);

const buckets = {
	noLegs: [],        // no route_legs at all — gate cannot apply
	full: [],          // every costed leg priced — unaffected
	partial: [],       // SOME priced — currently prints a WRONG number
	none: [],          // none priced — currently prints the whole execution delta
};

for (const r of rows) {
	const legs = costedLegs(r);
	if (!r.route_legs || legs.length === 0) { buckets.noLegs.push(r); continue; }
	const priced = legs.filter((l) => l.priceImpactBps != null);
	const rec = {
		id: r.id, tier: r.tier, agg: r.aggregator,
		notional: num(r.notional_usd) ?? 0,
		slip: num(r.slippage_bps),
		status: r.pricing_status,
		cov: priceImpactCoverage(legs) ?? 0,
		fullyPriced: isFullyPriced(legs),
		nlegs: legs.length,
		rfqOnly: legs.every((l) => l.type === 'rfq'),
		conf: r.decomp_confidence,
	};
	if (rec.fullyPriced) buckets.full.push(rec);
	else if (priced.length > 0) buckets.partial.push(rec);
	else buckets.none.push(rec);
}

// A receipt only LOSES something if it currently renders a number: it needs a
// non-null slippage_bps and must not already be short-circuited to n/a.
const printsNumber = (o) => o.slip != null && o.status !== 'partial';

const money = (xs) => `$${xs.reduce((s, o) => s + o.notional, 0).toFixed(0)}`;
const line = (label, xs) =>
	console.log(`  ${label.padEnd(34)} ${String(xs.length).padStart(3)}   ${money(xs).padStart(9)}`);

console.log(`total receipts: ${rows.length}   with costed legs: ${rows.length - buckets.noLegs.length}\n`);
console.log('PRICE-IMPACT COVERAGE BY RECEIPT               n     notional');
line('no route_legs (gate N/A)', buckets.noLegs.map((r) => ({ notional: num(r.notional_usd) ?? 0 })));
line('100% — unaffected', buckets.full);
line('partial — currently WRONG', buckets.partial);
line('0% — currently mislabelled', buckets.none);

const affected = [...buckets.partial, ...buckets.none];
const losing = affected.filter(printsNumber);
console.log(`\nBELOW 100% COVERAGE: ${affected.length} receipts (${money(affected)})`);
console.log(`  of which currently print a Slippage number: ${losing.length} (${money(losing)})`);
console.log(`  already render n/a (null slip or pricingStatus=partial): ${affected.length - losing.length}`);

const rfq = losing.filter((o) => o.rfqOnly);
console.log(`  of the ${losing.length}: RFQ-only routes ${rfq.length} (${money(rfq)}), mixed/pool ${losing.length - rfq.length} (${money(losing.filter((o) => !o.rfqOnly))})`);

console.log('\nEVERY RECEIPT THAT WOULD LOSE ITS NUMBER');
console.log(' id  tier       aggregator      notional  legs  cov   slip     rfqOnly conf');
for (const o of losing.sort((a, b) => b.notional - a.notional)) {
	console.log(
		`${String(o.id).padStart(3)}  ${String(o.tier).padEnd(10)} ${String(o.agg).slice(0, 14).padEnd(14)} ${o.notional.toFixed(0).padStart(9)} ${String(o.nlegs).padStart(5)}  ${(100 * o.cov).toFixed(0).padStart(3)}%  ${(o.slip ?? 0).toFixed(1).padStart(8)}  ${o.rfqOnly ? 'yes' : 'no '}     ${o.conf}`,
	);
}
