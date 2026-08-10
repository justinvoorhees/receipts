import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

globalThis.React = React;

describe('Footer', () => {
	it('renders the four links in order with their hrefs', async () => {
		const { Footer } = await import('./footer');
		const html = renderToStaticMarkup(<Footer />);
		expect(html).toContain('https://docs.withfabric.xyz/');
		expect(html).toContain('https://spandex.sh/');
		expect(html).toContain('https://benchmark.withfabric.xyz/');
		expect(html).toContain('href="/methodology"');
		expect(html).toContain('>Docs<');
		expect(html.indexOf('>Docs<')).toBeLessThan(html.indexOf('>spanDEX<'));
		expect(html.indexOf('>spanDEX<')).toBeLessThan(html.indexOf('>Quotebench<'));
		expect(html.indexOf('>Quotebench<')).toBeLessThan(html.indexOf('>Methodology<'));
	});

	it('keeps the Built by Fabric attribution', async () => {
		const { Footer } = await import('./footer');
		const html = renderToStaticMarkup(<Footer />);
		expect(html).toContain('Built by');
		expect(html).toContain('https://withfabric.xyz');
	});

	it('carries no top border — the rule above it is a separate element', async () => {
		const { Footer } = await import('./footer');
		const html = renderToStaticMarkup(<Footer />);
		expect(html).not.toContain('border-t');
	});

	it('opens every footer link in a new tab', async () => {
		const { Footer } = await import('./footer');
		const html = renderToStaticMarkup(<Footer />);
		const targets = html.match(/target="_blank"/g) ?? [];
		expect(targets.length).toBe(4);
		const rels = html.match(/rel="noreferrer"/g) ?? [];
		expect(rels.length).toBe(4);
	});
});
