import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.React = React;

class RedirectError extends Error {
	constructor(public to: string) {
		super(`redirect:${to}`);
	}
}

const permanentRedirect = vi.fn((to: string) => {
	throw new RedirectError(to);
});

// useRouter is required, not optional — this page renders ReceiptView, which
// renders ReceiptSearch (components/receiptView.tsx:78), which calls it.
vi.mock('next/navigation', () => ({
	permanentRedirect,
	useRouter: () => ({ push: () => {} }),
}));

const { default: IndexPage } = await import('./page');

const HASH = '0x' + 'a'.repeat(64);
const MIXED = '0x' + 'A'.repeat(64);

const render = (tx?: string) =>
	IndexPage({ searchParams: Promise.resolve(tx === undefined ? {} : { tx }) });

beforeEach(() => {
	vi.clearAllMocks();
});

describe('index page', () => {
	it('renders the empty search state with no ?tx', async () => {
		const html = renderToStaticMarkup(await render());
		expect(permanentRedirect).not.toHaveBeenCalled();
		expect(html).toContain('Create Receipt');
	});

	it('308s a legacy ?tx= link to the canonical path', async () => {
		await expect(render(HASH)).rejects.toBeInstanceOf(RedirectError);
		expect(permanentRedirect).toHaveBeenCalledWith(`/tx/base/${HASH}`);
	});

	it('lowercases the hash while redirecting', async () => {
		await expect(render(MIXED)).rejects.toBeInstanceOf(RedirectError);
		expect(permanentRedirect).toHaveBeenCalledWith(`/tx/base/${HASH}`);
	});

	// A 404 would be a worse answer than the search box for someone who pasted
	// badly, so a malformed ?tx renders the empty state instead of redirecting.
	it('renders the search box for a malformed ?tx instead of redirecting', async () => {
		const html = renderToStaticMarkup(await render('nonsense'));
		expect(permanentRedirect).not.toHaveBeenCalled();
		expect(html).toContain('Create Receipt');
	});

	it('ignores an empty ?tx', async () => {
		const html = renderToStaticMarkup(await render('   '));
		expect(permanentRedirect).not.toHaveBeenCalled();
		expect(html).toContain('Create Receipt');
	});
});
