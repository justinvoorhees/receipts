import { describe, it, expect, vi } from 'vitest';
import { resolveContractName, enrichFeeSinkNames } from './contractNames.js';

const okResp = (name: string) => ({
	ok: true,
	json: async () => ({ status: '1', message: 'OK', result: [{ ContractName: name }] }),
});

describe('resolveContractName', () => {
	it('returns the verified ContractName', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(okResp('AugustusFeeVault')) as unknown as typeof fetch;
		const cache: Record<string, string | null> = {};
		const name = await resolveContractName('0xAbC', { fetchImpl, apiKey: 'k', cache });
		expect(name).toBe('AugustusFeeVault');
		expect(cache['0xabc']).toBe('AugustusFeeVault');
	});

	it('returns null for empty ContractName and negative-caches it', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(okResp('')) as unknown as typeof fetch;
		const cache: Record<string, string | null> = {};
		const name = await resolveContractName('0xDEF', { fetchImpl, apiKey: 'k', cache });
		expect(name).toBeNull();
		expect(cache['0xdef']).toBeNull();
	});

	it('uses the cache without fetching', async () => {
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		const cache = { '0xabc': 'Cached' };
		const name = await resolveContractName('0xABC', { fetchImpl, apiKey: 'k', cache });
		expect(name).toBe('Cached');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('returns null (no throw) when no api key', async () => {
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		const name = await resolveContractName('0x1', { fetchImpl, apiKey: undefined, cache: {} });
		expect(name).toBeNull();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('returns null (no throw) when fetch rejects', async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error('network')) as unknown as typeof fetch;
		const name = await resolveContractName('0x2', { fetchImpl, apiKey: 'k', cache: {} });
		expect(name).toBeNull();
	});
});

describe('enrichFeeSinkNames', () => {
	it('adds names preserving order and shape', async () => {
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(okResp('Vault'))
			.mockResolvedValueOnce(okResp('')) as unknown as typeof fetch;
		const out = await enrichFeeSinkNames(
			[{ address: '0xA', feeBps: 10, source: 'retained_balance' }, { address: '0xB', feeBps: 5, source: 'retained_balance' }],
			{ fetchImpl, apiKey: 'k', cache: {} },
		);
		expect(out).toEqual([
			{ address: '0xA', feeBps: 10, source: 'retained_balance', name: 'Vault' },
			{ address: '0xB', feeBps: 5, source: 'retained_balance', name: null },
		]);
	});
});
