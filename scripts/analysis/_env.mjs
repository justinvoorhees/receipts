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
 * The frozen receipt corpus (docs/qa/corpus.json), in the raw snake_case row
 * shape it was originally dumped in: snake_case keys, `numeric` columns as
 * strings. Identical to what `connect()` used to hand back, so callers
 * destructure exactly as before.
 *
 * Already ordered by id, so a `.filter()` preserves the old `order by id`.
 *
 * This is a FROZEN file, not a live table. It cannot tell you whether today's
 * code disagrees with today's chain — only whether today's code disagrees with
 * the code that produced this snapshot.
 */
export function loadCorpus() {
	return JSON.parse(
		readFileSync(new URL('../../docs/qa/corpus.json', import.meta.url), 'utf8'),
	);
}

/**
 * Interesting transactions, as HASHES ONLY (docs/qa/cases.json).
 *
 * The deliberate counterpart to loadCorpus(). That file stores decoded columns
 * and therefore rots the moment core changes — which is why the no-RPC scripts
 * reading it are always reading some past version of this codebase. A hash does
 * not rot: every script that needs a receipt re-decodes it against today's code
 * and today's chain.
 *
 * So this is where a newly-interesting transaction goes. Do NOT append decoded
 * rows to corpus.json to grow a sample — mixing vintages there makes any
 * average across the set span two versions of core. If the stored columns ever
 * genuinely need to grow, re-decode the WHOLE set into a fresh snapshot
 * (serially — see decodeGolden.mjs) rather than appending to the old one.
 *
 * Each entry: { hash, chainId, added, tags[], why }. `why` earns the entry its
 * place — a hash with no explanation is impossible to prune later.
 */
export function loadCases() {
	return JSON.parse(
		readFileSync(new URL('../../docs/qa/cases.json', import.meta.url), 'utf8'),
	);
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
