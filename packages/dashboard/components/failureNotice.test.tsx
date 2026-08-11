import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

globalThis.React = React;

describe('FailureNotice', () => {
	it('renders a dotted-underline label + tooltip for a tooltip-bearing reason', async () => {
		const { FailureNotice } = await import('./failureNotice');
		const html = renderToStaticMarkup(<FailureNotice failure={{ reason: 'NOT_DECODABLE' }} />);
		expect(html).toContain('Not a swap');
		expect(html).toContain('Token-in / token-out swap not found (signature, approval, LP action, etc)');
		expect(html).toContain('decoration-dotted');
		expect(html).toContain('hover:decoration-solid');
	});

	it('renders a plain label (no underline, no tooltip) for NOT_FOUND_ONCHAIN', async () => {
		const { FailureNotice } = await import('./failureNotice');
		const html = renderToStaticMarkup(<FailureNotice failure={{ reason: 'NOT_FOUND_ONCHAIN' }} />);
		expect(html).toContain('Transaction not found on Base');
		expect(html).not.toContain('decoration-dotted');
	});

	it('renders the relayer label plain, with no tooltip and NO beneficiary detail', async () => {
		const { FailureNotice } = await import('./failureNotice');
		const html = renderToStaticMarkup(
			<FailureNotice
				failure={{
					reason: 'RELAYER_THIRD_PARTY',
					detail: { beneficiary: '0xf70da97812cb96acdf810712aa562db8dfa3dbef', inputToken: '0x8335', outputToken: 'native' },
				}}
			/>,
		);
		expect(html).toContain('Transaction not supported');
		// The old tooltip claimed beneficiary anchoring was unsupported; it shipped,
		// and this reason now means an anchored account with no clean 2-token flow.
		expect(html).not.toContain('Beneficiary-anchored decoding');
		expect(html).not.toContain('decoration-dotted');
		expect(html).not.toContain('0xf70d');
	});

	it('renders the cross-chain label plain, with no tooltip', async () => {
		const { FailureNotice } = await import('./failureNotice');
		const html = renderToStaticMarkup(<FailureNotice failure={{ reason: 'CROSS_CHAIN_LEG' }} />);
		expect(html).toContain('Cross-chain transactions not supported');
		expect(html).not.toContain('decoration-dotted');
	});

	it('does not reuse the generic not-a-swap label for a cross-chain leg', async () => {
		const { FailureNotice } = await import('./failureNotice');
		const html = renderToStaticMarkup(<FailureNotice failure={{ reason: 'CROSS_CHAIN_LEG' }} />);
		// Anchor on the closing tag: 'Not a swap' would otherwise also match
		// nothing here, but a future label containing it must still fail.
		expect(html).not.toContain('>Not a swap<');
	});
});
