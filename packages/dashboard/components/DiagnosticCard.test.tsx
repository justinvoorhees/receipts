import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

globalThis.React = React;

describe('DiagnosticCard', () => {
	it('renders title + body for a plain reason', async () => {
		const { DiagnosticCard } = await import('./DiagnosticCard');
		const html = renderToStaticMarkup(<DiagnosticCard failure={{ reason: 'NOT_FOUND_ONCHAIN' }} />);
		expect(html).toContain('Not found on Base');
		expect(html).toContain('No transaction with this hash exists on Base');
	});

	it('renders the beneficiary + pair for a relayer trade', async () => {
		const { DiagnosticCard } = await import('./DiagnosticCard');
		const html = renderToStaticMarkup(
			<DiagnosticCard
				failure={{
					reason: 'RELAYER_THIRD_PARTY',
					detail: {
						beneficiary: '0xf70da97812cb96acdf810712aa562db8dfa3dbef',
						inputToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
						outputToken: 'native',
						inputSymbol: 'USDC',
						outputSymbol: 'ETH',
					},
				}}
			/>,
		);
		expect(html).toContain('Relay / third-party trade');
		expect(html).toContain('0xf70d'); // shortened beneficiary
		expect(html).toContain('USDC');
		expect(html).toContain('ETH');
	});
});
