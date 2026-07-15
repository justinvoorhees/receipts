import { describe, expect, it } from 'vitest';
import { findSettlementEvents, AGGREGATOR_SIGNATURES, settlementEventPresent, matchSettlementEvent, findAggregatorHints } from './aggregatorSignatures.js';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ROUTER = '0x19ceead7105607cd444f5ad10dd51356436095a1'; // odos v2

describe('findSettlementEvents', () => {
	it('returns distinct non-Transfer events emitted by the settlement contract only', () => {
		const logs = [
			{ address: ROUTER, topics: [TRANSFER_TOPIC] },              // excluded: Transfer
			{ address: ROUTER, topics: ['0xaaa'] },                      // kept
			{ address: ROUTER, topics: ['0xaaa'] },                      // same -> count 2
			{ address: '0xpool', topics: ['0xbbb'] },                    // excluded: not the contract
		];
		const out = findSettlementEvents(logs, ROUTER);
		expect(out).toEqual([{ address: ROUTER, topic0: '0xaaa', count: 2 }]);
	});

	it('is case-insensitive on the contract address', () => {
		const logs = [{ address: ROUTER.toUpperCase(), topics: ['0xccc'] }];
		expect(findSettlementEvents(logs, ROUTER)).toEqual([
			{ address: ROUTER, topic0: '0xccc', count: 1 },
		]);
	});

	it('has a signature entry per v1 provider', () => {
		for (const slug of ['fabric', 'kyberswap', '0x', 'nordstern', 'odos', 'relay', 'velora']) {
			expect(AGGREGATOR_SIGNATURES[slug]).toBeTruthy();
			expect(AGGREGATOR_SIGNATURES[slug]!.settlementContract).toMatch(/^0x[0-9a-f]{40}$/);
			expect(Array.isArray(AGGREGATOR_SIGNATURES[slug]!.eventTopics)).toBe(true);
		}
	});
});

describe('matchSettlementEvent', () => {
	describe('router mode (default)', () => {
		const sig = {
			aggregator: 'test', settlementContract: ROUTER,
			eventTopics: ['0xaaa'], eventName: null,
		};

		it('returns the matched topic when emitted by the settlement contract', () => {
			expect(matchSettlementEvent([{ address: ROUTER, topics: ['0xaaa'] }], sig)).toBe('0xaaa');
		});

		it('returns null when the topic comes from a different address', () => {
			expect(matchSettlementEvent([{ address: '0xpool', topics: ['0xaaa'] }], sig)).toBeNull();
		});

		it('returns null when the topic is absent entirely', () => {
			expect(matchSettlementEvent([{ address: ROUTER, topics: ['0xzzz'] }], sig)).toBeNull();
		});

		it('matches ANY listed topic when several are registered', () => {
			const multi = { ...sig, eventTopics: ['0xaaa', '0xbbb'] };
			expect(matchSettlementEvent([{ address: ROUTER, topics: ['0xbbb'] }], multi)).toBe('0xbbb');
		});

		it('falls back to the first observed non-noise event when no topics are registered', () => {
			const unknown = { ...sig, eventTopics: [] };
			expect(matchSettlementEvent([{ address: ROUTER, topics: ['0xnew'] }], unknown)).toBe('0xnew');
		});

		it('is case-insensitive on the observed topic', () => {
			expect(matchSettlementEvent([{ address: ROUTER, topics: ['0xAAA'] }], sig)).toBe('0xaaa');
		});
	});

	describe("detectBy 'event_anywhere'", () => {
		const sig = {
			aggregator: 'test', settlementContract: ROUTER,
			eventTopics: ['0xbbb'], eventName: null, detectBy: 'event_anywhere' as const,
		};

		it('matches on ANY address, not just the router', () => {
			expect(matchSettlementEvent([{ address: '0xother', topics: ['0xbbb'] }], sig)).toBe('0xbbb');
		});

		it('returns null when absent', () => {
			expect(matchSettlementEvent([{ address: '0xother', topics: ['0xccc'] }], sig)).toBeNull();
		});

		it('returns null when no topics are registered', () => {
			expect(matchSettlementEvent([{ address: ROUTER, topics: ['0xbbb'] }], { ...sig, eventTopics: [] })).toBeNull();
		});
	});

	describe("detectBy 'none' (anonymous log)", () => {
		it('never matches — 0x Settler emits a zero-topic log that no topic rule can see', () => {
			const sig = AGGREGATOR_SIGNATURES['0x']!;
			expect(sig.detectBy).toBe('none');
			expect(sig.eventTopics).toEqual([]);
			// The real anonymous log from tx 0xb02037…9e26: topics is empty.
			const logs = [{ address: '0x7747f8d2a76bd6345cc29622a946a929647f2359', topics: [] as string[] }];
			expect(matchSettlementEvent(logs, sig)).toBeNull();
		});

		it('short-circuits even when a matching topic IS present — the guard, not the empty topic list', () => {
			const sig = AGGREGATOR_SIGNATURES['0x']!;
			const EXCHANGE_PROXY = '0xdef1c0ded9bec7f1a1670819833240f027b25eff';
			// Force the only conditions under which a match could otherwise occur:
			// the topic is registered AND emitted by the settlementContract. The
			// 'none' short-circuit must still win.
			const forced = { ...sig, eventTopics: ['0xaaa'] };
			expect(matchSettlementEvent([{ address: EXCHANGE_PROXY, topics: ['0xaaa'] }], forced)).toBeNull();
		});
	});
});

describe('settlementEventPresent', () => {
	it('is a boolean wrapper over matchSettlementEvent', () => {
		const sig = { aggregator: 't', settlementContract: ROUTER, eventTopics: ['0xaaa'], eventName: null };
		expect(settlementEventPresent([{ address: ROUTER, topics: ['0xaaa'] }], sig)).toBe(true);
		expect(settlementEventPresent([{ address: ROUTER, topics: ['0xzzz'] }], sig)).toBe(false);
	});
});

describe('Odos backfill (verified against receipts id 75/78 and the live V3 router)', () => {
	const ODOS_SWAP_V2 = '0x823eaf01002d7353fbcadb2ea3305cc46fa35d799cb0914846d185ac06f8ad05';
	const ODOS_SWAP_V3 = '0x69db20ca9e32403e6c56e5193b3e3b2827ae5c430ccfdea392ba950d2d1ab2bc';
	const ODOS_V3_ROUTER = '0x0d05a7d3448512b78fa8a9e46c4872c88c4a0d05';

	it('registers all four Odos topics', () => {
		expect(AGGREGATOR_SIGNATURES['odos']!.eventTopics).toHaveLength(4);
	});

	it('matches the v2 Swap topic seen in receipts id 75 and 78', () => {
		const logs = [{ address: ROUTER, topics: [ODOS_SWAP_V2] }];
		expect(matchSettlementEvent(logs, AGGREGATOR_SIGNATURES['odos']!)).toBe(ODOS_SWAP_V2);
	});

	it('matches the V3 router, which is not the registered settlementContract', () => {
		const logs = [{ address: ODOS_V3_ROUTER, topics: [ODOS_SWAP_V3] }];
		expect(matchSettlementEvent(logs, AGGREGATOR_SIGNATURES['odos']!)).toBe(ODOS_SWAP_V3);
	});

	it('no longer accepts an arbitrary non-noise event — the check can now fail', () => {
		const logs = [{ address: ROUTER, topics: ['0xdeadbeef'] }];
		expect(matchSettlementEvent(logs, AGGREGATOR_SIGNATURES['odos']!)).toBeNull();
	});
});

describe('findAggregatorHints', () => {
	it('names aggregators whose settlement topic appears anywhere in the logs', () => {
		const nordstern = AGGREGATOR_SIGNATURES['nordstern']!.eventTopics[0]!;
		expect(findAggregatorHints([{ address: '0xanything', topics: [nordstern] }])).toEqual(['nordstern']);
	});

	it('returns empty when no known topic is present', () => {
		expect(findAggregatorHints([{ address: '0xanything', topics: ['0xnope'] }])).toEqual([]);
	});

	it('never names 0x — its anonymous log is invisible to topic matching', () => {
		expect(findAggregatorHints([{ address: '0x7747f8d2a76bd6345cc29622a946a929647f2359', topics: [] }])).toEqual([]);
	});

	it('skips detectBy none entries even when their topic is present', () => {
		// If findAggregatorHints did not skip 'none' entries, a registered 0x
		// topic appearing in the logs would name 0x. It must not.
		const patched = { ...AGGREGATOR_SIGNATURES['0x']!, eventTopics: ['0xaaa'] };
		const original = AGGREGATOR_SIGNATURES['0x'];
		AGGREGATOR_SIGNATURES['0x'] = patched;
		try {
			expect(findAggregatorHints([{ address: '0xanything', topics: ['0xaaa'] }])).toEqual([]);
		} finally {
			AGGREGATOR_SIGNATURES['0x'] = original!;
		}
	});
});
