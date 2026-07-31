import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// TradesTable calls useRouter() for the delete → refresh flow; the app-router
// context isn't mounted under renderToStaticMarkup, so stub it.
vi.mock('next/navigation', () => ({
	useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

globalThis.React = React;

// Minimal ReceiptRow-shaped sample for table-level tests. Full USDC/WETH row.
const sampleReceiptRow = {
	id: 42,
	txHash: '0x1234567890abcdef1234567890abcdef12345678',
	chainId: 8453,
	blockNumber: 123,
	aggregator: 'kyberswap',
	direction: 'buy_weth',
	inputSymbol: 'USDC',
	outputSymbol: 'WETH',
	inputAmount: '1000.00',
	outputAmount: '0.33',
	notionalUsd: '1000.00',
	realizedPrice: '3000',
	marketMid: '3000',
	allInCostBps: '-1',
	pricingStatus: 'full',
	lpFeeBps: '1',
	aggFeeBps: '0',
	slippageBps: '-2',
	gasCostUsd: '0.001',
	routeLegs: [],
	manipulationFlag: false,
};

describe('TradesTable', () => {
	it('renders no per-row delete control (delete lives in the receipt dialog)', async () => {
		const { TradesTable } = await import('./tradesTable');
		const onDelete = vi.fn();
		const rows = [
			sampleReceiptRow as never,
			{ ...sampleReceiptRow, id: 43, txHash: '0xabcdef1234567890abcdef1234567890abcdef12' } as never,
		];
		const html = renderToStaticMarkup(
			<TradesTable
				initialSort={{ column: 'block', direction: 'desc' }}
				rows={rows}
				onDelete={onDelete}
			/>,
		);
		expect(html).not.toContain('aria-label="Delete receipt');
	});

	it('does not render route hop badges', async () => {
		const { TradesTable } = await import('./tradesTable');
		const html = renderToStaticMarkup(
			<TradesTable
				initialSort={{ column: 'block', direction: 'desc' }}
				rows={[
					{
						id: 99,
						txHash: '0x1234567890abcdef1234567890abcdef12345678',
						blockNumber: 123,
						aggregator: 'kyberswap',
						direction: 'buy_weth',
						inputSymbol: 'USDC',
						outputSymbol: 'WETH',
						inputAmount: '1.00',
						outputAmount: '0.0003',
						notionalUsd: '1.00',
						pricingStatus: 'full',
						allInCostBps: '-1',
						lpFeeBps: '1',
						aggFeeBps: '0',
						slippageBps: '-2',
						gasCostUsd: '0.001',
						hopCount: 2,
						routeShape: 'linear',
						decompConfidence: 'high',
						routeLegs: [
							{
								venue: '0xvenue',
								type: 'univ4',
								tokenIn: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
								tokenOut: '0x4200000000000000000000000000000000000006',
								feeTierBps: 5,
								notionalUsdc: 1,
								lpFeeBps: 5,
								priceImpactBps: 0,
							},
						],
					} as never,
				]}
			/>,
		);

		expect(html).not.toContain('2-hop');
		expect(html).not.toContain('TXN');
		expect(html).not.toContain('Side');
		expect(html).not.toContain('Buy WETH');
		expect(html).toContain('hover:bg-[var(--color-surface-low)]');
	});

	it('splits execution into price impact and market-forces slippage', async () => {
		const { getExecutionBreakdown } = await import('./tradesTable');
		const result = getExecutionBreakdown({
			slippageBps: '10.785184150012705',
			routeLegs: [
				{
					venue: '0xvenue',
					type: 'rfq',
					tokenIn: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
					tokenOut: '0x4200000000000000000000000000000000000006',
					feeTierBps: 0,
					notionalUsdc: 1,
					lpFeeBps: 0,
					priceImpactBps: 10.963985804579822,
				},
			],
		} as never);

		expect(result.executionDisplay.text).toBe('10.79bps');
		expect(result.priceImpactDisplay.text).toBe('10.96bps');
		expect(result.marketForcesDisplay.text).toBe('+0.18bps');
	});

	it('formats price impact as per-pool rows', async () => {
		const { getPriceImpactRows } = await import('./tradesTable');
		const rows = getPriceImpactRows([
			{
				venue: '0x482fe995c4a52bc79271ab29a53591363ee30a89',
				type: 'sushiv3',
				tokenIn: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
				tokenOut: '0x4200000000000000000000000000000000000006',
				priceImpactBps: 0.4785596659121545,
			},
			{
				venue: '0x4545410f7601b34a779edcebc641e529f465eeaa',
				type: 'curve_stableng',
				tokenIn: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
				tokenOut: '0x4200000000000000000000000000000000000006',
				priceImpactBps: null,
			},
		] as never);

		expect(rows).toEqual([
			{
				label: 'SushiSwap v3',
				href: 'https://basescan.org/address/0x482fe995c4a52bc79271ab29a53591363ee30a89',
				context: 'USDC/WETH',
				value: '0.48bps',
				color: undefined,
			},
			{
				label: 'Curve StableNG',
				href: 'https://basescan.org/address/0x4545410f7601b34a779edcebc641e529f465eeaa',
				context: 'USDC/WETH',
				value: 'N/A',
				color: undefined,
				valueTooltip: 'No price available for this leg',
			},
		]);
	});

	it('resolves endpoint + native-ETH leg symbols from the receipt when a row is passed', async () => {
		const { getPriceImpactRows } = await import('./tradesTable');
		// Real WARP->ETH route: WARP is absent from the static TOKEN_SYMBOLS map,
		// and the terminal Uniswap v4 leg pays native ETH directly (tokenOut is
		// the WETH stand-in, outputToken is 'native', no unwrap step).
		const rows = getPriceImpactRows(
			[
				{ venue: '0x53932cbd6cddbb907ce1bb108496c7bd8aaa5dce', type: 'univ3', tokenIn: '0xd9159ad2d5fe625cd1f54f4d328fb19cb5262b07', tokenOut: '0x4200000000000000000000000000000000000006', priceImpactBps: null },
				{ venue: '0x72ab388e2e2f6facef59e3c3fa2c4e29011c2d38', type: 'pancakev3', tokenIn: '0x4200000000000000000000000000000000000006', tokenOut: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', priceImpactBps: null },
				{ venue: '0x498581ff718922c3f8e6a244956af099b2652b2b', type: 'univ4', tokenIn: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', tokenOut: '0x4200000000000000000000000000000000000006', priceImpactBps: null },
			] as never,
			{ inputToken: '0xd9159ad2d5fe625cd1f54f4d328fb19cb5262b07', outputToken: 'native', inputSymbol: 'WARP', outputSymbol: 'ETH' } as never,
		);

		expect(rows.map((r) => r.context)).toEqual(['WARP/WETH', 'WETH/USDC', 'USDC/ETH']);
	});

	it('uses core-stored leg symbols for an intermediate hop token (USDT), not a hash', async () => {
		const { getPriceImpactRows } = await import('./tradesTable');
		// USDT is neither an endpoint nor in the static TOKEN_SYMBOLS map — without
		// the stored per-leg symbol it would render as a shortened address.
		const USDT = '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2';
		const rows = getPriceImpactRows(
			[
				{ venue: '0xp1', type: 'univ3', tokenIn: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', tokenOut: USDT, tokenInSymbol: 'USDC', tokenOutSymbol: 'USDT', priceImpactBps: null },
				{ venue: '0xp2', type: 'pancakev3', tokenIn: USDT, tokenOut: '0x4200000000000000000000000000000000000006', tokenInSymbol: 'USDT', tokenOutSymbol: 'WETH', priceImpactBps: null },
			] as never,
			{ inputToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', outputToken: '0x4200000000000000000000000000000000000006', inputSymbol: 'USDC', outputSymbol: 'WETH' } as never,
		);
		expect(rows.map((r) => r.context)).toEqual(['USDC/USDT', 'USDT/WETH']);
	});

	it('formats Coinbase Wrapped Staked ETH with its token symbol', async () => {
		const { getPriceImpactRows } = await import('./tradesTable');

		const rows = getPriceImpactRows([
			{
				venue: '0x77e44581399f96129a8a0041dbb4e1a7569b9969',
				type: 'curve_stableng',
				tokenIn: '0x2Ae3F1Ec7F1f5012CFEab0185bfc7aa3cf0DEC22',
				tokenOut: '0x4200000000000000000000000000000000000006',
				priceImpactBps: 1,
			},
		] as never);

		expect(rows[0]?.context).toBe('cbETH/WETH');
	});

	it('renders stringified route legs with Coinbase token symbols in the dialog', async () => {
		const { TransactionDetailsDialog } = await import('./tradesTable');
		const row = {
			id: 1, chainId: 8453, pricingStatus: 'full',
			txHash: '0x6442772f65f0575be26037beac9c7a168d2543cadc16c4ccdbf80182f7d03f8e',
			blockNumber: 123, aggregator: 'kyberswap', direction: 'buy_weth',
			inputSymbol: 'USDC', outputSymbol: 'WETH', inputAmount: '1.646224', outputAmount: '0.0005',
			notionalUsd: '1.646224', realizedPrice: '3000',
			marketMid: '3000', allInCostBps: '-1',
			lpFeeBps: '1', aggFeeBps: '0', slippageBps: '-2', executionBps: '-1', gasCostUsd: '0.001',
			hopCount: 3, routeShape: 'linear', decompConfidence: 'medium',
			routeLegs: JSON.stringify([
				{
					venue: '0xa9ab48b7e1577eef7ff6babc0870bd0f00131f76',
					type: 'rfq',
					tokenIn: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
					tokenOut: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf',
					feeTierBps: 0,
					notionalUsdc: 1.646224,
					lpFeeBps: 0,
					priceImpactBps: 1,
				},
				{
					venue: '0x498581ff718922c3f8e6a244956af099b2652b2b',
					type: 'univ4',
					tokenIn: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf',
					tokenOut: '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22',
					feeTierBps: 0.5,
					notionalUsdc: 1.646224,
					lpFeeBps: 0.5,
					priceImpactBps: 5,
				},
				{
					venue: '0xb1383dc47d9971fc999c3a9088f79e744b376e97',
					type: 'rfq',
					tokenIn: '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22',
					tokenOut: '0x4200000000000000000000000000000000000006',
					feeTierBps: 0,
					notionalUsdc: 1.646224,
					lpFeeBps: 0,
					priceImpactBps: 0,
				},
			]),
			routePure: true,
			reconResidualBps: null, settledIn: 'WETH',
			manipulationFlag: false,
		};

		const html = renderToStaticMarkup(
			<TransactionDetailsDialog row={row as never} onClose={() => {}} onDelete={async () => true} />,
		);

		// The Route summary row was removed from the receipt; leg token symbols are
		// still exercised via the Cost Breakdown per-venue pair labels below.
		expect(html).toContain('cbBTC/cbETH');
		expect(html).toContain('cbETH/WETH');
	});

	it('formats tagged pool venues for the transaction dialog', async () => {
		const { getVenueLabel } = await import('./tradesTable');

		expect(getVenueLabel({ type: 'sushiv3' } as never)).toBe('SushiSwap v3');
		expect(getVenueLabel({ type: 'baseswapv3' } as never)).toBe('BaseSwap v3');
		expect(getVenueLabel({ type: 'aerodrome_cl' } as never)).toBe('Aerodrome SlipStream');
		expect(getVenueLabel({ type: 'curve_stableng' } as never)).toBe('Curve StableNG');
		expect(getVenueLabel({
			venue: '0x77E44581399F96129a8a0041dBb4E1a7569B9969',
			type: 'rfq',
		} as never)).toBe('Curve StableNG');
	});

	// These venues are labelled from their type, so any pool of the same protocol
	// resolves — not just the specific addresses pinned in KNOWN_VENUE_LABELS.
	it('labels newly tagged venue types by protocol, for any pool address', async () => {
		const { getVenueLabel } = await import('./tradesTable');

		expect(getVenueLabel({ venue: '0xnotpinned', type: 'maverickv1' } as never)).toBe('Maverick v1');
		expect(getVenueLabel({ venue: '0xnotpinned', type: 'hydrex' } as never)).toBe('Hydrex');
		expect(getVenueLabel({ venue: '0xnotpinned', type: 'quickswapv4' } as never)).toBe('QuickSwap v4');
		expect(getVenueLabel({ venue: '0xnotpinned', type: 'unipool' } as never)).toBe('UniPool');
	});

	it('labels rfq legs Market Maker and unknown legs Unknown Pool', async () => {
		const { getVenueLabel } = await import('./tradesTable');

		expect(getVenueLabel({ type: 'rfq', venue: '0x69a9f156d5902191dce331ab348f3e9e96e48b22' } as never)).toBe('Market Maker');
		expect(getVenueLabel({ type: 'unknown', venue: '0x51c72848c68a965f66fa7a88855f9f7784502a7f' } as never)).toBe('Unknown Pool');
	});

	it('uses generic null impact copy for manually tagged Curve pools even if persisted as RFQ', async () => {
		const { getPriceImpactRows } = await import('./tradesTable');

		const rows = getPriceImpactRows([
			{
				venue: '0x77E44581399F96129a8a0041dBb4E1a7569B9969',
				type: 'rfq',
				tokenIn: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
				tokenOut: '0x4200000000000000000000000000000000000006',
				priceImpactBps: null,
			},
		] as never);

		expect(rows[0]).toMatchObject({
			label: 'Curve StableNG',
			valueTooltip: 'No price available for this leg',
		});
	});

	it('labels unknown-type pools as "Unknown Pool" regardless of address', async () => {
		const { getPriceImpactRows, getVenueLabel } = await import('./tradesTable');

		expect(getVenueLabel({
			venue: '0xbee3211ab312a8d065c4fef0247448e17a8da000',
			type: 'unknown',
		} as never)).toBe('Unknown Pool');

		expect(getPriceImpactRows([
			{
				venue: '0xbee3211ab312a8d065c4fef0247448e17a8da000',
				type: 'unknown',
				tokenIn: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
				tokenOut: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b',
				priceImpactBps: null,
			},
		] as never)[0]).toMatchObject({
			label: 'Unknown Pool',
			context: 'USDC/VIRTUAL',
			value: 'N/A',
			valueTooltip: 'No price available for this leg',
		});
	});

	it('labels known Hydrex and UniPool addresses despite an "unknown" decomposition type', async () => {
		const { getVenueLabel } = await import('./tradesTable');

		expect(getVenueLabel({
			venue: '0xa9ab48b7e1577eef7ff6babc0870bd0f00131f76',
			type: 'unknown',
		} as never)).toBe('UniPool');
		expect(getVenueLabel({
			venue: '0xb1383dc47d9971fc999c3a9088f79e744b376e97',
			type: 'unknown',
		} as never)).toBe('Hydrex');
	});

	it('labels smoke-03 unknown pool and token pair symbols', async () => {
		const { getPriceImpactRows, getVenueLabel } = await import('./tradesTable');

		expect(getVenueLabel({
			venue: '0xdcc8a6ba71a6c0053cbb32f935e9b4b64d465ea3',
			type: 'unknown',
		} as never)).toBe('Unknown Pool');

		expect(getPriceImpactRows([
			{
				venue: '0xdcc8a6ba71a6c0053cbb32f935e9b4b64d465ea3',
				type: 'unknown',
				tokenIn: '0x50c5725949a6f0c72e6c4a641f24049a917db0cb',
				tokenOut: '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca',
				priceImpactBps: -0.6653663005707009,
			},
		] as never)[0]).toMatchObject({
			label: 'Unknown Pool',
			context: 'DAI/USDbC',
			value: '+0.67bps',
		});
	});

	it('renders tooltip text on all History column headers', async () => {
		const { TradesTable } = await import('./tradesTable');
		const html = renderToStaticMarkup(
			<TradesTable
				initialSort={{ column: 'block', direction: 'desc' }}
				rows={[]}
			/>,
		);

		expect(html).toContain('Delta between execution price and market price; the sum of L.P. Fee, Agg. Fee, P. Impact, and Slippage (or Unattributed)');
		expect(html).toContain('Fees paid to liquidity providers');
		expect(html).toContain('Fees paid to aggregators');
		expect(html).toContain('Per-venue delta between execution price and the prior-block mid, excluding L.P. Fee');
		expect(html).toContain('Residual cost after L.P. Fee, Agg. Fee, and P. Impact');
		expect(html).toContain('role="tooltip"');
	});

	it('wires aria-describedby between tooltip headers and their tooltip elements', async () => {
		const { TradesTable } = await import('./tradesTable');
		const html = renderToStaticMarkup(
			<TradesTable
				initialSort={{ column: 'block', direction: 'desc' }}
				rows={[]}
			/>,
		);

		expect(html).toContain('aria-describedby="tooltip-accuracy"');
		expect(html).toContain('aria-describedby="tooltip-lp-fee"');
		expect(html).toContain('aria-describedby="tooltip-agg-fee"');
		expect(html).toContain('aria-describedby="tooltip-impact"');
		expect(html).toContain('aria-describedby="tooltip-slippage"');
		expect(html).toContain('id="tooltip-accuracy"');
		expect(html).toContain('id="tooltip-lp-fee"');
		expect(html).toContain('id="tooltip-agg-fee"');
		expect(html).toContain('id="tooltip-impact"');
		expect(html).toContain('id="tooltip-slippage"');
	});

	it('per-sink fee lines: dominant named/generic, subsequent truncated, all linked', async () => {
		// Replaces the old curated-vault getAggregatorFeeAttribution tests. Fee
		// attribution now flows off the persisted feeSinks[] + Basescan names;
		// full coverage lives in receipt/receiptDisplay.test.ts.
		const { getAggregatorFeeLines } = await import('./tradesTable');

		// Fabric-router fee → neutral "Integrator Fee", linked to the recipient.
		const fabric = getAggregatorFeeLines({
			aggregator: 'Fabric',
			aggFeeBps: 11.58,
			feeSinks: [{ address: '0x403560800cb7e03a06ebbc991dba0f6ac751a1c5', feeBps: 11.58, source: 'retained_balance', name: null }],
		} as never);
		expect(fabric[0]!.label).toBe('Integrator Fee');
		expect(fabric[0]!.href).toBe('https://basescan.org/address/0x403560800cb7e03a06ebbc991dba0f6ac751a1c5');

		// Non-Fabric unnamed sink → generic "<Provider> Fee".
		const odos = getAggregatorFeeLines({
			aggregator: 'odos',
			aggFeeBps: 80,
			feeSinks: [{ address: '0x1111111111111111111111111111111111111111', feeBps: 80, source: 'retained_balance', name: null }],
		} as never);
		expect(odos[0]!.label).toBe('Odos Fee');

		// Zero fee → no lines.
		expect(getAggregatorFeeLines({ aggregator: 'fabric', aggFeeBps: 0 } as never)).toEqual([]);
	});

	it('formats dialog bps values with two decimal places', async () => {
		const { formatDialogBps } = await import('./tradesTable');

		expect(formatDialogBps(-1).text).toBe('1.00bps');
		expect(formatDialogBps(0).text).toBe('0.00bps');
	});

	it('uses granular normalize flags instead of repeating confidence', async () => {
		const { getFlagLabel } = await import('./tradesTable');

		expect(getFlagLabel({ normalizeFlags: ['PI_IMPLAUSIBLE: leg mid stale', 'SETTLEMENT_EVENT_MISSING: no distinctive event'] })).toBe(
			'PI_IMPLAUSIBLE: leg mid stale; SETTLEMENT_EVENT_MISSING: no distinctive event',
		);
		expect(getFlagLabel({ decompConfidence: 'medium', normalizeFlags: [] })).toBe('None');
		expect(getFlagLabel({ decompConfidence: 'low' })).toBe('None');
	});

	it('dialog shows the manipulation badge when flagged', async () => {
		const { TransactionDetailsDialog } = await import('./tradesTable');
		const row = {
			id: 2, chainId: 8453, pricingStatus: 'full',
			txHash: '0x1234567890abcdef1234567890abcdef12345678',
			blockNumber: 123, aggregator: 'kyberswap', direction: 'buy_weth',
			inputSymbol: 'USDC', outputSymbol: 'WETH', inputAmount: '1000.00', outputAmount: '0.33',
			notionalUsd: '1000.00', realizedPrice: '3000',
			marketMid: '3000', allInCostBps: '-1',
			lpFeeBps: '1', aggFeeBps: '0', slippageBps: '-2', executionBps: '-1', gasCostUsd: '0.001',
			hopCount: 1, routeShape: 'single', decompConfidence: 'low', routeLegs: [], routePure: true,
			reconResidualBps: null,
			chainlinkPrice: '2970', chainlinkDevBps: '101', poolDivergenceBps: '3', manipulationFlag: true,
		};
		const html = renderToStaticMarkup(
			<TransactionDetailsDialog row={row as never} onClose={() => {}} onDelete={async () => true} />,
		);
		// The generalized receipt keeps the manipulation badge (the Chainlink-specific
		// Δ row was dropped when the dialog was generalized off ReceiptRow).
		expect(html).toContain('Possible manipulation');
	});

	// base = WETH (output, anchor rank 1 < USDC's 2) → the user BOUGHT the base.
	// Quote = USDC. The sentence states where the fill landed; for a buy, below is
	// the good half. Direction used to live in a tooltip and is now in the value
	// text itself, with "per 1 WETH" split into the subvalue.
	it.each([
		['3005', '3000', 'WETH bought at 5.00 USDC above Market Price', 'per 1 WETH'],
		['2995', '3000', 'WETH bought at 5.00 USDC below Market Price', 'per 1 WETH'],
		['3000', '3000', 'None', null],
	])('realized=%s market=%s renders Price Delta "%s" with subvalue %s', async (realizedPrice, marketMid, expectedValue, expectedSub) => {
		const { TransactionDetailsDialog } = await import('./tradesTable');
		const row = {
			id: 3, chainId: 8453, pricingStatus: 'full',
			txHash: '0x1234567890abcdef1234567890abcdef12345678',
			blockNumber: 123, aggregator: 'kyberswap', direction: 'buy_weth',
			inputSymbol: 'USDC', outputSymbol: 'WETH', inputAmount: '1000.00', outputAmount: '0.33',
			notionalUsd: '1000.00', realizedPrice,
			marketMid, allInCostBps: '-1',
			lpFeeBps: '1', aggFeeBps: '0', slippageBps: '-2', executionBps: '-1', gasCostUsd: '0.001',
			hopCount: 1, routeShape: 'single', decompConfidence: 'low', routeLegs: [], routePure: true,
			reconResidualBps: null,
		};
		const html = renderToStaticMarkup(
			<TransactionDetailsDialog row={row as never} onClose={() => {}} onDelete={async () => true} />,
		);
		expect(html).toContain(expectedValue);
		if (expectedSub) {
			expect(html).toContain(expectedSub);
		} else {
			// An exact tie has no delta to qualify: no subvalue, and no direction
			// sentence (the bare "Market Price" row label still renders, of course).
			expect(html).not.toContain('per 1 WETH');
			expect(html).not.toContain('above Market Price');
			expect(html).not.toContain('below Market Price');
		}
	});
});

describe('wrap/unwrap venue handling', () => {
	it('labels wrap and unwrap legs, with the conversion in a separate context string', async () => {
		const { getVenueLabel, getStepContext } = await import('./tradesTable');
		expect(getVenueLabel({ type: 'unwrap' })).toBe('Unwrap');
		expect(getVenueLabel({ type: 'wrap' })).toBe('Wrap');
		expect(getStepContext('unwrap')).toBe('WETH → ETH');
		expect(getStepContext('wrap')).toBe('ETH → WETH');
		expect(getStepContext('univ3')).toBeUndefined();
	});
	it('includes wrap/unwrap legs in price-impact rows with a dash value and no impact tooltip', async () => {
		const { getPriceImpactRows } = await import('./tradesTable');
		const rows = getPriceImpactRows([
			{ venue: '0xpool', type: 'univ3', tokenIn: '0xusdc', tokenOut: '0xweth', priceImpactBps: 5 },
			{ venue: '0x4200000000000000000000000000000000000006', type: 'unwrap', tokenIn: '0x4200000000000000000000000000000000000006', tokenOut: 'native', priceImpactBps: null },
		] as never);
		expect(rows).toHaveLength(2);
		expect(rows[1]).toMatchObject({
			label: 'Unwrap',
			context: 'WETH → ETH',
			value: '–',
			color: undefined,
			valueTooltip: undefined,
		});
	});
});

describe('formatSubvalueUsd sub-cent precision', () => {
	it('renders a sub-cent value at 3 significant figures', async () => {
		const { formatSubvalueUsd } = await import('./tradesTable');
		expect(formatSubvalueUsd(0.000000667735)).toBe('$0.000000668');
	});

	it('keeps 2-decimal formatting at or above $0.01', async () => {
		const { formatSubvalueUsd } = await import('./tradesTable');
		expect(formatSubvalueUsd(1829.76)).toBe('$1,829.76');
		expect(formatSubvalueUsd(2.25)).toBe('$2.25');
		expect(formatSubvalueUsd(0.01)).toBe('$0.01');
	});

	it('returns – for zero and non-finite', async () => {
		const { formatSubvalueUsd } = await import('./tradesTable');
		expect(formatSubvalueUsd(0)).toBe('–');
		expect(formatSubvalueUsd(NaN)).toBe('–');
	});

	it('formatUsdMagnitude returns unsigned string or null', async () => {
		const { formatUsdMagnitude } = await import('./tradesTable');
		expect(formatUsdMagnitude(0.000000667735)).toBe('0.000000668');
		expect(formatUsdMagnitude(2.25)).toBe('2.25');
		expect(formatUsdMagnitude(0)).toBeNull();
	});

	it('formatUsdMagnitude returns an unsigned magnitude for negative input', async () => {
		const { formatUsdMagnitude } = await import('./tradesTable');
		expect(formatUsdMagnitude(-2.25)).toBe('2.25');
		expect(formatUsdMagnitude(-0.000000667735)).toBe('0.000000668');
	});
});

describe('token amount significant-figure clamp', () => {
	it('caps a sub-1 amount at 3 significant digits (leading zeros are free), no separators', async () => {
		const { formatTokenOut } = await import('./tradesTable');
		// leading zeros after the decimal don't count as sig figs, so this keeps 5 decimal places
		expect(formatTokenOut({ outputSymbol: 'WETH', outputAmount: '0.00122969043150473' })).toBe(
			'0.00123 WETH',
		);
	});

	it('never rounds away the whole part, even when the fraction alone exceeds 3 sig figs', async () => {
		const { formatTokenIn } = await import('./tradesTable');
		expect(formatTokenIn({ inputSymbol: 'WETH', inputAmount: '1000000000.123456789' })).toBe(
			'1000000000.123 WETH',
		);
		// id-117-shaped WARP amount: 9-digit whole part stays intact; fraction clamps to 3 sig figs.
		expect(formatTokenIn({ inputSymbol: 'WARP', inputAmount: '202116011.4518599' })).toBe(
			'202116011.452 WARP',
		);
	});

	it('special-cases stablecoins to exactly 2 decimals (currency style, padded)', async () => {
		const { formatTokenIn, formatTokenOut } = await import('./tradesTable');
		expect(formatTokenOut({ outputSymbol: 'USDC', outputAmount: '2.25005' })).toBe('2.25 USDC');
		// Every stablecoin in STABLE_SYMBOLS clamps, incl. 18-decimal DAI + USDbC.
		expect(formatTokenOut({ outputSymbol: 'DAI', outputAmount: '2.250050000000000000' })).toBe('2.25 DAI');
		expect(formatTokenIn({ inputSymbol: 'USDbC', inputAmount: '2.25005' })).toBe('2.25 USDbC');
		// Padded to exactly 2 decimals (whole and half values gain trailing zeros).
		expect(formatTokenIn({ inputSymbol: 'USDC', inputAmount: '1000.00' })).toBe('1000.00 USDC');
		expect(formatTokenOut({ outputSymbol: 'USDC', outputAmount: '0.5' })).toBe('0.50 USDC');
	});

	it('clamps a memecoin-scale amount to 3 sig figs on the fraction, whole part intact', async () => {
		const { formatTokenOut } = await import('./tradesTable');
		expect(formatTokenOut({ outputSymbol: 'PEPE', outputAmount: '3369822.1456789' })).toBe('3369822.146 PEPE');
		// id-189-shaped jesse amount.
		expect(formatTokenOut({ outputSymbol: 'jesse', outputAmount: '1301340.4246528773' })).toBe(
			'1301340.425 jesse',
		);
	});

	it('applies the same 3-sig-fig fractional cap regardless of unit price', async () => {
		const { formatTokenIn } = await import('./tradesTable');
		expect(formatTokenIn({ inputSymbol: 'WETH', inputAmount: '0.123456789012' })).toBe('0.123 WETH');
	});

	it('leaves an exact whole number with no fraction untouched', async () => {
		const { formatTokenIn } = await import('./tradesTable');
		expect(formatTokenIn({ inputSymbol: 'WBTC', inputAmount: '48601527' })).toBe('48601527 WBTC');
	});

	it('tokenUnitPriceUsd returns null on missing/zero inputs', async () => {
		const { tokenUnitPriceUsd } = await import('./tradesTable');
		expect(tokenUnitPriceUsd('2.25', '3369822')).toBeCloseTo(2.25 / 3369822, 15);
		expect(tokenUnitPriceUsd(null, '10')).toBeNull();
		expect(tokenUnitPriceUsd('2.25', '0')).toBeNull();
	});
});

describe('formatExecutionPrice value clamp', () => {
	it('clamps a stablecoin-quoted price to exactly 2 decimals (>=$1, padded)', async () => {
		const { formatExecutionPrice } = await import('./tradesTable');
		expect(formatExecutionPrice('1829.763683289442', 'WETH', 'USDC')).toBe('1829.76 USDC = 1 WETH');
		expect(formatExecutionPrice('2.25005', 'X', 'USDC')).toBe('2.25 USDC = 1 X');
		// DAI is a stablecoin too.
		expect(formatExecutionPrice('1.23456', 'X', 'DAI')).toBe('1.23 DAI = 1 X');
		// Whole / half values pad to 2 decimals.
		expect(formatExecutionPrice('3000', 'WETH', 'USDC')).toBe('3000.00 USDC = 1 WETH');
	});

	it('falls back to 3 sig figs for a sub-cent stablecoin-quoted price', async () => {
		const { formatExecutionPrice } = await import('./tradesTable');
		expect(formatExecutionPrice('0.000000667735123', 'PEPE', 'USDC')).toBe('0.000000668 USDC = 1 PEPE');
	});

	it('falls back to 3 sig figs for a below-$1 stablecoin-quoted price (2 decimals would be too coarse)', async () => {
		const { formatExecutionPrice } = await import('./tradesTable');
		// Real USDC→BRIAN row: 2-decimal rounding would show "0.01" (>10% error, only 1 sig fig).
		expect(formatExecutionPrice('0.011298109377510487', 'BRIAN', 'USDC')).toBe('0.0113 USDC = 1 BRIAN');
	});

	it('uses 3 sig figs for a non-stablecoin-quoted price', async () => {
		const { formatExecutionPrice } = await import('./tradesTable');
		expect(formatExecutionPrice('0.000546123456', 'X', 'WETH')).toBe('0.000546 WETH = 1 X');
		// A large non-stablecoin price keeps the whole part intact; only the fraction clamps to 3 sig figs.
		expect(formatExecutionPrice('1829.763683289442', 'X', 'WETH')).toBe('1829.764 WETH = 1 X');
	});

	it('returns – for invalid input', async () => {
		const { formatExecutionPrice } = await import('./tradesTable');
		expect(formatExecutionPrice(null, 'WETH', 'USDC')).toBe('–');
	});
});

describe('beneficiaryAnchorNote', () => {
	it('is null for a normal (self-anchored) receipt', async () => {
		const { beneficiaryAnchorNote } = await import('./tradesTable');
		expect(beneficiaryAnchorNote({ normalizeFlags: ['SETTLEMENT_EVENT_MISSING: x'] })).toBeNull();
	});

	it('names UniswapX when anchored via the Fill event', async () => {
		const { beneficiaryAnchorNote } = await import('./tradesTable');
		expect(beneficiaryAnchorNote({ normalizeFlags: ['BENEFICIARY_ANCHORED: y', 'ANCHOR_VIA_UNISWAPX: z'] }))
			.toBe('Executed on your behalf via UniswapX');
	});

	it('is generic for a net-flow relayer anchor', async () => {
		const { beneficiaryAnchorNote } = await import('./tradesTable');
		expect(beneficiaryAnchorNote({ normalizeFlags: ['BENEFICIARY_ANCHORED: y'] }))
			.toBe('Executed on your behalf by a solver');
	});
});

describe('isUniswapXFillerRow', () => {
	it('is false for a normal (self-anchored) receipt', async () => {
		const { isUniswapXFillerRow } = await import('./tradesTable');
		expect(isUniswapXFillerRow({ normalizeFlags: ['SETTLEMENT_EVENT_MISSING: x'], fillerAddress: null })).toBe(false);
	});

	it('is true when UniswapX-anchored and fillerAddress is present', async () => {
		const { isUniswapXFillerRow } = await import('./tradesTable');
		expect(isUniswapXFillerRow({
			normalizeFlags: ['BENEFICIARY_ANCHORED: y', 'ANCHOR_VIA_UNISWAPX: z'],
			fillerAddress: '0xfiller1234567890abcdef1234567890abcdef12',
		})).toBe(true);
	});

	it('is false when UniswapX-anchored but fillerAddress is null (legacy pre-column row)', async () => {
		const { isUniswapXFillerRow } = await import('./tradesTable');
		expect(isUniswapXFillerRow({
			normalizeFlags: ['BENEFICIARY_ANCHORED: y', 'ANCHOR_VIA_UNISWAPX: z'],
			fillerAddress: null,
		})).toBe(false);
	});

	it('is false for a net-flow-anchored (non-UniswapX) relayer trade even with a fillerAddress', async () => {
		const { isUniswapXFillerRow } = await import('./tradesTable');
		expect(isUniswapXFillerRow({
			normalizeFlags: ['BENEFICIARY_ANCHORED: y'],
			fillerAddress: '0xfiller1234567890abcdef1234567890abcdef12',
		})).toBe(false);
	});
});

describe('getFlagLabel excludes provenance tokens', () => {
	it('does not surface anchor tokens as warning flags', async () => {
		const { getFlagLabel } = await import('./tradesTable');
		expect(getFlagLabel({ normalizeFlags: ['BENEFICIARY_ANCHORED: y', 'ANCHOR_VIA_UNISWAPX: z'] })).toBe('None');
	});

	it('still surfaces genuine warnings alongside an anchor token', async () => {
		const { getFlagLabel } = await import('./tradesTable');
		expect(getFlagLabel({ normalizeFlags: ['BENEFICIARY_ANCHORED: y', 'SETTLEMENT_EVENT_MISSING: x'] }))
			.toBe('SETTLEMENT_EVENT_MISSING: x');
	});
});

describe('TradesTable slippage columns', () => {
	const baseRow = {
		id: 1, txHash: '0xaaaa', chainId: 8453, blockNumber: 1,
		aggregator: 'kyberswap', direction: 'buy_weth',
		inputToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
		outputToken: '0x4200000000000000000000000000000000000006',
		inputSymbol: 'USDC', outputSymbol: 'WETH',
		inputAmount: '1000', outputAmount: '0.33', notionalUsd: '1000',
		realizedPrice: '3000', marketMid: '3000', allInCostBps: '-1',
		pricingStatus: 'full', lpFeeBps: '1', aggFeeBps: '0',
		slippageBps: '25.54', executionBps: '-1', gasCostUsd: '0.001',
		hopCount: 1, routeShape: 'single', decompConfidence: 'low',
		routePure: true, reconResidualBps: null, manipulationFlag: false,
	};
	const leg = (notionalUsdc: number, priceImpactBps: number | null) => ({
		venue: '0x1111111111111111111111111111111111111111', type: 'swap',
		tokenIn: baseRow.inputToken, tokenOut: baseRow.outputToken,
		feeTierBps: 5, notionalUsdc, lpFeeBps: 1, priceImpactBps,
	});

	it('renders an ID column immediately right of Aggregator, right-aligned', async () => {
		const { TradesTable } = await import('./tradesTable');
		const html = renderToStaticMarkup(
			<TradesTable
				rows={[{ ...baseRow, id: 4242, routeLegs: [leg(1000, 19.37)] }] as never}
				initialSort={{ column: 'block', direction: 'desc' }}
			/>,
		);
		// Position matters: the ID header must sit between Aggregator and Pair.
		const head = html.slice(html.indexOf('<thead'), html.indexOf('</thead>'));
		expect(head.indexOf('>Aggregator')).toBeLessThan(head.indexOf('>ID'));
		expect(head.indexOf('>ID')).toBeLessThan(head.indexOf('>Pair'));

		// And the cell carries the receipt's own id, right-aligned.
		const body = html.slice(html.indexOf('<tbody'));
		const cells = (body.match(/<td[^>]*>([^<]*)<\/td>/g) ?? []);
		expect(cells[1]).toContain('4242');
		expect(cells[1]).toContain('text-right');
	});

	it('orders the fee columns Agg. Fee before L.P. Fee', async () => {
		const { TradesTable } = await import('./tradesTable');
		const html = renderToStaticMarkup(
			<TradesTable
				rows={[{ ...baseRow, id: 7, lpFeeBps: '3.5', aggFeeBps: '9.5', routeLegs: [leg(1000, 19.37)] }] as never}
				initialSort={{ column: 'block', direction: 'desc' }}
			/>,
		);
		const head = html.slice(html.indexOf('<thead'), html.indexOf('</thead>'));
		expect(head.indexOf('>Size')).toBeLessThan(head.indexOf('>Agg. Fee'));
		expect(head.indexOf('>Agg. Fee')).toBeLessThan(head.indexOf('>L.P. Fee'));
		expect(head.indexOf('>L.P. Fee')).toBeLessThan(head.indexOf('>P. IMPACT'));

		// And the cells follow the headers — distinct values so a swap is visible.
		const body = html.slice(html.indexOf('<tbody'));
		const cells = (body.match(/<td[^>]*>([^<]*)<\/td>/g) ?? []).map((c) => c.replace(/<[^>]*>/g, ''));
		expect(cells[4]).toBe('9.5bps');
		expect(cells[5]).toBe('3.5bps');
	});

	it('renders all three slippage columns as headers', async () => {
		const { TradesTable } = await import('./tradesTable');
		const html = renderToStaticMarkup(
			<TradesTable
				rows={[{ ...baseRow, routeLegs: [leg(1000, 19.37)] }] as never}
				initialSort={{ column: 'block', direction: 'desc' }}
			/>,
		);
		// Anchor on the cell: 'Slippage' is a substring of 'Pos. Slippage'.
		expect(html).toContain('>Slippage');
		expect(html).toContain('>Pos. Slippage');
		expect(html).toContain('>Unattributed');
	});

	// A COUNTED DIFFERENTIAL, not an absolute count: '–' is not unique in this
	// table (an RFQ-only route dashes L.P. Fee, a null allInCostBps dashes
	// Ex. Quality), so an absolute assertion would be brittle and could pass for
	// the wrong reason. Both renders below differ ONLY in the unpriced leg.
	const renderBody = async (legs: unknown[]) => {
		const { TradesTable } = await import('./tradesTable');
		const html = renderToStaticMarkup(
			<TradesTable
				rows={[{ ...baseRow, routeLegs: legs }] as never}
				initialSort={{ column: 'block', direction: 'desc' }}
			/>,
		);
		return html.slice(html.indexOf('<tbody'));
	};
	const dashes = (s: string) => s.split('>–<').length - 1;

	it('the residual moves from Slippage to Unattributed when a leg is unpriced', async () => {
		const priced = await renderBody([leg(1000, 19.37)]);
		const partial = await renderBody([leg(1000, 19.37), leg(500, null)]);

		// Same residual either way — 25.54 − 19.37 = 6.17. Only the column moves.
		expect(priced).toContain('6.17bps');
		expect(partial).toContain('6.17bps');

		// Fully priced: Slippage + Pos. Slippage filled, Unattributed dashed.
		// Partial: the inverse — two dashed, one filled. Net +1 dash.
		expect(dashes(partial) - dashes(priced)).toBe(1);
	});

	it('the fully-priced row dashes Unattributed specifically', async () => {
		const priced = await renderBody([leg(1000, 19.37)]);
		// The last three <td>s before Ex. Quality are the slippage trio. Assert
		// on order: filled, 0.00bps (the benefit half), dashed.
		const cells = priced.match(/<td[^>]*>([^<]*)<\/td>/g) ?? [];
		const texts = cells.map((c) => c.replace(/<[^>]*>/g, ''));
		expect(texts.slice(-4, -1)).toEqual(['6.17bps', '0.00bps', '–']);
	});
});
