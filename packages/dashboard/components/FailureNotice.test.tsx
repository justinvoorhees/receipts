import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

globalThis.React = React;

describe('FailureNotice', () => {
	it('renders a dotted-underline label + tooltip for a tooltip-bearing reason', async () => {
		const { FailureNotice } = await import('./FailureNotice');
		const html = renderToStaticMarkup(<FailureNotice failure={{ reason: 'NOT_DECODABLE' }} />);
		expect(html).toContain('Not a swap');
		expect(html).toContain('Could not find a token-in / token-out swap');
		expect(html).toContain('decoration-dotted');
		expect(html).toContain('hover:decoration-solid');
	});

	it('renders a plain label (no underline, no tooltip) for NOT_FOUND_ONCHAIN', async () => {
		const { FailureNotice } = await import('./FailureNotice');
		const html = renderToStaticMarkup(<FailureNotice failure={{ reason: 'NOT_FOUND_ONCHAIN' }} />);
		expect(html).toContain('Transaction not found on Base');
		expect(html).not.toContain('decoration-dotted');
	});

	it('shows the relayer generic tooltip and NO beneficiary detail', async () => {
		const { FailureNotice } = await import('./FailureNotice');
		const html = renderToStaticMarkup(
			<FailureNotice
				failure={{
					reason: 'RELAYER_THIRD_PARTY',
					detail: { beneficiary: '0xf70da97812cb96acdf810712aa562db8dfa3dbef', inputToken: '0x8335', outputToken: 'native' },
				}}
			/>,
		);
		expect(html).toContain('Relay / third-party trade');
		expect(html).toContain('Beneficiary-anchored decoding not yet supported');
		expect(html).not.toContain('0xf70d');
	});
});
