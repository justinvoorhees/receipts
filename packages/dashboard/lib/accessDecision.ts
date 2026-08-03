/**
 * Where the access gate says yes or no.
 *
 * Split out from middleware.ts so the policy is unit-testable without standing
 * up a Next request — the middleware itself is then a thin adapter that maps
 * these outcomes onto responses.
 */

export type AccessOutcome =
	| 'allow'
	| 'redirect-login'
	| 'redirect-home'
	| 'unauthorized'
	| 'misconfigured';

// /api/login is the one API path served without a session — it is where the
// password is submitted, so gating it would make logging in impossible. Being
// public makes it the brute-force surface: the handler rate-limits it hard.
const PUBLIC_EXACT = new Set(['/login', '/api/login', '/favicon.ico']);
const PUBLIC_PREFIXES = ['/_next/'];

/**
 * Paths reachable without a session.
 *
 * Prefix matching uses a trailing slash so `/_next/` cannot be satisfied by
 * `/_nextdoor`, and everything else is an exact match so `/login` cannot be
 * satisfied by `/loginhack`.
 */
export function isPublicPath(pathname: string): boolean {
	if (PUBLIC_EXACT.has(pathname)) return true;
	return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p)) || pathname === '/_next';
}

export function decideAccess(input: {
	pathname: string;
	configured: boolean;
	hasValidSession: boolean;
}): AccessOutcome {
	const { pathname, configured, hasValidSession } = input;

	// The login screen stays reachable even when unconfigured, so an operator
	// gets a page that explains itself rather than a bare refusal.
	if (pathname === '/login') {
		return configured && hasValidSession ? 'redirect-home' : 'allow';
	}
	// Checked before the fail-closed branch below: these must stay reachable even
	// when unconfigured, so the operator gets an explanation instead of silence.
	if (isPublicPath(pathname)) return 'allow';

	// Fail closed: no password configured means nothing is served. A missing env
	// var in production must not silently degrade into an open app.
	if (!configured) return 'misconfigured';
	if (hasValidSession) return 'allow';

	// An API client cannot act on a 302 to an HTML login page — and a naive
	// script would read the 200 that follows it as success.
	return pathname.startsWith('/api/') ? 'unauthorized' : 'redirect-login';
}
