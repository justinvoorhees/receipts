import { describe, expect, it } from 'vitest';
import { extractFrameChains } from './legFrameChains.js';
import type { TraceNode } from './tradeEndpoints.js';

const POOL = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const POOL_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OUTER = '0xcccccccccccccccccccccccccccccccccccccccc';
const MID = '0xdddddddddddddddddddddddddddddddddddddddd';
const INNER = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
// A real fill-topic shape (RFQ maker fill), used to prove log-matching is
// topic-blind rather than merely tolerant of an empty topics array.
const RFQ_FILL_TOPIC = '0x51ab1232e2b0ce9c8db2b12f5c4a3b4e9b1c8f3d2a6e5b7c9d0e1f2a3b4c5d6e';

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
		const trace = call(OUTER, {
			calls: [call(POOL, { logs: [{
				address: POOL as `0x${string}`,
				data: '0x' as `0x${string}`,
				topics: [RFQ_FILL_TOPIC as `0x${string}`],
			}] })],
		});
		expect(extractFrameChains(trace, new Set([POOL])).has(POOL)).toBe(true);
	});

	it('never opens a frame for a venue address — not just the one whose chain is being built (a venue is never a router)', () => {
		// OUTER -> POOL(logs) -> POOL_B(logs), both venues. POOL must not appear
		// in POOL_B's chain even though POOL directly called POOL_B.
		const trace = call(OUTER, {
			calls: [call(POOL, { logs: [log(POOL)], calls: [call(POOL_B, { logs: [log(POOL_B)] })] })],
		});
		const chains = extractFrameChains(trace, new Set([POOL, POOL_B]));
		expect(chains.get(POOL)).toEqual([OUTER]);
		expect(chains.get(POOL_B)).toEqual([OUTER]);
	});

	it('returns an empty map for a venue with no logs at all', () => {
		const trace = call(OUTER, { calls: [call(POOL)] });
		expect(extractFrameChains(trace, new Set([POOL])).size).toBe(0);
	});

	it('does not throw and does not open a frame for a node with no type', () => {
		const trace = call(OUTER, {
			calls: [{ to: MID as `0x${string}`, calls: [call(POOL, { logs: [log(POOL)] })] }],
		});
		expect(() => extractFrameChains(trace, new Set([POOL]))).not.toThrow();
		expect(extractFrameChains(trace, new Set([POOL])).get(POOL)).toEqual([OUTER]);
	});

	it('does not throw and does not open a frame for a node with no to', () => {
		const trace = call(OUTER, {
			calls: [{ type: 'CALL', calls: [call(POOL, { logs: [log(POOL)] })] }],
		});
		expect(() => extractFrameChains(trace, new Set([POOL]))).not.toThrow();
		expect(extractFrameChains(trace, new Set([POOL])).get(POOL)).toEqual([OUTER]);
	});

	it('lowercases venue keys and frame addresses', () => {
		const trace = call(OUTER.toUpperCase().replace('0X', '0x'), {
			calls: [call(POOL, { logs: [log(POOL.toUpperCase().replace('0X', '0x'))] })],
		});
		expect(extractFrameChains(trace, new Set([POOL])).get(POOL)).toEqual([OUTER]);
	});
});
