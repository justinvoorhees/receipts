import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Receipt } from '@fabric-tca/core';

vi.mock('@fabric-tca/core', () => ({ analyzeTransaction: vi.fn() }));
vi.mock('../../../lib/queries.js', () => ({
	getReceiptByHash: vi.fn(),
	insertReceipt: vi.fn(),
}));

import { analyzeTransaction } from '@fabric-tca/core';
import { getReceiptByHash, insertReceipt } from '../../../lib/queries.js';
import { POST } from './route.js';

const mockAnalyze = vi.mocked(analyzeTransaction);
const mockGet = vi.mocked(getReceiptByHash);
const mockInsert = vi.mocked(insertReceipt);

function post(body: unknown): Request {
	return new Request('http://x/api/receipts', {
		method: 'POST',
		body: JSON.stringify(body),
	});
}

const sampleReceipt: Receipt = {
	txHash: '0xabc',
	chainId: 8453,
	blockNumber: 123,
	aggregator: '0xagg',
	trader: '0xtrader',
	direction: 'buy_weth',
	inputToken: '0xusdc',
	outputToken: '0xweth',
	inputSymbol: 'USDC',
	outputSymbol: 'WETH',
	inputAmount: 1000.5,
	outputAmount: 0.42,
	notionalUsd: 1000.5,
	realizedPrice: 2380.1,
	marketMid: 2381.0,
	allInCostBps: 12.3,
	pricingStatus: 'full',
	executionBps: 5.1,
	lpFeeBps: 5.0,
	aggFeeBps: 2.0,
	slippageBps: 0.2,
	gasCostUsd: 0.5,
	routePure: true,
	routeShape: 'single',
	hopCount: 1,
	routeLegs: [{ venue: '0xpool' }],
	reconResidualBps: null,
	decompConfidence: 'high',
	feeRecipient: null,
	feeSinkSource: null,
	integratorFeeBps: null,
	fabricFeeBps: null,
	settlementEventName: 'Swap',
	settlementEventTopic0: '0xtopic',
	settlementEventSeen: true,
	normalizeFlags: ['x'],
	chainlinkPrice: 2381.5,
	chainlinkDevBps: 0.1,
	poolDivergenceBps: 0.05,
	manipulationFlag: false,
	offchainPrice: null,
	offchainDevBps: null,
	chainlinkStalenessSecs: 12,
	anchorPriceUsd: null,
};

describe('POST /api/receipts', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.TCA_RPC_URL = 'http://rpc.test';
	});

	it('404s "Transaction not found." when analysis yields null', async () => {
		mockGet.mockResolvedValue(null);
		mockAnalyze.mockResolvedValue(null);

		const res = await POST(post({ hash: '0xnope' }));

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'Transaction not found.' });
		expect(mockInsert).not.toHaveBeenCalled();
	});

	it('200s with the existing stored row without re-analyzing', async () => {
		const stored = { id: 7, txHash: '0xabc' } as never;
		mockGet.mockResolvedValue(stored);

		const res = await POST(post({ hash: '0xabc' }));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(stored);
		expect(mockAnalyze).not.toHaveBeenCalled();
		expect(mockInsert).not.toHaveBeenCalled();
	});

	it('200s computing and inserting when not previously stored', async () => {
		mockGet.mockResolvedValue(null);
		mockAnalyze.mockResolvedValue(sampleReceipt);
		const inserted = { id: 42, txHash: '0xabc' } as never;
		mockInsert.mockResolvedValue(inserted);

		const res = await POST(post({ hash: '0xabc' }));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(inserted);
		expect(mockAnalyze).toHaveBeenCalledOnce();
		expect(mockInsert).toHaveBeenCalledOnce();

		// numeric columns must be strings for Drizzle numeric inserts
		const arg = mockInsert.mock.calls[0]![0] as Record<string, unknown>;
		expect(arg.inputAmount).toBe('1000.5');
		expect(arg.allInCostBps).toBe('12.3');
		expect(arg.offchainPrice).toBeNull();
		// jsonb + non-numeric pass through unchanged
		expect(arg.routeLegs).toEqual([{ venue: '0xpool' }]);
		expect(arg.blockNumber).toBe(123);
		expect(arg.settlementEventSeen).toBe(true);
	});
});
