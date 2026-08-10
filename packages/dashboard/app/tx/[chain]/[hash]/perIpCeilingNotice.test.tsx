import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

globalThis.React = React;

// Its own file, for the same reason as the global-ceiling tests: the per-IP
// analysis limiter is a module-scope singleton read from this env var at
// import time, so it must be set before the page module is imported and must
// not share a module registry with any other ceiling-sensitive test —
// including perIpCeilingBlocksAnalysis.test.tsx, which needs the SAME budget
// exhausted from a clean start.
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
const { ReceiptBody } = await import('./receiptBody');
const { DEFAULT_CHAIN } = await import('../../../../lib/chains');

const mockLoad = vi.mocked(loadReceipt);

const HASH_A = '0x' + 'a'.repeat(64);
const HASH_B = '0x' + 'b'.repeat(64);


beforeEach(() => {
	mockLoad.mockClear();
	delete process.env.TCA_RPC_URL;
});

// The per-IP throttle and the global ceiling are two different truths. A
// visitor tripping the per-minute limiter must not be told the SHARED hourly
// budget is gone — that is a false claim about site-wide capacity, the same
// category of error CeilingNotice exists to keep out of a claim about the
// transaction.
it('tells a per-IP-throttled visitor something brief and specific, not the global-exhaustion message', async () => {
	// Same client both times (clientKeyFromHeaders falls back to 'unknown' when
	// no forwarding headers are present), so the second call is the SAME
	// visitor tripping their own per-minute budget — not two different callers
	// sharing a global ceiling.
	await ReceiptBody({ chain: DEFAULT_CHAIN, hash: HASH_A });
	const html = renderToStaticMarkup(await ReceiptBody({ chain: DEFAULT_CHAIN, hash: HASH_B }));

	expect(html).toContain('faster than we allow');
	expect(html).not.toContain('hourly analysis budget is exhausted');
});
