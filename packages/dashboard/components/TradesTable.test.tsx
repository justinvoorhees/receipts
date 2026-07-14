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
		const { TradesTable } = await import('./TradesTable');
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
		const { TradesTable } = await import('./TradesTable');
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
		const { getExecutionBreakdown } = await import('./TradesTable');
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
		const { getPriceImpactRows } = await import('./TradesTable');
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
				value: 'Null',
				color: undefined,
				valueTooltip: 'No reliable reference mid was available for this leg, so it is excluded from price-impact attribution.',
			},
		]);
	});

	it('resolves endpoint + native-ETH leg symbols from the receipt when a row is passed', async () => {
		const { getPriceImpactRows } = await import('./TradesTable');
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
		const { getPriceImpactRows } = await import('./TradesTable');
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
		const { getPriceImpactRows } = await import('./TradesTable');

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
		const { TransactionDetailsDialog } = await import('./TradesTable');
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
		const { getVenueLabel } = await import('./TradesTable');

		expect(getVenueLabel({ type: 'sushiv3' } as never)).toBe('SushiSwap v3');
		expect(getVenueLabel({ type: 'baseswapv3' } as never)).toBe('BaseSwap v3');
		expect(getVenueLabel({ type: 'aerodrome_cl' } as never)).toBe('Aerodrome SlipStream');
		expect(getVenueLabel({ type: 'curve_stableng' } as never)).toBe('Curve StableNG');
		expect(getVenueLabel({
			venue: '0x77E44581399F96129a8a0041dBb4E1a7569B9969',
			type: 'rfq',
		} as never)).toBe('Curve StableNG');
	});

	it('uses generic null impact copy for manually tagged Curve pools even if persisted as RFQ', async () => {
		const { getPriceImpactRows } = await import('./TradesTable');

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
			valueTooltip: 'No reliable reference mid was available for this leg, so it is excluded from price-impact attribution.',
		});
	});

	it('labels unknown-type pools as "Unknown Pool" regardless of address', async () => {
		const { getPriceImpactRows, getVenueLabel } = await import('./TradesTable');

		expect(getVenueLabel({
			venue: '0xbee3211ab312a8d065c4fef0247448e17a8da000',
			type: 'unknown',
		} as never)).toBe('Unknown Pool');
		expect(getVenueLabel({ venue: '0xother', type: 'rfq' } as never)).toBe('Unknown Pool');

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
			value: 'Null',
			valueTooltip: 'No reliable reference mid was available for this leg, so it is excluded from price-impact attribution.',
		});
	});

	it('labels known Hydrex and UniPool addresses despite an "unknown" decomposition type', async () => {
		const { getVenueLabel } = await import('./TradesTable');

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
		const { getPriceImpactRows, getVenueLabel } = await import('./TradesTable');

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
		const { TradesTable } = await import('./TradesTable');
		const html = renderToStaticMarkup(
			<TradesTable
				initialSort={{ column: 'block', direction: 'desc' }}
				rows={[]}
			/>,
		);

		expect(html).toContain('Delta between execution price and market price; the sum of L.P. Fee, Agg. Fee, P. Impact, and Slippage');
		expect(html).toContain('Fees paid to liquidity providers');
		expect(html).toContain('Fees paid to aggregators');
		expect(html).toContain('Per-venue delta between execution price and the prior-block mid, excluding L.P. Fee');
		expect(html).toContain('Residual execution difference after L.P. Fee, Agg. Fee, and P. Impact');
		expect(html).toContain('role="tooltip"');
	});

	it('wires aria-describedby between tooltip headers and their tooltip elements', async () => {
		const { TradesTable } = await import('./TradesTable');
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

	it('links known aggregator fee vaults by contract', async () => {
		const { getAggregatorFeeAttribution } = await import('./TradesTable');

		expect(getAggregatorFeeAttribution({ aggregator: 'velora' } as never)).toEqual({
			label: 'Augustus Fee Vault',
			href: 'https://basescan.org/address/0x00700052c0608F670705380a4900e0a8080010CC',
		});
		expect(getAggregatorFeeAttribution({ aggregator: 'relay' } as never)).toEqual({
			label: 'Relay: Solver',
			href: 'https://basescan.org/address/0xf70da97812CB96acDF810712Aa562db8dfA3dbEF',
		});
		expect(getAggregatorFeeAttribution({ aggregator: 'kyberswap' } as never)).toEqual({
			label: 'KyberSwap Fee Sink',
			href: 'https://basescan.org/address/0x4f82e73edb06d29ff62c91ec8f5ff06571bdeb29',
		});
	});

	it('does not attribute a large Fabric-router fee to Fabric itself', async () => {
		// Regression for the WARP->ETH tx (0xa21e4d82...): an 80bps fee retained
		// by an address reached via the Fabric router. Fabric's own protocol fee
		// caps at 10bps (surplus-sharing only), so anything larger routed through
		// Fabric is necessarily a partner/integrator's feeBps, not Fabric revenue.
		// The "Farcaster" name comes from the INTEGRATOR_FEE_RECIPIENTS registry
		// (keyed on this exact feeRecipient address), not a hardcoded label.
		const { getAggregatorFeeAttribution } = await import('./TradesTable');

		const result = getAggregatorFeeAttribution({
			aggregator: 'Fabric',
			aggFeeBps: 11.58,
			feeRecipient: '0x403560800cb7e03a06ebbc991dba0f6ac751a1c5',
		} as never);
		expect(result.label).toBe('Integrator Fee (Farcaster)');
		expect(result.label).not.toMatch(/^Fabric Fee$/);
		expect(result.tooltip).toMatch(/not Fabric revenue/);
		// Links to the persisted integrator fee wallet.
		expect(result.href).toBe('https://basescan.org/address/0x403560800cb7e03a06ebbc991dba0f6ac751a1c5');
	});

	it('resolves a known integrator fee-recipient address to its display name', async () => {
		const { getAggregatorFeeAttribution } = await import('./TradesTable');

		const result = getAggregatorFeeAttribution({
			aggregator: 'fabric',
			aggFeeBps: 25,
			feeRecipient: '0x403560800CB7E03A06EBBC991DBA0F6AC751A1C5', // mixed-case, must still match
		} as never);
		expect(result.label).toBe('Integrator Fee (Farcaster)');
		expect(result.href).toBe('https://basescan.org/address/0x403560800CB7E03A06EBBC991DBA0F6AC751A1C5');
	});

	it('labels an unrecognized Fabric-router integrator fee neutrally, without inventing a name', async () => {
		const { getAggregatorFeeAttribution } = await import('./TradesTable');

		const result = getAggregatorFeeAttribution({
			aggregator: 'fabric',
			aggFeeBps: 42,
			feeRecipient: '0x00000000000000000000000000000000000bad',
		} as never);
		expect(result.label).toBe('Integrator Fee');
		expect(result.label).not.toContain('Farcaster');
		expect(result.href).toBe('https://basescan.org/address/0x00000000000000000000000000000000000bad');
		expect(result.tooltip).toMatch(/not Fabric revenue/);
		expect(result.tooltip).toMatch(/has not been identified/);
	});

	it('labels a large Fabric-router fee neutrally when no feeRecipient is persisted', async () => {
		const { getAggregatorFeeAttribution } = await import('./TradesTable');

		const result = getAggregatorFeeAttribution({ aggregator: 'fabric', aggFeeBps: 42 } as never);
		expect(result.label).toBe('Integrator Fee');
		expect(result.label).not.toContain('Farcaster');
		expect(result.href).toBeUndefined();
	});

	it('labels a small Fabric-router fee neutrally (cannot distinguish Fabric surplus-share from a small partner fee)', async () => {
		const { getAggregatorFeeAttribution } = await import('./TradesTable');

		const result = getAggregatorFeeAttribution({ aggregator: 'fabric', aggFeeBps: 5 } as never);
		expect(result.label).toBe('Router Fee');
		expect(result.label).not.toMatch(/^Fabric Fee$/);
	});

	it('still labels a zero Fabric fee as the plain provider name', async () => {
		const { getAggregatorFeeAttribution } = await import('./TradesTable');

		expect(getAggregatorFeeAttribution({ aggregator: 'fabric', aggFeeBps: 0 } as never)).toEqual({
			label: 'Fabric',
		});
	});

	it('keeps the "<Provider> Fee" label for non-Fabric aggregators regardless of fee size', async () => {
		const { getAggregatorFeeAttribution } = await import('./TradesTable');

		expect(getAggregatorFeeAttribution({ aggregator: 'odos', aggFeeBps: 80 } as never)).toEqual({
			label: 'Odos Fee',
		});
	});

	it('formats dialog bps values with two decimal places', async () => {
		const { formatDialogBps } = await import('./TradesTable');

		expect(formatDialogBps(-1).text).toBe('1.00bps');
		expect(formatDialogBps(0).text).toBe('0.00bps');
	});

	it('uses granular normalize flags instead of repeating confidence', async () => {
		const { getFlagLabel } = await import('./TradesTable');

		expect(getFlagLabel({ normalizeFlags: ['PI_IMPLAUSIBLE: leg mid stale', 'SETTLEMENT_EVENT_MISSING: no distinctive event'] })).toBe(
			'PI_IMPLAUSIBLE: leg mid stale; SETTLEMENT_EVENT_MISSING: no distinctive event',
		);
		expect(getFlagLabel({ decompConfidence: 'medium', normalizeFlags: [] })).toBe('None');
		expect(getFlagLabel({ decompConfidence: 'low' })).toBe('None');
	});

	it('dialog shows the manipulation badge when flagged', async () => {
		const { TransactionDetailsDialog } = await import('./TradesTable');
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

	it.each([
		['3005', '3000', 'Below Market'],
		['2995', '3000', 'Above Market'],
		['3000', '3000', 'At Market'],
	])('renders Price Delta subvalue "%s" as %s when realized=%s market=%s', async (realizedPrice, marketMid, expected) => {
		const { TransactionDetailsDialog } = await import('./TradesTable');
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
		expect(html).toContain('$');
		expect(html).toContain(expected);
	});
});

describe('wrap/unwrap venue handling', () => {
	it('labels wrap and unwrap legs', async () => {
		const { getVenueLabel } = await import('./TradesTable');
		expect(getVenueLabel({ type: 'unwrap' })).toBe('Unwrap (WETH→ETH)');
		expect(getVenueLabel({ type: 'wrap' })).toBe('Wrap (ETH→WETH)');
	});
	it('excludes wrap/unwrap legs from price-impact rows', async () => {
		const { getPriceImpactRows } = await import('./TradesTable');
		const rows = getPriceImpactRows([
			{ venue: '0xpool', type: 'univ3', tokenIn: '0xusdc', tokenOut: '0xweth', priceImpactBps: 5 },
			{ venue: '0x4200000000000000000000000000000000000006', type: 'unwrap', tokenIn: '0x4200000000000000000000000000000000000006', tokenOut: 'native', priceImpactBps: null },
		] as never);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.label).not.toContain('Unwrap');
	});
});

describe('formatSubvalueUsd sub-cent precision', () => {
	it('renders a sub-cent value at 6 significant figures', async () => {
		const { formatSubvalueUsd } = await import('./TradesTable');
		expect(formatSubvalueUsd(0.000000667735)).toBe('$0.000000667735');
	});

	it('keeps 2-decimal formatting at or above $0.01', async () => {
		const { formatSubvalueUsd } = await import('./TradesTable');
		expect(formatSubvalueUsd(1829.76)).toBe('$1,829.76');
		expect(formatSubvalueUsd(2.25)).toBe('$2.25');
		expect(formatSubvalueUsd(0.01)).toBe('$0.01');
	});

	it('returns – for zero and non-finite', async () => {
		const { formatSubvalueUsd } = await import('./TradesTable');
		expect(formatSubvalueUsd(0)).toBe('–');
		expect(formatSubvalueUsd(NaN)).toBe('–');
	});

	it('formatUsdMagnitude returns unsigned string or null', async () => {
		const { formatUsdMagnitude } = await import('./TradesTable');
		expect(formatUsdMagnitude(0.000000667735)).toBe('0.000000667735');
		expect(formatUsdMagnitude(2.25)).toBe('2.25');
		expect(formatUsdMagnitude(0)).toBeNull();
	});

	it('formatUsdMagnitude returns an unsigned magnitude for negative input', async () => {
		const { formatUsdMagnitude } = await import('./TradesTable');
		expect(formatUsdMagnitude(-2.25)).toBe('2.25');
		expect(formatUsdMagnitude(-0.000000667735)).toBe('0.000000667735');
	});
});

describe('token amount decimal clamp', () => {
	it('caps headline (>$0.01/unit) token decimals at 6, no separators', async () => {
		const { formatTokenOut } = await import('./TradesTable');
		// unit price = 3.7 / 0.00122969043150473 ≈ $3009/unit → headline → cap at 6 decimals
		expect(
			formatTokenOut({ outputSymbol: 'WETH', outputAmount: '0.00122969043150473', notionalUsd: '3.7' }),
		).toBe('0.00123 WETH');
	});

	it('leaves large whole numbers intact without separators', async () => {
		const { formatTokenIn } = await import('./TradesTable');
		expect(
			formatTokenIn({ inputSymbol: 'WETH', inputAmount: '1000000000.123456789', notionalUsd: '1000000000' }),
		).toBe('1000000000.123457 WETH');
	});

	it('special-cases stablecoins to exactly 2 decimals (currency style, padded)', async () => {
		const { formatTokenIn, formatTokenOut } = await import('./TradesTable');
		expect(
			formatTokenOut({ outputSymbol: 'USDC', outputAmount: '2.25005', notionalUsd: '2.25' }),
		).toBe('2.25 USDC');
		// Every stablecoin in STABLE_SYMBOLS clamps, incl. 18-decimal DAI + USDbC.
		expect(
			formatTokenOut({ outputSymbol: 'DAI', outputAmount: '2.250050000000000000', notionalUsd: '2.25' }),
		).toBe('2.25 DAI');
		expect(
			formatTokenIn({ inputSymbol: 'USDbC', inputAmount: '2.25005', notionalUsd: '2.25' }),
		).toBe('2.25 USDbC');
		// Padded to exactly 2 decimals (whole and half values gain trailing zeros).
		expect(
			formatTokenIn({ inputSymbol: 'USDC', inputAmount: '1000.00', notionalUsd: '1000' }),
		).toBe('1000.00 USDC');
		expect(
			formatTokenOut({ outputSymbol: 'USDC', outputAmount: '0.5', notionalUsd: '0.5' }),
		).toBe('0.50 USDC');
		// A non-stable headline token still uses the 6-decimal cap.
		expect(
			formatTokenOut({ outputSymbol: 'WETH', outputAmount: '0.00122969043150473', notionalUsd: '3.7' }),
		).toBe('0.00123 WETH');
	});

	it('does not clamp sub-cent (<$0.01/unit) token decimals', async () => {
		const { formatTokenOut } = await import('./TradesTable');
		// unit price = 2.25 / 3369822.1456789 ≈ $6.7e-7 → sub-cent → keep precision
		expect(
			formatTokenOut({ outputSymbol: 'PEPE', outputAmount: '3369822.1456789', notionalUsd: '2.25' }),
		).toBe('3369822.1456789 PEPE');
	});

	it('defaults to clamped (6 decimals) when unit price is unknown', async () => {
		const { formatTokenIn } = await import('./TradesTable');
		expect(
			formatTokenIn({ inputSymbol: 'WETH', inputAmount: '0.123456789012' }),
		).toBe('0.123457 WETH');
	});

	it('tokenUnitPriceUsd returns null on missing/zero inputs', async () => {
		const { tokenUnitPriceUsd } = await import('./TradesTable');
		expect(tokenUnitPriceUsd('2.25', '3369822')).toBeCloseTo(2.25 / 3369822, 15);
		expect(tokenUnitPriceUsd(null, '10')).toBeNull();
		expect(tokenUnitPriceUsd('2.25', '0')).toBeNull();
	});
});

describe('formatExecutionPrice value clamp', () => {
	it('clamps a stablecoin-quoted price to exactly 2 decimals (>=$0.01, padded)', async () => {
		const { formatExecutionPrice } = await import('./TradesTable');
		expect(formatExecutionPrice('1829.763683289442', 'WETH', 'USDC')).toBe('1829.76 USDC = 1 WETH');
		expect(formatExecutionPrice('2.25005', 'X', 'USDC')).toBe('2.25 USDC = 1 X');
		// DAI is a stablecoin too.
		expect(formatExecutionPrice('1.23456', 'X', 'DAI')).toBe('1.23 DAI = 1 X');
		// Whole / half values pad to 2 decimals.
		expect(formatExecutionPrice('3000', 'WETH', 'USDC')).toBe('3000.00 USDC = 1 WETH');
	});

	it('falls back to 6 sig figs for a sub-cent stablecoin-quoted price', async () => {
		const { formatExecutionPrice } = await import('./TradesTable');
		expect(formatExecutionPrice('0.000000667735123', 'PEPE', 'USDC')).toBe('0.000000667735 USDC = 1 PEPE');
	});

	it('uses 6 sig figs for a non-stablecoin-quoted price', async () => {
		const { formatExecutionPrice } = await import('./TradesTable');
		expect(formatExecutionPrice('0.000546123456', 'X', 'WETH')).toBe('0.000546123 WETH = 1 X');
		// A large non-stablecoin price is capped at 6 significant figures.
		expect(formatExecutionPrice('1829.763683289442', 'X', 'WETH')).toBe('1829.76 WETH = 1 X');
	});

	it('returns – for invalid input', async () => {
		const { formatExecutionPrice } = await import('./TradesTable');
		expect(formatExecutionPrice(null, 'WETH', 'USDC')).toBe('–');
	});
});
