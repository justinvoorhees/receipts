import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const cases = JSON.parse(
	readFileSync(new URL('../docs/qa/cases.json', import.meta.url), 'utf8'),
);

describe('the QA case list', () => {
	it('holds 68 cases: 62 carry a corpusId (61 migrated plus hand-written entry 485), 6 are purely hand-written', () => {
		expect(cases.length).toBe(68);
		expect(cases.filter((c) => c.corpusId != null).length).toBe(62);
	});

	// A duplicate hash means a transaction gets analysed twice and silently
	// double-weights every average taken across this set.
	it('has no duplicate hashes and no duplicate corpus ids', () => {
		const hashes = cases.map((c) => c.hash.toLowerCase());
		expect(new Set(hashes).size).toBe(hashes.length);
		const ids = cases.filter((c) => c.corpusId != null).map((c) => c.corpusId);
		expect(new Set(ids).size).toBe(ids.length);
	});

	// `why` is this file's whole contract: a hash with no explanation cannot be
	// pruned later, because nobody can tell what it was keeping.
	it('gives every entry a non-empty why and a usable hash', () => {
		for (const c of cases) {
			expect(c.hash, JSON.stringify(c)).toMatch(/^0x[0-9a-f]{64}$/);
			expect(typeof c.chainId, c.hash).toBe('number');
			expect((c.why ?? '').length, c.hash).toBeGreaterThan(0);
		}
	});

	// The one overlap: corpus id 485 was already here, hand-written. The
	// migration takes its id and must not overwrite the better rationale.
	it('keeps the hand-written why on the entry that was already present', () => {
		const c = cases.find((x) => x.corpusId === 485);
		expect(c).toBeDefined();
		expect(c.why).toContain('routeReconstructed');
		expect(c.source).toBeUndefined(); // not a bulk-migrated entry
	});
});
