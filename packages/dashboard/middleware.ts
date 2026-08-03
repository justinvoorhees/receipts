import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySession } from './lib/auth';
import { decideAccess } from './lib/accessDecision';

/**
 * Access gate.
 *
 * The receipt tool is public by design — anyone can paste a hash on the index
 * and get a receipt. This gate covers the API: it closes DELETE, the one
 * destructive endpoint, and every API path not explicitly opened.
 *
 * /trades is NOT gated here. Middleware cannot render, only rewrite, and there
 * is no login route to rewrite to — so that page renders its own signed-out
 * state and gates its data fetch itself. See app/trades/page.tsx.
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

	switch (decideAccess({ pathname: req.nextUrl.pathname, method: req.method, configured, hasValidSession })) {
		case 'allow':
			return NextResponse.next();

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
