import { describe, it, expect } from 'vitest';
import { signSession, verifySession, safeEqual, SESSION_COOKIE } from './auth';

const SECRET = 'test-secret-value-at-least-32-chars-long';
const OTHER = 'different-secret-value-at-least-32-ch';
const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

describe('signSession / verifySession', () => {
	it('accepts a token signed with the same secret', async () => {
		const token = await signSession(SECRET, NOW + HOUR);
		expect(await verifySession(token, SECRET, NOW)).toBe(true);
	});

	it('rejects a token signed with a different secret', async () => {
		const token = await signSession(OTHER, NOW + HOUR);
		expect(await verifySession(token, SECRET, NOW)).toBe(false);
	});

	// The whole point of signing: the expiry is client-visible, so it must not be
	// editable. Extending it by hand has to invalidate the signature.
	it('rejects a token whose expiry has been tampered with', async () => {
		const token = await signSession(SECRET, NOW + HOUR);
		const [, sig] = token.split('.');
		const forged = `${NOW + 100 * HOUR}.${sig}`;
		expect(await verifySession(forged, SECRET, NOW)).toBe(false);
	});

	it('rejects an expired token even though its signature is valid', async () => {
		const token = await signSession(SECRET, NOW - 1);
		expect(await verifySession(token, SECRET, NOW)).toBe(false);
	});

	it('accepts a token right up to its expiry', async () => {
		const token = await signSession(SECRET, NOW + 1);
		expect(await verifySession(token, SECRET, NOW)).toBe(true);
	});

	it.each([
		['empty', ''],
		['no separator', 'garbage'],
		['non-numeric expiry', 'abc.def'],
		['missing signature', `${NOW + HOUR}.`],
		['signature only', '.deadbeef'],
		['extra segments', `${NOW + HOUR}.sig.extra`],
	])('rejects a malformed token (%s) without throwing', async (_label, token) => {
		await expect(verifySession(token, SECRET, NOW)).resolves.toBe(false);
	});

	it('produces a different signature for a different expiry', async () => {
		const a = await signSession(SECRET, NOW + HOUR);
		const b = await signSession(SECRET, NOW + 2 * HOUR);
		expect(a.split('.')[1]).not.toBe(b.split('.')[1]);
	});

	it('names the cookie something that cannot collide with Next internals', () => {
		expect(SESSION_COOKIE).toMatch(/^[a-z0-9_-]+$/i);
		expect(SESSION_COOKIE.startsWith('__next')).toBe(false);
	});
});

// Comparing secrets with === leaks their contents through timing: it returns on
// the first differing byte, so an attacker can recover a value one character at
// a time. These assert correctness; the constant-time property is structural.
describe('safeEqual', () => {
	it('is true for identical strings', () => {
		expect(safeEqual('hunter2', 'hunter2')).toBe(true);
	});

	it('is false for different strings of equal length', () => {
		expect(safeEqual('hunter2', 'hunter3')).toBe(false);
	});

	it('is false for different lengths', () => {
		expect(safeEqual('short', 'much-longer-value')).toBe(false);
	});

	it('is false when either side is empty', () => {
		expect(safeEqual('', 'x')).toBe(false);
		expect(safeEqual('x', '')).toBe(false);
	});

	// An empty configured password must never authenticate an empty submission —
	// that is what a missing env var looks like.
	it('is false when both sides are empty', () => {
		expect(safeEqual('', '')).toBe(false);
	});
});
