import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySession } from './lib/auth';
import { decideAccess } from './lib/accessDecision';

/**
 * Access gate for the whole app.
 *
 * This sits in middleware rather than on individual pages on purpose. Gating
 * only /trades would leave /api/receipts open — and the API is where both the
 * cost (a receipt analysis is ~40 RPC calls) and the destructive operation
 * (DELETE) live. The boundary has to cover pages and API together.
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
	switch (decideAccess({ pathname, configured, hasValidSession })) {
		case 'allow':
			return NextResponse.next();

		case 'redirect-home':
			return NextResponse.redirect(new URL('/', req.url));

		case 'redirect-login': {
			const url = new URL('/login', req.url);
			// Preserve where they were headed, but only as a path — taking a full
			// URL here would make this an open redirect.
			url.searchParams.set('next', pathname + req.nextUrl.search);
			return NextResponse.redirect(url);
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
