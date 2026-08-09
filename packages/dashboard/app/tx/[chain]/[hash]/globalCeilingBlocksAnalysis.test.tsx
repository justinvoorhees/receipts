import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

globalThis.React = React;

// Its own file, because the global analysis limiter is a module-scope
// singleton: a sibling test that shares this ceiling would make this one fail
// for the wrong reason — hence the one-assertion-per-file split across the
// four ceiling tests in this directory. The env var must be set BEFORE
// the page module is imported — it is read once, at module-load time, to size
// the limiter, so setting it inside an `it` block would be too late.
process.env.RATE_LIMIT_ANALYSES_GLOBAL_PER_HOUR = '1';

class NotFoundError extends Error {}
class RedirectError extends Error {
	constructor(public to: string) {
		super(`redirect:${to}`);
	}
}

// useRouter is required, not optional: this page renders ReceiptView, which
// renders ReceiptSearch, which calls useRouter(). Mocking next/navigation
// without it throws at render.
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
// Safe to stub wholesale: components import RUNTIME values only from
// '@fabric-tca/core/pure' (a different specifier). What they take from
// '@fabric-tca/core' is `import type` and erases at compile.
vi.mock('@fabric-tca/core', () => ({ classifyTransaction: vi.fn(async () => ({ reason: 'NOT_A_SWAP' })) }));

const { loadReceipt } = await import('../../../../lib/loadReceipt');
const { default: ReceiptPage } = await import('./page');

const mockLoad = vi.mocked(loadReceipt);

const HASH_A = '0x' + 'a'.repeat(64);
const HASH_B = '0x' + 'b'.repeat(64);
// Same render-safe fixture shape as components/receiptView.test.tsx's
// fullUsdcWethRow — kept renderable (not just type-cast) so a pre-fix RED run
// fails on the ceiling assertion itself, not on an unrelated crash while
// rendering a half-built receipt.
const RECEIPT = {
	txHash: HASH_A,
	chainId: 8453, blockNumber: 123, aggregator: 'kyberswap', direction: 'buy_weth',
	inputToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
	outputToken: '0x4200000000000000000000000000000000000006',
	inputSymbol: 'USDC', outputSymbol: 'WETH',
	inputAmount: 1000.00, outputAmount: 0.33, notionalUsd: 1000.00,
	realizedPrice: 3000, marketMid: 3000, allInCostBps: -1, pricingStatus: 'full',
	lpFeeBps: 1, aggFeeBps: 0, slippageBps: -2, executionBps: '-1', gasCostUsd: 0.001,
	hopCount: 1, routeShape: 'single', decompConfidence: 'low', routeLegs: [], routePure: true,
	reconResidualBps: null, manipulationFlag: false,
} as never;

const paramsFor = (hash: string) => Promise.resolve({ chain: 'base', hash });

beforeEach(() => {
	mockLoad.mockClear();
	delete process.env.TCA_RPC_URL;
});

// The property that protects the RPC bill: a request rejected by the global
// ceiling must not reach loadReceipt. Asserting on the rendered output alone
// would pass even if the analysis ran and its result was thrown away.
it('does not analyze once the global hourly ceiling is exhausted', async () => {
	mockLoad.mockResolvedValue(RECEIPT);

	await ReceiptPage({ params: paramsFor(HASH_A) });
	expect(mockLoad).toHaveBeenCalledTimes(1);

	await ReceiptPage({ params: paramsFor(HASH_B) });
	expect(mockLoad).toHaveBeenCalledTimes(1); // still 1 — the second was refused
});
