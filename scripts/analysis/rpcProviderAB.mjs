/**
 * rpcProviderAB.mjs — do two RPC providers produce identical receipts?
 *
 * Written for the 2026-08-03 Alchemy → QuickNode migration, before the database
 * was removed. Re-analyzes every row in the frozen corpus (docs/qa/corpus.json)
 * TWICE on the SAME code — once per provider — and diffs the two computed
 * Receipts field by field.
 *
 * Why not just diff the frozen rows against a recompute? Because the frozen
 * corpus was dumped once and never updates, so that diff conflates every bit of
 * code drift since the freeze with provider behaviour. Only an A/B on identical
 * code, run twice back-to-back, isolates the provider. (See the README's
 * "Risks and accepted costs" note: this is now the ONLY corpus-wide regression
 * check left — it can A/B two providers, but it can no longer answer "does
 * today's code disagree with last month's.")
 *
 * ⚠️ A raw A/B still over-reports: anything genuinely non-deterministic (a read
 * at head rather than at the trade's block, an upstream name lookup) shows up as
 * a "difference" that has nothing to do with the provider. Run --control first:
 * it A/As ONE provider against itself, so any field it flags is noise and is
 * then excluded from the A/B verdict.
 *
 * Read-only. Writes nothing, anywhere.
 *
 *   node scripts/analysis/rpcProviderAB.mjs --control [--limit=N]
 *   node scripts/analysis/rpcProviderAB.mjs [--limit=N] [--ids=56,134]
 */
import { env, loadCorpus, core } from './_env.mjs';

const { analyzeTransaction } = await core('analyzeTransaction.js');

const CONTROL = process.argv.includes('--control');
const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const LIMIT = arg('limit') ? Number(arg('limit')) : null;
const IDS = arg('ids') ? new Set(arg('ids').split(',').map(Number)) : null;

const A = { name: 'Alchemy', url: env.TCA_RPC_URL_PREV };
const B = { name: 'QuickNode', url: env.TCA_RPC_URL };
if (!A.url || !B.url) {
	console.error('Need TCA_RPC_URL and TCA_RPC_URL_PREV in .env');
	process.exit(1);
}
// In control mode both sides are the SAME endpoint, so every difference the run
// reports is non-determinism rather than provider behaviour.
const left = CONTROL ? { ...B, name: 'QuickNode#1' } : A;
const right = CONTROL ? { ...B, name: 'QuickNode#2' } : B;

/** Stable scalar rendering: BigInt-safe, and floats compared at receipt precision. */
const show = (v) => {
	if (v == null) return '·';
	if (typeof v === 'bigint') return v.toString();
	if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(6);
	if (typeof v === 'object') return JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
	return String(v);
};

/** Flatten a Receipt to comparable leaf paths, recursing into routeLegs/feeSinks. */
function flatten(obj, prefix = '', out = {}) {
	for (const [k, v] of Object.entries(obj ?? {})) {
		const path = prefix ? `${prefix}.${k}` : k;
		if (v && typeof v === 'object' && !Array.isArray(v) && typeof v !== 'bigint') flatten(v, path, out);
		else if (Array.isArray(v) && v.every((e) => e && typeof e === 'object')) {
			v.forEach((e, i) => flatten(e, `${path}[${i}]`, out));
		} else out[path] = show(v);
	}
	return out;
}

function diffReceipts(x, y) {
	const fx = flatten(x), fy = flatten(y);
	const keys = new Set([...Object.keys(fx), ...Object.keys(fy)]);
	const diffs = [];
	for (const k of keys) if (fx[k] !== fy[k]) diffs.push({ field: k, a: fx[k] ?? '∅', b: fy[k] ?? '∅' });
	return diffs;
}

let rows = loadCorpus();
if (IDS) rows = rows.filter((r) => IDS.has(r.id));
if (LIMIT) rows = rows.slice(0, LIMIT);

console.log(`${CONTROL ? 'CONTROL (A/A — measures noise)' : 'A/B (measures provider)'}`);
console.log(`${left.name} vs ${right.name} · ${rows.length} receipts · same code both sides\n`);

const fieldCounts = new Map(); // field path (index-stripped) → receipts affected
let identical = 0, differing = 0, failed = 0;

for (const row of rows) {
	let ra, rb;
	try {
		// Sequential, not parallel: keeps each provider's load pattern comparable
		// and avoids one side being rate-limited into a retry path the other never took.
		ra = await analyzeTransaction(row.tx_hash, row.chain_id, { rpcUrl: left.url });
		rb = await analyzeTransaction(row.tx_hash, row.chain_id, { rpcUrl: right.url });
	} catch (e) {
		console.log(`id ${String(row.id).padStart(3)}  ERROR ${e.message}`);
		failed++;
		continue;
	}
	const pair = `${row.input_symbol}->${row.output_symbol}`;
	if (!ra || !rb) {
		if (!ra && !rb) { console.log(`id ${String(row.id).padStart(3)}  ${pair.padEnd(16)} both null (unchanged)`); identical++; }
		else { console.log(`id ${String(row.id).padStart(3)}  ${pair.padEnd(16)} ⚠ NULL ON ONE SIDE: ${left.name}=${ra ? 'ok' : 'null'} ${right.name}=${rb ? 'ok' : 'null'}`); differing++; }
		continue;
	}
	const diffs = diffReceipts(ra, rb);
	if (!diffs.length) { identical++; continue; }
	differing++;
	console.log(`id ${String(row.id).padStart(3)}  ${pair.padEnd(16)} ${diffs.length} field(s) differ`);
	for (const d of diffs.slice(0, 12)) {
		console.log(`        ${d.field}:  ${left.name}=${d.a}  ${right.name}=${d.b}`);
		const generic = d.field.replace(/\[\d+\]/g, '[]');
		fieldCounts.set(generic, (fieldCounts.get(generic) ?? 0) + 1);
	}
	if (diffs.length > 12) console.log(`        … and ${diffs.length - 12} more`);
}

console.log(`\n── summary ──`);
console.log(`identical: ${identical} · differing: ${differing} · errors: ${failed} (of ${rows.length})`);
if (fieldCounts.size) {
	console.log(`\nfields that differed, by receipts affected:`);
	for (const [f, n] of [...fieldCounts].sort((x, y) => y[1] - x[1])) console.log(`  ${String(n).padStart(3)}  ${f}`);
}
if (!differing && !failed) {
	console.log(CONTROL
		? '\nNo noise: this corpus is deterministic, so any A/B difference is real.'
		: '\nThe two providers produce byte-identical receipts across the corpus.');
}
process.exit(0);
