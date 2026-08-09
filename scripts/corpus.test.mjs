import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const corpus = JSON.parse(
	readFileSync(new URL('../docs/qa/corpus.json', import.meta.url), 'utf8'),
);

describe('the frozen QA corpus', () => {
	it('is not empty', () => {
		expect(corpus.length).toBeGreaterThan(0);
	});

	// The $5 floor is the whole reason this file is a curated corpus rather than
	// a table dump. A dust trade's bps figures are dominated by rounding and gas,
	// so one slipping back in would quietly skew every aggregate downstream.
	it('contains no receipt under $5', () => {
		const under = corpus.filter(
			(r) => r.notional_usd == null || Number(r.notional_usd) < 5,
		);
		expect(under.map((r) => r.tx_hash)).toEqual([]);
	});

	// Task 2's scripts destructure these by name. If the freeze ever changes
	// shape, this fails here rather than as a wall of NaN in an analysis run.
	it('preserves the raw snake_case shape it was frozen in', () => {
		expect(corpus[0]).toHaveProperty('tx_hash');
		expect(corpus[0]).toHaveProperty('notional_usd');
		expect(corpus[0]).toHaveProperty('route_legs');
	});

	// This is not a normal fixture count that will need bumping as the corpus
	// grows — the corpus cannot grow. It was dumped from the `receipts` table by
	// scripts/freezeCorpus.mjs, and BOTH are gone: the Postgres instance was
	// deleted 2026-08-09, and the script with it (it was a bare `select * from
	// receipts` with no other data source, so it could not run again). That
	// makes docs/qa/corpus.json a frozen, unrepeatable snapshot: 62 rows in, 62
	// rows forever.
	//
	// Do NOT re-add a freeze script — there is no table to freeze. If this
	// corpus ever genuinely needs to grow, the only path is to recompute rows
	// from chain via analyzeTransaction() and append them in this same raw
	// snake_case shape, which is a different tool than the one that was
	// deleted. Bump the count here in the same commit if you do.
	//
	// A count that drifts from 62 doesn't mean the fixture is stale, it means
	// the file was truncated or corrupted — the other three checks above would
	// all still pass on a file missing 40 rows, or cut down to just the first
	// one. This number is a checksum, not a snapshot to keep in sync.
	it('has exactly the 62 rows frozen on 2026-08-06', () => {
		expect(corpus.length).toBe(62);
	});
});
