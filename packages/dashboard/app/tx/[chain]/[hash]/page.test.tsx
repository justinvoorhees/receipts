import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.React = React;

// notFound() and permanentRedirect() really do throw in Next, and the page
// relies on that to stop executing. Sentinel throws preserve that control flow
// so a test cannot accidentally pass by falling through to the render.
class NotFoundError extends Error {}
class RedirectError extends Error {
	constructor(public to: string) {
		super(`redirect:${to}`);
	}
}

const notFound = vi.fn(() => {
	throw new NotFoundError('NEXT_NOT_FOUND');
});
const permanentRedirect = vi.fn((to: string) => {
	throw new RedirectError(to);
});

// useRouter is required, not optional: this page renders ReceiptView, which
// renders ReceiptSearch (components/receiptView.tsx:78), which calls
// useRouter(). Mocking next/navigation without it throws at render.
vi.mock('next/navigation', () => ({
	notFound,
	permanentRedirect,
	useRouter: () => ({ push: () => {} }),
}));
vi.mock('next/headers', () => ({ headers: async () => new Map() }));
vi.mock('../../../../lib/loadReceipt', () => ({ loadReceipt: vi.fn(async () => null) }));
// Safe to stub wholesale: components import RUNTIME values only from
// '@fabric-tca/core/pure' (a different specifier). What they take from
// '@fabric-tca/core' is `import type` and erases at compile.
vi.mock('@fabric-tca/core', () => ({ classifyTransaction: vi.fn(async () => ({ reason: 'NOT_DECODABLE' })) }));

const { loadReceipt } = await import('../../../../lib/loadReceipt');
const { DEFAULT_CHAIN } = await import('../../../../lib/chains');
const { default: TxPage } = await import('./page');

const mockLoad = vi.mocked(loadReceipt);

const HASH = '0x' + 'a'.repeat(64);
const MIXED = '0x' + 'A'.repeat(64);

const render = (chain: string, hash: string) =>
	TxPage({ params: Promise.resolve({ chain, hash }) });

beforeEach(() => {
	vi.clearAllMocks();
	delete process.env.TCA_RPC_URL;
});

describe('/tx/[chain]/[hash]', () => {
	it('renders a canonical URL without redirecting', async () => {
		const html = renderToStaticMarkup(await render('base', HASH));
		expect(permanentRedirect).not.toHaveBeenCalled();
		expect(notFound).not.toHaveBeenCalled();
		expect(html).toContain('Create Receipt');
	});

	it('loads the receipt with the RESOLVED chain, not a hardcoded one', async () => {
		await render('base', HASH);
		expect(mockLoad).toHaveBeenCalledWith(DEFAULT_CHAIN, HASH);
	});

	it('308s the numeric alias and a mixed-case hash in one hop', async () => {
		await expect(render('8453', MIXED)).rejects.toBeInstanceOf(RedirectError);
		expect(permanentRedirect).toHaveBeenCalledWith(`/tx/base/${HASH}`);
	});

	it('404s an unregistered chain', async () => {
		await expect(render('arbitrum', HASH)).rejects.toBeInstanceOf(NotFoundError);
		expect(notFound).toHaveBeenCalled();
	});

	it('404s a malformed hash', async () => {
		await expect(render('base', 'nonsense')).rejects.toBeInstanceOf(NotFoundError);
	});

	// The rejection must be free. Spending a database read on a URL that cannot
	// name a transaction is the failure this ordering exists to prevent.
	it('rejects without touching the data layer', async () => {
		await expect(render('arbitrum', HASH)).rejects.toThrow();
		await expect(render('base', 'nonsense')).rejects.toThrow();
		expect(mockLoad).not.toHaveBeenCalled();
	});

	it('redirects without touching the data layer', async () => {
		await expect(render('8453', HASH)).rejects.toThrow();
		expect(mockLoad).not.toHaveBeenCalled();
	});
});
