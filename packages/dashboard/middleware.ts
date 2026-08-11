import { NextResponse, type NextRequest } from 'next/server';
import { isLinkExpander, previewHtml } from './lib/linkExpander';
import { resolveReceiptUrl } from './lib/receiptUrl';
import { securityHeaders, noIndexHeaders } from './lib/securityHeaders.mjs';

/**
 * Answer link expanders without spending an analysis.
 *
 * A receipt render costs ~130 RPC calls, and a chat app previewing a shared
 * link wants only the <head>. This intercepts those fetches ABOVE the route, so
 * nothing reaches loadReceipt. Everyone else falls through untouched — this
 * adds a user-agent check and a regex to the receipt path and nothing else.
 *
 * Middleware rather than a branch inside the page for one reason: by the time
 * the page function runs we are already inside the render, and the point is to
 * not start it.
 *
 * ⚠️ This does NOT close the hole, it narrows it. The UA list drifts, and
 * anything not on it still pays full price. The durable fix is caching
 * loadReceipt so a second fetch of the same hash is free regardless of who
 * makes it — see docs/known-issues.md.
 */
export const config = {
	// Literal, because Next parses this statically — a computed matcher silently
	// registers nothing. /tx only: the index and /methodology are cheap and we
	// WANT them previewable, and /qa 404s in production anyway.
	matcher: '/tx/:path*',
};

export function middleware(request: NextRequest) {
	if (!isLinkExpander(request.headers.get('user-agent'))) return NextResponse.next();

	// Reuses the route's own URL policy instead of re-deriving it. Only a request
	// that would have RENDERED gets a stub: a non-canonical URL still redirects
	// and a malformed one still 404s, exactly as before, so this cannot become a
	// second and divergent opinion about what a receipt URL means.
	//
	// It is also what validates the hash before previewHtml interpolates it into
	// markup.
	const [, , chainParam, hashParam] = request.nextUrl.pathname.split('/');
	if (!chainParam || !hashParam) return NextResponse.next();
	const resolution = resolveReceiptUrl(chainParam, hashParam);
	if (resolution.kind !== 'render') return NextResponse.next();

	const html = previewHtml({
		url: `${request.nextUrl.origin}${request.nextUrl.pathname}`,
		hash: resolution.hash,
	});

	const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' });
	// ⚠️ Set explicitly, NOT inherited. The header rules in next.config.mjs are
	// applied by the routing layer to responses it produces; a Response
	// constructed here short-circuits that, so anything omitted is simply absent.
	// These paths already carry both sets, and a bot getting a weaker response
	// than a browser would be a quiet regression the smoke test does not cover
	// (it sends no expander UA).
	for (const { key, value } of securityHeaders(process.env.NODE_ENV === 'production')) {
		headers.set(key, value);
	}
	for (const { key, value } of noIndexHeaders()) headers.set(key, value);

	// ⚠️ Vary is load-bearing, not hygiene. This response is chosen BY the
	// user-agent, so any shared cache that stores it without Vary could serve
	// this stub to a person who asked for the receipt. There is no CDN in front
	// of the app today; this is what keeps that from becoming a bug when there is.
	headers.set('vary', 'User-Agent');
	headers.set('cache-control', 'public, max-age=3600');

	return new NextResponse(html, { status: 200, headers });
}
