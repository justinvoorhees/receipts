import { describe, expect, it } from 'vitest';
import { extractFrameChains } from './legFrameChains.js';
import type { TraceNode } from './tradeEndpoints.js';

const POOL = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OUTER = '0xcccccccccccccccccccccccccccccccccccccccc';
const MID = '0xdddddddddddddddddddddddddddddddddddddddd';
const INNER = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

/** A log emitted by `address`; topics are irrelevant — matching is by emitter. */
const log = (address: string) => ({
	address: address as `0x${string}`,
	data: '0x' as `0x${string}`,
	topics: [] as [],
});

const call = (to: string, extra: Partial<TraceNode> = {}): TraceNode => ({
	type: 'CALL',
	to: to as `0x${string}`,
	...extra,
});

describe('extractFrameChains', () => {
	it('records the enclosing CALL frames of a venue, outermost first', () => {
		const trace = call(OUTER, {
			calls: [call(MID, { calls: [call(POOL, { logs: [log(POOL)] })] })],
		});
		expect(extractFrameChains(trace, new Set([POOL]))).toEqual(
			new Map([[POOL, [OUTER, MID]]]),
		);
	});

	it('excludes the venue itself from its own chain', () => {
		const trace = call(OUTER, { calls: [call(POOL, { logs: [log(POOL)] })] });
		expect(extractFrameChains(trace, new Set([POOL]))?.get(POOL)).toEqual([OUTER]);
	});

	it('ignores DELEGATECALL and STATICCALL frames — they have no frame of their own', () => {
		const trace = call(OUTER, {
			calls: [
				{ type: 'DELEGATECALL', to: MID as `0x${string}`, calls: [
					{ type: 'STATICCALL', to: INNER as `0x${string}`, calls: [
						call(POOL, { logs: [log(POOL)] }),
					] },
				] },
			],
		});
		expect(extractFrameChains(trace, new Set([POOL])).get(POOL)).toEqual([OUTER]);
	});

	it('skips reverted frames', () => {
		const trace = call(OUTER, {
			calls: [call(MID, { error: 'execution reverted', calls: [call(POOL, { logs: [log(POOL)] })] })],
		});
		expect(extractFrameChains(trace, new Set([POOL])).get(POOL)).toEqual([OUTER]);
	});

	it('collapses consecutive repeats (the V4 unlock-callback re-entry)', () => {
		// Real shape: Executor -> PoolManager.unlock -> Executor.unlockCallback
		// -> PoolManager.swap. PoolManager is the venue (excluded), so Executor
		// would otherwise appear twice in a row.
		const trace = call(OUTER, {
			calls: [call(INNER, { calls: [call(POOL, { calls: [call(INNER, {
				calls: [call(POOL, { logs: [log(POOL)] })],
			})] })] })],
		});
		expect(extractFrameChains(trace, new Set([POOL])).get(POOL)).toEqual([OUTER, INNER]);
	});

	it('caps a chain at 12 frames, keeping the innermost', () => {
		// 20 nested frames 0x01..0x14, then the pool.
		const addrs = Array.from({ length: 20 }, (_, i) =>
			`0x${String(i + 1).padStart(2, '0').repeat(20)}`,
		);
		let node: TraceNode = call(POOL, { logs: [log(POOL)] });
		for (const a of [...addrs].reverse()) node = call(a, { calls: [node] });
		const chain = extractFrameChains(node, new Set([POOL])).get(POOL)!;
		expect(chain).toHaveLength(12);
		expect(chain[11]).toBe(addrs[19]);
		expect(chain[0]).toBe(addrs[8]);
	});

	it('omits a venue reached from two different chains (fail closed)', () => {
		// Two pools sharing one address (the V4 PoolManager singleton), called by
		// two different routers. Ambiguous -> no attribution for either.
		const trace = call(OUTER, {
			calls: [
				call(MID, { calls: [call(POOL, { logs: [log(POOL)] })] }),
				call(INNER, { calls: [call(POOL, { logs: [log(POOL)] })] }),
			],
		});
		expect(extractFrameChains(trace, new Set([POOL])).has(POOL)).toBe(false);
	});

	it('ignores logs from addresses that are not venues', () => {
		const trace = call(OUTER, { calls: [call(MID, { logs: [log(MID)] })] });
		expect(extractFrameChains(trace, new Set([POOL])).size).toBe(0);
	});

	it('matches any log from a venue, not just swap topics (RFQ + transfer-discovered venues)', () => {
		const trace = call(OUTER, { calls: [call(POOL, { logs: [log(POOL)] })] });
		expect(extractFrameChains(trace, new Set([POOL])).has(POOL)).toBe(true);
	});

	it('returns an empty map for a venue with no logs at all', () => {
		const trace = call(OUTER, { calls: [call(POOL)] });
		expect(extractFrameChains(trace, new Set([POOL])).size).toBe(0);
	});

	it('lowercases venue keys and frame addresses', () => {
		const trace = call(OUTER.toUpperCase().replace('0X', '0x'), {
			calls: [call(POOL, { logs: [log(POOL.toUpperCase().replace('0X', '0x'))] })],
		});
		expect(extractFrameChains(trace, new Set([POOL])).get(POOL)).toEqual([OUTER]);
	});
});
