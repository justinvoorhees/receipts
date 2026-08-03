import { NextResponse } from 'next/server';
import { SESSION_COOKIE, SESSION_TTL_MS, safeEqual, signSession } from '../../../lib/auth';
import { clientKeyFromHeaders, createMemoryStore, createRateLimiter } from '../../../lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * This is the only API path the access gate serves without a session, which
 * makes it the brute-force surface for the shared password. Ten attempts per
 * 15 minutes per client is generous for a human and useless for a guesser.
 *
 * The window is counted per client key, so a lockout cannot be escaped by
 * finally guessing correctly — the limiter runs before the comparison.
 */
const attempts = createRateLimiter(createMemoryStore(), {
	limit: 10,
	windowMs: 15 * 60 * 1000,
});

export async function POST(req: Request): Promise<Response> {
	const limit = await attempts(clientKeyFromHeaders(req.headers));
	if (!limit.allowed) {
		return NextResponse.json(
			{ error: 'Too many attempts. Try again later.' },
			{ status: 429, headers: { 'retry-after': String(limit.retryAfterSecs) } },
		);
	}

	const password = process.env.APP_ACCESS_PASSWORD;
	const secret = process.env.APP_SESSION_SECRET;
	if (!password || !secret) {
		return NextResponse.json(
			{ error: 'Server misconfigured: APP_ACCESS_PASSWORD and APP_SESSION_SECRET must be set.' },
			{ status: 503 },
		);
	}

	let body: { password?: unknown };
	try {
		body = await req.json();
	} catch {
		return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
	}

	const supplied = typeof body.password === 'string' ? body.password : '';
	// safeEqual is length-independent and treats empty as never-equal, so a blank
	// submission cannot match a blank configured value.
	if (!safeEqual(supplied, password)) {
		return NextResponse.json({ error: 'Incorrect password.' }, { status: 401 });
	}

	const token = await signSession(secret, Date.now() + SESSION_TTL_MS);
	const res = NextResponse.json({ ok: true }, { status: 200 });
	res.cookies.set(SESSION_COOKIE, token, {
		httpOnly: true, // unreadable from JS, so an XSS cannot lift the session
		secure: true, // never sent over plain HTTP
		sameSite: 'lax', // not attached to cross-site POSTs
		path: '/',
		maxAge: Math.floor(SESSION_TTL_MS / 1000),
	});
	return res;
}
