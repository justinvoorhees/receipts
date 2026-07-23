import { describe, it, expect } from 'vitest';
import { mechanismForKind, pickReferenceToken, POOL_FAMILIES } from './poolFamilies.js';

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const BLUAI = '0xed9ae3def8d6f052971bb8b6d1975ff267cf9aad';

describe('mechanismForKind', () => {
	it('maps V3-style kinds to v3-slot0', () => {
		expect(mechanismForKind('univ3')).toBe('v3-slot0');
		expect(mechanismForKind('pancakev3')).toBe('v3-slot0');
		expect(mechanismForKind('aerodrome_cl')).toBe('v3-slot0');
	});
	it('maps basic-AMM kinds to v2-reserves', () => {
		expect(mechanismForKind('aerodrome_basic')).toBe('v2-reserves');
		expect(mechanismForKind('univ2')).toBe('v2-reserves');
	});
});

describe('pickReferenceToken', () => {
	it('prefers the stronger anchor (WETH over a volatile token)', () => {
		expect(pickReferenceToken(BLUAI, WETH)).toBe(WETH);
		expect(pickReferenceToken(WETH, BLUAI)).toBe(WETH);
	});
	it('prefers a stablecoin over WETH', () => {
		expect(pickReferenceToken(WETH, USDC)).toBe(USDC);
	});
	it('is deterministic on an anchor tie (higher address wins)', () => {
		const a = '0x0000000000000000000000000000000000000001';
		const b = '0x0000000000000000000000000000000000000002';
		expect(pickReferenceToken(a, b)).toBe(b);
		expect(pickReferenceToken(b, a)).toBe(b);
	});
});

describe('POOL_FAMILIES', () => {
	it('includes the Aerodrome basic family with v2-reserves mechanism', () => {
		const basic = POOL_FAMILIES.find((f) => f.kind === 'aerodrome_basic');
		expect(basic).toBeDefined();
		expect(basic!.mechanism).toBe('v2-reserves');
	});
	it('every family mechanism agrees with mechanismForKind', () => {
		for (const f of POOL_FAMILIES) expect(f.mechanism).toBe(mechanismForKind(f.kind));
	});
});
