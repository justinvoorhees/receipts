/**
 * Shared env + connection helpers for the analysis scripts in this directory.
 *
 * These read the repo-root .env directly rather than relying on the shell,
 * because `source .env` does not export by itself — a script that depends on
 * process.env alone silently sees nothing.
 */
import { readFileSync } from 'node:fs';

export const env = Object.fromEntries(
	readFileSync(new URL('../../.env', import.meta.url), 'utf8')
		.split('\n').filter((l) => l.includes('='))
		.map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

/**
 * Interesting transactions, as HASHES ONLY (docs/qa/cases.json).
 *
 * A hash does not rot: every script that needs a receipt re-decodes it against
 * today's code and today's chain.
 *
 * So this is where a newly-interesting transaction goes. Do NOT add decoded
 * columns to an entry here to grow a sample — a hash-only entry cannot go
 * stale, but a decoded one rots on every pricing change, which is exactly what
 * docs/qa/corpus.json did before it was deleted. If a decoded snapshot is ever
 * genuinely needed, generate it fresh into its own file (serially — see
 * decodeGolden.mjs) rather than mixing decoded columns into this one.
 *
 * 68 entries total. 62 carry `corpusId`; the other 6 are hand-written and
 * carry neither. That is not a clean 61+7 split: one hand-written entry
 * (corpus id 485) already existed in this file before the migration and
 * gained a `corpusId` in place, while keeping its own hand-written `why`
 * rather than the shared migrated one — and, because it was hand-written
 * first, it never gained the `source: 'corpus-v1'` tag the other 61 migrated
 * entries carry.
 *
 * `corpusId != null` is the correct test for "was in the original corpus"
 * (62 entries — what the five analysis scripts' `loadCasesDecoded({ filter })`
 * use). `source === 'corpus-v1'` is NOT an equivalent test — it matches only
 * 61, silently dropping entry 485. That gap is exactly why the five scripts'
 * filter was corrected from `source` to `corpusId`; a reader who
 * "simplifies" it back to `source` reintroduces the bug.
 *
 * `why` earns every entry its place — a hash with no explanation is impossible
 * to prune later.
 *
 * ⚠️ `blockNumber`, not `corpusId`, is the reliable signal for "migrated with a
 * pinned block": the 61 migrated entries carry `blockNumber`, the 7
 * hand-written ones do not — and entry 485 is the exception that breaks a
 * `corpusId`-based check: it carries a `corpusId` (485) with NO `blockNumber`,
 * because it was hand-written before the migration and only gained the id in
 * place. A future consumer that gates on `corpusId != null` to decide whether
 * to pin a decode to `blockNumber` would silently decode entry 485 against
 * current chain state while believing it was pinned historically — a
 * divergence with no error signal. Check `blockNumber` directly instead.
 *
 * ⚠️ There is no longer a $5 notional floor enforced on this list (that check
 * lived in the old `corpus.test.mjs`, against `notional_usd`, which is decoder
 * output and no longer lives in this file). Nothing stops a dust transaction
 * from entering here and skewing a notional-weighted average computed over it.
 */
export function loadCases() {
	return JSON.parse(
		readFileSync(new URL('../../docs/qa/cases.json', import.meta.url), 'utf8'),
	);
}

export { receiptToRow } from './_rowShape.mjs';
import { receiptToRow } from './_rowShape.mjs';

/**
 * Every case, decoded against TODAY's code and TODAY's chain.
 *
 * The replacement for `loadCorpus()`. That returned a frozen snapshot and so
 * could only tell you whether today's code disagreed with the code that produced
 * the snapshot; this tells you what today's code actually does.
 *
 * SERIAL on purpose, and it must stay that way: concurrent decodes of the same
 * transaction return different receipts with no flag, so a parallel version
 * would produce numbers that change between runs.
 *
 * Costs roughly 3.5-4 minutes for the full 62. Pass `limit` while iterating.
 * A transaction that fails to decode is REPORTED and skipped, never returned as
 * a row of nulls — every script here filters on `route_legs != null`, so a null
 * row would silently shrink the sample with nothing to show for it.
 */
export async function loadCasesDecoded({ limit = Infinity, filter } = {}) {
	const { analyzeTransaction } = await core('index.js');
	const rpcUrl = env.TCA_RPC_URL;
	if (!rpcUrl) throw new Error('TCA_RPC_URL missing from the repo-root .env');

	const cases = loadCases()
		.filter((c) => (filter ? filter(c) : true))
		.sort((a, b) => (a.corpusId ?? Infinity) - (b.corpusId ?? Infinity))
		.slice(0, limit);

	const rows = [];
	const failures = [];
	for (const [i, c] of cases.entries()) {
		try {
			const receipt = await analyzeTransaction(c.hash, c.chainId, { rpcUrl });
			if (receipt) rows.push(receiptToRow(receipt, c.corpusId ?? null));
			else failures.push([c.hash, 'null receipt']);
		} catch (err) {
			failures.push([c.hash, err.message]);
		}
		if ((i + 1) % 10 === 0) console.error(`  decoded ${i + 1}/${cases.length}`);
	}
	if (failures.length) {
		console.error(`⚠️  ${failures.length} of ${cases.length} failed to decode:`);
		for (const [hash, msg] of failures) console.error(`     ${hash.slice(0, 12)} ${msg}`);
	}
	return rows;
}

/**
 * Parse `--limit=N` out of argv. A typo'd or non-positive value (`--limit=abc`,
 * `Number('abc')` is `NaN`) falls back to Infinity rather than being handed to
 * `loadCasesDecoded`'s `.slice(0, limit)` as-is: `slice(0, NaN)` returns `[]`,
 * silently turning a typo into an empty sample instead of the harmlessly full
 * one you'd get from a missing flag.
 */
export function parseLimitFlag(argv = process.argv) {
	const hit = argv.find((a) => a.startsWith('--limit='));
	const parsed = hit ? Number(hit.slice(8)) : Infinity;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : Infinity;
}

export const core = (file) =>
	import(new URL(`../../packages/core/dist/${file}`, import.meta.url));

/** Median of an array of numbers. NaN on empty. */
export const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

/** Quantile helper over an already-sorted array. */
export const quantile = (sorted, p) => sorted[Math.floor(p * (sorted.length - 1))];

/**
 * Cost-bearing legs only — wrap/unwrap are informational and carry no notional.
 * Re-exported from core so the scripts and the receipt UI share ONE definition.
 * Takes a DB row; core's takes the leg array.
 */
const pure = await import(new URL('../../packages/core/dist/receiptPure.js', import.meta.url));
export const costedLegs = (row) => pure.costedLegs(row.route_legs ?? []);
export const { priceImpactCoverage, isFullyPriced } = pure;

export const num = (v) => (v == null ? null : Number(v));
