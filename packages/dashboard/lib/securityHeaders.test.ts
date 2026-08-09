import { describe, it, expect } from 'vitest';
// Plain .mjs so next.config.mjs can import it too; `allowJs` in tsconfig lets
// this resolve without a type error, so no @ts-expect-error is needed here.
import { securityHeaders, noIndexHeaders } from './securityHeaders.mjs';

const asMap = (isProd: boolean) =>
	Object.fromEntries(
		(securityHeaders(isProd) as Array<{ key: string; value: string }>).map((h) => [h.key, h.value]),
	);

describe('securityHeaders', () => {
	it('sets the headers that stop framing and sniffing', () => {
		const h = asMap(true);
		expect(h['X-Frame-Options']).toBe('DENY');
		expect(h['X-Content-Type-Options']).toBe('nosniff');
		expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
		expect(h['Permissions-Policy']).toContain('geolocation=()');
	});

	it('blocks framing via CSP as well', () => {
		expect(asMap(true)['Content-Security-Policy']).toContain("frame-ancestors 'none'");
	});

	// HSTS preload is effectively irreversible; not before the domain is settled.
	it('sets HSTS without preload', () => {
		const hsts = asMap(true)['Strict-Transport-Security']!;
		expect(hsts).toContain('max-age=');
		expect(hsts).not.toContain('preload');
	});

	// React inline style={{…}} attributes are governed by style-src; removing
	// 'unsafe-inline' there would break rendering.
	it("keeps 'unsafe-inline' in style-src", () => {
		expect(asMap(true)['Content-Security-Policy']).toMatch(/style-src[^;]*'unsafe-inline'/);
	});

	// Dev needs eval for HMR. Production must never carry it.
	it("allows 'unsafe-eval' only outside production", () => {
		expect(asMap(false)['Content-Security-Policy']).toContain("'unsafe-eval'");
		expect(asMap(true)['Content-Security-Policy']).not.toContain("'unsafe-eval'");
	});

	it('restricts default-src and object-src', () => {
		const csp = asMap(true)['Content-Security-Policy']!;
		expect(csp).toContain("default-src 'self'");
		expect(csp).toContain("object-src 'none'");
	});

	// Transport assertions that only make sense once there is real https to
	// enforce. Over plain http://localhost, upgrade-insecure-requests has
	// caused Safari to rewrite dev subresources to https and break rendering;
	// pinning HSTS in dev would also apply to a rotating ngrok hostname.
	it('emits upgrade-insecure-requests and HSTS only in production', () => {
		const prod = asMap(true);
		expect(prod['Content-Security-Policy']).toContain('upgrade-insecure-requests');
		expect(prod['Strict-Transport-Security']).toBeDefined();

		const dev = asMap(false);
		expect(dev['Content-Security-Policy']).not.toContain('upgrade-insecure-requests');
		expect(dev['Strict-Transport-Security']).toBeUndefined();
	});

	// The global header set is applied to every path, including '/' and
	// '/methodology', which we DO want indexed. noindex must never live here.
	it('never carries X-Robots-Tag, which is path-scoped instead', () => {
		expect(asMap(true)['X-Robots-Tag']).toBeUndefined();
		expect(asMap(false)['X-Robots-Tag']).toBeUndefined();
	});
});

describe('noIndexHeaders', () => {
	// Every /tx hit is a fresh ~40-call RPC analysis with no cache behind it, so
	// an indexed receipt link is a standing invitation for a crawler to spend the
	// global hourly budget and take the tool down for real visitors.
	it('tells crawlers not to index or follow', () => {
		const value = Object.fromEntries(
			(noIndexHeaders() as Array<{ key: string; value: string }>).map((h) => [h.key, h.value]),
		)['X-Robots-Tag'];
		expect(value).toContain('noindex');
		expect(value).toContain('nofollow');
	});
});
