import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.React = React;

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

const {
	getServerSnapshot,
	getSnapshot,
	rememberReceipt,
	resetReceiptTransition,
	setLoaderWord,
} = await import('./receiptTransition');

const RECEIPT = {
	txHash: '0x' + 'a'.repeat(64),
	chainId: 8453, blockNumber: 123, aggregator: 'kyberswap', direction: 'buy_weth',
	inputToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
	outputToken: '0x4200000000000000000000000000000000000006',
	inputSymbol: 'USDC', outputSymbol: 'WETH',
	inputAmount: 1000.0, outputAmount: 0.33, notionalUsd: 1000.0,
	realizedPrice: 3000, marketMid: 3000, allInCostBps: -1, pricingStatus: 'full',
	lpFeeBps: 1, aggFeeBps: 0, slippageBps: -2, executionBps: '-1', gasCostUsd: 0.001,
	hopCount: 1, routeShape: 'single', decompConfidence: 'low', routeLegs: [], routePure: true,
	reconResidualBps: null, manipulationFlag: false,
} as never;

beforeEach(() => {
	resetReceiptTransition();
});

describe('receipt transition store', () => {
	it('carries the receipt and the loader word across a navigation', () => {
		setLoaderWord('Decomposing');
		rememberReceipt(RECEIPT);
		expect(getSnapshot()).toEqual({ receipt: RECEIPT, word: 'Decomposing' });
	});

	// The store is module state. On the server that is shared by every request,
	// so a populated snapshot would put one visitor's receipt into another
	// visitor's HTML. getServerSnapshot is the guard, and it must stay blind to
	// whatever the module happens to be holding.
	it('never reports a receipt to a server render, even once populated', () => {
		rememberReceipt(RECEIPT);
		setLoaderWord('Decomposing');
		expect(getSnapshot().receipt).not.toBeNull();
		expect(getServerSnapshot()).toEqual({ receipt: null, word: null });
	});

	it('is a no-op when handed the receipt it already holds', () => {
		rememberReceipt(RECEIPT);
		const first = getSnapshot();
		rememberReceipt(RECEIPT);
		expect(getSnapshot()).toBe(first);
	});
});

describe('ReceiptFallback', () => {
	// renderToStaticMarkup resolves useSyncExternalStore through
	// getServerSnapshot, so this is the hard-navigation screen by construction —
	// which is exactly the case that must not leak.
	it('renders the empty prefilled shell on a server render, never a stored receipt', async () => {
		rememberReceipt(RECEIPT);
		const { ReceiptFallback } = await import('./receiptFallback');
		const hash = '0x' + 'b'.repeat(64);
		const html = renderToStaticMarkup(<ReceiptFallback hash={hash} />);

		expect(html).toContain(`value="${hash}"`);
		expect(html).toContain('Analyzing…');
		// The stored receipt's content must be absent: no aggregator name, and
		// none of the receipt sections.
		expect(html).not.toContain('KyberSwap');
		expect(html).not.toContain('Transaction Costs');
		expect(html).not.toContain('receipt-pending-pulse');
	});
});
