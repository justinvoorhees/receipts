import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

globalThis.React = React;

vi.mock('next/navigation', () => ({
	useRouter: () => ({ push: () => {} }),
}));

describe('formatPriceDelta', () => {
	it('renders the delta in the quote token at 3 significant figures after the decimal', async () => {
		const { formatPriceDelta } = await import('./receipt/priceFormat');
		// Real ETH→WBTC row (receipts id 135), quote = ETH, base = WBTC.
		expect(formatPriceDelta(35.02321455049866, 34.93402185961484, 'ETH')).toBe('0.0892 ETH');
	});

	it('renders the same magnitude when execution is above market', async () => {
		const { formatPriceDelta } = await import('./receipt/priceFormat');
		expect(formatPriceDelta(34.93402185961484, 35.02321455049866, 'ETH')).toBe('0.0892 ETH');
	});

	it('renders a stablecoin-quoted delta at 2 decimals', async () => {
		const { formatPriceDelta } = await import('./receipt/priceFormat');
		expect(formatPriceDelta(3000, 2995, 'USDC')).toBe('5.00 USDC');
	});

	it('renders an exact tie as None', async () => {
		const { formatPriceDelta } = await import('./receipt/priceFormat');
		expect(formatPriceDelta(3000, 3000, 'USDC')).toBe('None');
	});

	it('renders a sub-cent memecoin delta at 3 sig figs rather than collapsing', async () => {
		const { formatPriceDelta } = await import('./receipt/priceFormat');
		// WARP→ETH: ETH-per-WARP. Float noise (8.99...e-12) must round away cleanly.
		expect(formatPriceDelta(0.000000000394, 0.000000000385, 'ETH')).toBe('0.000000000009 ETH');
	});

	it('returns – for null or non-finite inputs', async () => {
		const { formatPriceDelta } = await import('./receipt/priceFormat');
		expect(formatPriceDelta(null, 1829.0, 'USDC')).toBe('–');
		expect(formatPriceDelta(1830.0, null, 'USDC')).toBe('–');
	});
});

describe('priceDeltaDirection', () => {
	// A fact about the price, not a verdict: it reports where the fill landed and
	// takes no view on who was buying, so there is no baseIsOutput to get wrong.

	it('reports a fill under the mid as below', async () => {
		const { priceDeltaDirection } = await import('./receipt/priceFormat');
		expect(priceDeltaDirection(35.02321455049866, 34.93402185961484)).toBe('below');
	});

	it('reports a fill over the mid as above', async () => {
		const { priceDeltaDirection } = await import('./receipt/priceFormat');
		expect(priceDeltaDirection(34.93402185961484, 35.02321455049866)).toBe('above');
	});

	it('is unaffected by trade direction — the same numbers read the same either way', async () => {
		const { priceDeltaDirection } = await import('./receipt/priceFormat');
		expect(priceDeltaDirection(3000, 3005)).toBe('above');
		expect(priceDeltaDirection(3000, 2995)).toBe('below');
	});

	it('returns null for an exact tie', async () => {
		const { priceDeltaDirection } = await import('./receipt/priceFormat');
		expect(priceDeltaDirection(3000, 3000)).toBeNull();
	});

	it('returns null for null or non-finite inputs', async () => {
		const { priceDeltaDirection } = await import('./receipt/priceFormat');
		expect(priceDeltaDirection(null, 3000)).toBeNull();
		expect(priceDeltaDirection(3000, null)).toBeNull();
	});
});

describe('formatPriceDeltaToken', () => {
	// The four quadrants, now carried by the VALUE text rather than a tooltip:
	// verb and direction are independent facts and the reader combines them.
	// bought+below and sold+above are the good halves — asserted against Total
	// Execution Quality in the render tests below.
	it('names the base token, the verb, and the direction in one sentence', async () => {
		const { formatPriceDeltaToken } = await import('./receipt/priceFormat');
		// ETH→WBTC (base WBTC, quote ETH), realized under the mid → bought below.
		expect(formatPriceDeltaToken(35.02321455049866, 34.93402185961484, 'WBTC', 'ETH', true)).toEqual({
			text: 'WBTC bought at 0.0892 ETH below Market Price',
			sub: 'per 1 WBTC',
		});
		// WETH→USDC (base WETH, quote USDC), realized over the mid → sold above.
		expect(formatPriceDeltaToken(3000, 3005, 'WETH', 'USDC', false)).toEqual({
			text: 'WETH sold at 5.00 USDC above Market Price',
			sub: 'per 1 WETH',
		});
	});

	it('renders an exact tie as None with no subvalue', async () => {
		const { formatPriceDeltaToken } = await import('./receipt/priceFormat');
		expect(formatPriceDeltaToken(3000, 3000, 'WETH', 'USDC', false)).toEqual({ text: 'None', sub: null });
	});

	it('renders unusable inputs as the bare placeholder', async () => {
		const { formatPriceDeltaToken } = await import('./receipt/priceFormat');
		expect(formatPriceDeltaToken(null, 3000, 'WETH', 'USDC', false)).toEqual({ text: '–', sub: null });
	});
});

describe('formatPriceDeltaUsd', () => {
	it('leads with the base symbol and splits "per 1 base" into the subvalue', async () => {
		const { formatPriceDeltaUsd } = await import('./receipt/priceFormat');
		// Bought the base with a gain → the fill landed BELOW the mid.
		expect(formatPriceDeltaUsd(159.76, 'WBTC', true, 4.57)).toEqual({
			text: 'WBTC bought at $159.76 below Market Price',
			sub: 'per 1 WBTC',
		});
		// Sold the base with a gain → the fill landed ABOVE the mid.
		expect(formatPriceDeltaUsd(5, 'WETH', false, 5)).toEqual({
			text: 'WETH sold at $5.00 above Market Price',
			sub: 'per 1 WETH',
		});
	});

	it('renders a zero result as None with no subvalue', async () => {
		const { formatPriceDeltaUsd } = await import('./receipt/priceFormat');
		expect(formatPriceDeltaUsd(0, 'WBTC', true, 0)).toEqual({ text: 'None', sub: null });
	});
});

describe('fallbackMethodology', () => {
	// Every persisted receipt predates the tier/methodology columns being populated
	// (all 39 rows carry NULL), so the descriptor must derive from pricingStatus.
	it('maps each pricing tier to its descriptor', async () => {
		const { fallbackMethodology } = await import('./receipt/priceFormat');
		expect(fallbackMethodology('full')).toContain('Verified:');
		expect(fallbackMethodology('estimated')).toContain('Estimated:');
		expect(fallbackMethodology('partial')).toBe('Unavailable: No reliable market price could be calculated.');
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
		const { ReceiptView } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={fullUsdcWethRow as never} hash={fullUsdcWethRow.txHash} />,
		);
		expect(html).toContain(`href="https://basescan.org/tx/${fullUsdcWethRow.txHash}"`);
		expect(html).toContain('0x1234…5678'); // shortTxHash: 0x1234…5678
		expect(html).not.toContain('>A+<');
	});

	it('links an attributed aggregator to its router contract page via routerAddress', async () => {
		const { ReceiptView } = await import('./receiptView');
		const router = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';
		const row = { ...fullUsdcWethRow, routerAddress: router };
		const html = renderToStaticMarkup(<ReceiptView trade={row as never} hash={row.txHash} />);
		expect(html).toContain(`href="https://basescan.org/address/${router}"`);
		expect(html).toContain('KyberSwap');
	});

	it('links an unattributed aggregator via its slug when routerAddress is absent (pre-column row)', async () => {
		const { ReceiptView } = await import('./receiptView');
		const unknownRouter = '0x77471234567890abcdef1234567890abcdef2359';
		const row = { ...fullUsdcWethRow, aggregator: unknownRouter };
		const html = renderToStaticMarkup(<ReceiptView trade={row as never} hash={row.txHash} />);
		// Full address shown (not truncated) and linked to its contract page.
		expect(html).toContain(`href="https://basescan.org/address/${unknownRouter}"`);
		expect(html).toContain(`>${unknownRouter}<`);
	});

	it('renders an attributed aggregator unlinked when no routerAddress exists (pre-column row)', async () => {
		const { ReceiptView } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={fullUsdcWethRow as never} hash={fullUsdcWethRow.txHash} />,
		);
		expect(html).toContain('KyberSwap');
		expect(html).not.toContain('basescan.org/address/');
	});

	it('renders a full USDC/WETH receipt with generalized token fields', async () => {
		const { ReceiptView } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={fullUsdcWethRow as never} hash={fullUsdcWethRow.txHash} />,
		);
		// Pair detail row reads as the swap direction (input→output), matching Token In/Out.
		expect(html).toContain('USDC → WETH');
		expect(html).not.toContain('WETH → USDC');
		// Token In / Token Out render the generalized symbols + amounts (USDC padded to 2 dp).
		expect(html).toContain('1000.00 USDC');
		expect(html).toContain('0.33 WETH');
		// Price expressed token-denominated, quote-per-base (USDC = 1 WETH, padded to 2 dp).
		expect(html).toContain('3000.00 USDC = 1 WETH');
		expect(html).toContain('Base');
		// Full receipts still show the priced sections.
		expect(html).not.toContain('unavailable for this pair');
	});

	it('renders no close/delete controls outside the dialog', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={fullUsdcWethRow as never} />);
		// The rule under the input belongs to ReceiptView now, not Receipt — see
		// the 'ReceiptSearch chrome' block for its coverage.
		expect(html).not.toContain('Close transaction details');
		expect(html).not.toContain('>Delete<');
	});

	it('in dialog mode (onClose/onDelete passed), renders the close button beside the header and a Delete button above Share', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<Receipt row={fullUsdcWethRow as never} onClose={() => {}} onDelete={() => {}} />,
		);
		// The dialog has no rule ABOVE its header — but it does carry the Cost
		// Breakdown rule further down, so assert ORDER, not absence. A bare
		// not.toContain here passes vacuously until a body divider exists, then
		// fails for the wrong reason.
		expect(html.indexOf('aria-label="Close transaction details"'))
			.toBeLessThan(html.indexOf('h-px w-full shrink-0 bg-[var(--color-primary)]'));
		expect(html).toContain('>Delete<');
		expect(html).toContain('>Share<');
		expect(html.indexOf('>Delete<')).toBeLessThan(html.indexOf('>Share<'));
	});
});

describe('UniswapX Filler row', () => {
	const fillerRow = {
		...fullUsdcWethRow,
		fillerAddress: '0xfiller1234567890abcdef1234567890abcdef12',
		normalizeFlags: ['BENEFICIARY_ANCHORED: y', 'ANCHOR_VIA_UNISWAPX: z'],
	};

	it('replaces the Aggregator row with Filler / via UniswapX + a Basescan link to the filler', async () => {
		const { ReceiptView } = await import('./receiptView');
		const html = renderToStaticMarkup(<ReceiptView trade={fillerRow as never} hash={fillerRow.txHash} />);
		expect(html).toContain('Filler');
		expect(html).toContain('via UniswapX');
		expect(html).toContain(`href="https://basescan.org/address/${fillerRow.fillerAddress}"`);
		expect(html).not.toContain('>Aggregator<');
		// The row itself now conveys "via UniswapX" — the separate note is redundant.
		expect(html).not.toContain('Executed on your behalf via UniswapX');
	});

	it('falls back to the ordinary Aggregator row + note when fillerAddress is null (legacy row)', async () => {
		const { ReceiptView } = await import('./receiptView');
		const legacyRow = { ...fillerRow, fillerAddress: null };
		const html = renderToStaticMarkup(<ReceiptView trade={legacyRow as never} hash={legacyRow.txHash} />);
		expect(html).toContain('>Aggregator<');
		expect(html).toContain('Executed on your behalf via UniswapX');
		expect(html).not.toContain('>Filler<');
	});

	it('leaves a non-UniswapX beneficiary-anchored (net-flow) row unaffected', async () => {
		const { ReceiptView } = await import('./receiptView');
		const netFlowRow = {
			...fullUsdcWethRow,
			fillerAddress: '0xfiller1234567890abcdef1234567890abcdef12',
			normalizeFlags: ['BENEFICIARY_ANCHORED: y'],
		};
		const html = renderToStaticMarkup(<ReceiptView trade={netFlowRow as never} hash={netFlowRow.txHash} />);
		expect(html).toContain('>Aggregator<');
		expect(html).toContain('Executed on your behalf by a solver');
		expect(html).not.toContain('>Filler<');
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
		const { ReceiptView } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={fabricPartnerRow as never} hash={fabricPartnerRow.txHash} />,
		);
		expect(html).toContain('Integrator Fee');
		expect(html).not.toContain('Fabric Fee');
		expect(html).toContain('href="https://basescan.org/address/0x403560800cb7e03a06ebbc991dba0f6ac751a1c5"');
		expect(html).not.toContain('not Fabric revenue');
	});

	it('labels a Fabric-routed integrator fee neutrally and links out even without a known name', async () => {
		const { ReceiptView } = await import('./receiptView');
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
		const { ReceiptView } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={partialRow as never} hash={partialRow.txHash} />,
		);
		// Pair title shows the exotic pair in swap direction (input→output).
		expect(html).toContain('AAA → BBB');
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
		const { ReceiptView } = await import('./receiptView');
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
		// WARP→ETH is ANCHORED (ETH anchors), so the price rows now carry USD sublines
		// and an Execution Delta — the MVP-thesis "no USD claim" no longer applies here.
		expect(html).toContain('>Execution Delta<');
		// Header pair title reads as the swap direction (input→output), matching
		// Token In/Out. It must NOT invert to ETH→WARP.
		expect(html).toContain('WARP → ETH');
		expect(html).not.toContain('ETH → WARP');
	});

	it('renders stablecoin-quoted (USDC/WETH) price rows with the USDC quote symbol', async () => {
		const { ReceiptView } = await import('./receiptView');
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
		const { ReceiptView } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={estimatedRow as never} hash={estimatedRow.txHash} />,
		);
		// The three rows are present (not "Unavailable for this pair").
		expect(html).toContain('Execution Price');
		expect(html).toContain('Market Price');
		expect(html).toContain('Price Delta');
		// No visible "est." marker. The methodology descriptor is now rendered as a
		// sub-label on Market Price rather than hidden in a tooltip, and it reports
		// the estimated tier.
		expect(html).not.toContain('est.');
		expect(html).toContain('Estimated');
		expect(html).not.toContain('cross-referenced against an on-chain price oracle');
		expect(html).not.toContain('not oracle-validated');
		expect((html.match(/Unavailable for this pair/g) ?? []).length).toBe(0);
	});

	it('shows Execution Price on a fully partial receipt but leaves Market/Delta null', async () => {
		const { ReceiptView } = await import('./receiptView');
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
		expect((html.match(/>n\/a</g) ?? []).length).toBe(4);
		expect((html.match(/No market price available/g) ?? []).length).toBeGreaterThanOrEqual(4);
	});
});

describe('Receipt route rendering (native/fallback)', () => {
	const base = { ...fullUsdcWethRow };
	it('renders costed pool legs plus an informational unwrap row', async () => {
		const { ReceiptView } = await import('./receiptView');
		const row = { ...base, routeLegs: [
			{ venue: '0x53932cbd9c700cf191b2b45e0b1cd50d69f66a1e', type: 'univ3', tokenIn: '0xd9159ad2d5fe625cd1f54f4d328fb19cb5262b07', tokenOut: '0x4200000000000000000000000000000000000006', feeTierBps: 30, notionalUsdc: 100, lpFeeBps: 30, priceImpactBps: 2 },
			{ venue: '0x4200000000000000000000000000000000000006', type: 'unwrap', tokenIn: '0x4200000000000000000000000000000000000006', tokenOut: 'native', feeTierBps: 0, notionalUsdc: 0, lpFeeBps: null, priceImpactBps: null },
		] };
		const html = renderToStaticMarkup(<ReceiptView trade={row as never} hash={row.txHash} />);
		expect(html).toContain('Uniswap v3');
		expect(html).toContain('Unwrap');
		expect(html).toContain('WETH → ETH');
		expect(html).not.toContain('No Route Found');
	});

	// Figma node 524-1644 orders the Cost Breakdown Aggregator Fee → Liquidity
	// Provider Fee → Price Impact. The first pair is the one that moved (Agg Fee
	// used to sit second), and lpFeeSection's slice bounds depend on it holding.
	it('orders the Cost Breakdown Aggregator Fee → Liquidity Provider Fee → Price Impact', async () => {
		const { ReceiptView } = await import('./receiptView');
		const row = { ...base, pricingStatus: 'full', routeLegs: [
			{ venue: '0x53932cbd9c700cf191b2b45e0b1cd50d69f66a1e', type: 'univ3',
				tokenIn: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
				tokenOut: '0x4200000000000000000000000000000000000006',
				feeTierBps: 30, notionalUsdc: 100, lpFeeBps: 30, priceImpactBps: 2 },
		] };
		const html = renderToStaticMarkup(<ReceiptView trade={row as never} hash={row.txHash} />);
		expect(html.indexOf('Aggregator Fee')).toBeGreaterThan(-1);
		expect(html.indexOf('Aggregator Fee')).toBeLessThan(html.indexOf('Liquidity Provider Fee'));
		expect(html.indexOf('Liquidity Provider Fee')).toBeLessThan(html.indexOf('Price Impact'));
	});

	it('renders a Pools Touched section when no leg is costed', async () => {
		const { ReceiptView } = await import('./receiptView');
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
		const { ReceiptView } = await import('./receiptView');
		const row = { ...base, pricingStatus: 'partial', routeLegs: [] };
		const html = renderToStaticMarkup(<ReceiptView trade={row as never} hash={row.txHash} />);
		expect(html).toContain('No Route Found');
		expect(html).not.toContain('>Route<');
	});

	it('labels an rfq leg "Market Maker", linked to its contract, with a null LP Fee and off-chain-quote tooltip', async () => {
		const { ReceiptView } = await import('./receiptView');
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
		expect(html).toContain('color:var(--color-secondary)');
		expect(html).toContain('Market maker inventory, no L.P. fee or price available for this leg');
		expect(html).toContain('>n/a<');
	});

	// The Price Impact section (populated by TradesTable's getPriceImpactRows,
	// consumed here at ~line 610) is a SEPARATE null-tooltip code path from the
	// LP Fee section's RFQ_LEG_TOOLTIP above. An rfq leg's price impact is null
	// BY DESIGN — off-chain quote, no on-chain mid — not because a mid was
	// "discovered ... implausible or stale" (the legacy, now-false, copy).
	it('gives an rfq leg\'s null Price Impact the market-maker tooltip, not the legacy "implausible or stale" copy', async () => {
		const { ReceiptView } = await import('./receiptView');
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
		expect(priceImpactSection).toContain('Market maker inventory, no L.P. fee or price available for this leg');
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
	// End-anchored on "Price Impact", the section that now FOLLOWS LP Fee. Do not
	// anchor on "Aggregator Fee": it renders ABOVE LP Fee, so the slice would run
	// backwards and return '' — silently turning every not.toContain below into a
	// vacuous pass.
	function lpFeeSection(html: string): string {
		const start = html.indexOf('Liquidity Provider Fee');
		const end = html.indexOf('Price Impact');
		if (start < 0 || end <= start) throw new Error('lpFeeSection: LP Fee section not found before Price Impact');
		return html.slice(start, end);
	}

	it('resolves the leading leg\'s WARP token via the receipt\'s own inputSymbol, not a short address', async () => {
		const { ReceiptView } = await import('./receiptView');
		const html = renderToStaticMarkup(<ReceiptView trade={warpEthRow as never} hash={warpEthRow.txHash} />);
		const lpSection = lpFeeSection(html);
		// WARP is absent from TradesTable's static TOKEN_SYMBOLS map, so without
		// the fix this would render a shortened hex address (e.g. "0xd915…62b0").
		expect(lpSection).toContain('WARP/WETH');
		expect(lpSection).not.toContain('0xd915');
	});

	it('labels the terminal leg\'s native-ETH settlement as ETH, not the internal WETH stand-in', async () => {
		const { ReceiptView } = await import('./receiptView');
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
		const { ReceiptView } = await import('./receiptView');
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
		const { ReceiptView } = await import('./receiptView');
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
		const { ReceiptView } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={null} hash="0xabc" diagnosis={{ reason: 'NOT_DECODABLE' }} />,
		);
		expect(html).toContain('Not a swap');
		expect(html).toContain('Token-in / token-out swap not found (signature, approval, LP action, etc)');
	});

	it('renders no failure notice when no diagnosis is supplied', async () => {
		const { ReceiptView } = await import('./receiptView');
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

	it('renders the anchored USD delta as a "Bought … below" sentence, agreeing with Execution Quality', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={ethWbtc as never} />);
		// ETH anchors → USD Price Delta sentence; direction ("below") is preserved from
		// priceDeltaDirection, so the inversion-fix correctness still holds. The
		// "per 1 WBTC" half is now a separate subvalue element, so assert it apart.
		expect(html).toContain('WBTC bought at');
		expect(html).toContain('below Market Price');
		expect(html).toContain('per 1 WBTC');
		// bought below = a good fill: Execution Delta reads Gained AND it agrees with
		// Total Execution Delta +25.53bps. This is the pairing the old inverted labels broke.
		expect(html).toContain('Gained');
		expect(html).toContain('+25.53bps');
		// Still never a verdict word on the price rows; the old labels stay gone.
		expect(html).not.toContain('better');
		expect(html).not.toContain('worse');
		expect(html).not.toContain('Above Market');
		expect(html).not.toContain('Below Market');
		expect(html).not.toContain('At Market');
	});

	it('flips to "Bought … above" (Lost) when the fill received fewer than the mid', async () => {
		const { Receipt } = await import('./receiptView');
		// Consistent loss: received 0.0284 WBTC (< the ~0.028552 the mid implies for 1 ETH),
		// so realizedPrice = 1/0.0284 ≈ 35.2113 ETH/WBTC (paid more ETH per WBTC than the mid).
		const html = renderToStaticMarkup(
			<Receipt row={{ ...ethWbtc, outputAmount: '0.0284', realizedPrice: '35.2113', allInCostBps: '25' } as never} />,
		);
		expect(html).toContain('WBTC bought at');
		expect(html).toContain('above Market Price');
		expect(html).toContain('per 1 WBTC');
		expect(html).toContain('Lost');
	});

	it('reads "Sold … above" for a sell (WETH→USDC), where the base is the input', async () => {
		const { Receipt } = await import('./receiptView');
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
		expect(html).toContain('WETH sold at');
		expect(html).toContain('above Market Price');
		expect(html).toContain('per 1 WETH');
		expect(html).toContain('Gained');
	});

	it('reads "Sold … below" for a sell that received less than the mid', async () => {
		const { Receipt } = await import('./receiptView');
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
		expect(html).toContain('WETH sold at');
		expect(html).toContain('below Market Price');
		expect(html).toContain('per 1 WETH');
		expect(html).toContain('Lost');
	});

	it('renders None with no tooltip when execution exactly matches the mid', async () => {
		const { Receipt } = await import('./receiptView');
		// A genuine tie: 3000 USDC → 1 WETH at a 3000 USDC/WETH mid → realized == mid,
		// so the single-ruler Execution Delta is exactly $0 and the Price Delta is None.
		const html = renderToStaticMarkup(
			<Receipt row={{ ...fullUsdcWethRow, inputAmount: '3000', outputAmount: '1', notionalUsd: '3000' } as never} />,
		);
		expect(html).toContain('None');
		expect(html).not.toContain('than Market Price');
	});

	it('renders a no-anchor memecoin pair through the same path, denominated in the quote token', async () => {
		const { Receipt } = await import('./receiptView');
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
		// The non-anchored path now uses the SAME sentence shape as the anchored one,
		// denominated in the quote token, with "per 1 LFI" as the subvalue.
		expect(html).toContain('LFI sold at 0.0292 GITLAWB below Market Price');
		expect(html).toContain('per 1 LFI');
	});

	it('reads "Bought … above" (Lost) for a USDC→WETH buy over the mid (this was once inverted)', async () => {
		const { Receipt } = await import('./receiptView');
		// base = WETH (output, rank 1 < USDC's 2) → the user BOUGHT the base.
		// Paid 3005 USDC/WETH against a 3000 mid → a $5/ETH overpay → bought above → Lost.
		// ReceiptView.test.tsx:470 once asserted this was "better".
		const html = renderToStaticMarkup(
			<Receipt row={{ ...fullUsdcWethRow, marketMid: '3000', realizedPrice: '3005' } as never} />,
		);
		expect(html).toContain('WETH bought at');
		expect(html).toContain('above Market Price');
		expect(html).toContain('per 1 WETH');
		expect(html).toContain('Lost');
	});
});

describe('Size row', () => {
	it('renders ~Size above Token In for a NON-anchored pair (no USD to reconcile)', async () => {
		const { Receipt } = await import('./receiptView');
		// LFI→GITLAWB: neither leg anchors → not anchored → the soft ~Size line renders.
		const html = renderToStaticMarkup(
			<Receipt row={{
				...fullUsdcWethRow, aggregator: 'fabric', pricingStatus: 'estimated',
				inputSymbol: 'LFI', outputSymbol: 'GITLAWB',
				inputToken: '0x3722264ab15a1dfce5a5af89e6547f7949a8aba3',
				outputToken: '0x5f980dcfc4c0fa3911554cf5ab288ed0eb13dba3',
				inputAmount: '6745937.5', outputAmount: '7234145.96', notionalUsd: '1791.1353895147784',
				marketMid: '1.1016', realizedPrice: '1.0724', chainlinkPrice: null,
			} as never} />,
		);
		expect(html).toContain('Size');
		expect(html).toContain('~$1,791.14');
		// Size precedes Token In in the document.
		expect(html.indexOf('Size')).toBeLessThan(html.indexOf('Token In'));
		// No Execution Delta row on a non-anchored pair.
		expect(html).not.toContain('>Execution Delta<');
	});

	it('replaces Size with Execution Delta on an ANCHORED pair (ETH→WBTC)', async () => {
		const { Receipt } = await import('./receiptView');
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
		expect(html).not.toContain('Size');
		expect(html).toContain('>Execution Delta<');
		expect(html).toContain('Gained');
		// Token In/Out carry per-side USD notionals.
		expect(html).toContain('$1,791.14'); // notionalIn (ETH side)
	});

	it('renders Size on a partial receipt, where no mid exists', async () => {
		const { Receipt } = await import('./receiptView');
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
		const { Receipt } = await import('./receiptView');
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
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<Receipt row={{ ...fullUsdcWethRow, notionalUsd: null } as never} />,
		);
		expect(html).toContain('Size');
		expect(html).toContain('Unavailable for this pair');
	});
});

describe('Anchored single-ruler receipt (supersedes the MVP no-fair-value thesis)', () => {
	// The reference ETH→WBTC row. Under the single ruler EVERY USD figure derives from
	// receiptDollars {notionalIn, notionalOut, execResultUsd} + the base (WBTC) amount:
	//   notionalIn  = 1791.14   notionalOut = 1795.71   execResult = +4.57 (Gained)
	//   exec $/WBTC = 62,571.56 market $/WBTC = 62,731.32  delta $/WBTC = 159.76
	const ethWbtc = {
		...fullUsdcWethRow, aggregator: 'kyberswap',
		inputSymbol: 'ETH', outputSymbol: 'WBTC',
		inputToken: 'native', outputToken: '0x0555e30da8f98308edb960aa94c0db47230d2b9c',
		inputAmount: '1', outputAmount: '0.02862539', notionalUsd: '1791.1353895147784',
		marketMid: '35.02321455049866', realizedPrice: '34.93402185961484',
		allInCostBps: '-25.53', chainlinkPrice: null,
	};

	it('renders per-side USD notionals + Execution Delta (Gained), no Size', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={{ ...ethWbtc, pricingStatus: 'full' } as never} />);
		expect(html).toContain('>Execution Delta<');
		expect(html).toContain('Gained');
		expect(html).toContain('$1,791.14'); // Token In (ETH) notionalIn
		expect(html).toContain('$1,795.71'); // Token Out (WBTC) notionalOut
		expect(html).not.toContain('Size');  // Size replaced by Execution Delta when anchored
	});

	it('reconciles: Execution Delta magnitude = per-base delta × base amount', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={{ ...ethWbtc, pricingStatus: 'estimated' } as never} />);
		// $159.76 below Market Price per WBTC × 0.02862539 WBTC ≈ $4.57 Execution Delta.
		expect(html).toContain('WBTC bought at $159.76 below Market Price');
		expect(html).toContain('per 1 WBTC');
		expect(html).toContain('Gained');
	});

	it('renders USD sublines on the price rows, keeping the token-denominated main lines', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={{ ...ethWbtc, pricingStatus: 'full' } as never} />);
		expect(html).toContain('$62,731.32'); // Market Price in USD (per WBTC)
		expect(html).toContain('$62,571.56'); // Execution Price in USD (per WBTC)
		expect(html).toContain('34.934 ETH = 1 WBTC'); // token-denominated main lines preserved
		expect(html).toContain('35.0232 ETH = 1 WBTC');
	});
});

describe('Receipt UI polish (2026-07-21 Figma pass)', () => {
	// ETH→WBTC, the reference anchored row: a gain of +$4.57.
	const ethWbtc = {
		...fullUsdcWethRow, aggregator: 'kyberswap', pricingStatus: 'estimated',
		inputSymbol: 'ETH', outputSymbol: 'WBTC',
		inputToken: 'native', outputToken: '0x0555e30da8f98308edb960aa94c0db47230d2b9c',
		inputAmount: '1', outputAmount: '0.02862539', notionalUsd: '1791.1353895147784',
		marketMid: '35.02321455049866', realizedPrice: '34.93402185961484',
		allInCostBps: '-25.53', chainlinkPrice: null,
	};

	it('sizes detail-row subvalues at 12px, matching the rest of the list', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={ethWbtc as never} />);
		// The 10px subvalue/sublabel treatment is gone from the detail table.
		expect(html).not.toContain('text-[10px]');
	});

	it('colors the Execution Delta VALUE green on a gain, leaving the subvalue secondary', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={ethWbtc as never} />);
		expect(html).toContain('>Execution Delta<');
		expect(html).toContain('Gained');
		// The green now sits on the element carrying the dollar magnitude, and the
		// "Gained" subvalue renders in secondary gray.
		expect(html).toMatch(/style="color:#117d45">\$4\.57</);
		expect(html).toMatch(/color:var\(--color-secondary\)">Gained/);
	});

	it('leaves a loss uncolored rather than red, matching formatDialogBps', async () => {
		const { Receipt } = await import('./receiptView');
		// Received fewer WBTC than the mid implies → a loss.
		const html = renderToStaticMarkup(
			<Receipt row={{ ...ethWbtc, outputAmount: '0.0284', realizedPrice: '35.2113', allInCostBps: '25' } as never} />,
		);
		expect(html).toContain('Lost');
		expect(html).not.toContain('--color-red');
		expect(html).not.toContain('#fa0b54');
	});

	it('renders the Market Price descriptor as a *-footnote when a mid exists', async () => {
		const { Receipt } = await import('./receiptView');
		// The stored methodology wins when present, rendered as a *-prefixed footnote.
		const stored = renderToStaticMarkup(
			<Receipt row={{ ...ethWbtc, methodology: 'Verified: The direct-pool price and WETH-derived price agree.' } as never} />,
		);
		expect(stored).toContain('*Verified: The direct-pool price and WETH-derived price agree.');
		expect(stored).toContain('Market Price*'); // label carries the asterisk connotation

		// A NULL methodology falls back to the tier string, still as a footnote.
		const estimated = renderToStaticMarkup(<Receipt row={{ ...ethWbtc, methodology: null } as never} />);
		expect(estimated).toContain('Estimated:');

		// The null-mid state shows NO asterisk and NO footnote (decision: only when a mid exists).
		const partial = renderToStaticMarkup(
			<Receipt row={{ ...ethWbtc, pricingStatus: 'partial', marketMid: null, methodology: null, allInCostBps: null } as never} />,
		);
		expect(partial).not.toContain('Market Price*');
		expect(partial).not.toContain('Unavailable: No reliable market price could be calculated.');

		// The hardcoded tooltip copy stays gone.
		for (const html of [stored, estimated]) {
			expect(html).not.toContain('cross-referenced against an on-chain price oracle');
			expect(html).not.toContain('Best-effort reference from the deepest on-chain pool');
		}
	});

	it('renders the Gas Cost descriptor', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={ethWbtc as never} />);
		expect(html).toContain('Gas Cost');
		expect(html).toContain('Paid separately in ETH');
	});

	it('keeps the descriptor on Gas Cost even when the value is unavailable', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={{ ...ethWbtc, gasCostUsd: null } as never} />);
		expect(html).toContain('Paid separately in ETH');
	});
});

describe('Aggregator fee sinks', () => {
	it('renders one fee line per sink: first named-or-generic, rest truncated, all linked', async () => {
		const { Receipt } = await import('./receiptView');
		const row = {
			...fullUsdcWethRow,
			aggregator: 'Nordstern',
			aggFeeBps: '22',
			feeRecipient: '0x3dbe077e7986657e95e1cc50089f17a5a4af0aae',
			feeSinks: [
				{ address: '0x3dbe077e7986657e95e1cc50089f17a5a4af0aae', feeBps: 19.02, source: 'retained_balance', name: null },
				{ address: '0x5f6900000000000000000000000000000000d431', feeBps: 2.98, source: 'retained_balance', name: null },
			],
		};
		const html = renderToStaticMarkup(<Receipt row={row as never} />);
		// First sink: generic "[Aggregator] Fee", linked to its recipient.
		expect(html).toContain('Nordstern Fee');
		expect(html).toContain('href="https://basescan.org/address/0x3dbe077e7986657e95e1cc50089f17a5a4af0aae"');
		// Second sink: truncated address as label + link (curation cue).
		expect(html).toContain('0x5f69…d431');
		expect(html).toContain('href="https://basescan.org/address/0x5f6900000000000000000000000000000000d431"');
	});
});

describe('LegRow router attribution', () => {
	const baseRow = {
		inputToken: '0x4200000000000000000000000000000000000006',
		outputToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
		inputSymbol: 'WETH',
		outputSymbol: 'USDC',
	};
	const leg = (router?: { slug: string; address: string; path: string[] }) => ({
		venue: '0x345825a980bd94e1480bc4f20fe4e3dae2f23dd3',
		type: 'pancakev3',
		tokenIn: baseRow.inputToken,
		tokenOut: baseRow.outputToken,
		tokenInSymbol: 'WETH',
		tokenOutSymbol: 'USDC',
		feeTierBps: 5,
		notionalUsdc: 1000,
		lpFeeBps: 5,
		priceImpactBps: 1,
		...(router ? { router } : {}),
	});

	const render = async (l: ReturnType<typeof leg>) => {
		const { LegRow } = await import('./receipt/receiptRows');
		return renderToStaticMarkup(
			React.createElement(LegRow, {
				leg: l as never,
				index: 0,
				legsLength: 1,
				row: baseRow as never,
				value: '5.0bps',
			}),
		);
	};

	it('renders the pair alone when no other aggregator executed the leg', async () => {
		const html = await render(leg());
		expect(html).toContain('WETH/USDC');
		expect(html).not.toContain('basescan.org/address/0x7c137a37');
	});

	it('appends the router, linked to its Basescan contract page', async () => {
		const html = await render(
			leg({ slug: 'fabric', address: '0x7c137a37742437d2212b7bd873ed135b5c4c61da', path: ['relay', 'fabric'] }),
		);
		expect(html).toContain('WETH/USDC');
		expect(html).toContain('Fabric');
		expect(html).toContain('href="https://basescan.org/address/0x7c137a37742437d2212b7bd873ed135b5c4c61da"');
	});

	it('shows no tooltip at depth 2', async () => {
		const html = await render(
			leg({ slug: 'fabric', address: '0x7c137a37742437d2212b7bd873ed135b5c4c61da', path: ['relay', 'fabric'] }),
		);
		expect(html).not.toContain('role="tooltip"');
	});

	it('shows the full arrow-joined path in a tooltip above depth 2', async () => {
		const html = await render(
			leg({ slug: 'fabric', address: '0x7c137a37742437d2212b7bd873ed135b5c4c61da', path: ['relay', 'odos', 'fabric'] }),
		);
		expect(html).toContain('role="tooltip"');
		expect(html).toContain('Relay → Odos → Fabric');
	});

	it('renders no router tag on a wrap step row', async () => {
		const wrapLeg = {
			...leg({ slug: 'fabric', address: '0x7c137a37742437d2212b7bd873ed135b5c4c61da', path: ['relay', 'fabric'] }),
			type: 'wrap',
		};
		const html = await render(wrapLeg as never);
		expect(html).toContain('ETH → WETH');
		expect(html).not.toContain('basescan.org/address/0x7c137a37');
	});
});

describe('getPriceImpactRows router attribution', () => {
	const ROUTER = { slug: 'fabric', address: '0x7c137a37742437d2212b7bd873ed135b5c4c61da', path: ['relay', 'fabric'] };
	const baseRow = {
		inputToken: '0x4200000000000000000000000000000000000006',
		outputToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
		inputSymbol: 'WETH',
		outputSymbol: 'USDC',
	};
	const leg = (extra: Record<string, unknown> = {}) => ({
		venue: '0x345825a980bd94e1480bc4f20fe4e3dae2f23dd3',
		type: 'pancakev3',
		tokenIn: baseRow.inputToken,
		tokenOut: baseRow.outputToken,
		tokenInSymbol: 'WETH',
		tokenOutSymbol: 'USDC',
		priceImpactBps: 3,
		...extra,
	});

	it('passes the leg router through as data', async () => {
		const { getPriceImpactRows } = await import('./receipt/receiptDisplay');
		const rows = getPriceImpactRows([leg({ router: ROUTER })] as never, baseRow as never);
		expect(rows[0]!.router).toEqual(ROUTER);
		expect(rows[0]!.context).toBe('WETH/USDC');
	});

	it('omits the router on a leg that has none', async () => {
		const { getPriceImpactRows } = await import('./receipt/receiptDisplay');
		const rows = getPriceImpactRows([leg()] as never, baseRow as never);
		expect(rows[0]!.router).toBeUndefined();
	});

	it('omits the router on a wrap step row', async () => {
		const { getPriceImpactRows } = await import('./receipt/receiptDisplay');
		const rows = getPriceImpactRows([leg({ type: 'wrap', router: ROUTER })] as never, baseRow as never);
		expect(rows[0]!.context).toBe('ETH → WETH');
		expect(rows[0]!.router).toBeUndefined();
	});

	it('returns JSX-free data — context stays a string', async () => {
		const { getPriceImpactRows } = await import('./receipt/receiptDisplay');
		const rows = getPriceImpactRows([leg({ router: ROUTER })] as never, baseRow as never);
		expect(typeof rows[0]!.context).toBe('string');
	});
});

describe('legContext', () => {
	const ROUTER = { slug: 'fabric', address: '0x7c137a37742437d2212b7bd873ed135b5c4c61da', path: ['relay', 'fabric'] };

	const render = async (pair: string | undefined, router: unknown, suppress: boolean) => {
		const { legContext } = await import('./receipt/receiptRows');
		return renderToStaticMarkup(
			React.createElement('div', null, legContext(pair, router as never, suppress)),
		);
	};

	it('joins the pair and the router with the bullet separator, in that order', async () => {
		const html = await render('WETH/USDC', ROUTER, false);
		expect(html).toMatch(/WETH\/USDC\s*•\s*<a[^>]*>Fabric<\/a>/);
	});

	it('emits exactly one separator', async () => {
		const html = await render('WETH/USDC', ROUTER, false);
		expect(html.match(/•/g)).toHaveLength(1);
	});

	it('renders the pair alone with no trailing separator when there is no router', async () => {
		const html = await render('WETH/USDC', undefined, false);
		expect(html).toBe('<div>WETH/USDC</div>');
	});

	it('renders the router with no leading separator when the pair is absent', async () => {
		const html = await render(undefined, ROUTER, false);
		expect(html).not.toContain('•');
		expect(html).toContain('Fabric');
	});

	it('suppresses the router entirely when suppress is set', async () => {
		const html = await render('ETH → WETH', ROUTER, true);
		expect(html).toBe('<div>ETH → WETH</div>');
	});
});

describe('ReceiptSearch chrome', () => {
	it('drops the Transaction Hash label and uses the short placeholder', async () => {
		const { ReceiptView } = await import('./receiptView');
		const html = renderToStaticMarkup(<ReceiptView trade={null} hash="" />);
		expect(html).not.toContain('Transaction Hash');
		expect(html).toContain('placeholder="Transaction hash"');
	});

	it('renders the divider under the input even with no receipt', async () => {
		const { ReceiptView } = await import('./receiptView');
		const html = renderToStaticMarkup(<ReceiptView trade={null} hash="" />);
		expect(html).toContain('h-px w-full shrink-0 bg-[var(--color-primary)]');
	});
});

describe('receipt dividers', () => {
	it('renders no dotted dividers anywhere', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={fullUsdcWethRow as never} />);
		expect(html).not.toContain('repeating-linear-gradient');
	});

	it('renders a primary rule immediately above the Cost Breakdown heading', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={fullUsdcWethRow as never} />);
		const heading = html.indexOf('>Cost Breakdown<');
		const rule = html.lastIndexOf('h-px w-full shrink-0 bg-[var(--color-primary)]', heading);
		expect(heading).toBeGreaterThan(-1);
		expect(rule).toBeGreaterThan(-1);
		// Nothing but whitespace/markup between the rule and the heading.
		expect(html.slice(rule, heading)).not.toContain('Gas Cost');
	});
});
