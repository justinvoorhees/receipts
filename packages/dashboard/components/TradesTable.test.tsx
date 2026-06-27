import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

globalThis.React = React;

describe('TradesTable', () => {
	it('does not render route hop badges', async () => {
		const { TradesTable } = await import('./TradesTable');
		const html = renderToStaticMarkup(
			<TradesTable
				initialSort={{ column: 'block', direction: 'desc' }}
				rows={[
					{
						txHash: '0x1234567890abcdef1234567890abcdef12345678',
						blockNumber: 123,
						aggregator: 'kyberswap',
						direction: 'buy_weth',
						usdcAmount: '1.00',
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

		expect(result.executionDisplay.text).toBe('-10.79bps');
		expect(result.priceImpactDisplay.text).toBe('-10.96bps');
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
				value: '-0.48bps',
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

	it('formats tagged pool venues for the transaction dialog', async () => {
		const { getVenueLabel } = await import('./TradesTable');

		expect(getVenueLabel({ type: 'sushiv3' } as never)).toBe('SushiSwap v3');
		expect(getVenueLabel({ type: 'baseswapv3' } as never)).toBe('BaseSwap v3');
		expect(getVenueLabel({ type: 'aerodrome_cl' } as never)).toBe('Aerodrome SlipStream');
		expect(getVenueLabel({ type: 'curve_stableng' } as never)).toBe('Curve StableNG');
	});

	it('labels the smoke-02 Kyber RFQ filler contract specifically', async () => {
		const { getPriceImpactRows, getVenueLabel } = await import('./TradesTable');

		expect(getVenueLabel({
			venue: '0xbee3211ab312a8d065c4fef0247448e17a8da000',
			type: 'rfq',
		} as never)).toBe('KyberSwap RFQ');
		expect(getVenueLabel({ venue: '0xother', type: 'rfq' } as never)).toBe('RFQ');

		expect(getPriceImpactRows([
			{
				venue: '0xbee3211ab312a8d065c4fef0247448e17a8da000',
				type: 'rfq',
				tokenIn: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
				tokenOut: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b',
				priceImpactBps: null,
			},
		] as never)[0]).toMatchObject({
			label: 'KyberSwap RFQ',
			context: 'USDC/VIRTUAL',
			value: 'Null',
			valueTooltip: 'The discovered RFQ reference mid was implausible or stale, so this leg is excluded from price-impact attribution.',
		});
	});

	it('labels the smoke-03 Kyber RFQ filler and token pair symbols', async () => {
		const { getPriceImpactRows, getVenueLabel } = await import('./TradesTable');

		expect(getVenueLabel({
			venue: '0xdcc8a6ba71a6c0053cbb32f935e9b4b64d465ea3',
			type: 'rfq',
		} as never)).toBe('KyberSwap RFQ');

		expect(getPriceImpactRows([
			{
				venue: '0xdcc8a6ba71a6c0053cbb32f935e9b4b64d465ea3',
				type: 'rfq',
				tokenIn: '0x50c5725949a6f0c72e6c4a641f24049a917db0cb',
				tokenOut: '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca',
				priceImpactBps: -0.6653663005707009,
			},
		] as never)[0]).toMatchObject({
			label: 'KyberSwap RFQ',
			context: 'DAI/USDbC',
			value: '+0.67bps',
		});
	});

	it('renders tooltip text on Accuracy, Impact, and Slippage column headers', async () => {
		const { TradesTable } = await import('./TradesTable');
		const html = renderToStaticMarkup(
			<TradesTable
				initialSort={{ column: 'block', direction: 'desc' }}
				rows={[]}
			/>,
		);

		expect(html).toContain('The delta between realized execution price and market mid');
		expect(html).toContain('Per-venue execution difference measured against that venue');
		expect(html).toContain('Residual execution difference after L.P. fees');
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
		expect(html).toContain('aria-describedby="tooltip-impact"');
		expect(html).toContain('aria-describedby="tooltip-slippage"');
		expect(html).toContain('id="tooltip-accuracy"');
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

	it('formats dialog bps values with two decimal places', async () => {
		const { formatDialogBps } = await import('./TradesTable');

		expect(formatDialogBps(-1).text).toBe('-1.00bps');
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
});
