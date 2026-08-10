import { describe, it, expect } from 'vitest';
import { pinnedPoolResolver } from './pinnedPool.js';

describe('pinnedPoolResolver', () => {
	it('resolves a pair once and serves every later block from that one resolution', async () => {
		const blocks: bigint[] = [];
		const resolve = async (a: string, b: string, block: bigint) => {
			blocks.push(block);
			return { address: '0xpool', kind: 'univ3' };
		};
		const pinned = pinnedPoolResolver(resolve, 100n);

		await pinned('0xa', '0xb', 100n);
		await pinned('0xa', '0xb', 99n);
		await pinned('0xa', '0xb', 101n);

		expect(blocks).toEqual([100n]);
	});

	it('pins to the reference block even when first called for a wing', async () => {
		const blocks: bigint[] = [];
		const resolve = async (a: string, b: string, block: bigint) => {
			blocks.push(block);
			return null;
		};
		const pinned = pinnedPoolResolver(resolve, 100n);

		await pinned('0xa', '0xb', 99n);

		expect(blocks).toEqual([100n]);
	});

	it('returns the SAME pool for the wings as for the centre, even when a different pool ranks deepest at an adjacent block', async () => {
		// The defect this exists to prevent: rank-per-block picks pool A at the
		// centre and pool B one block over, so the before/mid/after triple
		// measures the gap between two pools instead of movement over time.
		const byBlock: Record<string, { address: string; kind: string }> = {
			'99': { address: '0xshallow', kind: 'univ3' },
			'100': { address: '0xdeep', kind: 'univ3' },
			'101': { address: '0xother', kind: 'univ3' },
		};
		const pinned = pinnedPoolResolver(async (a, b, block) => byBlock[String(block)], 100n);

		const centre = await pinned('0xa', '0xb', 100n);
		const before = await pinned('0xa', '0xb', 99n);
		const after = await pinned('0xa', '0xb', 101n);

		expect(centre?.address).toBe('0xdeep');
		expect(before?.address).toBe('0xdeep');
		expect(after?.address).toBe('0xdeep');
	});

	it('keeps distinct pairs distinct, in both token orders', async () => {
		const seen: string[] = [];
		const pinned = pinnedPoolResolver(async (a, b) => {
			seen.push(`${a}/${b}`);
			return { address: `${a}${b}`, kind: 'univ3' };
		}, 100n);

		await pinned('0xa', '0xb', 100n);
		await pinned('0xc', '0xd', 100n);
		await pinned('0xA', '0xB', 100n); // same pair, different casing
		await pinned('0xb', '0xa', 100n); // same pair, reversed order

		expect(seen).toEqual(['0xa/0xb', '0xc/0xd']);
	});

	it('caches a null resolution too, so a pair with no pool is not rescanned per block', async () => {
		let calls = 0;
		const pinned = pinnedPoolResolver(async () => {
			calls += 1;
			return null;
		}, 100n);

		await pinned('0xa', '0xb', 100n);
		await pinned('0xa', '0xb', 99n);

		expect(calls).toBe(1);
	});

	it('does not cache a rejection — the next call retries', async () => {
		let calls = 0;
		const pinned = pinnedPoolResolver(async () => {
			calls += 1;
			if (calls === 1) throw new Error('transient');
			return { address: '0xpool', kind: 'univ3' };
		}, 100n);

		await expect(pinned('0xa', '0xb', 100n)).rejects.toThrow('transient');
		await expect(pinned('0xa', '0xb', 100n)).resolves.toEqual({ address: '0xpool', kind: 'univ3' });
		expect(calls).toBe(2);
	});
});
