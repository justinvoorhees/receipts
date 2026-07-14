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

	it('renders a sub-cent delta at 6 significant figures', async () => {
		const { formatDelta } = await import('./ReceiptView');
		// Figma tooltip example: delta of $0.000000004856
		expect(formatDelta(0.000000004856, 0)).toBe('$0.000000004856');
	});

	it('renders an exact-zero delta as $0.00', async () => {
		const { formatDelta } = await import('./ReceiptView');
		expect(formatDelta(1829.0, 1829.0)).toBe('$0.00');
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

	it('never returns At Market for a sub-cent tokenOut', async () => {
		const { priceDeltaComparison } = await import('./ReceiptView');
		// Within the 0.01 band but sub-cent tokenOut → resolve by sign, not "At Market".
		expect(priceDeltaComparison(0.0000010, 0.0000011, true)).toBe('Below Market');
		expect(priceDeltaComparison(0.0000011, 0.0000010, true)).toBe('Above Market');
	});

	it('breaks an exact sub-cent tie toward Below Market', async () => {
		const { priceDeltaComparison } = await import('./ReceiptView');
		expect(priceDeltaComparison(0.0000010, 0.0000010, true)).toBe('Below Market');
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
	it('renders the hash header as a Basescan link, with no grade badge', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={fullUsdcWethRow as never} hash={fullUsdcWethRow.txHash} />,
		);
		expect(html).toContain(`href="https://basescan.org/tx/${fullUsdcWethRow.txHash}"`);
		expect(html).toContain('0x1234…5678'); // shortTxHash: 0x1234…5678
		expect(html).not.toContain('>A+<');
	});

	it('renders a full USDC/WETH receipt with generalized token fields', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={fullUsdcWethRow as never} hash={fullUsdcWethRow.txHash} />,
		);
		// Pair detail row reads as the swap direction (input→output), matching Token In/Out.
		expect(html).toContain('USDC→WETH');
		expect(html).not.toContain('WETH→USDC');
		// Token In / Token Out render the generalized symbols + amounts (USDC padded to 2 dp).
		expect(html).toContain('1000.00 USDC');
		expect(html).toContain('0.33 WETH');
		// Price expressed token-denominated, quote-per-base (USDC = 1 WETH, padded to 2 dp).
		expect(html).toContain('3000.00 USDC = 1 WETH');
		expect(html).toContain('Base');
		// Full receipts still show the priced sections.
		expect(html).not.toContain('unavailable for this pair');
	});

	it('keeps the top divider and renders no close/delete controls outside the dialog', async () => {
		const { Receipt } = await import('./ReceiptView');
		const html = renderToStaticMarkup(<Receipt row={fullUsdcWethRow as never} />);
		expect(html).toContain('h-px w-full shrink-0 bg-[var(--color-primary)]'); // top Divider present
		expect(html).not.toContain('Close transaction details');
		expect(html).not.toContain('>Delete<');
	});

	it('in dialog mode (onClose/onDelete passed), omits the top divider and renders the close button beside the header and a Delete button above Share', async () => {
		const { Receipt } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<Receipt row={fullUsdcWethRow as never} onClose={() => {}} onDelete={() => {}} />,
		);
		expect(html).not.toContain('h-px w-full shrink-0 bg-[var(--color-primary)]'); // no top Divider
		expect(html).toContain('aria-label="Close transaction details"');
		expect(html).toContain('>Delete<');
		expect(html).toContain('>Share<');
		expect(html.indexOf('>Delete<')).toBeLessThan(html.indexOf('>Share<'));
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
		expect(html).toContain('3000.00 USDC = 1 WETH');
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

describe('Price Delta tooltip', () => {
	const baseRow = {
		id: 7, chainId: 8453, pricingStatus: 'full',
		txHash: '0x1234567890abcdef1234567890abcdef12345678',
		blockNumber: 123, aggregator: 'kyberswap', direction: 'buy_weth',
		inputSymbol: 'USDC', outputSymbol: 'WETH', inputAmount: '1000.00', outputAmount: '0.33',
		notionalUsd: '1000.00', lpFeeBps: '1', aggFeeBps: '0', slippageBps: '-2',
		executionBps: '-1', gasCostUsd: '0.001', hopCount: 1, routeShape: 'single',
		decompConfidence: 'low', routeLegs: [], routePure: true, reconResidualBps: null,
	};

	it('renders the "better than Market" tooltip when below market', async () => {
		const { Receipt } = await import('./ReceiptView');
		// realized 3005 vs market 3000 → exec>mid → Below Market → "better"
		const html = renderToStaticMarkup(
			<Receipt row={{ ...baseRow, marketMid: '3000', realizedPrice: '3005' } as never} />,
		);
		expect(html).toContain('Execution Price is better than Market Price by $');
		// dotted-underline treatment on the subvalue label
		expect(html).toContain('decoration-dotted');
	});

	it('renders the "same as Market" tooltip when at market', async () => {
		const { Receipt } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<Receipt row={{ ...baseRow, marketMid: '3000', realizedPrice: '3000' } as never} />,
		);
		expect(html).toContain('Execution Price is the same as Market Price within $0.01');
	});

	it('renders the "worse than Market" tooltip when above market', async () => {
		const { Receipt } = await import('./ReceiptView');
		// realized 2995 vs market 3000 → exec<mid → Above Market → "worse"
		const html = renderToStaticMarkup(
			<Receipt row={{ ...baseRow, marketMid: '3000', realizedPrice: '2995' } as never} />,
		);
		expect(html).toContain('Execution Price is worse than Market Price by $');
	});
});

describe('per-side notionals (Phase 1: both-or-none)', () => {
	it('isAnchorable is true for stablecoins and ETH/WETH, false otherwise', async () => {
		const { isAnchorable } = await import('./ReceiptView');
		expect(isAnchorable('USDC')).toBe(true);
		expect(isAnchorable('DAI')).toBe(true);
		expect(isAnchorable('WETH')).toBe(true);
		expect(isAnchorable('ETH')).toBe(true);
		expect(isAnchorable('WBTC')).toBe(false);
		expect(isAnchorable('GITLAWB')).toBe(false);
	});

	it('values both sides at their mid USD price for a double-anchored pair', async () => {
		const { perSideNotionals } = await import('./ReceiptView');
		// USDC->WETH, mid 2000 USDC/WETH; received 0.51 WETH for 1000 USDC (beat mid).
		const n = perSideNotionals({
			inputSymbol: 'USDC', outputSymbol: 'WETH',
			inputAmount: '1000', outputAmount: '0.51', marketMid: '2000',
		} as never);
		expect(n.notionalIn).toBe(1000);   // 1000 USDC x $1
		expect(n.notionalOut).toBe(1020);  // 0.51 WETH x 2000
	});

	it('returns both-null for a single-anchored pair (no second anchor in Phase 1)', async () => {
		const { perSideNotionals } = await import('./ReceiptView');
		// ETH->WBTC: WBTC not anchorable -> both null (never split)
		const n = perSideNotionals({
			inputSymbol: 'ETH', outputSymbol: 'WBTC',
			inputAmount: '1', outputAmount: '0.028', marketMid: '35',
		} as never);
		expect(n.notionalIn).toBeNull();
		expect(n.notionalOut).toBeNull();
	});

	it('returns both-null for a no-anchor pair', async () => {
		const { perSideNotionals } = await import('./ReceiptView');
		const n = perSideNotionals({
			inputSymbol: 'LFI', outputSymbol: 'GITLAWB',
			inputAmount: '6745937.5', outputAmount: '7234145.96', marketMid: '1.1016',
		} as never);
		expect(n.notionalIn).toBeNull();
		expect(n.notionalOut).toBeNull();
	});

	it('returns both-null when an ether side has no mid to value it', async () => {
		const { perSideNotionals } = await import('./ReceiptView');
		const n = perSideNotionals({
			inputSymbol: 'USDC', outputSymbol: 'WETH',
			inputAmount: '1000', outputAmount: '0.5', marketMid: null,
		} as never);
		expect(n.notionalIn).toBeNull();
		expect(n.notionalOut).toBeNull();
	});
});

describe('formatExecutionResult', () => {
	it('formats a positive result as +$ in green', async () => {
		const { formatExecutionResult } = await import('./ReceiptView');
		expect(formatExecutionResult(20)).toEqual({ text: '+$20.00', color: '#117d45' });
	});
	it('formats a negative result as -$ with default color', async () => {
		const { formatExecutionResult } = await import('./ReceiptView');
		expect(formatExecutionResult(-10)).toEqual({ text: '-$10.00', color: undefined });
	});
	it('formats an exact-zero result as $0.00', async () => {
		const { formatExecutionResult } = await import('./ReceiptView');
		expect(formatExecutionResult(0)).toEqual({ text: '$0.00', color: undefined });
	});
});

describe('outputTokenDelta (no-anchor Price Delta)', () => {
	it('is the output-token difference vs marking at mid', async () => {
		const { outputTokenDelta } = await import('./ReceiptView');
		// 7,234,145.96 - 6,745,937.5 x 1.1016 = -197,178.79
		const d = outputTokenDelta({
			inputAmount: '6745937.5', outputAmount: '7234145.96',
			marketMid: '1.1016', realizedPrice: '1.0724',
		} as never);
		expect(d).toBeCloseTo(-197178.79, 1);
	});
	it('is null when there is no mid', async () => {
		const { outputTokenDelta } = await import('./ReceiptView');
		expect(outputTokenDelta({ inputAmount: '1', outputAmount: '2', marketMid: null, realizedPrice: null } as never)).toBeNull();
	});
});

describe('Receipt notional display (Phase 1)', () => {
	it('double-anchored: shows distinct per-side notionals and an Execution Result surplus', async () => {
		const { Receipt } = await import('./ReceiptView');
		// USDC->WETH, mid 2000; got 0.51 WETH for 1000 USDC -> out $1,020 vs in $1,000 = +$20.
		const row = {
			...fullUsdcWethRow, pricingStatus: 'full',
			inputAmount: '1000', outputAmount: '0.51',
			marketMid: '2000', realizedPrice: '1960.784313725',
		};
		const html = renderToStaticMarkup(<Receipt row={row as never} />);
		expect(html).toContain('Execution Result');
		expect(html).toContain('+$20.00');
		expect(html).toContain('$1,020.00'); // Token Out valued on its own at mid
		expect(html).toContain('$1,000.00'); // Token In
	});

	it('no-anchor: no Execution Result, Price Delta reads in output tokens', async () => {
		const { Receipt } = await import('./ReceiptView');
		const row = {
			...fullUsdcWethRow, aggregator: 'fabric', pricingStatus: 'estimated',
			inputSymbol: 'LFI', outputSymbol: 'GITLAWB',
			inputToken: '0x3722264ab15a1dfce5a5af89e6547f7949a8aba3',
			outputToken: '0x5f980dcfc4c0fa3911554cf5ab288ed0eb13dba3',
			inputAmount: '6745937.5', outputAmount: '7234145.96',
			marketMid: '1.1016', realizedPrice: '1.0724', allInCostBps: '265', chainlinkPrice: null,
		};
		const html = renderToStaticMarkup(<Receipt row={row as never} />);
		expect(html).not.toContain('Execution Result');
		// Price Delta value is the output-token difference, not a dollar figure.
		expect(html).toContain('197178.79 GITLAWB');
	});

	it('single-anchor: no per-side notionals and no Execution Result (Phase 1)', async () => {
		const { Receipt } = await import('./ReceiptView');
		// ETH->WBTC: only one anchorable side -> both notionals suppressed.
		const row = {
			...fullUsdcWethRow, aggregator: 'kyberswap', pricingStatus: 'estimated',
			inputSymbol: 'ETH', outputSymbol: 'WBTC',
			inputToken: 'native', outputToken: '0x0555e30da8f98308edb960aa94c0db47230d2b9c',
			inputAmount: '1', outputAmount: '0.02862539',
			marketMid: '35.0232', realizedPrice: '34.934', allInCostBps: '-25', chainlinkPrice: null,
		};
		const html = renderToStaticMarkup(<Receipt row={row as never} />);
		expect(html).not.toContain('Execution Result');
	});
});

describe('singleAnchorNotionals (Phase 2a)', () => {
	it('values the non-anchored side at mid for an ETH-quoted single-anchor pair', async () => {
		const { singleAnchorNotionals } = await import('./ReceiptView');
		// ETH->WBTC (real row): ETH anchored, WBTC marked at mid.
		const n = singleAnchorNotionals({
			inputSymbol: 'ETH', outputSymbol: 'WBTC',
			inputAmount: '1', outputAmount: '0.02862539', notionalUsd: '1791.1353895147784',
			marketMid: '35.02321455049866', realizedPrice: '34.93402185961484',
		} as never);
		expect(n?.notionalIn).toBeCloseTo(1791.14, 1);  // ETH = stored notional
		expect(n?.notionalOut).toBeCloseTo(1795.71, 1); // WBTC valued at mid
	});

	it('values the non-anchored side at mid for a stable-quoted single-anchor pair', async () => {
		const { singleAnchorNotionals } = await import('./ReceiptView');
		// CLAWD->USDC: USDC anchored (output face), CLAWD marked at mid.
		const n = singleAnchorNotionals({
			inputSymbol: 'CLAWD', outputSymbol: 'USDC',
			inputAmount: '1000', outputAmount: '50', notionalUsd: '50',
			marketMid: '0.052', realizedPrice: '0.05',
		} as never);
		expect(n?.notionalIn).toBeCloseTo(52, 6);   // 1000 CLAWD x 0.052
		expect(n?.notionalOut).toBeCloseTo(50, 6);  // USDC face
	});

	it('returns null for double-anchor and no-anchor pairs', async () => {
		const { singleAnchorNotionals } = await import('./ReceiptView');
		expect(singleAnchorNotionals({ inputSymbol: 'USDC', outputSymbol: 'WETH', inputAmount: '1', outputAmount: '1', notionalUsd: '1', marketMid: '2000', realizedPrice: '2000' } as never)).toBeNull();
		expect(singleAnchorNotionals({ inputSymbol: 'LFI', outputSymbol: 'GITLAWB', inputAmount: '1', outputAmount: '1', notionalUsd: '1', marketMid: '1', realizedPrice: '1' } as never)).toBeNull();
	});
});

describe('Receipt single-anchor validated display (Phase 2a)', () => {
	const ethWbtc = {
		...fullUsdcWethRow, aggregator: 'kyberswap',
		inputSymbol: 'ETH', outputSymbol: 'WBTC',
		inputToken: 'native', outputToken: '0x0555e30da8f98308edb960aa94c0db47230d2b9c',
		inputAmount: '1', outputAmount: '0.02862539', notionalUsd: '1791.1353895147784',
		marketMid: '35.02321455049866', realizedPrice: '34.93402185961484', chainlinkPrice: null,
	};

	it('full-tier single-anchor shows both notionals + Execution Result marked at the validated mid', async () => {
		const { Receipt } = await import('./ReceiptView');
		const html = renderToStaticMarkup(<Receipt row={{ ...ethWbtc, pricingStatus: 'full' } as never} />);
		expect(html).toContain('$1,795.71'); // Token Out (WBTC) valued at mid
		expect(html).toContain('Execution Result');
		expect(html).toContain('+$4.57');
		expect(html).toContain('validated benchmark mid'); // label distinguishes the marked path
	});

	it('estimated single-anchor stays dark (not validated)', async () => {
		const { Receipt } = await import('./ReceiptView');
		const html = renderToStaticMarkup(<Receipt row={{ ...ethWbtc, pricingStatus: 'estimated' } as never} />);
		expect(html).not.toContain('Execution Result');
		expect(html).not.toContain('$1,795.71');
	});
});
