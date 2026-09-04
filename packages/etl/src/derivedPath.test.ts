import { describe, expect, it } from 'vitest';
import { cacheFilePath, derivedFileName, derivedFilePath } from './derivedPath.js';

describe('derivedFileName', () => {
	it('puts the family first and zero-pads both bounds to ten digits', () => {
		expect(derivedFileName('candidates', 'base', 50842630, 50842929)).toBe(
			'candidates.base.0050842630-0050842929.parquet',
		);
	});

	it('sorts lexically in the same order as numerically within a family', () => {
		const names = [
			derivedFileName('candidates', 'base', 9_000_000, 9_000_299),
			derivedFileName('candidates', 'base', 500, 799),
			derivedFileName('candidates', 'base', 50_842_630, 50_842_929),
		];
		expect([...names].sort()).toEqual([names[1], names[0], names[2]]);
	});

	it('rejects an inverted range', () => {
		expect(() => derivedFileName('candidates', 'base', 500, 499)).toThrow(/inverted/);
	});

	it('rejects a range it cannot pad without truncating', () => {
		expect(() => derivedFileName('legs', 'base', 1, 10_000_000_000)).toThrow(/ten digits/);
	});

	it('rejects a chain name containing path traversal', () => {
		expect(() => derivedFileName('legs', '../../etc', 1, 2)).toThrow(/Chain name must match/);
	});
});

describe('derivedFilePath', () => {
	it('nests the file under data/derived/<build>/', () => {
		expect(
			derivedFilePath({
				dataDir: '/repo/data',
				build: '2026-09-04a',
				family: 'candidates',
				chain: 'base',
				fromBlock: 50842630,
				toBlock: 50842929,
			}),
		).toBe('/repo/data/derived/2026-09-04a/candidates.base.0050842630-0050842929.parquet');
	});

	it('rejects a build tag containing path traversal', () => {
		expect(() =>
			derivedFilePath({
				dataDir: '/repo/data',
				build: '../seeds',
				family: 'candidates',
				chain: 'base',
				fromBlock: 1,
				toBlock: 2,
			}),
		).toThrow(/Build tag must match/);
	});
});

describe('cacheFilePath', () => {
	it('places caches OUTSIDE any build directory', () => {
		expect(cacheFilePath({ dataDir: '/repo/data', name: 'v4_poolkeys', chain: 'base' })).toBe(
			'/repo/data/cache/v4_poolkeys.base.parquet',
		);
	});

	it('rejects a chain name containing path traversal', () => {
		expect(() => cacheFilePath({ dataDir: '/repo/data', name: 'pools', chain: 'a/b' })).toThrow(
			/Chain name must match/,
		);
	});
});
