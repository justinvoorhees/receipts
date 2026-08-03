/**
 * Shared-password access gate — a stopgap until a real auth suite lands.
 *
 * Deliberately stateless: the cookie is an HMAC over its own expiry, so
 * middleware can verify it without a database round trip on every request, and
 * there is no session table to build or clean up. The trade-off is that
 * individual sessions cannot be revoked — rotating APP_SESSION_SECRET
 * invalidates all of them at once, which is the right blunt instrument for a
 * closed beta.
 *
 * Uses Web Crypto rather than node:crypto so the same code runs in middleware
 * (edge runtime) and in route handlers (Node).
 */

export const SESSION_COOKIE = 'fabric_tca_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const encoder = new TextEncoder();

async function hmac(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
	// base64url so the value is cookie-safe without further escaping.
	return btoa(String.fromCharCode(...new Uint8Array(sig)))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

/** Mint a session token that is valid until `expiresAt` (epoch ms). */
export async function signSession(secret: string, expiresAt: number): Promise<string> {
	return `${expiresAt}.${await hmac(secret, String(expiresAt))}`;
}

/**
 * Verify a session token. Returns false — never throws — for anything that is
 * not a well-formed, correctly-signed, unexpired token.
 */
export async function verifySession(
	token: string | undefined | null,
	secret: string,
	now: number = Date.now(),
): Promise<boolean> {
	if (!token || !secret) return false;
	const parts = token.split('.');
	if (parts.length !== 2) return false;
	const [expRaw, sig] = parts;
	if (!expRaw || !sig) return false;
	if (!/^\d+$/.test(expRaw)) return false;
	const expiresAt = Number(expRaw);
	if (!Number.isSafeInteger(expiresAt)) return false;

	// Signature first, then expiry: both must hold, and checking the signature
	// unconditionally keeps the work done per request uniform.
	const expected = await hmac(secret, expRaw);
	if (!safeEqual(sig, expected)) return false;
	return expiresAt >= now;
}

/**
 * Length-independent string comparison.
 *
 * `===` on secrets returns at the first differing byte, which leaks the value
 * one character at a time to an attacker who can measure response times. This
 * always walks the full width. Two empty strings are NOT equal here — an unset
 * password env var must never authenticate an empty submission.
 */
export function safeEqual(a: string, b: string): boolean {
	if (a.length === 0 || b.length === 0) return false;
	const aBytes = encoder.encode(a);
	const bBytes = encoder.encode(b);
	// Compare over a fixed width so the loop count does not depend on the secret.
	const width = Math.max(aBytes.length, bBytes.length);
	let diff = aBytes.length ^ bBytes.length;
	for (let i = 0; i < width; i++) {
		diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
	}
	return diff === 0;
}
