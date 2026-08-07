import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

globalThis.React = React;

// Its own file, because the per-IP analysis limiter is a module-scope
// singleton: a sibling test that shares this budget would make this one fail
// for the wrong reason (same pattern as globalCeilingBlocksAnalysis.test.tsx).
// The env vars must be set BEFORE the page module is imported — they are read
// once, at module-load time, to size the limiters.
process.env.RATE_LIMIT_ANALYSES_PER_MIN = '1';
// Sized exactly to the number of ADMITTED analyses this file expects to run
// (1 in the first test below + 2 in the second) — see that test's comment for
// why an exact-fit budget, not a generous one, is what makes it a real test.
process.env.RATE_LIMIT_ANALYSES_GLOBAL_PER_HOUR = '3';

class NotFoundError extends Error {}
class RedirectError extends Error {
	constructor(public to: string) {
		super(`redirect:${to}`);
	}
}

// Mutable per-test client IP: clientKeyFromHeaders reads x-forwarded-for, so
// varying it is how the second test below simulates two different visitors.
// Defaults to no header set — clientKeyFromHeaders then falls back to
// 'unknown', matching the first test's original (unparameterized) behaviour.
const { getClientIp, setClientIp } = vi.hoisted(() => {
	let ip = '';
	return { getClientIp: () => ip, setClientIp: (next: string) => { ip = next; } };
});

vi.mock('next/navigation', () => ({
	notFound: vi.fn(() => {
		throw new NotFoundError('NEXT_NOT_FOUND');
	}),
	permanentRedirect: vi.fn((to: string) => {
		throw new RedirectError(to);
	}),
	useRouter: () => ({ push: () => {} }),
}));
vi.mock('next/headers', () => ({
	headers: async () => new Map(getClientIp() ? [['x-forwarded-for', getClientIp()]] : []),
}));
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
	setClientIp('');
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

// page.tsx checks the per-IP limiter FIRST and returns early on refusal,
// before the global limiter is ever invoked (see the comment at page.tsx
// "Per-IP is checked first and short-circuits"). This test pins that
// property: a visitor throttled per-IP must not spend any of the SHARED
// global budget, or one abusive IP could drain it for every other visitor.
//
// The global budget above is sized to EXACTLY 3 — the count of admitted
// (non-per-IP-blocked) analyses across this whole file: 1 from the test
// above (IP 'unknown') + 2 below (one per distinct IP here). That exactness
// is what makes this a real test rather than a vacuous one: if a future
// change made a per-IP refusal also call the global limiter, IP1's second
// (refused) request would silently consume the 3rd slot, and IP2's request
// — which this test asserts succeeds — would then be wrongly refused by the
// global ceiling instead. A generously large global budget would hide that
// regression completely.
it('does not charge the shared global budget for a per-IP refusal', async () => {
	mockLoad.mockResolvedValue(null);

	setClientIp('1.1.1.1');
	await ReceiptPage({ params: paramsFor(HASH_A) });
	expect(mockLoad).toHaveBeenCalledTimes(1); // admitted — 2nd global slot used

	await ReceiptPage({ params: paramsFor(HASH_B) });
	expect(mockLoad).toHaveBeenCalledTimes(1); // refused per-IP — global untouched

	setClientIp('2.2.2.2');
	await ReceiptPage({ params: paramsFor(HASH_A) });
	// A different IP, never throttled before, admitted on its first request —
	// and the global budget still has room for it only if the refusal above
	// truly spent nothing from the shared pool.
	expect(mockLoad).toHaveBeenCalledTimes(2);
});
