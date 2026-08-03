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

	// Rendered in place, not redirected: the design calls this "/trades-auth",
	// i.e. the logged-out STATE of /trades. The URL stays put so signing in
	// returns you to where you were, and a bookmark still points at /trades.
	it('shows the login screen in place for an anonymous visitor on /trades', () => {
		expect(decideAccess({ ...anon, pathname: '/trades', method: GET })).toBe('show-login');
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

	it('lets an anonymous user reach the login page and endpoint', () => {
		expect(decideAccess({ ...anon, pathname: '/login', method: GET })).toBe('allow');
		expect(decideAccess({ ...anon, pathname: '/api/login', method: 'POST' })).toBe('allow');
	});

	it('sends an already-authenticated user away from the login page', () => {
		expect(decideAccess({ ...ok, pathname: '/login', method: GET })).toBe('redirect-home');
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

	it('refuses protected routes when the gate is unconfigured, rather than opening them', () => {
		expect(decideAccess({ configured: false, hasValidSession: false, pathname: '/trades', method: GET })).toBe(
			'misconfigured',
		);
		expect(
			decideAccess({ configured: false, hasValidSession: false, pathname: '/api/receipts', method: 'DELETE' }),
		).toBe('misconfigured');
	});
});

describe('isProtected', () => {
	it.each(['/trades', '/trades/', '/trades/anything'])('protects %s', (p) => {
		expect(isProtected(p, GET)).toBe(true);
	});

	it.each(['/', '/methodology', '/login'])('leaves %s public', (p) => {
		expect(isProtected(p, GET)).toBe(false);
	});

	// A bare prefix test would let /tradesXYZ through as public — or, written the
	// other way, would wrongly protect it. Segment boundaries are what matter.
	it('does not treat a path that merely starts with /trades as the trades page', () => {
		expect(isProtected('/tradesomething', GET)).toBe(false);
	});

	it('protects DELETE on the receipts API regardless of path casing of the verb', () => {
		expect(isProtected('/api/receipts', 'DELETE')).toBe(true);
		expect(isProtected('/api/receipts', 'delete')).toBe(true);
	});

	it('leaves POST on the receipts API public', () => {
		expect(isProtected('/api/receipts', 'POST')).toBe(false);
	});
});
