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
		// Pair title reads as the swap direction (input→output), matching Token In/Out.
		expect(html).toContain('USDC→WETH');
		expect(html).not.toContain('WETH→USDC');
		// Token In / Token Out render the generalized symbols + amounts.
		expect(html).toContain('1000 USDC');
		expect(html).toContain('0.33 WETH');
		// Price expressed token-denominated, quote-per-base (USDC = 1 WETH).
		expect(html).toContain('3000 USDC = 1 WETH');
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
		// Pair title shows the exotic pair in swap direction (input→output).
		expect(html).toContain('AAA→BBB');
		// Token symbols/amounts still render.
		expect(html).toContain('1000 AAA');
		expect(html).toContain('5 BBB');
		// Unavailable treatment for price-derived sections.
		expect(html.toLowerCase()).toContain('unavailable for this pair');
		// Aggregator fee still shows normally (non-zero).
		expect(html).toContain('Aggregator Fee');
	});
});

describe('Receipt token-denominated price rows', () => {
	it('renders ETH-quoted prices token-denominated with the quote symbol', async () => {
		const { ReceiptView } = await import('./ReceiptView');
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
		// Main line is now token-denominated ETH-per-WARP, quote symbol on the left.
		expect(html).toContain('0.000000000385 ETH = 1 WARP');
		expect(html).toContain('0.000000000394 ETH = 1 WARP');
		// The USD figure (previously shown on the main line) no longer appears there —
		// it still lives in the sub-value, so assert its presence rather than absence.
		expect(html).not.toContain('0.000000000385 = 1 WARP');
		expect(html).toContain('$0.00'); // USD sub-value still rendered (rounds to $0.00 at this scale)
		// Header pair title reads as the swap direction (input→output), matching
		// Token In/Out. It must NOT invert to ETH→WARP.
		expect(html).toContain('WARP→ETH');
		expect(html).not.toContain('ETH→WARP');
	});

	it('renders stablecoin-quoted (USDC/WETH) price rows with the USDC quote symbol', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const html = renderToStaticMarkup(<ReceiptView trade={fullUsdcWethRow as never} hash={fullUsdcWethRow.txHash} />);
		expect(html).toContain('3000 USDC = 1 WETH');
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
		expect(html).toContain('Execution Price');
		expect(html).toContain('Market Price');
		expect(html).toContain('Price Delta');
		// No visible "est." marker, but the honest best-effort tooltip is present,
		// and NOT the oracle-validated copy.
		expect(html).not.toContain('est.');
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
		expect(html).toContain('Execution Price');
		// Execution Price renders (realizedPrice present); only Market + Delta are unavailable.
		expect((html.match(/Unavailable for this pair/g) ?? []).length).toBe(2);
	});
});

describe('Receipt route rendering (native/fallback)', () => {
	const base = { ...fullUsdcWethRow };
	it('renders costed pool legs plus an informational unwrap row', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const row = { ...base, routeLegs: [
			{ venue: '0x53932cbd9c700cf191b2b45e0b1cd50d69f66a1e', type: 'univ3', tokenIn: '0xd9159ad2d5fe625cd1f54f4d328fb19cb5262b07', tokenOut: '0x4200000000000000000000000000000000000006', feeTierBps: 30, notionalUsdc: 100, lpFeeBps: 30, priceImpactBps: 2 },
			{ venue: '0x4200000000000000000000000000000000000006', type: 'unwrap', tokenIn: '0x4200000000000000000000000000000000000006', tokenOut: 'native', feeTierBps: 0, notionalUsdc: 0, lpFeeBps: null, priceImpactBps: null },
		] };
		const html = renderToStaticMarkup(<ReceiptView trade={row as never} hash={row.txHash} />);
		expect(html).toContain('Uniswap v3');
		expect(html).toContain('Unwrap (WETH→ETH)');
		expect(html).not.toContain('No Route Found');
	});

	it('renders a Pools Touched section when no leg is costed', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const row = { ...base, pricingStatus: 'partial', routeLegs: [
			{ venue: '0x498581ff718922c3f8e6a244956af099b2652b2b', type: 'univ4', tokenIn: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', tokenOut: 'native', feeTierBps: 0, notionalUsdc: 0, lpFeeBps: null, priceImpactBps: null },
		] };
		const html = renderToStaticMarkup(<ReceiptView trade={row as never} hash={row.txHash} />);
		expect(html).toContain('Pools Touched');
		// This venue address is the real Uniswap V4 PoolManager on Base, which
		// KNOWN_VENUE_LABELS maps to the friendlier "Uniswap v4" label
		// (taking priority over the generic univ4 -> "Uniswap v4" fallback).
		expect(html).toContain('Uniswap v4');
		expect(html).not.toContain('Liquidity Provider Fee');
	});

	it('renders "No Route Found" when there are no legs', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const row = { ...base, pricingStatus: 'partial', routeLegs: [] };
		const html = renderToStaticMarkup(<ReceiptView trade={row as never} hash={row.txHash} />);
		expect(html).toContain('No Route Found');
		expect(html).not.toContain('>Route<');
	});
});

// Regression coverage for the leg "context" (token-pair) label in the Cost
// Breakdown: TOKEN_SYMBOLS (imported from TradesTable) is a static map that
// does not contain every token, so the leg-context resolver must prefer the
// receipt's own resolved input/output symbols before falling back to it.
describe('Receipt leg context — endpoint token resolution', () => {
	// The real WARP->ETH route (tx 0xa21e4d82b961726614ce6f310e30e29a4b55b8eca1d6a46621c3adaf8edf6ab1,
	// verified live against RPC): WARP/WETH (Uniswap v3) -> WETH/USDC (PancakeSwap v3)
	// -> USDC/WETH (Uniswap v4 PoolManager), with NO separate unwrap leg — the v4
	// pool pays native ETH directly to the taker.
	const warpEthRow = {
		...fullUsdcWethRow,
		aggregator: 'fabric',
		pricingStatus: 'estimated',
		inputSymbol: 'WARP', outputSymbol: 'ETH',
		inputToken: '0xd9159ad2d5fe625cd1f54f4d328fb19cb5262b07', outputToken: 'native',
		routeLegs: [
			{ venue: '0x53932cbd6cddbb907ce1bb108496c7bd8aaa5dce', type: 'univ3',
				tokenIn: '0xd9159ad2d5fe625cd1f54f4d328fb19cb5262b07',
				tokenOut: '0x4200000000000000000000000000000000000006',
				feeTierBps: 100, notionalUsdc: 136.09, lpFeeBps: 100.83, priceImpactBps: null },
			{ venue: '0x72ab388e2e2f6facef59e3c3fa2c4e29011c2d38', type: 'pancakev3',
				tokenIn: '0x4200000000000000000000000000000000000006',
				tokenOut: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
				feeTierBps: 1, notionalUsdc: 136.07, lpFeeBps: 1.01, priceImpactBps: null },
			{ venue: '0x498581ff718922c3f8e6a244956af099b2652b2b', type: 'univ4',
				tokenIn: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
				tokenOut: '0x4200000000000000000000000000000000000006',
				feeTierBps: 5, notionalUsdc: 136.07, lpFeeBps: 5.04, priceImpactBps: null },
		],
	};

	// The Cost Breakdown's "Liquidity Provider Fee" list (rendered by LegRow,
	// ReceiptView.tsx ~line 309) is the one under test here. The separate
	// "Price Impact" list further down the page is populated by TradesTable's
	// getPriceImpactRows — a different, out-of-scope code path — so assertions
	// are scoped to the LP Fee section to avoid coupling to that unrelated list.
	function lpFeeSection(html: string): string {
		return html.slice(html.indexOf('Liquidity Provider Fee'), html.indexOf('Aggregator Fee'));
	}

	it('resolves the leading leg\'s WARP token via the receipt\'s own inputSymbol, not a short address', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const html = renderToStaticMarkup(<ReceiptView trade={warpEthRow as never} hash={warpEthRow.txHash} />);
		const lpSection = lpFeeSection(html);
		// WARP is absent from TradesTable's static TOKEN_SYMBOLS map, so without
		// the fix this would render a shortened hex address (e.g. "0xd915…62b0").
		expect(lpSection).toContain('WARP/WETH');
		expect(lpSection).not.toContain('0xd915');
	});

	it('labels the terminal leg\'s native-ETH settlement as ETH, not the internal WETH stand-in', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const html = renderToStaticMarkup(<ReceiptView trade={warpEthRow as never} hash={warpEthRow.txHash} />);
		const lpSection = lpFeeSection(html);
		// The last leg (Uniswap v4 PoolManager) pays native ETH directly — there is no
		// separate unwrap row here — so its true settlement token is ETH, matching
		// the receipt's own outputSymbol, not the WETH address core uses internally
		// to model the native transfer through the ERC-20-only route graph.
		expect(lpSection).toContain('USDC/ETH');
		expect(lpSection).not.toContain('USDC/WETH');
		// The middle leg genuinely trades WETH (into the v4 pool) — unaffected.
		expect(lpSection).toContain('WETH/USDC');
	});

	it('surfaces the cost decomposition on the estimated tier instead of the "unavailable" placeholder', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		// Post-fix, an estimated-tier receipt carries the per-leg price impact (and
		// slippage) that decomposeRoute computed — core only nulls them on the
		// mid-less `partial` tier. The Cost Breakdown must therefore render the
		// Price Impact rows with real values, not the all-"Null"/unavailable state.
		const impacts = [39.4, 0.95, 0.76];
		const estimatedWithImpact = {
			...warpEthRow,
			routeLegs: warpEthRow.routeLegs.map((l, i) => ({ ...l, priceImpactBps: impacts[i] })),
		};
		const html = renderToStaticMarkup(<ReceiptView trade={estimatedWithImpact as never} hash={warpEthRow.txHash} />);
		// The section is surfaced, not gated to the "unavailable" placeholder.
		expect(html).not.toContain('Price Impact / Slippage unavailable for this pair');
		// Per-leg price impact renders real values, not the pre-fix all-"Null" state.
		expect(html).not.toContain('Null');
	});

	it('keeps a WETH-producing leg labeled WETH when a real unwrap step follows it', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		// Same shape as the "informational unwrap row" case above, but this time
		// asserting the swap leg's own context string, not just the unwrap label.
		// Here core did NOT model native ETH as a WETH stand-in — WETH really is
		// this leg's output, and the separate unwrap row below it is what produces
		// the final ETH — so relabeling it here would be less accurate, not more.
		const row = {
			...fullUsdcWethRow,
			inputSymbol: 'WARP', outputSymbol: 'ETH',
			inputToken: '0xd9159ad2d5fe625cd1f54f4d328fb19cb5262b07', outputToken: 'native',
			routeLegs: [
				{ venue: '0x53932cbd9c700cf191b2b45e0b1cd50d69f66a1e', type: 'univ3',
					tokenIn: '0xd9159ad2d5fe625cd1f54f4d328fb19cb5262b07',
					tokenOut: '0x4200000000000000000000000000000000000006',
					feeTierBps: 30, notionalUsdc: 100, lpFeeBps: 30, priceImpactBps: 2 },
				{ venue: '0x4200000000000000000000000000000000000006', type: 'unwrap',
					tokenIn: '0x4200000000000000000000000000000000000006', tokenOut: 'native',
					feeTierBps: 0, notionalUsdc: 0, lpFeeBps: null, priceImpactBps: null },
			],
		};
		const html = renderToStaticMarkup(<ReceiptView trade={row as never} hash={row.txHash} />);
		expect(html).toContain('WARP/WETH');
		expect(html).not.toContain('WARP/ETH');
	});
});

describe('ReceiptView diagnosis', () => {
	it('renders the DiagnosticCard when trade is null and a diagnosis is present', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={null} hash="0xabc" diagnosis={{ reason: 'NOT_DECODABLE' }} />,
		);
		expect(html).toContain('Not a decodable swap');
	});

	it('falls back to the field error when no diagnosis is supplied', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const html = renderToStaticMarkup(<ReceiptView trade={null} hash="0xabc" />);
		expect(html).toContain('Transaction not found.');
		expect(html).not.toContain('Not a decodable swap');
	});
});
