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
	});
});
