import { describe, expect, it } from 'vitest';
import { resolveLegRouter } from './resolveLegRouter.js';

const RELAY = '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be'; // routers.json: Relay
const FABRIC = '0x7c137a37742437d2212b7bd873ed135b5c4c61da'; // routers.json: Fabric
const KYBER = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5'; // routers.json: KyberSwap
const UNKNOWN_A = '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f'; // RelayRouterV3, uncurated
const UNKNOWN_B = '0x1b2b6ce813b99b840fe632c63bca5394938ef01e'; // VelodromeSlipstreamRouter

describe('resolveLegRouter', () => {
	it('returns the innermost known router when it differs from the top line', () => {
		expect(resolveLegRouter([RELAY, UNKNOWN_A, FABRIC], 'relay')).toEqual({
			slug: 'fabric',
			address: FABRIC,
			path: ['relay', 'fabric'],
		});
	});

	it('drops uncurated frames from the path entirely', () => {
		const r = resolveLegRouter([RELAY, UNKNOWN_A, UNKNOWN_B, FABRIC], 'relay');
		expect(r!.path).toEqual(['relay', 'fabric']);
	});

	it('returns null when the innermost known router IS the top-line aggregator', () => {
		expect(resolveLegRouter([KYBER, UNKNOWN_A], 'kyberswap')).toBeNull();
	});

	it('returns null on re-entry — the top-line aggregator took the leg back', () => {
		// Relay > Fabric > Relay. A real participant (Fabric) goes unmentioned;
		// that is a decided tradeoff, not an oversight (see the design doc).
		expect(resolveLegRouter([RELAY, FABRIC, RELAY], 'relay')).toBeNull();
	});

	it('attributes even when the top-line aggregator is uncurated', () => {
		// id250: top line is the bare address 0x5f693aa7…, so the path is Fabric
		// alone — length 1, which Task 5 renders without a tooltip.
		expect(resolveLegRouter([UNKNOWN_A, FABRIC], '0x5f693aa785c5c8301f21ec9d204cde209514d431')).toEqual({
			slug: 'fabric',
			address: FABRIC,
			path: ['fabric'],
		});
	});

	it('returns null when no frame is a known router', () => {
		expect(resolveLegRouter([UNKNOWN_A, UNKNOWN_B], 'relay')).toBeNull();
	});

	it('returns null for an absent or empty chain', () => {
		expect(resolveLegRouter(undefined, 'relay')).toBeNull();
		expect(resolveLegRouter([], 'relay')).toBeNull();
	});

	it('collapses consecutive frames belonging to the same aggregator', () => {
		// Nordstern runs two routers; two of its own frames in a row are one hop.
		const N1 = '0xc87de04e2ec1f4282dff2933a2d58199f688fc3d';
		const N2 = '0x663dc15d3c1ac63ff12e45ab68fea3f0a883c251';
		expect(resolveLegRouter([RELAY, N2, N1], 'relay')!.path).toEqual(['relay', 'nordstern']);
	});

	it('is case-insensitive on both the chain and the top-level slug', () => {
		expect(resolveLegRouter([RELAY.toUpperCase().replace('0X', '0x'), FABRIC], 'RELAY')).toEqual({
			slug: 'fabric',
			address: FABRIC,
			path: ['relay', 'fabric'],
		});
	});
});
