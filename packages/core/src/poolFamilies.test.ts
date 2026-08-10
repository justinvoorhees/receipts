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

/** A client stand-in that records peak concurrent readContract calls. */
function probingClient(result: string = '0x00000000000000000000000000000000000000ab') {
	let inFlight = 0;
	let peak = 0;
	let calls = 0;
	const client = {
		readContract: async () => {
			calls += 1;
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight -= 1;
			return result;
		},
	};
	return { client, peak: () => peak, calls: () => calls };
}

describe('factory scans', () => {
	const univ3Family = POOL_FAMILIES.find((f) => f.kind === 'univ3')!;
	it('scans a family’s fee tiers / tick spacings concurrently, not one at a time', async () => {
		const probe = probingClient();

		await univ3Family.discover(probe.client as never, '0xa', '0xb');

		expect(probe.calls()).toBeGreaterThan(1);
		expect(probe.peak()).toBeGreaterThan(1);
	});

	it('returns candidates in the family’s declared parameter order', async () => {
		// Order is load-bearing: rankCandidatesByDepth breaks a depth tie by
		// position, so a scan that returns tiers in completion order would make
		// pool selection depend on RPC timing.
		let n = 0;
		const client = {
			readContract: async () => {
				const i = n++;
				// Later tiers resolve first. 1-based so tier 0 is not the zero
				// address, which discovery legitimately drops.
				await new Promise((r) => setTimeout(r, 20 - i * 4));
				return `0x${String(i + 1).repeat(40).slice(0, 40)}`;
			},
		};

		const addrs = await univ3Family.discover(client as never, '0xa', '0xb');

		expect(addrs).toEqual([
			'0x1111111111111111111111111111111111111111',
			'0x2222222222222222222222222222222222222222',
			'0x3333333333333333333333333333333333333333',
			'0x4444444444444444444444444444444444444444',
		]);
	});

	it('still drops the zero address and a reverting tier', async () => {
		let n = 0;
		const client = {
			readContract: async () => {
				const i = n++;
				if (i === 0) return '0x0000000000000000000000000000000000000000';
				if (i === 1) throw new Error('no such tier');
				return `0x${String(i + 1).repeat(40).slice(0, 40)}`;
			},
		};

		const addrs = await univ3Family.discover(client as never, '0xa', '0xb');

		expect(addrs).toEqual([
			'0x3333333333333333333333333333333333333333',
			'0x4444444444444444444444444444444444444444',
		]);
	});
});
