/**
 * Static security headers, applied to every path from next.config.mjs.
 *
 * Plain .mjs rather than .ts so next.config.mjs can import it directly while
 * vitest can still unit-test the list.
 *
 * The CSP deliberately uses no nonces. A nonce must be minted per request in
 * middleware, which opts every page into dynamic rendering and forecloses ever
 * moving the receipt page into Next's full-route cache — the escalation path if
 * container CPU ever becomes the ceiling. The residual risk is thin: there is
 * no dangerouslySetInnerHTML anywhere and no user-controlled HTML.
 *
 * All fonts, scripts and images are self-hosted (see styles/fonts.css), so
 * 'self' needs no exceptions.
 */
export function securityHeaders(isProduction) {
	const csp = [
		"default-src 'self'",
		// 'unsafe-eval' is required by Next's dev-mode HMR and must never ship.
		`script-src 'self' 'unsafe-inline'${isProduction ? '' : " 'unsafe-eval'"}`,
		// Required: the components style via React inline style={{…}} attributes.
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data:",
		"font-src 'self' data:",
		"connect-src 'self'",
		"frame-ancestors 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"object-src 'none'",
		// A transport assertion, not a content policy: over plain http://localhost
		// there is no https to upgrade to, and Safari has honored it there anyway,
		// rewriting dev subresources to https and breaking CSS/fonts — a false
		// "the app is unstyled" bug report. Production-only.
		...(isProduction ? ['upgrade-insecure-requests'] : []),
	].join('; ');

	return [
		{ key: 'Content-Security-Policy', value: csp },
		// Redundant with frame-ancestors, kept for browsers that ignore it.
		{ key: 'X-Frame-Options', value: 'DENY' },
		{ key: 'X-Content-Type-Options', value: 'nosniff' },
		{ key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
		// No `preload`: it is effectively irreversible and the domain is not settled.
		// Production-only: dev over ngrok (see allowedDevOrigins in next.config.mjs)
		// IS https, and a 2-year HSTS entry would pin against a rotating
		// *.ngrok-free.app hostname.
		...(isProduction
			? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]
			: []),
		{ key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
	];
}

/**
 * Keep-out headers for the routes that spend RPC, applied per-path from
 * next.config.mjs. Deliberately NOT part of securityHeaders() above, which goes
 * on every path — '/' and '/methodology' are the pages we want found.
 *
 * This is a cost control, not a privacy measure. Receipts are public and
 * shareable by design; the problem is that with nothing cached, every /tx hit
 * is a fresh ~40-call analysis charged against the global hourly ceiling. A
 * crawler that discovers a handful of shared receipt links and walks them can
 * exhaust that budget, at which point real visitors get the ceiling notice.
 *
 * Paired with public/robots.txt, which does the load-bearing work: a Disallow
 * stops the well-behaved crawler from FETCHING, which is what actually saves
 * the RPC call. This header only stops indexing, and the crawler has already
 * spent our budget by the time it reads it — but it is the half that still
 * works when a URL is discovered from an external link rather than by crawling,
 * and when a crawler ignores robots.txt but honors this.
 */
export function noIndexHeaders() {
	return [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }];
}
