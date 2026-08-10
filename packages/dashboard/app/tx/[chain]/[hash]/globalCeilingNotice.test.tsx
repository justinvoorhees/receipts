import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

globalThis.React = React;

// Its own file, for the same reason as globalCeilingBlocksAnalysis.test.tsx:
// the global analysis limiter is a module-scope singleton read from this env
// var at import time, so it must be set before the page module is imported and
// must not share a module registry with any other ceiling-sensitive test.
process.env.RATE_LIMIT_ANALYSES_GLOBAL_PER_HOUR = '1';

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


beforeEach(() => {
	mockLoad.mockClear();
	delete process.env.TCA_RPC_URL;
});

// A ceiling is about US, not about the transaction. Every other empty state on
// this page asserts something the analysis established; rendering the normal
// "not a swap" state here would assert something we never checked.
it('refuses politely rather than rendering a false negative', async () => {
	mockLoad.mockResolvedValue(RECEIPT);

	await ReceiptBody({ chain: DEFAULT_CHAIN, hash: HASH_A });
	const html = renderToStaticMarkup(await ReceiptBody({ chain: DEFAULT_CHAIN, hash: HASH_B }));

	expect(html).toContain('temporarily unavailable');
	expect(html).not.toContain('Not a swap');
});
