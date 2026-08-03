import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySession } from './lib/auth';
import { decideAccess } from './lib/accessDecision';

/**
 * Access gate.
 *
 * The receipt tool is public by design — anyone can paste a hash on the index
 * and get a receipt. The password protects /trades (the shared history of what
 * everyone has analyzed) and DELETE (the one destructive endpoint).
 *
 * Because POST /api/receipts is public, RATE LIMITING is the only thing standing
 * between an anonymous visitor and the RPC bill — see lib/rateLimit and the
 * per-IP plus global ceilings in the receipts route.
 *
 * Policy lives in lib/accessDecision so it can be unit-tested; this file only
 * maps outcomes onto responses.
 */
export async function middleware(req: NextRequest) {
	const secret = process.env.APP_SESSION_SECRET;
	const password = process.env.APP_ACCESS_PASSWORD;
	const configured = Boolean(secret && password);

	const token = req.cookies.get(SESSION_COOKIE)?.value;
	const hasValidSession = configured ? await verifySession(token, secret!) : false;

	const { pathname } = req.nextUrl;
	switch (decideAccess({ pathname, method: req.method, configured, hasValidSession })) {
		case 'allow':
			return NextResponse.next();

		case 'redirect-home':
			return NextResponse.redirect(new URL('/', req.url));

		case 'show-login': {
			// Rewrite, not redirect: the browser stays on /trades and renders the
			// login screen there — the logged-out STATE of the page rather than a
			// detour to a different URL. The /trades component never executes, so
			// no receipt data is fetched for an anonymous visitor.
			const url = new URL('/login', req.url);
			// Where to land after signing in. A path only — passing a full URL
			// through would turn the post-login navigation into an open redirect.
			url.searchParams.set('next', pathname + req.nextUrl.search);
			return NextResponse.rewrite(url);
		}

		case 'unauthorized':
			return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });

		case 'misconfigured':
			return NextResponse.json(
				{ error: 'Server misconfigured: APP_ACCESS_PASSWORD and APP_SESSION_SECRET must be set.' },
				{ status: 503 },
			);
	}
}

export const config = {
	// Everything except Next's own static output. The decision function still
	// re-checks public paths, so this matcher is an optimisation, not the policy.
	matcher: ['/((?!_next/static|_next/image).*)'],
};
