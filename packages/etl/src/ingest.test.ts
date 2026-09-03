import { afterEach, describe, expect, it, vi } from 'vitest';
import { ingestRange, mapWithConcurrency } from './ingest.js';

/**
 * ingest.test.ts — coverage for `mapWithConcurrency`, plus the
 * `concurrency` validation guard that also lives in `ingestRange`.
 *
 * `ingestRange`'s end-to-end behavior (RPC calls, row assembly, the write) is
 * exercised by Task 7's live pilot test, which is the right place to prove
 * the whole pipeline wires together against a real RPC endpoint. But an e2e
 * test cannot observe internal properties like "was the concurrency limit
 * actually respected", "were results placed by index rather than pushed as
 * they completed", or "did a bad --concurrency value avoid making any RPC
 * call at all" — a live test would pass or coincidentally look fine either
 * way. Those properties are pinned here instead, with deterministic,
 * artificially-ordered completion timing (for the first two) and a stubbed
 * global `fetch` (for the third) so a broken implementation cannot
 * accidentally produce the right answer by luck.
 */

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('mapWithConcurrency', () => {
	it('returns results in INPUT order even when later items finish first', async () => {
		// Item N is given delay (10 - N) ms, so item 9 (last in input order)
		// resolves FIRST and item 0 (first in input order) resolves LAST. An
		// implementation that appended to the results array as each worker
		// finished — rather than writing to `results[index]` — would return
		// completion order (9, 8, 7, …, 0) here instead of input order.
		const items = Array.from({ length: 10 }, (_, i) => i);
		const results = await mapWithConcurrency(items, 10, async (item) => {
			await delay((10 - item) * 5);
			return item * 100;
		});

		expect(results).toEqual(items.map((item) => item * 100));
	});

	it('never runs more workers in flight than the concurrency limit', async () => {
		const limit = 3;
		let inFlight = 0;
		let maxInFlight = 0;
		const items = Array.from({ length: 12 }, (_, i) => i);

		await mapWithConcurrency(items, limit, async (item) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			// Stagger slightly by item so workers overlap rather than running in
			// lockstep, which would mask a limit violation.
			await delay(5 + (item % 3));
			inFlight--;
			return item;
		});

		expect(maxInFlight).toBeLessThanOrEqual(limit);
		// Sanity: the fixture actually exercises concurrency instead of
		// happening to run everything serially.
		expect(maxInFlight).toBeGreaterThan(1);
	});

	it('handles a limit larger than the item count without breaking', async () => {
		const items = [1, 2, 3];
		const results = await mapWithConcurrency(items, 100, async (item) => item * 2);
		expect(results).toEqual([2, 4, 6]);
	});

	it('handles an empty item list without hanging', async () => {
		const results = await mapWithConcurrency([], 5, async (item) => item);
		expect(results).toEqual([]);
	});

	it('reports progress via onDone as each item completes', async () => {
		const calls: Array<[number, number]> = [];
		await mapWithConcurrency(
			[1, 2, 3],
			2,
			async (item) => item,
			(done, total) => calls.push([done, total]),
		);
		expect(calls).toHaveLength(3);
		expect(calls[calls.length - 1]).toEqual([3, 3]);
	});
});

describe('mapWithConcurrency — concurrency limit validation', () => {
	it('rejects a zero limit', async () => {
		await expect(mapWithConcurrency([1, 2, 3], 0, async (item) => item)).rejects.toThrow(
			'concurrency limit must be a positive integer, got 0',
		);
	});

	it('rejects a negative limit', async () => {
		await expect(mapWithConcurrency([1, 2, 3], -2, async (item) => item)).rejects.toThrow(
			'concurrency limit must be a positive integer, got -2',
		);
	});

	it('rejects a non-integer limit', async () => {
		await expect(mapWithConcurrency([1, 2, 3], 1.5, async (item) => item)).rejects.toThrow(
			'concurrency limit must be a positive integer, got 1.5',
		);
	});

	it('rejects a NaN limit (e.g. from an unvalidated Number(flag) upstream)', async () => {
		const badLimit = Number('not-a-number');
		await expect(mapWithConcurrency([1, 2, 3], badLimit, async (item) => item)).rejects.toThrow(
			'concurrency limit must be a positive integer, got NaN',
		);
	});
});

describe('ingestRange — concurrency validation happens before any RPC call', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	// A bad `concurrency` used to launch zero workers silently (Array.from
	// treats a non-positive-integer length as 0) rather than throw, so the
	// only observable symptom was an empty result days later. These pin both
	// that the guard throws AND that it throws BEFORE `finalizedHead()`'s
	// fetch — moving the check to after that RPC call would still throw (a
	// different, unrelated error) but would fail the `fetchSpy` assertion.
	function baseOpts(concurrency: number) {
		return {
			rpcUrl: 'https://rpc.example.invalid/should-never-be-called',
			chain: 'base',
			chainId: 8453,
			fromBlock: 100,
			toBlock: 100,
			dataDir: '/tmp/ingest-test-should-not-be-used',
			source: 'test',
			allowUnfinalized: false,
			concurrency,
		};
	}

	it('rejects concurrency: 0 without calling fetch', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);

		await expect(ingestRange(baseOpts(0))).rejects.toThrow(
			'concurrency must be a positive integer, got 0',
		);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('rejects a fractional concurrency without calling fetch', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);

		await expect(ingestRange(baseOpts(2.5))).rejects.toThrow(
			'concurrency must be a positive integer, got 2.5',
		);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
