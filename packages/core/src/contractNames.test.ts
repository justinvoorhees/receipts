import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveContractName, enrichFeeSinkNames } from './contractNames.js';

afterEach(() => {
	vi.unstubAllEnvs();
});

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

	// The two tests below pin BOTH sides of the `'apiKey' in deps` branch in
	// contractNames.ts. Env is stubbed in each so the result never depends on
	// whether the shell exported ETHERSCAN_API_KEY.
	it('returns null (no throw) when apiKey is explicitly undefined, even with the env set', async () => {
		vi.stubEnv('ETHERSCAN_API_KEY', 'env-key');
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		const name = await resolveContractName('0x1', { fetchImpl, apiKey: undefined, cache: {} });
		expect(name).toBeNull();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('falls back to the env only when apiKey is absent from deps', async () => {
		vi.stubEnv('ETHERSCAN_API_KEY', 'env-key');
		const spy = vi.fn().mockResolvedValue(okResp('EnvKeyed'));
		const name = await resolveContractName('0x3', { fetchImpl: spy as unknown as typeof fetch, cache: {} });
		expect(name).toBe('EnvKeyed');
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith(expect.stringContaining('apikey=env-key'));
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
