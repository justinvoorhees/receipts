import { describe, it, expect } from 'vitest';
import { decideAccess, isProtected } from './accessDecision';

const ok = { configured: true, hasValidSession: true };
const anon = { configured: true, hasValidSession: false };
const GET = 'GET';

describe('decideAccess — public receipt tool, private history', () => {
	// The product is a paste-a-hash tool. The index and the receipt API are meant
	// to be usable by anyone; only the shared history is private.
	it.each(['/', '/methodology'])('serves %s to an anonymous visitor', (pathname) => {
		expect(decideAccess({ ...anon, pathname, method: GET })).toBe('allow');
	});

	it('lets an anonymous visitor generate a receipt', () => {
		expect(decideAccess({ ...anon, pathname: '/api/receipts', method: 'POST' })).toBe('allow');
	});

	// /trades renders its OWN signed-out state, so middleware lets the request
	// through and the page decides. There is no separate login route to rewrite
	// to. The page must therefore gate its data fetch — see trades/page.test.tsx.
	it('lets /trades through so the page can render its own signed-out state', () => {
		expect(decideAccess({ ...anon, pathname: '/trades', method: GET })).toBe('allow');
	});

	it('serves /trades to a logged-in user', () => {
		expect(decideAccess({ ...ok, pathname: '/trades', method: GET })).toBe('allow');
	});

	// DELETE stays closed even though its path is otherwise public. It is the one
	// destructive endpoint, it takes no ownership check, and an unauthenticated
	// loop over ids previously emptied the table.
	it('refuses an anonymous DELETE on the otherwise-public receipts path', () => {
		expect(decideAccess({ ...anon, pathname: '/api/receipts', method: 'DELETE' })).toBe('unauthorized');
	});

	it('allows DELETE for a logged-in user', () => {
		expect(decideAccess({ ...ok, pathname: '/api/receipts', method: 'DELETE' })).toBe('allow');
	});

	// Anything not explicitly allowed on a public API path is refused, so a new
	// verb (PUT, PATCH) cannot become publicly reachable by being forgotten.
	it.each(['PUT', 'PATCH'])('refuses an anonymous %s on the receipts path', (method) => {
		expect(decideAccess({ ...anon, pathname: '/api/receipts', method })).toBe('unauthorized');
	});

	it('lets an anonymous user reach the login endpoint', () => {
		expect(decideAccess({ ...anon, pathname: '/api/login', method: 'POST' })).toBe('allow');
	});

	// Fail closed applies only to what the gate actually protects. The public
	// receipt tool must keep working even if the password is not configured —
	// otherwise a missing env var takes down the whole product, not just history.
	it('still serves the public tool when the gate is unconfigured', () => {
		expect(decideAccess({ configured: false, hasValidSession: false, pathname: '/', method: GET })).toBe('allow');
		expect(
			decideAccess({ configured: false, hasValidSession: false, pathname: '/api/receipts', method: 'POST' }),
		).toBe('allow');
	});

	// The API keeps getting a status code, not a rendered page — a rewrite would
	// hand an API client HTML with a 200 attached, which reads as success.
	it('still answers an anonymous protected API request with a status, not a page', () => {
		expect(decideAccess({ ...anon, pathname: '/api/receipts', method: 'DELETE' })).toBe('unauthorized');
	});

	it('refuses protected API routes when the gate is unconfigured, rather than opening them', () => {
		expect(
			decideAccess({ configured: false, hasValidSession: false, pathname: '/api/receipts', method: 'DELETE' }),
		).toBe('misconfigured');
	});
});

describe('isProtected', () => {
	// Pages are all served; /trades gates itself in-page.
	it.each(['/', '/methodology', '/trades'])('leaves page %s to the page', (p) => {
		expect(isProtected(p, GET)).toBe(false);
	});

	// Any API path not explicitly opened is protected, so a new endpoint is
	// closed by default even if nobody remembers to list it.
	it.each(['/api/anything', '/api/admin/purge'])('protects unlisted API path %s', (p) => {
		expect(isProtected(p, GET)).toBe(true);
	});

	it('protects DELETE on the receipts API regardless of path casing of the verb', () => {
		expect(isProtected('/api/receipts', 'DELETE')).toBe(true);
		expect(isProtected('/api/receipts', 'delete')).toBe(true);
	});

	it('leaves POST on the receipts API public', () => {
		expect(isProtected('/api/receipts', 'POST')).toBe(false);
	});
});
