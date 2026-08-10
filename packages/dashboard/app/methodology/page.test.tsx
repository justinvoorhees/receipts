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
		expect(html).toContain('>Market Price<');
		expect(html).toContain('>Per-Leg Price<');
		for (const label of ['WETH/USDC Price:', 'Direct-Pool Price:', 'WETH-Derived Price:', 'Oracle Reference:']) {
			expect(html).toContain(label);
		}
		expect(html.indexOf('WETH/USDC Price:')).toBeLessThan(html.indexOf('Direct-Pool Price:'));
		expect(html.indexOf('Direct-Pool Price:')).toBeLessThan(html.indexOf('WETH-Derived Price:'));
		expect(html.indexOf('WETH-Derived Price:')).toBeLessThan(html.indexOf('Oracle Reference:'));
		expect(html.indexOf('>Market Price<')).toBeLessThan(html.indexOf('>Per-Leg Price<'));
	});

	// Figma 662-4353: the disclaimer, v0.1, every Label and every Body are Söhne
	// Mono; only the two headings are Söhne Breit. The page previously set plain
	// `Sohne` as its base, so all the mono text rendered in the sans face.
	//
	// The families are asserted in their ESCAPED form: renderToStaticMarkup
	// serializes the `'` inside a class attribute as `&#x27;`, so a literal
	// "font-['Sohne_Mono']" matches nothing and every assertion built from it
	// passes or fails for the wrong reason.
	const family = (name: string) => `font-[&#x27;${name}&#x27;]`;

	it('sets Sohne Mono as the page base family, with Breit only on the headings', async () => {
		const { default: Page } = await import('./page');
		const html = renderToStaticMarkup(<Page />);
		expect(html).toContain(family('Sohne_Mono'));
		// The sans face must be gone. `font-[&#x27;Sohne&#x27;]` is NOT a prefix
		// of the Mono/Breit classes — the closing escaped quote disambiguates —
		// so this cannot pass vacuously.
		expect(html).not.toContain(family('Sohne'));
		// h1 + the two section headings. Counted by split, not RegExp: the class
		// contains `[` and `]`, which are regex metacharacters.
		expect(html.split(family('Sohne_Breit')).length - 1).toBe(3);
	});

	it('renders the title in Halbfett (600), heavier than the Kräftig (500) headings', async () => {
		const { default: Page } = await import('./page');
		const html = renderToStaticMarkup(<Page />);
		expect(html).toContain(`${family('Sohne_Breit')} font-semibold text-[28px]`);
		expect(html).toContain(`${family('Sohne_Breit')} font-medium text-[20px]`);
	});

	it('renders labels uppercase (CSS transform) at 12px/12px, matching Figma 662-4349', async () => {
		const { default: Page } = await import('./page');
		const html = renderToStaticMarkup(<Page />);
		// The text node itself stays mixed-case; `uppercase` is a CSS transform, not a
		// text change, so the raw markup still reads "WETH/USDC Price:".
		expect(html).toContain('WETH/USDC Price:');
		expect(html).toContain('text-[12px] leading-[12px] font-medium uppercase');
	});

	it('renders body paragraphs at 12px/20px, matching Figma (was 14px)', async () => {
		const { default: Page } = await import('./page');
		const html = renderToStaticMarkup(<Page />);
		expect(html).toContain('text-[12px] leading-[20px]');
		expect(html).not.toContain('text-[14px]');
	});

	it('groups the title and version tag on a 12px gap, separate from the page-wide 20px rhythm', async () => {
		const { default: Page } = await import('./page');
		const html = renderToStaticMarkup(<Page />);
		expect(html).toContain('gap-[12px]');
	});

	it('states the disclaimer and the measurement rule', async () => {
		const { default: Page } = await import('./page');
		const html = renderToStaticMarkup(<Page />);
		expect(html).toContain(
			'Important: All pricing is provided on a best-effort basis and is not guaranteed.',
		);
		expect(html).toContain('All prices are measured at the block immediately before the transaction.');
		// The old Market-Price-scoped wording is gone — the sentence moved to the title
		// section and dropped "market" from its phrasing.
		expect(html).not.toContain('All market prices are measured');
	});

	it('mentions gas cost in the WETH/USDC Price paragraph', async () => {
		const { default: Page } = await import('./page');
		const html = renderToStaticMarkup(<Page />);
		expect(html).toContain('other token pairs and gas cost.');
	});

	it('states the Verified/Estimated/Unavailable rule', async () => {
		const { default: Page } = await import('./page');
		const html = renderToStaticMarkup(<Page />);
		expect(html).toContain('When at least 2/3 methods agree, prices are Verified.');
		expect(html).toContain('When neither, prices are Unavailable.');
	});

	it('keeps the oracle tolerance at 50bps, matching MANIPULATION_TOL_BPS', async () => {
		const { default: Page } = await import('./page');
		const html = renderToStaticMarkup(<Page />);
		expect(html).toContain('50 bps, or 0.50%');
		expect(html).not.toContain('10 bps');
	});

	it('states the Per-Leg Price fallback rule', async () => {
		const { default: Page } = await import('./page');
		const html = renderToStaticMarkup(<Page />);
		expect(html).toContain(
			"The midpoint price from the leg’s executing liquidity pool. When unavailable, the deepest qualifying liquidity pool for the same token pair is used as a fallback. Market maker legs remain unpriced by nature.",
		);
	});
});
