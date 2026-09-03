import { describe, expect, it } from 'vitest';
import { seedFileName, seedFilePath } from './seedPath.js';

describe('seedFileName', () => {
	it('zero-pads both bounds to ten digits', () => {
		expect(seedFileName('base', 50830910, 50831209)).toBe(
			'traces.base.0050830910-0050831209.parquet',
		);
	});

	it('sorts lexically in the same order as numerically', () => {
		const names = [
			seedFileName('base', 9_000_000, 9_000_299),
			seedFileName('base', 500, 799),
			seedFileName('base', 50_831_209, 50_831_508),
		];
		expect([...names].sort()).toEqual([names[1], names[0], names[2]]);
	});

	it('rejects a range it cannot pad without truncating', () => {
		expect(() => seedFileName('base', 1, 10_000_000_000)).toThrow(/exceeds ten digits/);
	});

	it('rejects an inverted range', () => {
		expect(() => seedFileName('base', 500, 499)).toThrow(/inverted/);
	});
});

describe('seedFilePath', () => {
	const base = { dataDir: '/repo/data', chain: 'base', fromBlock: 100, toBlock: 399 };

	it('puts finalized files in the canonical archive', () => {
		expect(seedFilePath({ ...base, finalized: true })).toBe(
			'/repo/data/seeds/traces.base.0000000100-0000000399.parquet',
		);
	});

	it('quarantines unfinalized files one directory deeper', () => {
		expect(seedFilePath({ ...base, finalized: false })).toBe(
			'/repo/data/seeds/provisional/traces.base.0000000100-0000000399.parquet',
		);
	});
});
