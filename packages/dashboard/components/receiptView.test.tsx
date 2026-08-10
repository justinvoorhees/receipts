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
			sub: 'At Block per 1 WBTC',
		});
		// WETH→USDC (base WETH, quote USDC), realized over the mid → sold above.
		expect(formatPriceDeltaToken(3000, 3005, 'WETH', 'USDC', false)).toEqual({
			text: 'WETH sold at 5.00 USDC above Market Price',
			sub: 'At Block per 1 WETH',
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

describe('tooltip touch support', () => {
	it('keeps a tooltip hover-only until touched — default render is unchanged', async () => {
		const { DetailRow } = await import('./receipt/receiptRows');
		const html = renderToStaticMarkup(
			<DetailRow label="Gas Cost" tooltip="Paid separately in ETH">
				$0.01
			</DetailRow>,
		);
		expect(html).toContain('role="tooltip"');
		expect(html).toContain('invisible group-hover:visible');
		expect(html).not.toContain('"visible"');
	});
});

describe('pendingPulseClass', () => {
	it('returns the pulse class while pending, and nothing otherwise', async () => {
		const { pendingPulseClass } = await import('./receiptView');
		expect(pendingPulseClass(true)).toBe('receipt-pending-pulse');
		expect(pendingPulseClass(false)).toBeUndefined();
	});
});

describe('pending-pulse wrapper layout', () => {
	it('keeps the receipt on the page-wide 40px flex rhythm inside the pending-pulse wrapper', async () => {
		const { ReceiptView } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={fullUsdcWethRow as never} hash={fullUsdcWethRow.txHash} />,
		);
		const matches = html.match(/class="flex flex-col gap-\[40px\]"/g) ?? [];
		expect(matches.length).toBe(2);
	});
});

// A full USDC/WETH receipt, generalized ReceiptModel shape (Task 8+).
const fullUsdcWethRow = {
	txHash: '0x1234567890abcdef1234567890abcdef12345678',
	chainId: 8453, blockNumber: 123, aggregator: 'kyberswap', direction: 'buy_weth',
	inputToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
	outputToken: '0x4200000000000000000000000000000000000006',
	inputSymbol: 'USDC', outputSymbol: 'WETH',
	inputAmount: 1000.00, outputAmount: 0.33, notionalUsd: 1000.00,
	realizedPrice: 3000, marketMid: 3000, allInCostBps: -1, pricingStatus: 'full',
	lpFeeBps: 1, aggFeeBps: 0, slippageBps: -2, executionBps: '-1', gasCostUsd: 0.001,
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

	it('renders no close/delete controls — there is no dialog mode', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={fullUsdcWethRow as never} />);
		// The rule under the input belongs to ReceiptView now, not Receipt — see
		// the 'ReceiptSearch chrome' block for its coverage.
		expect(html).not.toContain('Close transaction details');
		expect(html).not.toContain('>Delete<');
	});
});

describe('UniswapX Filler row', () => {
	const fillerRow = {
		...fullUsdcWethRow,
		fillerAddress: '0xfiller1234567890abcdef1234567890abcdef12',
		normalizeFlags: ['BENEFICIARY_ANCHORED: y', 'ANCHOR_VIA_UNISWAPX: z'],
	};

	it('replaces the Provider row with Filler / via UniswapX + a Basescan link to the filler', async () => {
		const { ReceiptView } = await import('./receiptView');
		const html = renderToStaticMarkup(<ReceiptView trade={fillerRow as never} hash={fillerRow.txHash} />);
		expect(html).toContain('Filler');
		expect(html).toContain('via UniswapX');
		expect(html).toContain(`href="https://basescan.org/address/${fillerRow.fillerAddress}"`);
		expect(html).not.toContain('>Provider<');
		// The row itself now conveys "via UniswapX" — the separate note is redundant.
		expect(html).not.toContain('Executed via UniswapX');
	});

	it('falls back to the ordinary Provider row + note when fillerAddress is null (legacy row)', async () => {
		const { ReceiptView } = await import('./receiptView');
		const legacyRow = { ...fillerRow, fillerAddress: null };
		const html = renderToStaticMarkup(<ReceiptView trade={legacyRow as never} hash={legacyRow.txHash} />);
		expect(html).toContain('>Provider<');
		expect(html).toContain('Executed via UniswapX');
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
		expect(html).toContain('>Provider<');
		expect(html).toContain('Executed via Solver');
		expect(html).not.toContain('>Filler<');
	});
});

describe('Receipt unnamed fee-sink attribution', () => {
	// An 80bps fee retained by 0x403560…a1c5. In the corpus that one address
	// appears under BOTH Fabric and 0x routes, so it cannot belong to either —
	// it is an integrator wallet. A retained balance never establishes whose it
	// is, so an unnamed sink must render its address and name no one.
	const sink = '0x403560800cb7e03a06ebbc991dba0f6ac751a1c5';
	const rowUnder = (aggregator: string) => ({
		...fullUsdcWethRow,
		aggregator,
		aggFeeBps: 80,
		feeRecipient: sink,
	});

	it('renders an unnamed sink as its truncated address, linked, naming no party', async () => {
		const { ReceiptView } = await import('./receiptView');
		const row = rowUnder('Fabric');
		const html = renderToStaticMarkup(<ReceiptView trade={row as never} hash={row.txHash} />);
		expect(html).toContain('0x4035…a1c5');
		expect(html).toContain(`href="https://basescan.org/address/${sink}"`);
		expect(html).not.toContain('Integrator Fee');
		expect(html).not.toContain('Fabric Fee');
	});

	it('gives the same sink the same label under a different aggregator', async () => {
		const { ReceiptView } = await import('./receiptView');
		const fabric = rowUnder('Fabric');
		const zeroEx = rowUnder('0x');
		const htmlFabric = renderToStaticMarkup(<ReceiptView trade={fabric as never} hash={fabric.txHash} />);
		const htmlZeroEx = renderToStaticMarkup(<ReceiptView trade={zeroEx as never} hash={zeroEx.txHash} />);
		expect(htmlFabric).toContain('0x4035…a1c5');
		expect(htmlZeroEx).toContain('0x4035…a1c5');
		expect(htmlZeroEx).not.toContain('0x Fee');
	});
});

describe('Receipt partial state', () => {
	const partialRow = {
		txHash: '0xabcabcabcabcabcabcabcabcabcabcabcabcabcd',
		chainId: 8453, blockNumber: 987, aggregator: 'odos', direction: 'USDC->???',
		inputToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
		outputToken: '0x000000000000000000000000000000000000dead',
		inputSymbol: 'AAA', outputSymbol: 'BBB',
		inputAmount: 1000, outputAmount: 5, notionalUsd: 1000,
		realizedPrice: null, marketMid: null, allInCostBps: null, pricingStatus: 'partial',
		lpFeeBps: 3, aggFeeBps: 2, slippageBps: null, executionBps: null, gasCostUsd: 0.01,
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
		// Third-party fee still shows normally (non-zero).
		expect(html).toContain('>Third-Party Fee<');
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
			inputAmount: 202116011.45, outputAmount: 0.0778, notionalUsd: 134.96,
			realizedPrice: 0.000000000385, marketMid: 0.000000000394, allInCostBps: 221,
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
		realizedPrice: 0.00000068,
		marketMid: 0.00000069,
		allInCostBps: 14,
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
			realizedPrice: 0.00000068,
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
		expect((html.match(/>N\/A</g) ?? []).length).toBe(4);
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

	// Figma node 524-1644 orders the Cost Breakdown Third-Party Fee → Liquidity
	// Provider Fee → Price Impact. The first pair is the one that moved (the fee
	// section used to sit second), and lpFeeSection's slice bounds depend on it
	// holding.
	//
	// Anchored on '>Label<', never the bare label: the Total Execution Delta
	// tooltip enumerates "Third-Party Fee, L.P. Fee, Price Impact, and Slippage"
	// in prose, so a bare indexOf can match tooltip copy instead of a heading and
	// pass (or fail) for the wrong reason.
	it('orders the Cost Breakdown Third-Party Fee → Liquidity Provider Fee → Price Impact', async () => {
		const { ReceiptView } = await import('./receiptView');
		const row = { ...base, pricingStatus: 'full', routeLegs: [
			{ venue: '0x53932cbd9c700cf191b2b45e0b1cd50d69f66a1e', type: 'univ3',
				tokenIn: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
				tokenOut: '0x4200000000000000000000000000000000000006',
				feeTierBps: 30, notionalUsdc: 100, lpFeeBps: 30, priceImpactBps: 2 },
		] };
		const html = renderToStaticMarkup(<ReceiptView trade={row as never} hash={row.txHash} />);
		expect(html.indexOf('>Third-Party Fee<')).toBeGreaterThan(-1);
		expect(html.indexOf('>Liquidity Provider Fee<')).toBeGreaterThan(-1);
		expect(html.indexOf('>Price Impact<')).toBeGreaterThan(-1);
		expect(html.indexOf('>Third-Party Fee<')).toBeLessThan(html.indexOf('>Liquidity Provider Fee<'));
		expect(html.indexOf('>Liquidity Provider Fee<')).toBeLessThan(html.indexOf('>Price Impact<'));
	});

	// A fee we could not read must not render as "0.00bps" — that asserts the pool
	// was free. Only an explicit feeResolved:false means unresolved; rows written
	// before the flag existed (key absent) keep rendering their fee as before.
	describe('unresolved LP fee', () => {
		const legWith = (over: Record<string, unknown>) => ({
			venue: '0x53932cbd9c700cf191b2b45e0b1cd50d69f66a1e', type: 'univ3',
			tokenIn: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
			tokenOut: '0x4200000000000000000000000000000000000006',
			feeTierBps: 0, notionalUsdc: 100, lpFeeBps: 0, priceImpactBps: 2, ...over,
		});
		const render = async (over: Record<string, unknown>) => {
			const { ReceiptView } = await import('./receiptView');
			const row = { ...base, pricingStatus: 'full', routeLegs: [legWith(over)] };
			return renderToStaticMarkup(<ReceiptView trade={row as never} hash={row.txHash} />);
		};

		// Counted, not just "contains": 0.00bps also appears on the Third-Party Fee
		// row, so a bare toContain would pass for the wrong reason.
		const zeroBpsCells = (html: string) => (html.match(/>0\.00bps</g) ?? []).length;

		it('explains an unresolved fee instead of claiming the pool was free', async () => {
			const html = await render({ feeResolved: false });
			expect(html).toContain('No fee available for this leg');
			expect(html).toContain('>N/A<');
		});

		it('drops the 0.00bps fee cell when the fee is unresolved', async () => {
			const resolved = await render({ feeResolved: true });
			const unresolved = await render({ feeResolved: false });
			expect(zeroBpsCells(unresolved)).toBe(zeroBpsCells(resolved) - 1);
		});

		it('still renders a genuine 0.00bps fee when the flag is absent (pre-flag rows)', async () => {
			const html = await render({});
			expect(zeroBpsCells(html)).toBeGreaterThan(0);
			expect(html).not.toContain('No fee available for this leg');
		});

		it('still renders a genuine 0.00bps fee when the fee resolved cleanly', async () => {
			const html = await render({ feeResolved: true });
			expect(zeroBpsCells(html)).toBeGreaterThan(0);
			expect(html).not.toContain('No fee available for this leg');
		});

		// The unresolved fee must not suppress the leg's price impact — they are
		// independent measurements and only the fee is in question. formatDialogBps
		// strips the sign, so a -2 impact renders as the cell text "2.00bps".
		it('leaves the leg price impact rendering when only the fee is unresolved', async () => {
			const html = await render({ feeResolved: false });
			expect(html).toContain('>2.00bps<');
		});
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
		expect(html).toContain('>N/A<');
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
	// anchor on "Third-Party Fee": it renders ABOVE LP Fee, so the slice would run
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
		inputAmount: 1, outputAmount: 0.02862539, notionalUsd: 1791.1353895147784,
		marketMid: 35.02321455049866, realizedPrice: 34.93402185961484,
		allInCostBps: -25.53, chainlinkPrice: null,
	};

	it('renders the anchored USD delta as a "Bought … below" sentence, agreeing with Execution Quality', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={ethWbtc as never} />);
		// ETH anchors → USD Price Delta sentence; direction ("below") is preserved from
		// priceDeltaDirection, so the inversion-fix correctness still holds. The
		// "per 1 WBTC" half is now a separate subvalue element, so assert it apart.
		expect(html).toContain('WBTC bought at');
		expect(html).toContain('below Market Price');
		expect(html).toContain('At Block per 1 WBTC');
		// Execution Delta now states direction in prose; the pairing it must preserve
		// is that a bought-below fill agrees with a positive Total Execution Delta.
		expect(html).toContain('Per 1 ETH');
		expect(html).toContain('+25.53bps');
		// Still never a verdict word on the price rows; the old labels stay gone.
		expect(html).not.toContain('better');
		expect(html).not.toContain('worse');
		expect(html).not.toContain('Above Market');
		expect(html).not.toContain('Below Market');
		expect(html).not.toContain('At Market');
	});

	it('flips to "Bought … above" when the fill received fewer than the mid', async () => {
		const { Receipt } = await import('./receiptView');
		// Consistent loss: received 0.0284 WBTC (< the ~0.028552 the mid implies for 1 ETH),
		// so realizedPrice = 1/0.0284 ≈ 35.2113 ETH/WBTC (paid more ETH per WBTC than the mid).
		const html = renderToStaticMarkup(
			<Receipt row={{ ...ethWbtc, outputAmount: 0.0284, realizedPrice: 35.2113, allInCostBps: 25 } as never} />,
		);
		expect(html).toContain('WBTC bought at');
		expect(html).toContain('above Market Price');
		expect(html).toContain('At Block per 1 WBTC');
		// Execution Delta states the same "above" direction in its own sentence now.
		expect(html).toContain('Per 1 ETH');
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
				inputAmount: 1, outputAmount: 3005,
				marketMid: 3000, realizedPrice: 3005,
			} as never} />,
		);
		expect(html).toContain('WETH sold at');
		expect(html).toContain('above Market Price');
		expect(html).toContain('At Block per 1 WETH');
		expect(html).toContain('Per 1 WETH');
	});

	it('reads "Sold … below" for a sell that received less than the mid', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<Receipt row={{
				...fullUsdcWethRow,
				inputSymbol: 'WETH', outputSymbol: 'USDC',
				inputToken: '0x4200000000000000000000000000000000000006',
				outputToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
				inputAmount: 1, outputAmount: 2995,
				marketMid: 3000, realizedPrice: 2995,
			} as never} />,
		);
		expect(html).toContain('WETH sold at');
		expect(html).toContain('below Market Price');
		expect(html).toContain('At Block per 1 WETH');
		expect(html).toContain('Per 1 WETH');
	});

	it('renders None with no tooltip when execution exactly matches the mid', async () => {
		const { Receipt } = await import('./receiptView');
		// A genuine tie: 3000 USDC → 1 WETH at a 3000 USDC/WETH mid → realized == mid,
		// so the single-ruler Execution Delta is exactly $0 and the Price Delta is None.
		const html = renderToStaticMarkup(
			<Receipt row={{ ...fullUsdcWethRow, inputAmount: 3000, outputAmount: 1, notionalUsd: 3000 } as never} />,
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
				inputAmount: 6745937.5, outputAmount: 7234145.96,
				marketMid: 1.1016, realizedPrice: 1.0724,
				allInCostBps: 265, chainlinkPrice: null,
			} as never} />,
		);
		expect(html).toContain('0.0292 GITLAWB');
		expect(html).not.toContain('197178.79 GITLAWB'); // the old quantity-based delta
		// base = LFI is the input → sold. 1.0724 < 1.1016 mid → received fewer, so
		// "sold below" — the bad half of a sell, agreeing with allInCostBps 265 (a cost).
		// The non-anchored path now uses the SAME sentence shape as the anchored one,
		// denominated in the quote token, with "per 1 LFI" as the subvalue.
		expect(html).toContain('LFI sold at 0.0292 GITLAWB below Market Price');
		expect(html).toContain('At Block per 1 LFI');
	});

	it('reads "Bought … above" for a USDC→WETH buy over the mid (this was once inverted)', async () => {
		const { Receipt } = await import('./receiptView');
		// base = WETH (output, rank 1 < USDC's 2) → the user BOUGHT the base.
		// Paid 3005 USDC/WETH against a 3000 mid → a $5/ETH overpay → the fill lands above Market Price.
		// ReceiptView.test.tsx:470 once asserted this was "better".
		const html = renderToStaticMarkup(
			<Receipt row={{ ...fullUsdcWethRow, marketMid: 3000, realizedPrice: 3005 } as never} />,
		);
		expect(html).toContain('WETH bought at');
		expect(html).toContain('above Market Price');
		expect(html).toContain('At Block per 1 WETH');
		expect(html).toContain('Per 1000.00 USDC');
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
				inputAmount: 6745937.5, outputAmount: 7234145.96, notionalUsd: 1791.1353895147784,
				marketMid: 1.1016, realizedPrice: 1.0724, chainlinkPrice: null,
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
				inputAmount: 1, outputAmount: 0.02862539, notionalUsd: 1791.1353895147784,
				marketMid: 35.02321455049866, realizedPrice: 34.93402185961484,
				chainlinkPrice: null,
			} as never} />,
		);
		expect(html).not.toContain('Size');
		expect(html).toContain('>Execution Delta<');
		expect(html).toContain('Per 1 ETH');
		// Token In/Out carry per-side USD notionals.
		expect(html).toContain('$1,791.14'); // notionalIn (ETH side)
	});

	it('renders Size on a partial receipt, where no mid exists', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<Receipt row={{
				...fullUsdcWethRow, pricingStatus: 'partial',
				marketMid: null, allInCostBps: null, notionalUsd: 1000.00,
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
				inputAmount: 1000, outputAmount: 2400, notionalUsd: 134.96,
				marketMid: 2.5, realizedPrice: 2.4, chainlinkPrice: null,
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
		inputAmount: 1, outputAmount: 0.02862539, notionalUsd: 1791.1353895147784,
		marketMid: 35.02321455049866, realizedPrice: 34.93402185961484,
		allInCostBps: -25.53, chainlinkPrice: null,
	};

	it('renders per-side USD notionals + Execution Delta, no Size', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={{ ...ethWbtc, pricingStatus: 'full' } as never} />);
		expect(html).toContain('>Execution Delta<');
		expect(html).toContain('Per 1 ETH');
		expect(html).toContain('$1,791.14'); // Token In (ETH) notionalIn
		expect(html).toContain('$1,795.71'); // Token Out (WBTC) notionalOut
		expect(html).not.toContain('Size');  // Size replaced by Execution Delta when anchored
	});

	it('agrees on direction: Price Delta (token) and Execution Delta (USD) both say "below"', async () => {
		// NOTE: prior to Task 8, this test was named 'reconciles: Execution Delta
		// magnitude = per-base delta × base amount' and asserted a numeric tie
		// between the two rows' magnitudes — valid when both were USD-denominated.
		// Since Task 8 moved Price Delta into the notional-free Price Range section,
		// it renders in the quote token (ETH) while Execution Delta stays in USD
		// (top block); the two no longer share a unit, so no magnitude reconciles
		// across them. What still holds, and is what this test checks now, is that
		// both rows agree on DIRECTION — same sign, same underlying gain, just two
		// different denominations of it.
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={{ ...ethWbtc, pricingStatus: 'estimated' } as never} />);
		// Price Delta: per-unit gap in the quote token (ETH), per 1 WBTC.
		expect(html).toContain('WBTC bought at 0.0892 ETH below Market Price');
		expect(html).toContain('At Block per 1 WBTC');
		// Execution Delta: whole-trade gap in USD — same direction, top block.
		expect(html).toContain('WBTC bought at $4.57 below Market Price');
		expect(html).toContain('Per 1 ETH');
	});

	it('renders no USD sublines on Price Range rows, keeping the token-denominated main lines', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={{ ...ethWbtc, pricingStatus: 'full' } as never} />);
		// Price Range is notional-free (Task 8): no USD subvalue on Execution Price
		// or Market Price, and Price Delta states its gap in the quote token.
		const priceRange = html.indexOf('>Price Range<');
		const txCost = html.indexOf('>Transaction Costs<');
		// Guard against a vacuous pass: if either heading vanished, indexOf
		// returns -1 and slice(-1, -1) would yield '', matching not.toMatch trivially.
		expect(priceRange).toBeGreaterThan(-1);
		expect(txCost).toBeGreaterThan(-1);
		const section = html.slice(priceRange, txCost);
		expect(section).not.toMatch(/\$[0-9]/);
		expect(html).toContain('34.934 ETH = 1 WBTC'); // token-denominated main lines preserved
		expect(html).toContain('35.0232 ETH = 1 WBTC');
	});

	it('sources Total Execution Delta bps from receiptDollars, not the stored all_in_cost_bps column', async () => {
		// Structural test, not a regression test: no divergence between the stored
		// column and the derived figure has ever been observed (they agree here to
		// the penny — see the ethWbtc fixture comment: -25.53bps either way). This
		// proves the RENDER PATH no longer reads the column, by feeding it a value
		// (999.99) nowhere near the ~25.53bps that receiptDollars derives from
		// marketMid/realizedPrice/notionalUsd — too far off to coincidentally match.
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<Receipt row={{ ...ethWbtc, pricingStatus: 'full', allInCostBps: 999.99 } as never} />,
		);
		expect(html).not.toContain('999.99');
		// The value actually derived from receiptDollars {execResultUsd, notionalIn}
		// via the same reconciledResult that produces the +$4.57 Execution Delta.
		expect(html).toContain('+25.53bps');
	});
});

describe('Receipt UI polish (2026-07-21 Figma pass)', () => {
	// ETH→WBTC, the reference anchored row: a gain of +$4.57.
	const ethWbtc = {
		...fullUsdcWethRow, aggregator: 'kyberswap', pricingStatus: 'estimated',
		inputSymbol: 'ETH', outputSymbol: 'WBTC',
		inputToken: 'native', outputToken: '0x0555e30da8f98308edb960aa94c0db47230d2b9c',
		inputAmount: 1, outputAmount: 0.02862539, notionalUsd: 1791.1353895147784,
		marketMid: 35.02321455049866, realizedPrice: 34.93402185961484,
		allInCostBps: -25.53, chainlinkPrice: null,
	};

	it('sizes detail-row subvalues at 12px, matching the rest of the list', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={ethWbtc as never} />);
		// The 10px subvalue/sublabel treatment is gone from the detail table, and the
		// Market Price methodology footnote (Figma 546-694) was brought up from 10px
		// to 12px too, so no 10px text remains anywhere in the receipt.
		expect(html).toContain('class="whitespace-nowrap text-[12px] leading-[12px] text-right"');
		expect(html).toContain('class="text-[12px] leading-[20px] text-[var(--color-secondary)]"');
		expect(html.match(/text-\[10px\]/g)).toBeNull();
	});

	it('renders the Execution Delta sentence uncolored on a gain, with the Per subvalue in secondary gray', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={ethWbtc as never} />);
		expect(html).toContain('>Execution Delta<');
		expect(html).toContain('WBTC bought at $4.57 below Market Price');
		// The value carries no color (direction lives in the prose now), and the
		// "Per 1 ETH" subvalue renders in secondary gray like every other subvalue.
		expect(html).toMatch(/<span class="min-w-0 text-right">WBTC bought at \$4\.57 below Market Price<\/span>/);
		expect(html).toMatch(/color:var\(--color-secondary\)">Per 1 ETH/);
	});

	it('leaves a loss uncolored too — no red, matching formatDialogBps', async () => {
		const { Receipt } = await import('./receiptView');
		// Received fewer WBTC than the mid implies → a loss.
		const html = renderToStaticMarkup(
			<Receipt row={{ ...ethWbtc, outputAmount: 0.0284, realizedPrice: 35.2113, allInCostBps: 25 } as never} />,
		);
		expect(html).toContain('WBTC bought at $9.57 above Market Price');
		expect(html).not.toContain('--color-red');
		expect(html).not.toContain('#fa0b54');
	});

	it('renders the Market Price descriptor as a footnote bound to the row on every tier', async () => {
		const { Receipt } = await import('./receiptView');
		// The stored methodology wins when present, rendered as a footnote (no `*` linkage).
		const stored = renderToStaticMarkup(
			<Receipt row={{ ...ethWbtc, methodology: 'Verified: The direct-pool price and WETH-derived price agree.' } as never} />,
		);
		expect(stored).toMatch(/<a[^>]*href="\/methodology"[^>]*>direct-pool price<\/a>/);
		expect(stored).toMatch(/<a[^>]*href="\/methodology"[^>]*>WETH-derived price<\/a>/);
		expect(stored).toContain('Verified: The ');
		expect(stored).toContain(' agree.');
		expect(stored).toContain('>Market Price<'); // asterisk is gone; position carries the link now

		// A NULL methodology falls back to the tier string, still as a footnote.
		const estimated = renderToStaticMarkup(<Receipt row={{ ...ethWbtc, methodology: null } as never} />);
		expect(estimated).toContain('Estimated:');

		// The null-mid (unpriced) tier now RENDERS the footnote too — it's the tier
		// `549-2857` shows the "Unavailable: …" string under `N/A`.
		const partial = renderToStaticMarkup(
			<Receipt row={{ ...ethWbtc, pricingStatus: 'partial', marketMid: null, methodology: null, allInCostBps: null } as never} />,
		);
		expect(partial).not.toContain('Market Price*');
		expect(partial).toContain('Unavailable: No reliable market price could be calculated.');

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

describe('Third-party fee sinks', () => {
	it('renders one fee line per sink: every unnamed sink truncated, all linked', async () => {
		const { Receipt } = await import('./receiptView');
		const row = {
			...fullUsdcWethRow,
			aggregator: 'Nordstern',
			aggFeeBps: 22,
			feeRecipient: '0x3dbe077e7986657e95e1cc50089f17a5a4af0aae',
			feeSinks: [
				{ address: '0x3dbe077e7986657e95e1cc50089f17a5a4af0aae', feeBps: 19.02, source: 'retained_balance', name: null },
				{ address: '0x5f6900000000000000000000000000000000d431', feeBps: 2.98, source: 'retained_balance', name: null },
			],
		};
		const html = renderToStaticMarkup(<Receipt row={row as never} />);
		// Dominant sink: truncated address, NOT "Nordstern Fee". Being biggest is
		// not evidence of whose wallet it is.
		expect(html).toContain('0x3dbe…0aae');
		expect(html).not.toContain('Nordstern Fee');
		expect(html).toContain('href="https://basescan.org/address/0x3dbe077e7986657e95e1cc50089f17a5a4af0aae"');
		// Second sink: truncated address as label + link (curation cue).
		expect(html).toContain('0x5f69…d431');
		expect(html).toContain('href="https://basescan.org/address/0x5f6900000000000000000000000000000000d431"');
	});
});

// Figma node 288-4340 (receipt-tooltips) is the source of truth for this copy.
// Pinned VERBATIM because the wording is load-bearing, not decorative: every
// enumeration lists third-party fees FIRST, matching the order the Cost
// Breakdown actually renders its rows. A find-and-replace of "aggregator" →
// "third-party" reproduces the old, contradictory ordering and must fail here.
describe('Cost Breakdown tooltip copy (Figma 288-4340)', () => {
	const row = {
		...fullUsdcWethRow,
		aggregator: 'Nordstern',
		aggFeeBps: 22,
		feeSinks: [
			{ address: '0x3dbe077e7986657e95e1cc50089f17a5a4af0aae', feeBps: 22, source: 'retained_balance', name: null },
		],
	};

	it.each([
		['Third-Party Fee', 'Value retained by third parties, not attributed to L.P. fees or price impact'],
		['Price Impact', 'Per-venue delta between execution price and the prior-block mid, excluding third-party fees and L.P. fees'],
		['Slippage', 'Residual cost after third-party fees, L.P. fees, and price impact'],
		['Positive Slippage', 'Residual benefit after third-party fees, L.P. fees, and price impact'],
		['Unattributed', 'Residual cost or benefit that could not be completely attributed to third-party fees, L.P. fees, or price impact'],
		['Total Execution Delta', 'Delta between execution price and market price; the sum of Third-Party Fee, L.P. Fee, Price Impact, and Slippage (or Unattributed)'],
	])('%s carries its Figma tooltip verbatim', async (_label, copy) => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={row as never} />);
		expect(html).toContain(copy);
	});

	it('names no aggregator anywhere in the Cost Breakdown copy', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={row as never} />);
		expect(html).not.toContain('aggregator fees');
		expect(html).not.toContain('Aggregator Fee');
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

	// An unread fee tier books as 0, and decomposeRoute derives price impact as
	// (legTotalCost − feeTier) × share (decomposeRoute.ts:374/632) while LP fee is
	// feeTier × the SAME share (:566). So a leg whose fee failed to resolve has
	// its missing fee sitting INSIDE its price impact, which then renders as a
	// bare confident number. Real case: receipt id 408, leg 0x238a3588… (the
	// PancakeSwap Infinity vault), price impact 2.88bps.
	// NB this does NOT move the Slippage/Unattributed residual — slippage is
	// overstated by exactly the same amount ΣPI is, so `slippage − ΣPI` is
	// invariant. The defect is confined to this one cell.
	it('reports no readable L.P. fee when every fee-bearing leg is unresolved', async () => {
		// Receipt id 78: both legs are pools whose fee tier we could not read, so
		// the rollup sums to a confident 0.0bps — asserting a $1,919 trade paid no
		// liquidity-provider fee. A missing fee must not sum to zero.
		const { hasNoReadableLpFee } = await import('./receipt/receiptDisplay');
		const unread = { type: 'unknown', venue: '0x0fcbb3f9aecc556de81ee756f01191d94a3d085e', lpFeeBps: 0, feeResolved: false };
		expect(hasNoReadableLpFee([unread, { ...unread, venue: '0xef05e733970c37b6a2f863de0db9378ea49447cc' }] as never)).toBe(true);
	});

	it('keeps the number when SOME leg contributed a real fee', async () => {
		// Receipt id 75: four small legs resolved, two large ones not. Understated,
		// but not a false zero — blanking it would discard real measurement.
		const { hasNoReadableLpFee } = await import('./receipt/receiptDisplay');
		const legs = [
			{ type: 'univ3', venue: '0xaaa', lpFeeBps: 0.05, feeResolved: undefined },
			{ type: 'unknown', venue: '0xbbb', lpFeeBps: 0, feeResolved: false },
		];
		expect(hasNoReadableLpFee(legs as never)).toBe(false);
	});

	it('still reports no L.P. fee for a maker-only route', async () => {
		// The pre-existing case this helper absorbs: an rfq leg carries lpFeeBps 0
		// by design, so a maker-only route also aggregates to a misleading 0.0.
		const { hasNoReadableLpFee } = await import('./receipt/receiptDisplay');
		expect(hasNoReadableLpFee([{ type: 'rfq', venue: '0xccc', lpFeeBps: 0 }] as never)).toBe(true);
	});

	it('is false for an ordinary fully-read route', async () => {
		const { hasNoReadableLpFee } = await import('./receipt/receiptDisplay');
		expect(hasNoReadableLpFee([{ type: 'univ3', venue: '0xaaa', lpFeeBps: 0.05 }] as never)).toBe(false);
	});

	it('ignores wrap/unwrap steps, which never carry a fee', async () => {
		// A wrap leg has lpFeeBps null. Counting it as a non-contributor would make
		// every wrapped route look unreadable.
		const { hasNoReadableLpFee } = await import('./receipt/receiptDisplay');
		const legs = [
			{ type: 'wrap', venue: '0xwwww', lpFeeBps: null },
			{ type: 'univ3', venue: '0xaaa', lpFeeBps: 0.05 },
		];
		expect(hasNoReadableLpFee(legs as never)).toBe(false);
	});

	it('names the PancakeSwap Infinity vault rather than calling it Unknown Pool', async () => {
		// The leg is type 'unknown' — we do not read Infinity's fee or mid yet —
		// but the address is known, and KNOWN_VENUE_LABELS is consulted before the
		// type dispatch. Naming it needs no VenueType, and so cannot disturb which
		// branch getLegMidAtBlock takes.
		const { getPriceImpactRows } = await import('./receipt/receiptDisplay');
		const rows = getPriceImpactRows(
			[leg({ venue: '0x238a358808379702088667322f80ac48bad5e6c4', type: 'unknown' })] as never,
			baseRow as never,
		);
		expect(rows[0]!.label).toBe('PancakeSwap Infinity');
	});

	it('still calls a genuinely unidentified pool Unknown Pool', async () => {
		const { getPriceImpactRows } = await import('./receipt/receiptDisplay');
		const rows = getPriceImpactRows(
			[leg({ venue: '0x0000000000000000000000000000000000000dead', type: 'unknown' })] as never,
			baseRow as never,
		);
		expect(rows[0]!.label).toBe('Unknown Pool');
	});

	it('links a synthesized V4 leg to its emitter, not to the poolId', async () => {
		// A per-pool V4 leg's venue is `v4:<poolId>` — not an address — so linking
		// to it yields a dead Basescan URL. The emitting singleton is persisted
		// alongside it for exactly this.
		const { getPriceImpactRows } = await import('./receipt/receiptDisplay');
		const POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b';
		const rows = getPriceImpactRows(
			[leg({ venue: 'v4:0xdeadbeef', v4Emitter: POOL_MANAGER })] as never,
			baseRow as never,
		);
		expect(rows[0]!.href).toBe(`https://basescan.org/address/${POOL_MANAGER}`);
		expect(rows[0]!.href).not.toContain('v4:');
	});

	it('links an ordinary leg to its own venue address', async () => {
		// The regression guard: every non-V4 leg's venue IS its address.
		const { getPriceImpactRows } = await import('./receipt/receiptDisplay');
		const rows = getPriceImpactRows([leg()] as never, baseRow as never);
		expect(rows[0]!.href).toBe('https://basescan.org/address/0x345825a980bd94e1480bc4f20fe4e3dae2f23dd3');
	});

	it('caveats a leg whose price impact absorbs an unresolved L.P. fee', async () => {
		const { getPriceImpactRows } = await import('./receipt/receiptDisplay');
		const rows = getPriceImpactRows([leg({ feeResolved: false })] as never, baseRow as never);
		expect(rows[0]!.value).toBe('3.00bps'); // the number still shows
		expect(rows[0]!.valueTooltip).toBe('Includes the unavailable L.P. fee for this leg');
	});

	it('leaves a resolved-fee leg uncaveated', async () => {
		const { getPriceImpactRows } = await import('./receipt/receiptDisplay');
		// Both the explicit-true and the absent (pre-2026-07-30 rows) cases.
		expect(getPriceImpactRows([leg({ feeResolved: true })] as never, baseRow as never)[0]!.valueTooltip)
			.toBeUndefined();
		expect(getPriceImpactRows([leg()] as never, baseRow as never)[0]!.valueTooltip).toBeUndefined();
	});

	it('keeps the null-price explanation when there is no impact to caveat', async () => {
		const { getPriceImpactRows, LEG_NULL_PRICE_TOOLTIP } = await import('./receipt/receiptDisplay');
		// Unresolved fee AND null impact: there is no number to be contaminated,
		// so the null explanation wins rather than promising a value that isn't there.
		const rows = getPriceImpactRows(
			[leg({ feeResolved: false, priceImpactBps: null })] as never,
			baseRow as never,
		);
		expect(rows[0]!.value).toBe('N/A');
		expect(rows[0]!.valueTooltip).toBe(LEG_NULL_PRICE_TOOLTIP);
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

	it('renders a primary rule immediately above the Transaction Costs heading', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={fullUsdcWethRow as never} />);
		const heading = html.indexOf('>Transaction Costs<');
		const rule = html.lastIndexOf('h-px w-full shrink-0 bg-[var(--color-primary)]', heading);
		expect(heading).toBeGreaterThan(-1);
		expect(rule).toBeGreaterThan(-1);
		// Nothing but whitespace/markup between the rule and the heading.
		expect(html.slice(rule, heading)).not.toContain('Gas Cost');
	});
});

describe('list item heights', () => {
	it('floors detail rows at 34px', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={fullUsdcWethRow as never} />);
		const aggregator = html.indexOf('>Provider<');
		expect(aggregator).toBeGreaterThan(-1);
		// Anchored on the row's OWN nearest DetailRow wrapper, not "any earlier
		// min-h-[34px] in the document" — a bare lastIndexOf-before-label check
		// only works because Provider happens to be the first detail row, and
		// goes vacuous the moment a floored row is inserted above it.
		// `md:grid-cols-[180px_1fr]` is DetailRow's own column spec at md+ and is
		// present on every DetailRow wrapper (stacked or not below md), so it is
		// a stable anchor independent of the below-`md` layout, which both this
		// test and the mobile pass keep changing.
		const gridBeforeAggregator = html.lastIndexOf('md:grid-cols-[180px_1fr]', aggregator);
		expect(html.slice(gridBeforeAggregator, aggregator)).toContain('min-h-[34px]');
	});

	it('floors the four standalone breakdown rows but not the group rows', async () => {
		const { Receipt } = await import('./receiptView');
		const row = { ...fullUsdcWethRow, pricingStatus: 'full', routeLegs: [
			{ venue: '0x1111111111111111111111111111111111111111', type: 'univ3',
				tokenIn: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
				tokenOut: '0x4200000000000000000000000000000000000006',
				feeTierBps: 5, notionalUsdc: 1000, lpFeeBps: 5, priceImpactBps: 1 },
		] };
		const html = renderToStaticMarkup(<Receipt row={row as never} />);
		// Total Execution Delta is standalone → floored. Anchored on ITS OWN nearest
		// grid wrapper rather than "any earlier min-h-[34px] in the document": the
		// detail table above is already full of floored DetailRows, so a bare
		// lastIndexOf-before-label check would pass vacuously no matter what this
		// row's own `standalone` flag is set to.
		const total = html.indexOf('>Total Execution Delta<');
		expect(total).toBeGreaterThan(-1);
		const gridBeforeTotal = html.lastIndexOf('grid grid-cols-', total);
		expect(html.slice(gridBeforeTotal, total)).toContain('min-h-[34px]');
		// The LP Fee heading is a group heading → NOT floored. Assert that the
		// nearest wrapper before it is not a floored one by checking the slice
		// between the heading and its own grid contains no floor class.
		const lpHeading = html.indexOf('>Liquidity Provider Fee<');
		expect(lpHeading).toBeGreaterThan(-1);
		const gridBefore = html.lastIndexOf('grid grid-cols-', lpHeading);
		expect(html.slice(gridBefore, lpHeading)).not.toContain('min-h-[34px]');
	});
});

describe('group section bottom padding (Figma 546-713)', () => {
	// The pb-[22px] wrapper's opening tag precedes its heading's own label text
	// (the wrapper is the heading's PARENT), so a plain lastIndexOf search for
	// the nearest preceding wrapper-shaped tag is ambiguous: an EARLIER
	// section's wrapper (already closed by the time we reach this label) sits
	// textually nearer than "no wrapper at all" would suggest, and gets picked
	// up as a false positive. A real ancestor check needs actual div-depth
	// tracking, not text proximity — so walk every <div>/</div> up to the
	// label with a stack and ask whether any div still OPEN at that point
	// carries pb-[22px].
	function hasPb22Ancestor(html: string, labelIndex: number): boolean {
		const tagRe = /<div\b([^>]*)>|<\/div>/g;
		const stack: string[] = [];
		let match: RegExpExecArray | null;
		while ((match = tagRe.exec(html)) && match.index < labelIndex) {
			if (match[0] === '</div>') {
				stack.pop();
			} else {
				const classMatch = /class="([^"]*)"/.exec(match[1] ?? '');
				stack.push(classMatch?.[1] ?? '');
			}
		}
		return stack.some((cls) => cls.includes('pb-[22px]'));
	}

	it('adds pb-[22px] to the Third-Party Fee section only when it has fee lines', async () => {
		const { Receipt } = await import('./receiptView');
		const withFee = {
			...fullUsdcWethRow,
			aggregator: 'Nordstern',
			aggFeeBps: 22,
			feeSinks: [
				{ address: '0x3dbe077e7986657e95e1cc50089f17a5a4af0aae', feeBps: 19.02, source: 'retained_balance', name: null },
			],
		};
		const htmlWithFee = renderToStaticMarkup(<Receipt row={withFee as never} />);
		const withFeeLabel = htmlWithFee.indexOf('>Third-Party Fee<');
		expect(withFeeLabel).toBeGreaterThan(-1);
		expect(hasPb22Ancestor(htmlWithFee, withFeeLabel)).toBe(true);

		const htmlStandalone = renderToStaticMarkup(<Receipt row={fullUsdcWethRow as never} />);
		const standaloneLabel = htmlStandalone.indexOf('>Third-Party Fee<');
		expect(standaloneLabel).toBeGreaterThan(-1);
		expect(hasPb22Ancestor(htmlStandalone, standaloneLabel)).toBe(false);
	});

	it('adds pb-[22px] to the Liquidity Provider Fee section when it falls back to "No Route Found"', async () => {
		const { Receipt } = await import('./receiptView');
		// routeLegs: [] (fullUsdcWethRow default) renders the "No Route Found"
		// fallback row — still a sub-item under the heading.
		const html = renderToStaticMarkup(<Receipt row={fullUsdcWethRow as never} />);
		const label = html.indexOf('>Liquidity Provider Fee<');
		expect(label).toBeGreaterThan(-1);
		expect(hasPb22Ancestor(html, label)).toBe(true);
	});

	it('adds pb-[22px] to the Liquidity Provider Fee section when it has real leg rows', async () => {
		const { Receipt } = await import('./receiptView');
		const row = {
			...fullUsdcWethRow,
			routeLegs: [
				{
					venue: '0x1111111111111111111111111111111111111111', type: 'univ3',
					tokenIn: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
					tokenOut: '0x4200000000000000000000000000000000000006',
					feeTierBps: 5, notionalUsdc: 1000, lpFeeBps: 5, priceImpactBps: 1,
				},
			],
		};
		const html = renderToStaticMarkup(<Receipt row={row as never} />);
		const label = html.indexOf('>Liquidity Provider Fee<');
		expect(label).toBeGreaterThan(-1);
		expect(hasPb22Ancestor(html, label)).toBe(true);
	});

	it('adds pb-[22px] to the "Pools Touched" fallback (LP Fee section, unpriced legs)', async () => {
		const { Receipt } = await import('./receiptView');
		const row = {
			...fullUsdcWethRow,
			routeLegs: [
				{
					venue: '0x1111111111111111111111111111111111111111', type: 'univ3',
					tokenIn: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
					tokenOut: '0x4200000000000000000000000000000000000006',
					feeTierBps: 5, notionalUsdc: 1000, lpFeeBps: null, priceImpactBps: null,
				},
			],
		};
		const html = renderToStaticMarkup(<Receipt row={row as never} />);
		const label = html.indexOf('>Pools Touched<');
		expect(label).toBeGreaterThan(-1);
		expect(hasPb22Ancestor(html, label)).toBe(true);
	});

	it('adds pb-[22px] to the priced Price Impact section but not the unpriced standalone pair', async () => {
		const { Receipt } = await import('./receiptView');
		// routeLegs: [] still renders a priced Price Impact section (the "No Route
		// Found" fallback row is a sub-item), since pricingStatus is 'full' here.
		const htmlPriced = renderToStaticMarkup(<Receipt row={fullUsdcWethRow as never} />);
		const pricedLabel = htmlPriced.indexOf('>Price Impact<');
		expect(pricedLabel).toBeGreaterThan(-1);
		expect(hasPb22Ancestor(htmlPriced, pricedLabel)).toBe(true);

		const htmlPartial = renderToStaticMarkup(
			<Receipt row={{ ...fullUsdcWethRow, pricingStatus: 'partial', marketMid: null, allInCostBps: null } as never} />,
		);
		const partialLabel = htmlPartial.indexOf('>Price Impact<');
		expect(partialLabel).toBeGreaterThan(-1);
		expect(hasPb22Ancestor(htmlPartial, partialLabel)).toBe(false);
	});
});

describe('Market Price composite', () => {
	const partialRow = { ...fullUsdcWethRow, pricingStatus: 'partial', marketMid: null, allInCostBps: null };

	it('places the methodology footnote between Market Price and Price Delta', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={fullUsdcWethRow as never} />);
		const market = html.indexOf('>Market Price<');
		const note = html.indexOf('Verified:');
		const delta = html.indexOf('>Price Delta<');
		expect(market).toBeGreaterThan(-1);
		expect(note).toBeGreaterThan(market);
		expect(delta).toBeGreaterThan(note);
	});

	it('drops the asterisk from the label and the footnote', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={fullUsdcWethRow as never} />);
		expect(html).toContain('>Market Price<');
		expect(html).not.toContain('Market Price*');
		expect(html).not.toContain('>*');
	});

	it('renders the footnote on the unpriced tier too', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={partialRow as never} />);
		expect(html).toContain('Unavailable: No reliable market price could be calculated.');
	});
});

describe('MethodologyText', () => {
	it('wraps each of the three methodology phrases in a new-tab /methodology link', async () => {
		const { MethodologyText } = await import('./receipt/receiptRows');
		const html = renderToStaticMarkup(
			<MethodologyText text="Estimated: The direct-pool price and WETH-derived price disagree, and the oracle reference does not confirm their median." />,
		);
		for (const phrase of ['direct-pool price', 'WETH-derived price', 'oracle reference']) {
			const re = new RegExp(`<a[^>]*href="/methodology"[^>]*>${phrase}</a>`);
			expect(html).toMatch(re);
		}
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noreferrer"');
		// Surrounding prose survives untouched, outside any anchor.
		expect(html).toContain('Estimated: The ');
		expect(html).toContain(' does not confirm their median.');
	});

	it('renders text with no matching phrase as plain text, with no anchors', async () => {
		const { MethodologyText } = await import('./receipt/receiptRows');
		const html = renderToStaticMarkup(
			<MethodologyText text="Unavailable: No reliable market price could be calculated." />,
		);
		expect(html).toBe('Unavailable: No reliable market price could be calculated.');
		expect(html).not.toContain('<a');
	});

	it('links every phrase in a three-way agreement sentence', async () => {
		const { MethodologyText } = await import('./receipt/receiptRows');
		const html = renderToStaticMarkup(
			<MethodologyText text="Verified: The direct-pool price, WETH-derived price, and oracle reference agree." />,
		);
		for (const phrase of ['direct-pool price', 'WETH-derived price', 'oracle reference']) {
			const re = new RegExp(`<a[^>]*href="/methodology"[^>]*>${phrase}</a>`);
			expect(html).toMatch(re);
		}
	});

	it('links the USDC/WETH fast-path liquidity phrase alongside oracle reference', async () => {
		// The exact sentence packages/core/src/pricing.ts:466 emits — previously
		// only "oracle reference" linked, leaving "three WETH/USDC pool prices"
		// inert next to it.
		const { MethodologyText } = await import('./receipt/receiptRows');
		const html = renderToStaticMarkup(
			<MethodologyText text="Verified: The median of three WETH/USDC pool prices agrees with the oracle reference." />,
		);
		for (const phrase of ['three WETH/USDC pool prices', 'oracle reference']) {
			const re = new RegExp(`<a[^>]*href="/methodology"[^>]*>${phrase}</a>`);
			expect(html).toMatch(re);
		}
	});
});

describe('formatExecutionDelta', () => {
	it('mirrors the Price Delta sentence with a Per {tokenIn} subvalue', async () => {
		const { formatExecutionDelta } = await import('./receipt/priceFormat');
		// Bought the base with a gain → the fill landed BELOW the mid.
		expect(formatExecutionDelta(4.57, 'WBTC', true, '1 ETH')).toEqual({
			text: 'WBTC bought at $4.57 below Market Price',
			sub: 'Per 1 ETH',
		});
		// Sold the base with a gain → the fill landed ABOVE the mid.
		expect(formatExecutionDelta(5, 'WETH', false, '1000 USDC')).toEqual({
			text: 'WETH sold at $5.00 above Market Price',
			sub: 'Per 1000 USDC',
		});
	});

	it('renders a loss on the opposite side of the mid', async () => {
		const { formatExecutionDelta } = await import('./receipt/priceFormat');
		expect(formatExecutionDelta(-4.57, 'WBTC', true, '1 ETH')).toEqual({
			text: 'WBTC bought at $4.57 above Market Price',
			sub: 'Per 1 ETH',
		});
	});

	it('renders an exact tie as None with no subvalue', async () => {
		const { formatExecutionDelta } = await import('./receipt/priceFormat');
		expect(formatExecutionDelta(0, 'WBTC', true, '1 ETH')).toEqual({ text: 'None', sub: null });
	});
});

describe('Execution Delta row', () => {
	// ETH→WBTC: base = WBTC (output, anchor rank 0 < ETH's 1) → the user BOUGHT the base.
	const ethWbtcRow = {
		...fullUsdcWethRow, aggregator: 'kyberswap', pricingStatus: 'estimated',
		inputSymbol: 'ETH', outputSymbol: 'WBTC',
		inputToken: 'native', outputToken: '0x0555e30da8f98308edb960aa94c0db47230d2b9c',
		inputAmount: 1, outputAmount: 0.02862539, notionalUsd: 1791.1353895147784,
		marketMid: 35.02321455049866, realizedPrice: 34.93402185961484,
		allInCostBps: -25.53, chainlinkPrice: null,
	};

	it('renders the sentence and the Per {tokenIn} subvalue, not Gained/Lost', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={ethWbtcRow as never} />);
		expect(html).toContain('>Execution Delta<');
		expect(html).toContain('Per 1 ETH');
		expect(html).not.toContain('Gained');
		expect(html).not.toContain('Lost');
	});

	it('leaves the sentence uncolored — green stays on the bps rows', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={ethWbtcRow as never} />);
		const delta = html.indexOf('>Execution Delta<');
		const total = html.indexOf('>Total Execution Delta<');
		// The green hex must not appear in the Execution Delta row's own markup.
		expect(html.slice(delta, html.indexOf('>Execution Price<'))).not.toContain('#117d45');
		// …but the bps row below still carries it.
		expect(total).toBeGreaterThan(-1);
		expect(html).toContain('+25.53bps');
	});
});

describe('SHARE bar', () => {
	it('renders the large uppercase bar with a rule above it on the standalone page', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={fullUsdcWethRow as never} />);
		expect(html).toContain('>SHARE<');
		expect(html).toContain('h-[69px]');
		const share = html.indexOf('>SHARE<');
		expect(html.lastIndexOf('h-px w-full shrink-0 bg-[var(--color-primary)]', share)).toBeGreaterThan(-1);
		// The above assertion alone is vacuous: the Cost Breakdown rule (Task 5)
		// already renders earlier in this same markup and shares this exact
		// className, so lastIndexOf finds THAT rule even if the new one directly
		// above the bar is missing. Anchor past it — require a SECOND occurrence
		// of the divider className, i.e. one strictly after the Cost Breakdown
		// rule, proving a distinct rule sits between it and the bar.
		const costBreakdownRule = html.indexOf('h-px w-full shrink-0 bg-[var(--color-primary)]');
		const ruleAboveBar = html.lastIndexOf('h-px w-full shrink-0 bg-[var(--color-primary)]', share);
		expect(ruleAboveBar).toBeGreaterThan(costBreakdownRule);
	});
});

describe('Receipt Unattributed row', () => {
	const pricedLeg = {
		venue: '0x1111111111111111111111111111111111111111',
		type: 'swap',
		tokenIn: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
		tokenOut: '0x4200000000000000000000000000000000000006',
		feeTierBps: 5, notionalUsdc: 1000, lpFeeBps: 1, priceImpactBps: 2,
	};
	const unpricedLeg = { ...pricedLeg, notionalUsdc: 500, priceImpactBps: null };

	const fullyPricedRow = { ...fullUsdcWethRow, routeLegs: [pricedLeg] };
	const partialRow = { ...fullUsdcWethRow, routeLegs: [pricedLeg, unpricedLeg] };

	it('hides the Unattributed row entirely when every leg is priced', async () => {
		const { ReceiptView } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={fullyPricedRow as never} hash={fullyPricedRow.txHash} />,
		);
		// Anchor on the cell, not the bare word: 'Slippage' is a substring of
		// 'Positive Slippage', and a bare toContain would pass vacuously.
		expect(html).not.toContain('>Unattributed<');
		expect(html).toContain('>Slippage<');
		expect(html).toContain('>Positive Slippage<');
	});

	it('shows Unattributed and N/A Slippage when a leg went unpriced', async () => {
		const { ReceiptView } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={partialRow as never} hash={partialRow.txHash} />,
		);
		expect(html).toContain('>Unattributed<');
		expect(html).toContain('>Slippage<');
		expect(html).toContain('>Positive Slippage<');
	});

	it('names the coverage percentage in the N/A tooltip', async () => {
		const { ReceiptView } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={partialRow as never} hash={partialRow.txHash} />,
		);
		// 1000 of 1500 notional priced = 66.66% → floors to 66.
		expect(html).toContain('No calculation available, per-leg pricing coverage is 66% complete');
	});

	it('explains Unattributed on its label', async () => {
		const { ReceiptView } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={partialRow as never} hash={partialRow.txHash} />,
		);
		expect(html).toContain(
			'Residual cost or benefit that could not be completely attributed to third-party fees, L.P. fees, or price impact',
		);
	});

	it('counts exactly two N/A cells in the slippage group, not one and not three', async () => {
		const { ReceiptView } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={partialRow as never} hash={partialRow.txHash} />,
		);
		// A counted differential: 'N/A' is NOT unique on this page (unpriced leg
		// rows carry it too), so assert against the same render without the
		// unpriced leg rather than against an absolute count.
		const baseline = renderToStaticMarkup(
			<ReceiptView trade={fullyPricedRow as never} hash={fullyPricedRow.txHash} />,
		);
		const count = (s: string) => s.split('N/A').length - 1;
		// partial adds: 1 unpriced leg row + Slippage + Positive Slippage = 3.
		expect(count(html) - count(baseline)).toBe(3);
	});

	it('blames market-maker inventory, not our coverage, on an RFQ-only gap', async () => {
		// id 36's shape: a single market-maker fill. There is no on-chain mid to
		// measure it against, so "pricing coverage is 0% complete" would report a
		// property of RFQ as a failure of ours.
		const { ReceiptView } = await import('./receiptView');
		const makerRow = {
			...fullUsdcWethRow,
			routeLegs: [{ ...pricedLeg, type: 'rfq', priceImpactBps: null }],
		};
		const html = renderToStaticMarkup(
			<ReceiptView trade={makerRow as never} hash={makerRow.txHash} />,
		);
		expect(html).toContain('No calculation available due to market maker inventory.');
		expect(html).not.toContain('pricing coverage is');
	});

	it('a MIXED pool+maker route reports coverage, not maker inventory', async () => {
		// id 210's shape. The maker leg is the only unpriced one, but five of six
		// legs were priced through pools — claiming "market maker inventory" would
		// describe 23% of the trade as though it were all of it.
		const { ReceiptView } = await import('./receiptView');
		const mixedRow = {
			...fullUsdcWethRow,
			routeLegs: [pricedLeg, { ...pricedLeg, type: 'rfq', priceImpactBps: null }],
		};
		const html = renderToStaticMarkup(
			<ReceiptView trade={mixedRow as never} hash={mixedRow.txHash} />,
		);
		expect(html).toContain('per-leg pricing coverage is');
		expect(html).not.toContain('market maker inventory');
	});

	it('still reports coverage when the unpriced leg is a pool, not a maker', async () => {
		const { ReceiptView } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={partialRow as never} hash={partialRow.txHash} />,
		);
		expect(html).toContain('pricing coverage is 66% complete');
		expect(html).not.toContain('market maker inventory');
	});

	it('omits the row when the route is unpriced AND there is no residual at all', async () => {
		// Reachable today — receipt id 219 is pricingStatus 'full' with a NULL
		// slippage_bps. Without the residualRawBps guard the row renders a bare
		// '–' under a tooltip promising a "residual cost or benefit", i.e. it
		// announces a quantity that does not exist. The Slippage / Positive
		// Slippage rows above already say N/A; a third empty row adds nothing.
		const { ReceiptView } = await import('./receiptView');
		const noResidualRow = { ...partialRow, slippageBps: null };
		const html = renderToStaticMarkup(
			<ReceiptView trade={noResidualRow as never} hash={noResidualRow.txHash} />,
		);
		expect(html).not.toContain('>Unattributed<');
		// ...and the coverage gate is still what suppressed the Slippage number,
		// so this is the no-residual case and not some unrelated early return.
		expect(html).toContain('>Slippage<');
		expect(html).toContain('>Positive Slippage<');
	});
});

describe('MarketPriceTable (Figma 647-3599)', () => {
	it('renders all three block rows with At Block emphasized', async () => {
		const { MarketPriceTable } = await import('./receipt/receiptRows');
		const html = renderToStaticMarkup(
			<MarketPriceTable
				before="35.0269 ETH = 1 WBTC"
				at="35.0232 ETH = 1 WBTC"
				after="35.0173 ETH = 1 WBTC"
			/>,
		);

		expect(html).toContain('>Before Block<');
		expect(html).toContain('>At Block<');
		expect(html).toContain('>After Block<');
		expect(html).toContain('>Market Price<');

		// At Block is the ruler — the only row in primary, its neighbours secondary.
		// Extract each row's markup to verify its specific color.
		const before = html.indexOf('>Before Block<');
		const at = html.indexOf('>At Block<');
		const after = html.indexOf('>After Block<');
		expect(before).toBeLessThan(at);
		expect(at).toBeLessThan(after);

		// Extract "Before Block" row: find the div that wraps it
		const beforeRowStart = html.lastIndexOf('<div', before);
		const beforeRowEnd = html.indexOf('</div>', before) + '</div>'.length;
		const beforeRowHtml = html.slice(beforeRowStart, beforeRowEnd);
		expect(beforeRowHtml).toContain('--color-secondary');
		expect(beforeRowHtml).not.toContain('--color-primary');

		// Extract "At Block" row: find the div that wraps it
		const atRowStart = html.lastIndexOf('<div', at);
		const atRowEnd = html.indexOf('</div>', at) + '</div>'.length;
		const atRowHtml = html.slice(atRowStart, atRowEnd);
		expect(atRowHtml).toContain('--color-primary');
		expect(atRowHtml).not.toContain('--color-secondary');

		// Extract "After Block" row: find the div that wraps it
		const afterRowStart = html.lastIndexOf('<div', after);
		const afterRowEnd = html.indexOf('</div>', after) + '</div>'.length;
		const afterRowHtml = html.slice(afterRowStart, afterRowEnd);
		expect(afterRowHtml).toContain('--color-secondary');
		expect(afterRowHtml).not.toContain('--color-primary');
	});

	it('renders whatever the caller passes for an unreadable block', async () => {
		// The dash is the caller's decision (formatMidCell in Task 8); this
		// component must not substitute anything of its own for a falsy value.
		const { MarketPriceTable } = await import('./receipt/receiptRows');
		const html = renderToStaticMarkup(
			<MarketPriceTable before="–" at="35.0232 ETH = 1 WBTC" after="–" />,
		);
		expect(html).toContain('–');
		expect(html).not.toContain('0.0000');
	});

	it('never wraps a value, however long the pair makes it', async () => {
		// Figma 647-3599 sized the value column to its own example string —
		// "35.0269 ETH = 1 WBTC" is exactly 20 chars ≈ 144px — so a hard
		// w-[144px] wraps every longer real value onto a second line. Observed
		// in the browser on receipt 397, whose cbBTC/USDC value needs ~180px.
		// jsdom does no layout, so this asserts the mechanism rather than the
		// pixels: nowrap present, and the width a floor rather than a cap.
		const { MarketPriceTable } = await import('./receipt/receiptRows');
		const html = renderToStaticMarkup(
			<MarketPriceTable
				before="63598.6719 USDC = 1 cbBTC"
				at="63552.5227 USDC = 1 cbBTC"
				after="63595.2759 USDC = 1 cbBTC"
			/>,
		);
		expect(html).toContain('whitespace-nowrap');
		expect(html).toContain('min-w-[144px]');
		// A fixed width on the value cell is the defect itself.
		expect(html).not.toContain('"w-[144px]');
	});
});

describe('Price Range section (Figma 647-3415)', () => {
	// fullUsdcWethRow plus a three-block mid triple (same values used in
	// priceDispersion.test.ts's 1.13bps case).
	const tripleMidRow = {
		...fullUsdcWethRow,
		marketMidBefore: 35.0269,
		marketMid: 35.0232,
		marketMidAfter: 35.0173,
	};
	// The file's other partial/unpriced fixtures are scoped inside their own
	// describe blocks (e.g. 'Market Price composite'); built the same way here
	// per Task 8's brief — fullUsdcWethRow with the tier fields nulled out the
	// way core persists an unpriced receipt.
	const unpricedRow = {
		...fullUsdcWethRow,
		marketMid: null,
		pricingStatus: 'partial',
		allInCostBps: null,
	};

	it('renders a Price Range heading between Gas Cost and Transaction Costs', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={tripleMidRow as never} />);
		const gas = html.indexOf('>Gas Cost<');
		const priceRange = html.indexOf('>Price Range<');
		const txCost = html.indexOf('>Transaction Costs<');
		expect(gas).toBeGreaterThan(-1);
		expect(priceRange).toBeGreaterThan(gas);
		expect(txCost).toBeGreaterThan(priceRange);
	});

	it('moves Gas Cost above Execution Price', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={tripleMidRow as never} />);
		// Gas is not a price and must not sit inside Price Range.
		expect(html.indexOf('>Gas Cost<')).toBeLessThan(html.indexOf('>Execution Price<'));
	});

	it('appends the dispersion clause to the methodology descriptor', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={tripleMidRow as never} />);
		expect(html).toContain('Price moved -1.68bps from At Block to After Block.');
	});

	it('renders the manipulation badge as a full-width sibling, not inside the At Block cell', async () => {
		// The badge used to be appended into the At Block value cell — a fixed
		// 144px column (Figma 647-3599) already full of the price string, so the
		// warning had nowhere to go and was invisible in the browser (caught by
		// the project owner, not by any diff). It now renders as its own line,
		// a sibling of <MarketPriceTable> inside the shared flex-col wrapper.
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<Receipt row={{ ...tripleMidRow, manipulationFlag: true } as never} />,
		);
		expect(html).toContain('Possible manipulation');

		// Must NOT be inside the At Block row's own <div> — that fixed-width
		// cell is exactly where it went missing.
		const at = html.indexOf('>At Block<');
		expect(at).toBeGreaterThan(-1);
		const atRowStart = html.lastIndexOf('<div', at);
		const atRowEnd = html.indexOf('</div>', at) + '</div>'.length;
		const atRowHtml = html.slice(atRowStart, atRowEnd);
		expect(atRowHtml).not.toContain('Possible manipulation');

		// It renders after the table and before the methodology footnote —
		// still visually attached to the Market Price row, just outside the cell.
		const badge = html.indexOf('Possible manipulation');
		const methodology = html.indexOf('Verified: market price corroborated across sources.');
		expect(badge).toBeGreaterThan(atRowEnd);
		expect(badge).toBeLessThan(methodology);
	});

	it('renders no manipulation badge when the flag is unset', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={tripleMidRow as never} />);
		expect(html).not.toContain('Possible manipulation');
	});

	it('omits the dispersion clause when a block is missing', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<Receipt row={{ ...tripleMidRow, marketMidAfter: null } as never} />,
		);
		expect(html).not.toContain('Price moved');
	});

	it('renders no USD subvalue on any Price Range row', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={tripleMidRow as never} />);
		const priceRange = html.indexOf('>Price Range<');
		const txCost = html.indexOf('>Transaction Costs<');
		// Guard against a vacuous pass: if either heading vanished, indexOf
		// returns -1 and slice(-1, -1) would yield '', matching not.toMatch trivially.
		expect(priceRange).toBeGreaterThan(-1);
		expect(txCost).toBeGreaterThan(-1);
		const section = html.slice(priceRange, txCost);
		// Price Range is deliberately notional-free across all tiers. The top
		// block keeps its USD; this section must not.
		expect(section).not.toMatch(/\$[0-9]/);
	});

	it('renders N/A for Market Price and Price Delta on the unpriced tier', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={unpricedRow as never} />);
		expect(html).toContain('>Price Range<');
		expect(html).toContain('Unavailable: No reliable market price could be calculated.');
		expect(html).not.toContain('>Before Block<');
	});
});
