import { describe, expect, it } from 'vitest';
import { parseDeployerTransfers, loadSettlerRegistry } from './settlerRegistry.js';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ERC721 Transfer topics: [sig, from, to, tokenId]. tokenId == feature number.
const SIG = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (addr: string) => '0x' + addr.slice(2).padStart(64, '0');
const ZERO = '0x0000000000000000000000000000000000000000';
const A = '0xbec2c2f65085c674da686b8229fa2b42f9b2f27b';
const B = '0x3d868cd3f8f24da361364e442411dae23cd79cc4';
const C = '0x109969447f53b29ee4b446323c41757b97481906';

const log = (from: string, to: string, feature: number, block: number) => ({
	topics: [SIG, pad(from), pad(to), '0x' + feature.toString(16).padStart(64, '0')],
	blockNumber: '0x' + block.toString(16),
});

describe('parseDeployerTransfers', () => {
	it('records the mint target as a settler at its mint block', () => {
		const out = parseDeployerTransfers([log(ZERO, A, 2, 14769149)], '0x');
		expect(out).toEqual([
			{ aggregator: '0x', feature: 2, address: A, fromBlock: 14769149, source: 'deployer-transfer-scan' },
		]);
	});

	it('keeps BOTH sides of a rotation — identity is a set, not a timeline', () => {
		const out = parseDeployerTransfers(
			[log(ZERO, A, 2, 14769149), log(A, B, 2, 14890301)],
			'0x',
		);
		expect(out.map((e) => e.address)).toEqual([A, B]);
	});

	it('filters the zero address so a burn does not enter the set', () => {
		const out = parseDeployerTransfers(
			[log(ZERO, C, 1, 12723120), log(C, ZERO, 1, 14859201)],
			'0x',
		);
		expect(out.map((e) => e.address)).toEqual([C]);
		expect(out.map((e) => e.address)).not.toContain(ZERO);
	});

	it('dedupes a re-registered address to its earliest block', () => {
		const out = parseDeployerTransfers([log(ZERO, A, 2, 500), log(B, A, 2, 900)], '0x');
		expect(out).toHaveLength(1);
		expect(out[0]!.fromBlock).toBe(500);
	});

	it('lowercases addresses', () => {
		const out = parseDeployerTransfers([log(ZERO, A.toUpperCase(), 2, 1)], '0x');
		expect(out[0]!.address).toBe(A);
	});

	it('sorts by feature then block', () => {
		const out = parseDeployerTransfers(
			[log(ZERO, B, 4, 100), log(ZERO, A, 2, 200), log(ZERO, C, 2, 50)],
			'0x',
		);
		expect(out.map((e) => e.feature)).toEqual([2, 2, 4]);
		expect(out.map((e) => e.fromBlock)).toEqual([50, 200, 100]);
	});
});

describe('loadSettlerRegistry', () => {
	async function writeConfig(body: unknown): Promise<string> {
		const dir = await mkdtemp(path.join(tmpdir(), 'settlers-'));
		const p = path.join(dir, 'settlers.json');
		await writeFile(p, JSON.stringify(body), 'utf8');
		return p;
	}

	it('indexes settlers by lowercase address', async () => {
		const p = await writeConfig({
			deployer: '0x00000000000004533fe15556b1e086bb1a72ceae',
			chainId: 8453,
			settlers: [
				{ aggregator: '0x', feature: 2, address: '0x7747f8d2a76bd6345cc29622a946a929647f2359', fromBlock: 44438102, source: 'deployer-transfer-scan' },
			],
		});
		const reg = await loadSettlerRegistry(p);
		expect(reg.byAddressLower.get('0x7747f8d2a76bd6345cc29622a946a929647f2359')!.aggregator).toBe('0x');
		expect(reg.all).toHaveLength(1);
	});

	it('is case-insensitive on lookup', async () => {
		const p = await writeConfig({
			deployer: '0x0', chainId: 8453,
			settlers: [{ aggregator: '0x', feature: 2, address: '0x7747F8D2A76BD6345CC29622A946A929647F2359', fromBlock: 1, source: 's' }],
		});
		const reg = await loadSettlerRegistry(p);
		expect(reg.byAddressLower.get('0x7747f8d2a76bd6345cc29622a946a929647f2359')).toBeTruthy();
	});

	it('throws on a missing file so the caller can decide to degrade', async () => {
		await expect(loadSettlerRegistry('/nonexistent/settlers.json')).rejects.toThrow();
	});
});
