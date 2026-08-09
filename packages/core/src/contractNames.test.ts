import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveContractName, enrichFeeSinkNames, resolveCachePath } from './contractNames.js';

afterEach(() => {
	vi.unstubAllEnvs();
});

const okResp = (name: string) => ({
	ok: true,
	json: async () => ({ status: '1', message: 'OK', result: [{ ContractName: name }] }),
});

// The repo root, found from this test file rather than from cwd — the whole
// point of the suite below is that cwd varies.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('resolveCachePath', () => {
	const EXPECTED = path.join(REPO_ROOT, 'configs', 'contractNames.json');

	it('finds the committed cache from the repo root (vitest, scripts, tsc dist)', () => {
		const found = resolveCachePath(REPO_ROOT);
		expect(found).toBe(EXPECTED);
		expect(existsSync(found!)).toBe(true);
	});

	// Where `next start` actually runs from. A resolver that only handled the
	// repo root would pass the test above and still miss in production.
	it('finds it from packages/dashboard, where the Next server runs', () => {
		expect(resolveCachePath(path.join(REPO_ROOT, 'packages', 'dashboard'))).toBe(EXPECTED);
	});

	// The cwd walk is what survives a build whose absolute paths do not exist at
	// runtime (see the docblock). Pinned with the fallback disabled so this
	// asserts the walk itself, not the fallback quietly covering for it.
	it('finds it by the cwd walk alone, with no module-relative fallback', () => {
		expect(resolveCachePath(path.join(REPO_ROOT, 'packages', 'dashboard'), null)).toBe(EXPECTED);
	});

	// The other half: when cwd is somewhere the walk cannot help, the
	// module-relative path still answers. This is the case that holds under
	// plain Node, and under a Nixpacks build where build and run share /app.
	it('falls back to the module-relative path when the cwd walk finds nothing', () => {
		expect(resolveCachePath(path.parse(REPO_ROOT).root, EXPECTED)).toBe(EXPECTED);
	});

	// Null, not a guessed path: "no cache file" is a legitimate state (a deploy
	// that did not ship configs/), and persistCache must not invent one.
	it('returns null rather than a guess when neither route finds a file', () => {
		expect(resolveCachePath(path.parse(REPO_ROOT).root, null)).toBeNull();
		expect(resolveCachePath(path.parse(REPO_ROOT).root, '/nope/contractNames.json')).toBeNull();
	});
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
		expect(spy).toHaveBeenCalledWith(expect.stringContaining('apikey=env-key'), expect.anything());
	});

	it('returns null (no throw) when fetch rejects', async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error('network')) as unknown as typeof fetch;
		const name = await resolveContractName('0x2', { fetchImpl, apiKey: 'k', cache: {} });
		expect(name).toBeNull();
	});

	// A non-2xx is a statement about Etherscan, not about the contract. 429, 502
	// and 403 all arrive here, and writing `null` for them records "this contract
	// has no verified name" — permanently, because the write is persisted and the
	// cache is consulted ahead of every later fetch. Must behave like the reject
	// branch above: answer null now, learn nothing.
	it('does not negative-cache a non-2xx response', async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: false,
			status: 429,
			json: async () => ({}),
		}) as unknown as typeof fetch;
		const cache: Record<string, string | null> = {};

		const name = await resolveContractName('0x5', { fetchImpl, apiKey: 'k', cache });

		expect(name).toBeNull();
		expect(cache).not.toHaveProperty('0x5');
	});

	// The consequence of the above, stated as behaviour: a rate-limited minute
	// must not cost the name forever.
	it('re-fetches after a non-2xx and resolves the name on the retry', async () => {
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) })
			.mockResolvedValueOnce(okResp('AugustusFeeVault')) as unknown as typeof fetch;
		const cache: Record<string, string | null> = {};

		expect(await resolveContractName('0x6', { fetchImpl, apiKey: 'k', cache })).toBeNull();
		expect(await resolveContractName('0x6', { fetchImpl, apiKey: 'k', cache })).toBe('AugustusFeeVault');
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	// This call now runs on the /tx render path: a hung socket must not hang
	// the page indefinitely, so every request carries an abort signal.
	it('passes an AbortSignal so a hung socket cannot hang the caller forever', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(okResp('Vault')) as unknown as typeof fetch;
		await resolveContractName('0x4', { fetchImpl, apiKey: 'k', cache: {} });
		expect(fetchImpl).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
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

	// This runs on the /tx render path, where each miss is a network round trip
	// capped at TIMEOUT_MS. Awaited one at a time, N cold sinks add up to N ×
	// TIMEOUT_MS to a page render; the lookups are independent, so they should
	// overlap. Asserting peak concurrency rather than elapsed time keeps this
	// from being a flaky timing test — sequential resolution pins maxInFlight at
	// 1 no matter how fast the machine is.
	it('resolves its sinks concurrently, not one after another', async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const fetchImpl = vi.fn().mockImplementation(async () => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 5));
			inFlight -= 1;
			return okResp('Vault');
		}) as unknown as typeof fetch;

		await enrichFeeSinkNames(
			[
				{ address: '0xA', feeBps: 10, source: 'retained_balance' },
				{ address: '0xB', feeBps: 5, source: 'retained_balance' },
				{ address: '0xC', feeBps: 1, source: 'retained_balance' },
			],
			{ fetchImpl, apiKey: 'k', cache: {} },
		);

		expect(maxInFlight).toBe(3);
	});
});
