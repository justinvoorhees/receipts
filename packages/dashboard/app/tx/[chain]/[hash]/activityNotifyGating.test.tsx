import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

globalThis.React = React;

// `activityNotify` and `alertNotify` are both module-scope singletons built
// by the SAME `createNotifier` factory (page.tsx:72-84), so a mock that
// intercepts the factory must be able to tell the two calls apart. They're
// distinguished by shape, not by an env var: `alertNotify` is created with a
// `debounceMs`, `activityNotify` is not. Routing on that lets the test assert
// on the activity stream specifically, without touching Slack, fetch, or the
// real debounce timer. `vi.hoisted` is required because `vi.mock` factories
// run before any module-scope `const` below them.
const { activityNotifySpy } = vi.hoisted(() => ({ activityNotifySpy: vi.fn() }));

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
vi.mock('../../../../lib/alerts.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../../lib/alerts.js')>();
	return {
		...actual,
		createNotifier: (opts: { debounceMs?: number } = {}) =>
			opts.debounceMs === undefined ? activityNotifySpy : vi.fn(),
	};
});

const { loadReceipt } = await import('../../../../lib/loadReceipt');
const { default: ReceiptPage } = await import('./page');

const mockLoad = vi.mocked(loadReceipt);

const HASH = '0x' + 'a'.repeat(64);
// Same render-safe fixture shape as the ceiling tests' RECEIPT — not required
// here (this test never renders to markup) but kept consistent in case a
// future assertion does.
const RECEIPT = {
	txHash: HASH,
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
	activityNotifySpy.mockClear();
	delete process.env.TCA_RPC_URL;
});

// The gate this notifier lives behind, verified rather than merely inspected:
// a genuine analysis must report exactly once.
it('notifies once when loadReceipt resolves a receipt', async () => {
	mockLoad.mockResolvedValue(RECEIPT);

	await ReceiptPage({ params: paramsFor(HASH) });

	expect(activityNotifySpy).toHaveBeenCalledTimes(1);
	expect(activityNotifySpy).toHaveBeenCalledWith('receipt_created', expect.stringContaining(HASH));
});

// With nothing stored, every view is a fresh analysis — so a null result
// (unresolvable hash, not a clean swap, unpriceable, ...) must NOT report a
// "receipt created" message about a transaction nobody successfully decoded.
it('does not notify when loadReceipt returns null', async () => {
	mockLoad.mockResolvedValue(null);

	await ReceiptPage({ params: paramsFor(HASH) });

	expect(activityNotifySpy).not.toHaveBeenCalled();
});
