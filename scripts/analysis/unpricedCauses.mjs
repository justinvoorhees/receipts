/**
 * unpricedCauses.mjs — WHY is each leg unpriced? Separate causes, don't lump.
 *
 * A single coverage percentage is useless because RFQ dominates it and RFQ is
 * honestly unpriceable. The value is in the split:
 *
 *   RFQ_LEG_UNPRICED     honest — off-chain quote, no on-chain mid exists
 *   ROUTE_NOT_DECOMPOSED reconstruction failed
 *   PI_IMPLAUSIBLE       A BUG IN HIDING — see below
 *   (no flag)            unexplained, needs a look
 *
 * ⚠️ This is the script that found the V4 PoolManager defect: every
 * PI_IMPLAUSIBLE instance in the corpus is the SAME venue
 * (0x498581ff…, the Uniswap V4 PoolManager) with impacts of 6881.8, 5335.9,
 * 9999.0 and −13,149,914,232 bps plus a 2000.00 bps "fee tier". That is a
 * systematically broken mid+fee reader, not implausible markets, and the clamp
 * nulls it so the loss vanishes into the residual.
 *
 * ⚠️ Do NOT raise PI_IMPLAUSIBLE_CAP_BPS to "see the impact" — those values are
 * wrong, which is why the clamp fired. Fix the reader, then repopulate.
 *
 *   node scripts/analysis/unpricedCauses.mjs
 */
import { loadCorpus, costedLegs, num } from './_env.mjs';

const rows = loadCorpus().filter((r) => r.route_legs != null);

const RX = /MID_NULL|PI_IMPLAUSIBLE|RFQ_LEG|ROUTE_NOT_DECOMPOSED|LEG_FEE_IMPLAUSIBLE|AMOUNT_IN_ZERO/;
const byCause = {};
const byVenue = {};

for (const r of rows) {
	const legs = costedLegs(r);
	const unpriced = legs.filter((l) => l.priceImpactBps == null);
	if (!unpriced.length) continue;
	const flags = (r.normalize_flags ?? []).map(String).filter((f) => RX.test(f));
	const cause = flags.find((f) => f.startsWith('PI_IMPLAUSIBLE')) ? 'PI_IMPLAUSIBLE'
		: flags.find((f) => f.startsWith('ROUTE_NOT_DECOMPOSED')) ? 'ROUTE_NOT_DECOMPOSED'
		: flags.find((f) => f.startsWith('RFQ_LEG')) ? 'RFQ_LEG_UNPRICED'
		: '(no flag — unexplained)';
	(byCause[cause] ??= []).push({ id: r.id, legs: unpriced.length, notional: num(r.notional_usd) ?? 0, tier: r.tier });
	for (const l of unpriced) {
		const k = `${l.type}  ${(l.venue ?? '').slice(0, 12)}`;
		(byVenue[k] ??= { legs: 0, usd: 0, ids: new Set() });
		byVenue[k].legs++; byVenue[k].usd += Number(l.notionalUsdc) || 0; byVenue[k].ids.add(r.id);
	}
	if (cause === 'PI_IMPLAUSIBLE' || cause === '(no flag — unexplained)') {
		console.log(`id ${String(r.id).padStart(3)}  ${String(r.tier).padEnd(10)} ${cause}`);
		for (const f of flags) console.log(`      ${f}`);
	}
}

console.log('\nUNPRICED RECEIPTS BY CAUSE');
for (const [k, v] of Object.entries(byCause).sort((a, b) => b[1].length - a[1].length)) {
	console.log(`  ${k.padEnd(26)} receipts=${String(v.length).padStart(2)}  trade $ affected=${v.reduce((s, x) => s + x.notional, 0).toFixed(0)}`);
	console.log(`      ids: ${v.map((x) => x.id).join(', ')}`);
}

console.log('\nUNPRICED LEGS BY VENUE — a repeat offender here is a reader bug, not a market');
for (const [k, v] of Object.entries(byVenue).sort((a, b) => b[1].legs - a[1].legs)) {
	console.log(`  ${k.padEnd(28)} legs=${String(v.legs).padStart(2)}  receipts=${String(v.ids.size).padStart(2)}  leg notional=$${v.usd.toFixed(0)}`);
}
