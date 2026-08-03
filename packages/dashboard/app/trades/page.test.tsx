import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

globalThis.React = React;

const SECRET = 'session-secret-at-least-32-characters';
let cookieValue: string | undefined;

vi.mock('next/headers', () => ({
	cookies: async () => ({ get: (n: string) => (cookieValue ? { name: n, value: cookieValue } : undefined) }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock('../../lib/queries', () => ({
	listReceipts: vi.fn(async () => []),
	countReceipts: vi.fn(async () => 0),
	TRADES_SORT_COLUMNS: { block: 'blockNumber' },
}));

const { listReceipts, countReceipts } = await import('../../lib/queries');
const { signSession } = await import('../../lib/auth');
const { default: TradesPage } = await import('./page');

const mockList = vi.mocked(listReceipts);
const mockCount = vi.mocked(countReceipts);

const render = async () =>
	renderToStaticMarkup(await TradesPage({ searchParams: Promise.resolve({}) }));

beforeEach(() => {
	vi.clearAllMocks();
	process.env.APP_ACCESS_PASSWORD = 'pw';
	process.env.APP_SESSION_SECRET = SECRET;
	cookieValue = undefined;
});
afterEach(() => {
	delete process.env.APP_ACCESS_PASSWORD;
	delete process.env.APP_SESSION_SECRET;
});

// With no /login route to rewrite to, middleware lets /trades through and this
// page is the gate. The check therefore has to sit in front of the data fetch —
// rendering the signed-out UI while still querying would leak nothing visibly
// but would put every receipt in the server's memory on an anonymous request.
describe('/trades gates its own data', () => {
	it('never queries receipts for an anonymous visitor', async () => {
		await render();
		expect(mockList).not.toHaveBeenCalled();
		expect(mockCount).not.toHaveBeenCalled();
	});

	it('renders the password bar instead of the table when signed out', async () => {
		const html = await render();
		expect(html).toContain('type="password"');
		expect(html).toContain('Sign In');
	});

	it('does not leak the history heading to an anonymous visitor', async () => {
		expect(await render()).not.toContain('>History<');
	});

	it('queries and renders the table for a signed-in visitor', async () => {
		cookieValue = await signSession(SECRET, Date.now() + 60_000);
		const html = await render();
		expect(mockList).toHaveBeenCalledOnce();
		expect(mockCount).toHaveBeenCalledOnce();
		expect(html).toContain('>History<');
	});

	it('rejects a forged cookie the same as no cookie', async () => {
		cookieValue = '99999999999999.forged';
		await render();
		expect(mockList).not.toHaveBeenCalled();
	});

	it('rejects an expired session', async () => {
		cookieValue = await signSession(SECRET, Date.now() - 1);
		await render();
		expect(mockList).not.toHaveBeenCalled();
	});

	// Fail closed: an unset secret must not be read as "no check required".
	it('does not query when the gate is unconfigured, even with a cookie', async () => {
		cookieValue = await signSession(SECRET, Date.now() + 60_000);
		delete process.env.APP_SESSION_SECRET;
		await render();
		expect(mockList).not.toHaveBeenCalled();
	});
});

// Half-configured is the likeliest deploy mistake: someone sets the password
// they had to invent and misses the secret they did not. It must be obvious
// rather than look like a wrong password.
describe('/trades with APP_ACCESS_PASSWORD set but APP_SESSION_SECRET missing', () => {
	beforeEach(() => {
		process.env.APP_ACCESS_PASSWORD = 'pw';
		delete process.env.APP_SESSION_SECRET;
		cookieValue = undefined;
	});

	it('says the gate is misconfigured instead of showing a password box', async () => {
		const html = await render();
		expect(html).toContain('not configured');
		expect(html).not.toContain('type="password"');
	});

	it('names both variables so the fix is unambiguous', async () => {
		const html = await render();
		expect(html).toContain('APP_ACCESS_PASSWORD');
		expect(html).toContain('APP_SESSION_SECRET');
	});

	it('still never queries receipts', async () => {
		await render();
		expect(mockList).not.toHaveBeenCalled();
		expect(mockCount).not.toHaveBeenCalled();
	});

	// The point of failing closed narrowly: history shuts, the product does not.
	it('says so explicitly, so nobody thinks the whole app is down', async () => {
		expect(await render()).toContain('receipt tool is unaffected');
	});
});
