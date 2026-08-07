import { describe, expect, it } from 'vitest';
import { enrichLegRouters } from './legRouterEnrichment';

const RELAY = '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be';
const FABRIC = '0x7c137a37742437d2212b7bd873ed135b5c4c61da';

describe('enrichLegRouters', () => {
	it('attaches the resolved router to a leg executed by another aggregator', () => {
		const out = enrichLegRouters([{ venue: '0xpool', frameChain: [RELAY, FABRIC] }], null, 'Relay');
		expect(out![0]!.router).toEqual({ slug: 'fabric', address: FABRIC, path: ['relay', 'fabric'] });
	});

	it('leaves a leg untouched when the router resolves to the top line', () => {
		const out = enrichLegRouters([{ venue: '0xpool', frameChain: [RELAY] }], null, 'Relay');
		expect(out![0]!.router).toBeUndefined();
	});

	it('leaves legs from rows persisted before frameChain existed untouched', () => {
		const out = enrichLegRouters([{ venue: '0xpool' }], null, 'Relay');
		expect(out![0]!.router).toBeUndefined();
	});

	it('returns null legs unchanged', () => {
		expect(enrichLegRouters(null, '0xabc', 'odos')).toBeNull();
	});

	it('resolves the top line through routerAddress, not the frozen aggregator label — a stale raw-address label must not self-tag once the registry curates it', () => {
		// Regression for Finding 1: the row was persisted when RELAY was
		// uncurated, so `aggregator` froze the raw address string. `routerAddress`
		// (tx.to) is the same address, but is re-resolved against TODAY's
		// registry, where RELAY is curated. The leg's frameChain is that same
		// single frame — i.e. the leg ran inside the SAME contract as the top
		// line. Without resolving the top line through the registry too, the
		// stale label ('0xccc8...') would never match resolveLegRouter's
		// resolved 'relay' innermost slug, and the leg would be wrongly tagged
		// as if a second aggregator executed it.
		const out = enrichLegRouters([{ venue: '0xpool', frameChain: [RELAY] }], RELAY, RELAY);
		expect(out![0]!.router).toBeUndefined();
	});

	it('enriches per leg, not per receipt', () => {
		const out = enrichLegRouters(
			[
				{ venue: '0xa', frameChain: [RELAY, FABRIC] },
				{ venue: '0xb', frameChain: [RELAY] },
			],
			null,
			'Relay',
		);
		expect(out![0]!.router?.slug).toBe('fabric');
		expect(out![1]!.router).toBeUndefined();
	});
});
