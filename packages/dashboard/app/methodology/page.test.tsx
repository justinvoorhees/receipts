import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

globalThis.React = React;

describe('Methodology page', () => {
	it('renders the title, version, and every method heading in order', async () => {
		const { default: Page } = await import('./page');
		const html = renderToStaticMarkup(<Page />);
		expect(html).toContain('>Methodology<');
		expect(html).toContain('v0.1');
		expect(html.indexOf('WETH/USDC Price:')).toBeLessThan(html.indexOf('Direct-Pool Price:'));
		expect(html.indexOf('Direct-Pool Price:')).toBeLessThan(html.indexOf('WETH-Derived Price:'));
		expect(html.indexOf('WETH-Derived Price:')).toBeLessThan(html.indexOf('Oracle Reference:'));
	});

	it('states the measurement block and the Verified/Estimated rule', async () => {
		const { default: Page } = await import('./page');
		const html = renderToStaticMarkup(<Page />);
		expect(html).toContain('All market prices are measured at the block immediately before the transaction.');
		expect(html).toContain('When at least 2/3 methods agree, prices are Verified.');
	});
});
