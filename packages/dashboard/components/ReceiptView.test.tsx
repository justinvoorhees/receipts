import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

globalThis.React = React;

vi.mock('next/navigation', () => ({
	useRouter: () => ({ push: () => {} }),
}));

describe('formatPriceDelta', () => {
	it('renders the delta in the quote token at 6 significant figures', async () => {
		const { formatPriceDelta } = await import('./ReceiptView');
		// Real ETH→WBTC row (receipts id 135), quote = ETH, base = WBTC.
		expect(formatPriceDelta(35.02321455049866, 34.93402185961484, 'ETH')).toBe('0.0891927 ETH');
	});

	it('renders the same magnitude when execution is above market', async () => {
		const { formatPriceDelta } = await import('./ReceiptView');
		expect(formatPriceDelta(34.93402185961484, 35.02321455049866, 'ETH')).toBe('0.0891927 ETH');
	});

	it('renders a stablecoin-quoted delta at 2 decimals', async () => {
		const { formatPriceDelta } = await import('./ReceiptView');
		expect(formatPriceDelta(3000, 2995, 'USDC')).toBe('5.00 USDC');
	});

	it('renders an exact tie as None', async () => {
		const { formatPriceDelta } = await import('./ReceiptView');
		expect(formatPriceDelta(3000, 3000, 'USDC')).toBe('None');
	});

	it('renders a sub-cent memecoin delta at 6 sig figs rather than collapsing', async () => {
		const { formatPriceDelta } = await import('./ReceiptView');
		// WARP→ETH: ETH-per-WARP. Float noise (8.99...e-12) must round away cleanly.
		expect(formatPriceDelta(0.000000000394, 0.000000000385, 'ETH')).toBe('0.000000000009 ETH');
	});

	it('returns – for null or non-finite inputs', async () => {
		const { formatPriceDelta } = await import('./ReceiptView');
		expect(formatPriceDelta(null, 1829.0, 'USDC')).toBe('–');
		expect(formatPriceDelta(1830.0, null, 'USDC')).toBe('–');
	});
});

describe('priceDeltaDirection', () => {
	// A fact about the price, not a verdict: it reports where the fill landed and
	// takes no view on who was buying, so there is no baseIsOutput to get wrong.

	it('reports a fill under the mid as below', async () => {
		const { priceDeltaDirection } = await import('./ReceiptView');
		expect(priceDeltaDirection(35.02321455049866, 34.93402185961484)).toBe('below');
	});

	it('reports a fill over the mid as above', async () => {
		const { priceDeltaDirection } = await import('./ReceiptView');
		expect(priceDeltaDirection(34.93402185961484, 35.02321455049866)).toBe('above');
	});

	it('is unaffected by trade direction — the same numbers read the same either way', async () => {
		const { priceDeltaDirection } = await import('./ReceiptView');
		expect(priceDeltaDirection(3000, 3005)).toBe('above');
		expect(priceDeltaDirection(3000, 2995)).toBe('below');
	});

	it('returns null for an exact tie', async () => {
		const { priceDeltaDirection } = await import('./ReceiptView');
		expect(priceDeltaDirection(3000, 3000)).toBeNull();
	});

	it('returns null for null or non-finite inputs', async () => {
		const { priceDeltaDirection } = await import('./ReceiptView');
		expect(priceDeltaDirection(null, 3000)).toBeNull();
		expect(priceDeltaDirection(3000, null)).toBeNull();
	});
});

describe('priceDeltaTooltip', () => {
	// The four quadrants. Verb and direction are independent facts; the reader
	// combines them. bought+below and sold+above are the good halves — asserted
	// against Total Execution Quality in the render tests below.
	it('names the base token and the verb implied by the trade direction', async () => {
		const { priceDeltaTooltip } = await import('./ReceiptView');
		expect(priceDeltaTooltip('WBTC', true, 'below')).toBe('WBTC bought below Market Price');
		expect(priceDeltaTooltip('WBTC', true, 'above')).toBe('WBTC bought above Market Price');
		expect(priceDeltaTooltip('WETH', false, 'above')).toBe('WETH sold above Market Price');
		expect(priceDeltaTooltip('WETH', false, 'below')).toBe('WETH sold below Market Price');
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

	it('links an attributed aggregator to its router contract page via routerAddress', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const router = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';
		const row = { ...fullUsdcWethRow, routerAddress: router };
		const html = renderToStaticMarkup(<ReceiptView trade={row as never} hash={row.txHash} />);
		expect(html).toContain(`href="https://basescan.org/address/${router}"`);
		expect(html).toContain('KyberSwap');
	});

	it('links an unattributed aggregator via its slug when routerAddress is absent (pre-column row)', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const unknownRouter = '0x77471234567890abcdef1234567890abcdef2359';
		const row = { ...fullUsdcWethRow, aggregator: unknownRouter };
		const html = renderToStaticMarkup(<ReceiptView trade={row as never} hash={row.txHash} />);
		// Full address shown (not truncated) and linked to its contract page.
		expect(html).toContain(`href="https://basescan.org/address/${unknownRouter}"`);
		expect(html).toContain(`>${unknownRouter}<`);
	});

	it('renders an attributed aggregator unlinked when no routerAddress exists (pre-column row)', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={fullUsdcWethRow as never} hash={fullUsdcWethRow.txHash} />,
		);
		expect(html).toContain('KyberSwap');
		expect(html).not.toContain('basescan.org/address/');
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
	// forwarded through the Fabric router. Fabric is only ever the router, so
	// the receipt must NOT present this as a "Fabric Fee" — it's a neutral,
	// no-tooltip "Integrator Fee" linking to the fee recipient's contract.
	const fabricPartnerRow = {
		...fullUsdcWethRow,
		aggregator: 'Fabric',
		aggFeeBps: '80',
		feeRecipient: '0x403560800cb7e03a06ebbc991dba0f6ac751a1c5',
	};

	it('links a large Fabric-routed integrator fee to its recipient contract, with no tooltip', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={fabricPartnerRow as never} hash={fabricPartnerRow.txHash} />,
		);
		expect(html).toContain('Integrator Fee');
		expect(html).not.toContain('Fabric Fee');
		expect(html).toContain('href="https://basescan.org/address/0x403560800cb7e03a06ebbc991dba0f6ac751a1c5"');
		expect(html).not.toContain('not Fabric revenue');
	});

	it('labels a Fabric-routed integrator fee neutrally and links out even without a known name', async () => {
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
		expect(html).not.toContain('Fabric Fee');
		expect(html).toContain('href="https://basescan.org/address/0x00000000000000000000000000000000000bad"');
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
		expect(html).not.toContain('0.000000000385 = 1 WARP');
		// The USD sub-value is gone — the price rows make no USD claim.
		// (Execution Price sub-value was $0.000000667735 = notionalUsd / inputAmount.)
		expect(html).not.toContain('$0.000000667735');
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

	it('shows Execution Price on a fully partial receipt but leaves Market/Delta null', async () => {
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
		// Execution Price renders (realizedPrice present); Market Price, Price Delta,
		// Price Impact, and Slippage are all null on a fully partial receipt, each
		// carrying the generic "no market price" tooltip.
		expect((html.match(/>Null</g) ?? []).length).toBe(4);
		expect((html.match(/No market price available/g) ?? []).length).toBeGreaterThanOrEqual(4);
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
		expect(html).toContain('Unwrap');
		expect(html).toContain('WETH→ETH');
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

	it('labels an rfq leg "Market Maker", linked to its contract, with a null LP Fee and off-chain-quote tooltip', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const venue = '0x69a9f156d5902191dce331ab348f3e9e96e48b22';
		// A costed leg alongside the rfq leg puts this route in the "Liquidity
		// Provider Fee" branch (hasCostedLeg), not the uncosted "Pools Touched"
		// branch, so the maker leg's LP Fee value/tooltip actually render.
		const row = { ...base, pricingStatus: 'partial', routeLegs: [
			{ venue: '0x53932cbd9c700cf191b2b45e0b1cd50d69f66a1e', type: 'univ3',
				tokenIn: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
				tokenOut: '0x4200000000000000000000000000000000000006',
				feeTierBps: 30, notionalUsdc: 100, lpFeeBps: 30, priceImpactBps: 2 },
			{ venue, type: 'rfq', tokenIn: '0x4200000000000000000000000000000000000006', tokenOut: 'native', feeTierBps: 0, notionalUsdc: 0, lpFeeBps: 0, priceImpactBps: null },
		] };
		const html = renderToStaticMarkup(<ReceiptView trade={row as never} hash={row.txHash} />);
		expect(html).toContain('Market Maker');
		expect(html).toContain(`href="https://basescan.org/address/${venue}"`);
		expect(html).toContain('color:var(--color-primary)');
		expect(html).toContain('Market maker inventory, no L.P. fee or market price available');
		expect(html).toContain('>Null<');
	});

	// The Price Impact section (populated by TradesTable's getPriceImpactRows,
	// consumed here at ~line 610) is a SEPARATE null-tooltip code path from the
	// LP Fee section's RFQ_LEG_TOOLTIP above. An rfq leg's price impact is null
	// BY DESIGN — off-chain quote, no on-chain mid — not because a mid was
	// "discovered ... implausible or stale" (the legacy, now-false, copy).
	it('gives an rfq leg\'s null Price Impact the market-maker tooltip, not the legacy "implausible or stale" copy', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const row = { ...base, pricingStatus: 'full', routeLegs: [
			{ venue: '0x53932cbd9c700cf191b2b45e0b1cd50d69f66a1e', type: 'univ3',
				tokenIn: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
				tokenOut: '0x4200000000000000000000000000000000000006',
				feeTierBps: 30, notionalUsdc: 100, lpFeeBps: 30, priceImpactBps: 2 },
			{ venue: '0x69a9f156d5902191dce331ab348f3e9e96e48b22', type: 'rfq',
				tokenIn: '0x4200000000000000000000000000000000000006',
				tokenOut: 'native',
				feeTierBps: 0, notionalUsdc: 0, lpFeeBps: null, priceImpactBps: null },
		] };
		const html = renderToStaticMarkup(<ReceiptView trade={row as never} hash={row.txHash} />);
		const priceImpactSection = html.slice(html.indexOf('Price Impact'), html.indexOf('Slippage'));
		expect(priceImpactSection).toContain('Market maker inventory, no L.P. fee or market price available');
		expect(priceImpactSection).not.toContain('implausible or stale');
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
	it('renders the failure notice when trade is null and a diagnosis is present', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={null} hash="0xabc" diagnosis={{ reason: 'NOT_DECODABLE' }} />,
		);
		expect(html).toContain('Not a swap');
		expect(html).toContain('Token-in / token-out swap not found (signature, approval, LP action, etc)');
	});

	it('renders no failure notice when no diagnosis is supplied', async () => {
		const { ReceiptView } = await import('./ReceiptView');
		const html = renderToStaticMarkup(<ReceiptView trade={null} hash="0xabc" />);
		expect(html).not.toContain('Not a swap');
	});
});

describe('Price Delta row', () => {
	// ETH→WBTC: base = WBTC (output, anchor rank 0 < ETH's 1) → the user BOUGHT the base.
	const ethWbtc = {
		...fullUsdcWethRow, aggregator: 'kyberswap', pricingStatus: 'estimated',
		inputSymbol: 'ETH', outputSymbol: 'WBTC',
		inputToken: 'native', outputToken: '0x0555e30da8f98308edb960aa94c0db47230d2b9c',
		inputAmount: '1', outputAmount: '0.02862539', notionalUsd: '1791.1353895147784',
		marketMid: '35.02321455049866', realizedPrice: '34.93402185961484',
		allInCostBps: '-25.53', chainlinkPrice: null,
	};

	it('renders the quote-denominated delta with a "bought below" tooltip, agreeing with Execution Quality', async () => {
		const { Receipt } = await import('./ReceiptView');
		const html = renderToStaticMarkup(<Receipt row={ethWbtc as never} />);
		expect(html).toContain('0.0891927 ETH');
		expect(html).toContain('WBTC bought below Market Price');
		// bought below = a good fill, so it must agree with Total Execution Quality,
		// which reads +25.53bps. This is the pairing the old inverted labels broke.
		expect(html).toContain('+25.53bps');
		// The tooltip states a fact, never a verdict — that stays with Execution Quality.
		expect(html).not.toContain('better');
		expect(html).not.toContain('worse');
		// The old verdict-labels are gone for good.
		expect(html).not.toContain('Above Market');
		expect(html).not.toContain('Below Market');
		expect(html).not.toContain('At Market');
	});

	it('flips to "bought above" when the fill is over the mid, agreeing with a negative Execution Quality', async () => {
		const { Receipt } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<Receipt row={{ ...ethWbtc, realizedPrice: '35.11', allInCostBps: '25' } as never} />,
		);
		expect(html).toContain('WBTC bought above Market Price');
	});

	it('reads "sold above" for a sell (WETH→USDC), where the base is the input', async () => {
		const { Receipt } = await import('./ReceiptView');
		// base = WETH (input, rank 1 < USDC's 2) → the user SOLD the base.
		// Received 3005 USDC/WETH vs a 3000 mid → better.
		const html = renderToStaticMarkup(
			<Receipt row={{
				...fullUsdcWethRow,
				inputSymbol: 'WETH', outputSymbol: 'USDC',
				inputToken: '0x4200000000000000000000000000000000000006',
				outputToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
				inputAmount: '1', outputAmount: '3005',
				marketMid: '3000', realizedPrice: '3005',
			} as never} />,
		);
		expect(html).toContain('5.00 USDC');
		expect(html).toContain('WETH sold above Market Price');
	});

	it('reads "sold below" for a sell that received less than the mid', async () => {
		const { Receipt } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<Receipt row={{
				...fullUsdcWethRow,
				inputSymbol: 'WETH', outputSymbol: 'USDC',
				inputToken: '0x4200000000000000000000000000000000000006',
				outputToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
				inputAmount: '1', outputAmount: '2995',
				marketMid: '3000', realizedPrice: '2995',
			} as never} />,
		);
		expect(html).toContain('WETH sold below Market Price');
	});

	it('renders None with no tooltip when execution exactly matches the mid', async () => {
		const { Receipt } = await import('./ReceiptView');
		// fullUsdcWethRow has marketMid === realizedPrice === '3000'.
		const html = renderToStaticMarkup(<Receipt row={fullUsdcWethRow as never} />);
		expect(html).toContain('None');
		expect(html).not.toContain('than Market Price');
	});

	it('renders a no-anchor memecoin pair through the same path, denominated in the quote token', async () => {
		const { Receipt } = await import('./ReceiptView');
		// LFI→GITLAWB (real row): neither leg anchors → tie in anchor rank →
		// base = input (LFI), quote = output (GITLAWB), marketMid is output-per-input.
		// Previously this rendered a total token quantity ("197178.79 GITLAWB") via
		// outputTokenDelta; it is now a per-base price delta like every other pair.
		const html = renderToStaticMarkup(
			<Receipt row={{
				...fullUsdcWethRow, aggregator: 'fabric', pricingStatus: 'estimated',
				inputSymbol: 'LFI', outputSymbol: 'GITLAWB',
				inputToken: '0x3722264ab15a1dfce5a5af89e6547f7949a8aba3',
				outputToken: '0x5f980dcfc4c0fa3911554cf5ab288ed0eb13dba3',
				inputAmount: '6745937.5', outputAmount: '7234145.96',
				marketMid: '1.1016', realizedPrice: '1.0724',
				allInCostBps: '265', chainlinkPrice: null,
			} as never} />,
		);
		expect(html).toContain('0.0292 GITLAWB');
		expect(html).not.toContain('197178.79 GITLAWB'); // the old quantity-based delta
		// base = LFI is the input → sold. 1.0724 < 1.1016 mid → received fewer, so
		// "sold below" — the bad half of a sell, agreeing with allInCostBps 265 (a cost).
		expect(html).toContain('LFI sold below Market Price');
	});

	it('reads "bought above" for a USDC→WETH buy over the mid (this assertion was once inverted)', async () => {
		const { Receipt } = await import('./ReceiptView');
		// base = WETH (output, rank 1 < USDC's 2) → the user BOUGHT the base.
		// Paid 3005 USDC/WETH against a 3000 mid → a $5/ETH overpay → bought above.
		// ReceiptView.test.tsx:470 once asserted this was "better".
		const html = renderToStaticMarkup(
			<Receipt row={{ ...fullUsdcWethRow, marketMid: '3000', realizedPrice: '3005' } as never} />,
		);
		expect(html).toContain('5.00 USDC');
		expect(html).toContain('WETH bought above Market Price');
	});
});

describe('Size row', () => {
	it('renders the trade notional above Token In', async () => {
		const { Receipt } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<Receipt row={{
				...fullUsdcWethRow, aggregator: 'kyberswap', pricingStatus: 'estimated',
				inputSymbol: 'ETH', outputSymbol: 'WBTC',
				inputToken: 'native', outputToken: '0x0555e30da8f98308edb960aa94c0db47230d2b9c',
				inputAmount: '1', outputAmount: '0.02862539', notionalUsd: '1791.1353895147784',
				marketMid: '35.02321455049866', realizedPrice: '34.93402185961484',
				chainlinkPrice: null,
			} as never} />,
		);
		expect(html).toContain('Size');
		expect(html).toContain('$1,791.14');
		// Size precedes Token In in the document.
		expect(html.indexOf('Size')).toBeLessThan(html.indexOf('Token In'));
	});

	it('renders Size on a partial receipt, where no mid exists', async () => {
		const { Receipt } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<Receipt row={{
				...fullUsdcWethRow, pricingStatus: 'partial',
				marketMid: null, allInCostBps: null, notionalUsd: '1000.00',
			} as never} />,
		);
		expect(html).toContain('Size');
		expect(html).toContain('$1,000.00');
	});

	it('renders Size for a no-anchor memecoin pair', async () => {
		const { Receipt } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<Receipt row={{
				...fullUsdcWethRow, pricingStatus: 'estimated',
				inputSymbol: 'LFI', outputSymbol: 'GITLAWB',
				inputToken: '0x1111111111111111111111111111111111111111',
				outputToken: '0x2222222222222222222222222222222222222222',
				inputAmount: '1000', outputAmount: '2400', notionalUsd: '134.96',
				marketMid: '2.5', realizedPrice: '2.4', chainlinkPrice: null,
			} as never} />,
		);
		expect(html).toContain('$134.96');
	});

	it('falls back to the unavailable placeholder when there is no notional', async () => {
		const { Receipt } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<Receipt row={{ ...fullUsdcWethRow, notionalUsd: null } as never} />,
		);
		expect(html).toContain('Size');
		expect(html).toContain('Unavailable for this pair');
	});
});

describe('Receipt makes no fair-value claim (MVP thesis)', () => {
	// The ETH→WBTC row that used to render "Execution Result +$4.57" by marking
	// WBTC at the mid, and "-$0.47" via the BTC/USD oracle. Both are answers to
	// "was this a good trade" and no longer belong on the receipt.
	const ethWbtc = {
		...fullUsdcWethRow, aggregator: 'kyberswap',
		inputSymbol: 'ETH', outputSymbol: 'WBTC',
		inputToken: 'native', outputToken: '0x0555e30da8f98308edb960aa94c0db47230d2b9c',
		inputAmount: '1', outputAmount: '0.02862539', notionalUsd: '1791.1353895147784',
		marketMid: '35.02321455049866', realizedPrice: '34.93402185961484',
		allInCostBps: '-25.53', chainlinkPrice: null,
	};

	it('renders no Execution Result on a full-tier single-anchor pair', async () => {
		const { Receipt } = await import('./ReceiptView');
		const html = renderToStaticMarkup(<Receipt row={{ ...ethWbtc, pricingStatus: 'full' } as never} />);
		expect(html).not.toContain('Execution Result');
		expect(html).not.toContain('$1,795.71'); // WBTC marked at the mid
		expect(html).not.toContain('+$4.57');
	});

	it('renders no Execution Result even with an independent oracle anchor present', async () => {
		const { Receipt } = await import('./ReceiptView');
		const html = renderToStaticMarkup(
			<Receipt row={{ ...ethWbtc, pricingStatus: 'estimated', anchorPriceUsd: '62000' } as never} />,
		);
		expect(html).not.toContain('Execution Result');
		expect(html).not.toContain('independent Chainlink oracle');
		expect(html).not.toContain('validated benchmark mid');
	});

	it('renders no per-side USD notionals on the token or price rows', async () => {
		const { Receipt } = await import('./ReceiptView');
		const html = renderToStaticMarkup(<Receipt row={{ ...ethWbtc, pricingStatus: 'full' } as never} />);
		// Token In / Token Out / Execution Price / Market Price carry no USD sub-value.
		// Size ($1,791.14) is the only USD figure above Gas Cost.
		expect(html).not.toContain('$62,731.32'); // Market Price in USD
		expect(html).not.toContain('$62,571.56'); // Execution Price in USD
		expect(html).toContain('$1,791.14');      // Size survives
		expect(html).toContain('34.934 ETH = 1 WBTC');
		expect(html).toContain('35.0232 ETH = 1 WBTC');
	});
});
