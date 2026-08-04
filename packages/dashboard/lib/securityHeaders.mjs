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
		'upgrade-insecure-requests',
	].join('; ');

	return [
		{ key: 'Content-Security-Policy', value: csp },
		// Redundant with frame-ancestors, kept for browsers that ignore it.
		{ key: 'X-Frame-Options', value: 'DENY' },
		{ key: 'X-Content-Type-Options', value: 'nosniff' },
		{ key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
		// No `preload`: it is effectively irreversible and the domain is not settled.
		{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
		{ key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
	];
}
