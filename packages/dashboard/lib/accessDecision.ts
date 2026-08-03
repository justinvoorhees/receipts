/**
 * Where the access gate says yes or no.
 *
 * The product is a public paste-a-hash receipt tool with a private shared
 * history, so the policy is an explicit PROTECTED list rather than deny-by-
 * default. That is the right shape for what this is, but it has a sharp edge
 * worth knowing: **a route added later is PUBLIC unless it is listed here.**
 * Anything that reads or mutates stored data belongs in the list below.
 *
 * Split out from middleware.ts so the policy is unit-testable without standing
 * up a Next request — the middleware is then a thin adapter onto responses.
 */

export type AccessOutcome =
	| 'allow'
	| 'unauthorized'
	| 'misconfigured';

/**
 * Page prefixes middleware refuses outright.
 *
 * Empty on purpose: middleware cannot render, only rewrite, and there is no
 * login route to rewrite to — so /trades renders its OWN signed-out state and
 * gates its data fetch in the page (see app/trades/page.tsx). This hook stays
 * for a page that should be refused rather than shown a signed-out view.
 * Matched on segment boundaries, so `/x` and `/x/y` are covered while `/xy` is
 * not silently swept in.
 */
const PROTECTED_PAGE_PREFIXES: string[] = [];

/**
 * Methods allowed WITHOUT a session, per API path. Anything not listed is
 * protected — so a verb nobody thought about (PUT, PATCH) fails closed rather
 * than being publicly reachable by omission.
 */
const PUBLIC_API_METHODS: Record<string, readonly string[]> = {
	'/api/receipts': ['POST'],
	'/api/login': ['POST'],
};

export function isProtected(pathname: string, method: string): boolean {
	const verb = method.toUpperCase();

	const publicMethods = PUBLIC_API_METHODS[pathname];
	if (publicMethods) return !publicMethods.includes(verb);
	// Every other API path is protected; only the two above are exposed.
	if (pathname.startsWith('/api/')) return true;

	return PROTECTED_PAGE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function decideAccess(input: {
	pathname: string;
	method: string;
	configured: boolean;
	hasValidSession: boolean;
}): AccessOutcome {
	const { pathname, method, configured, hasValidSession } = input;

	// Public surface is served regardless of gate configuration: a missing
	// password env var must not take down the receipt tool itself, only close
	// what the password was protecting.
	if (!isProtected(pathname, method)) return 'allow';

	// Protected surface fails closed when unconfigured — never opens.
	if (!configured) return 'misconfigured';
	if (hasValidSession) return 'allow';

	return 'unauthorized';
}
