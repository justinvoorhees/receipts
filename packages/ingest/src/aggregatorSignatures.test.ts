import { describe, expect, it } from 'vitest';
import { findSettlementEvents, AGGREGATOR_SIGNATURES, settlementEventPresent } from './aggregatorSignatures.js';

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
		}
	});
});

describe('settlementEventPresent', () => {
	describe('router mode (default)', () => {
		const sig = {
			aggregator: 'test', settlementContract: ROUTER,
			eventTopic0: '0xaaa', eventName: null,
		};

		it('returns true when eventTopic0 is emitted by the settlement contract', () => {
			const logs = [{ address: ROUTER, topics: ['0xaaa'] }];
			expect(settlementEventPresent(logs, sig)).toBe(true);
		});

		it('returns false when eventTopic0 is emitted by a different address', () => {
			const logs = [{ address: '0xother', topics: ['0xaaa'] }];
			expect(settlementEventPresent(logs, sig)).toBe(false);
		});

		it('returns false when eventTopic0 is absent entirely', () => {
			const logs = [{ address: ROUTER, topics: ['0xzzz'] }];
			expect(settlementEventPresent(logs, sig)).toBe(false);
		});
	});

	describe('event_anywhere mode', () => {
		const sig = {
			aggregator: 'test', settlementContract: ROUTER,
			eventTopic0: '0xbbb', eventName: null, detectBy: 'event_anywhere' as const,
		};

		it('returns true when eventTopic0 appears on ANY address (incl. non-router)', () => {
			const logs = [{ address: '0xexecutor_contract', topics: ['0xbbb'] }];
			expect(settlementEventPresent(logs, sig)).toBe(true);
		});

		it('returns false when eventTopic0 is absent', () => {
			const logs = [{ address: '0xexecutor_contract', topics: ['0xccc'] }];
			expect(settlementEventPresent(logs, sig)).toBe(false);
		});

		it('returns false when eventTopic0 is null', () => {
			const nullSig = { ...sig, eventTopic0: null };
			const logs = [{ address: '0xexecutor_contract', topics: ['0xbbb'] }];
			expect(settlementEventPresent(logs, nullSig)).toBe(false);
		});
	});
});
