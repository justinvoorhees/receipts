import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

globalThis.React = React;

vi.mock('next/navigation', () => ({
	useRouter: () => ({ push: () => {} }),
}));

describe('formatDelta', () => {
	it('returns the absolute dollar difference between market and execution price', async () => {
		const { formatDelta } = await import('./ReceiptView');
		// Figma example: market 1830.44284125, realized 1829.763683289442 → $0.68
		expect(formatDelta(1830.44284125, 1829.763683289442)).toBe('$0.68');
	});

	it('returns the same value when realized > market', async () => {
		const { formatDelta } = await import('./ReceiptView');
		expect(formatDelta(1829.00, 1830.00)).toBe('$1.00');
	});

	it('returns – for null inputs', async () => {
		const { formatDelta } = await import('./ReceiptView');
		expect(formatDelta(null, 1829.0)).toBe('–');
		expect(formatDelta(1830.0, null)).toBe('–');
	});
});

describe('priceDeltaComparison', () => {
	it('returns Below Market when execution price is above market', async () => {
		const { priceDeltaComparison } = await import('./ReceiptView');
		expect(priceDeltaComparison(1829.0, 1830.0)).toBe('Below Market');
	});

	it('returns Above Market when execution price is below market', async () => {
		const { priceDeltaComparison } = await import('./ReceiptView');
		expect(priceDeltaComparison(1830.0, 1829.0)).toBe('Above Market');
	});

	it('returns At Market when execution and market prices match', async () => {
		const { priceDeltaComparison } = await import('./ReceiptView');
		expect(priceDeltaComparison(1830.0, 1830.0)).toBe('At Market');
	});

	it('returns undefined for null inputs', async () => {
		const { priceDeltaComparison } = await import('./ReceiptView');
		expect(priceDeltaComparison(null, 1829.0)).toBeUndefined();
		expect(priceDeltaComparison(1830.0, null)).toBeUndefined();
	});
});

// A full USDC/WETH receipt, generalized ReceiptRow shape (Task 8+).
const fullUsdcWethRow = {
	txHash: '0x1234567890abcdef1234567890abcdef12345678',
	chainId: 8453, blockNumber: 123, aggregator: 'kyberswap', direction: 'buy_weth',
	inputToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
	outputToken: '0x4200000000000000000000000000000000000006',
	inputSymbol: 'USDC', outputSymbol: 'WETH',
	inputAmount: '1000.00', outputAmount: '0.33', notionalUsd: '1000.00',
	realizedPrice: '3000', marketMid: '3000', allInCostBps: '-1', pricingStatus: 'full',
	lpFeeBps: '1', aggFeeBps: '0', slippageBps: '-2', executionBps: '-1', gasCostUsd: '0.001',
	hopCount: 1, routeShape: 'single', decompConfidence: 'low', routeLegs: [], routePure: true,
	reconResidualBps: null, manipulationFlag: false,
};

describe('Receipt header', () => {
	it('renders the execution grade next to the pair title', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={fullUsdcWethRow as never} hash={fullUsdcWethRow.txHash} />,
		);
		expect(html).toContain('>A+<');
		expect(html).toContain('Total Execution Quality is ≥0bps');
	});

	it('renders a full USDC/WETH receipt with generalized token fields', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={fullUsdcWethRow as never} hash={fullUsdcWethRow.txHash} />,
		);
		// Pair title uses outputSymbol→inputSymbol convention.
		expect(html).toContain('WETH→USDC');
		// Token In / Token Out render the generalized symbols + amounts.
		expect(html).toContain('1000 USDC');
		expect(html).toContain('0.33 WETH');
		// Price expressed per output token (WETH), chain derived from chainId.
		expect(html).toContain('= 1 WETH');
		expect(html).toContain('Base');
		// Full receipts still show the priced sections.
		expect(html).not.toContain('unavailable for this pair');
	});
});

describe('Receipt Fabric partner-fee attribution', () => {
	// A Fabric-routed swap where an integrator/partner feeBps (80bps here) is
	// forwarded through the Fabric router. Fabric's own fee caps at 10bps, so the
	// receipt must NOT present this as a "Fabric Fee".
	const fabricPartnerRow = {
		...fullUsdcWethRow,
		aggregator: 'Fabric',
		aggFeeBps: '80',
		// Farcaster/Warplet's known fee-collection wallet — resolved to a display
		// name via the INTEGRATOR_FEE_RECIPIENTS registry in TradesTable.tsx.
		feeRecipient: '0x403560800cb7e03a06ebbc991dba0f6ac751a1c5',
	};

	it('does not render "Fabric Fee" for a large Fabric-routed integrator fee', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={fabricPartnerRow as never} hash={fabricPartnerRow.txHash} />,
		);
		expect(html).toContain('Integrator Fee (Farcaster)');
		expect(html).not.toContain('Fabric Fee');
		expect(html).toContain('not Fabric revenue');
	});

	it('labels an unrecognized Fabric-routed integrator fee neutrally, without inventing a name', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const unknownIntegratorRow = {
			...fullUsdcWethRow,
			aggregator: 'Fabric',
			aggFeeBps: '80',
			feeRecipient: '0x00000000000000000000000000000000000bad',
		};
		const html = renderToStaticMarkup(
			<ReceiptView trade={unknownIntegratorRow as never} hash={unknownIntegratorRow.txHash} />,
		);
		expect(html).toContain('Integrator Fee');
		expect(html).not.toContain('Farcaster');
		expect(html).not.toContain('Fabric Fee');
		expect(html).toContain('not Fabric revenue');
	});
});

describe('Receipt partial state', () => {
	const partialRow = {
		txHash: '0xabcabcabcabcabcabcabcabcabcabcabcabcabcd',
		chainId: 8453, blockNumber: 987, aggregator: 'odos', direction: 'USDC->???',
		inputToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
		outputToken: '0x000000000000000000000000000000000000dead',
		inputSymbol: 'AAA', outputSymbol: 'BBB',
		inputAmount: '1000', outputAmount: '5', notionalUsd: '1000',
		realizedPrice: null, marketMid: null, allInCostBps: null, pricingStatus: 'partial',
		lpFeeBps: '3', aggFeeBps: '2', slippageBps: null, executionBps: null, gasCostUsd: '0.01',
		hopCount: 1, routeShape: 'single', decompConfidence: 'low', routeLegs: [], routePure: true,
		reconResidualBps: null, manipulationFlag: null,
	};

	it('renders a partial exotic-pair receipt with impact/slippage unavailable and does not crash on nulls', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={partialRow as never} hash={partialRow.txHash} />,
		);
		// Pair title shows the exotic pair (outputSymbol→inputSymbol).
		expect(html).toMatch(/BBB→AAA|AAA→BBB/);
		// Token symbols/amounts still render.
		expect(html).toContain('1000 AAA');
		expect(html).toContain('5 BBB');
		// Unavailable treatment for price-derived sections.
		expect(html.toLowerCase()).toContain('unavailable for this pair');
		// Aggregator fee still shows normally (non-zero).
		expect(html).toContain('Aggregator Fee');
	});
});

describe('Receipt USD-per-base display for ETH/WETH-quoted pairs', () => {
	it('renders ETH-quoted estimated prices in USD-per-base, not ETH-per-base', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const { formatExecutionPrice } = await import('./TradesTable');
		const row = {
			...fullUsdcWethRow,
			aggregator: 'fabric', pricingStatus: 'estimated',
			inputSymbol: 'WARP', outputSymbol: 'ETH',
			inputToken: '0xd9159ad2d5fe625cd1f54f4d328fb19cb5262b07', outputToken: 'native',
			inputAmount: '202116011.45', outputAmount: '0.0778', notionalUsd: '134.96',
			realizedPrice: '0.000000000385', marketMid: '0.000000000394', allInCostBps: '221',
			chainlinkPrice: null, manipulationFlag: false,
		};
		const html = renderToStaticMarkup(<ReceiptView trade={row as never} hash={row.txHash} />);
		const execUsd = 134.96 / 202116011.45;
		expect(html).toContain(formatExecutionPrice(execUsd, 'WARP')); // USD-per-WARP, base = WARP
		expect(html).not.toContain('= 1 ETH');
		expect(html).not.toContain(formatExecutionPrice(0.000000000385, 'WARP')); // not the ETH figure
	});

	it('leaves stablecoin-quoted (USDC/WETH) price rows unchanged', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const { formatExecutionPrice } = await import('./TradesTable');
		const html = renderToStaticMarkup(<ReceiptView trade={fullUsdcWethRow as never} hash={fullUsdcWethRow.txHash} />);
		expect(html).toContain(formatExecutionPrice('3000', 'WETH'));
	});
});

describe('Receipt estimated pricing tier', () => {
	const estimatedRow = {
		...fullUsdcWethRow,
		aggregator: 'fabric',
		pricingStatus: 'estimated',
		// best-effort mid + realized price present, but no oracle fields
		realizedPrice: '0.00000068',
		marketMid: '0.00000069',
		allInCostBps: '14',
		chainlinkPrice: null,
		manipulationFlag: false,
	};

	it('renders Execution, Market, and Delta on an estimated receipt with a best-effort marker', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={estimatedRow as never} hash={estimatedRow.txHash} />,
		);
		// The three rows are present (not "Unavailable for this pair").
		expect(html).toContain('Realized Execution Price');
		expect(html).toContain('Market Price');
		expect(html).toContain('Price Delta');
		// Best-effort marker + honest tooltip, and NOT the oracle-validated copy.
		expect(html).toContain('est.');
		expect(html).toContain('not oracle-validated');
		expect(html).not.toContain('cross-referenced against an on-chain price oracle');
		expect((html.match(/Unavailable for this pair/g) ?? []).length).toBe(0);
	});

	it('shows Execution Price on a fully partial receipt but leaves Market/Delta unavailable', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const partialRow = {
			...fullUsdcWethRow,
			pricingStatus: 'partial',
			realizedPrice: '0.00000068',
			marketMid: null,
			allInCostBps: null,
		};
		const html = renderToStaticMarkup(
			<ReceiptView trade={partialRow as never} hash={partialRow.txHash} />,
		);
		// Execution Price now renders (previously "Unavailable for this pair").
		expect(html).toContain('Realized Execution Price');
		// Execution Price renders (realizedPrice present); only Market + Delta are unavailable.
		expect((html.match(/Unavailable for this pair/g) ?? []).length).toBe(2);
	});
});
