import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

globalThis.React = React;

// Its own file, because the per-IP analysis limiter is a module-scope
// singleton: a sibling test that shares this budget would make this one fail
// for the wrong reason (same pattern as globalCeilingBlocksAnalysis.test.tsx).
// The env var must be set BEFORE the page module is imported — it is read
// once, at module-load time, to size the limiter.
process.env.RATE_LIMIT_ANALYSES_PER_MIN = '1';

class NotFoundError extends Error {}
class RedirectError extends Error {
	constructor(public to: string) {
		super(`redirect:${to}`);
	}
}

vi.mock('next/navigation', () => ({
	notFound: vi.fn(() => {
		throw new NotFoundError('NEXT_NOT_FOUND');
	}),
	permanentRedirect: vi.fn((to: string) => {
		throw new RedirectError(to);
	}),
	useRouter: () => ({ push: () => {} }),
}));
vi.mock('next/headers', () => ({ headers: async () => new Map() }));
vi.mock('../../../../lib/loadReceipt', () => ({ loadReceipt: vi.fn(async () => null) }));
vi.mock('@fabric-tca/core', () => ({ classifyTransaction: vi.fn(async () => ({ reason: 'NOT_A_SWAP' })) }));

const { loadReceipt } = await import('../../../../lib/loadReceipt');
const { default: ReceiptPage } = await import('./page');

const mockLoad = vi.mocked(loadReceipt);

const HASH_A = '0x' + 'a'.repeat(64);
const HASH_B = '0x' + 'b'.repeat(64);

const paramsFor = (hash: string) => Promise.resolve({ chain: 'base', hash });

beforeEach(() => {
	mockLoad.mockClear();
	delete process.env.TCA_RPC_URL;
});

// The property that protects the RPC bill: a request rejected by the per-IP
// limiter must not reach loadReceipt. Asserting on the rendered output alone
// would pass even if the analysis ran and its result was thrown away.
it('does not analyze once the per-IP limiter is exhausted', async () => {
	mockLoad.mockResolvedValue(null);

	await ReceiptPage({ params: paramsFor(HASH_A) });
	expect(mockLoad).toHaveBeenCalledTimes(1);

	await ReceiptPage({ params: paramsFor(HASH_B) });
	expect(mockLoad).toHaveBeenCalledTimes(1); // still 1 — the second was throttled
});
