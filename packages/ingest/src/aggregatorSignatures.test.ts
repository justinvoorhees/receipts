import { describe, expect, it } from 'vitest';
import { findSettlementEvents, AGGREGATOR_SIGNATURES } from './aggregatorSignatures.js';

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
