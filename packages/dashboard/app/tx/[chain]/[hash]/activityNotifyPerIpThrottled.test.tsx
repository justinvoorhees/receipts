import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

globalThis.React = React;

// Its own file, for the same reason as perIpCeilingBlocksAnalysis.test.tsx:
// the per-IP analysis limiter is a module-scope singleton read from this env
// var at import time.
process.env.RATE_LIMIT_ANALYSES_PER_MIN = '1';

// See activityNotifyGating.test.tsx for why the mock discriminates on
// `debounceMs` rather than an env var: `alertNotify` and `activityNotify`
// share one factory and only differ in shape.
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

const HASH_A = '0x' + 'a'.repeat(64);
const HASH_B = '0x' + 'b'.repeat(64);
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
	activityNotifySpy.mockClear();
	delete process.env.TCA_RPC_URL;
});

// A request the per-IP limiter refuses never reaches loadReceipt (see
// perIpCeilingBlocksAnalysis.test.tsx), so it must not report a "receipt
// created" message either — there is no receipt. The first call is the
// control: it's admitted and DOES notify, so the second call's flat count
// proves the throttle, not an accident of the mock.
it('does not notify for a request throttled by the per-IP limiter', async () => {
	mockLoad.mockResolvedValue(RECEIPT);

	await ReceiptPage({ params: paramsFor(HASH_A) });
	expect(activityNotifySpy).toHaveBeenCalledTimes(1); // the admitted view

	await ReceiptPage({ params: paramsFor(HASH_B) });
	expect(activityNotifySpy).toHaveBeenCalledTimes(1); // still 1 — throttled, no second report
});
