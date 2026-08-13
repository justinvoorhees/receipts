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
 * 68 entries total. 62 carry `corpusId` (source: 'corpus-v1') and additionally
 * blockNumber; the other 6 are hand-written and carry neither. That is not a
 * clean 61+7 split: one hand-written entry (corpus id 485) already existed in
 * this file before the migration and gained a `corpusId` in place, while
 * keeping its own hand-written `why` rather than the shared migrated one.
 * `why` earns every entry its place — a hash with no explanation is impossible
 * to prune later.
 *
 * ⚠️ Only entries carrying `corpusId` also carry `blockNumber`. A future
 * consumer that pins a decode to blockNumber would silently decode the 6
 * hand-written entries against current chain state while the other 62 pin
 * historically — a divergence with no error signal.
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
