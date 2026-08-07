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
	it('preserves the raw snake_case postgres shape', () => {
		expect(corpus[0]).toHaveProperty('tx_hash');
		expect(corpus[0]).toHaveProperty('notional_usd');
		expect(corpus[0]).toHaveProperty('route_legs');
	});

	// This is not a normal fixture count that will need bumping as the corpus
	// grows — the corpus cannot grow. The database this was read from is gone
	// by design (see scripts/freezeCorpus.mjs), so docs/qa/corpus.json is a
	// frozen, unrepeatable snapshot: 62 rows in, 62 rows forever. A count that
	// drifts from 62 doesn't mean the fixture is stale, it means the file was
	// truncated or corrupted — the other three checks above would all still
	// pass on a file missing 40 rows, or cut down to just the first one. This
	// number is a checksum, not a snapshot to keep in sync.
	it('has exactly the 62 rows frozen on 2026-08-06', () => {
		expect(corpus.length).toBe(62);
	});
});
