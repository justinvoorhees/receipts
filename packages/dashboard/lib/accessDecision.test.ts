import { describe, it, expect } from 'vitest';
import { decideAccess, isPublicPath } from './accessDecision';

const ok = { configured: true, hasValidSession: true };
const anon = { configured: true, hasValidSession: false };

describe('decideAccess', () => {
	it('allows a page request that carries a valid session', () => {
		expect(decideAccess({ ...ok, pathname: '/trades' })).toBe('allow');
	});

	it('sends an anonymous page request to the login screen', () => {
		expect(decideAccess({ ...anon, pathname: '/trades' })).toBe('redirect-login');
	});

	// A redirect to an HTML page is useless to an API client and, worse, a 30x
	// looks like success to a naive script. API paths must get a hard 401.
	it('returns 401 rather than a redirect for an anonymous API request', () => {
		expect(decideAccess({ ...anon, pathname: '/api/receipts' })).toBe('unauthorized');
	});

	it('allows an API request that carries a valid session', () => {
		expect(decideAccess({ ...ok, pathname: '/api/receipts' })).toBe('allow');
	});

	// The gate must fail CLOSED. A missing password env var in production is
	// exactly the misconfiguration that would otherwise expose everything.
	it('refuses every request when the gate is not configured', () => {
		expect(decideAccess({ configured: false, hasValidSession: true, pathname: '/trades' })).toBe('misconfigured');
		expect(decideAccess({ configured: false, hasValidSession: false, pathname: '/api/receipts' })).toBe('misconfigured');
	});

	it('lets an anonymous user reach the login page, or it could never log in', () => {
		expect(decideAccess({ ...anon, pathname: '/login' })).toBe('allow');
	});

	// Still true when unconfigured: otherwise the operator sees a blank refusal
	// with no hint of what is wrong. The login POST itself rejects on no password.
	it('lets the login page render even when the gate is unconfigured', () => {
		expect(decideAccess({ configured: false, hasValidSession: false, pathname: '/login' })).toBe('allow');
	});

	it('sends an already-authenticated user away from the login page', () => {
		expect(decideAccess({ ...ok, pathname: '/login' })).toBe('redirect-home');
	});

	// The endpoint that ACCEPTS the password must be reachable without a session,
	// or logging in is impossible. It is the one API path that is public — and so
	// the one that needs its own brute-force limit (see route).
	it('allows the login endpoint without a session', () => {
		expect(decideAccess({ ...anon, pathname: '/api/login' })).toBe('allow');
	});

	it('still allows the login endpoint when unconfigured, so it can report why', () => {
		expect(decideAccess({ configured: false, hasValidSession: false, pathname: '/api/login' })).toBe('allow');
	});
});

describe('isPublicPath', () => {
	it.each(['/login', '/api/login', '/_next/static/chunk.js', '/_next/image', '/favicon.ico'])(
		'treats %s as public',
		(p) => expect(isPublicPath(p)).toBe(true),
	);

	it.each(['/', '/trades', '/methodology', '/api/receipts'])(
		'treats %s as protected',
		(p) => expect(isPublicPath(p)).toBe(false),
	);

	// A prefix check written as `startsWith('/login')` would also open
	// /loginhack; and one written loosely on /_next would open /_nextdoor.
	it('does not open paths that merely start with a public prefix', () => {
		expect(isPublicPath('/loginhack')).toBe(false);
		expect(isPublicPath('/_nextdoor')).toBe(false);
	});
});
