import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { POST } from './route.js';
import { SESSION_COOKIE, verifySession } from '../../../lib/auth';

const PASSWORD = 'correct-horse-battery-staple';
const SECRET = 'session-secret-at-least-32-characters';

// Each test uses a distinct client IP so the brute-force limiter (keyed on IP)
// cannot bleed between tests without needing a reset hook in production code.
let ipCounter = 0;
function login(body: unknown, ip = `10.0.0.${++ipCounter}`): Request {
	return new Request('http://x/api/login', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	process.env.APP_ACCESS_PASSWORD = PASSWORD;
	process.env.APP_SESSION_SECRET = SECRET;
});
afterEach(() => {
	delete process.env.APP_ACCESS_PASSWORD;
	delete process.env.APP_SESSION_SECRET;
});

describe('POST /api/login', () => {
	it('accepts the correct password', async () => {
		const res = await POST(login({ password: PASSWORD }));
		expect(res.status).toBe(200);
	});

	it('sets a session cookie that actually verifies', async () => {
		const res = await POST(login({ password: PASSWORD }));
		const cookie = res.headers.get('set-cookie') ?? '';
		const token = /fabric_tca_session=([^;]+)/.exec(cookie)?.[1];
		expect(token).toBeTruthy();
		expect(await verifySession(decodeURIComponent(token!), SECRET)).toBe(true);
	});

	// A session cookie readable from JS is stealable by any XSS; one sent over
	// plain HTTP is stealable on the wire; one without SameSite rides along on
	// cross-site requests.
	it('marks the session cookie HttpOnly, Secure and SameSite', async () => {
		const res = await POST(login({ password: PASSWORD }));
		const cookie = res.headers.get('set-cookie') ?? '';
		expect(cookie).toMatch(/HttpOnly/i);
		expect(cookie).toMatch(/Secure/i);
		expect(cookie).toMatch(/SameSite=Lax/i);
		expect(cookie).toMatch(/Path=\//i);
	});

	it('rejects a wrong password with 401 and no cookie', async () => {
		const res = await POST(login({ password: 'wrong' }));
		expect(res.status).toBe(401);
		expect(res.headers.get('set-cookie')).toBeNull();
	});

	it('rejects a missing password field', async () => {
		const res = await POST(login({}));
		expect(res.status).toBe(401);
	});

	it('rejects an empty password even if the env var were empty', async () => {
		process.env.APP_ACCESS_PASSWORD = '';
		const res = await POST(login({ password: '' }));
		expect(res.status).not.toBe(200);
		expect(res.headers.get('set-cookie')).toBeNull();
	});

	it('returns 503, not 401, when the gate is unconfigured', async () => {
		delete process.env.APP_ACCESS_PASSWORD;
		const res = await POST(login({ password: 'anything' }));
		expect(res.status).toBe(503);
	});

	it('does not crash on a malformed JSON body', async () => {
		const res = await POST(
			new Request('http://x/api/login', {
				method: 'POST',
				headers: { 'x-forwarded-for': '10.9.9.9' },
				body: 'not json',
			}),
		);
		expect(res.status).toBe(400);
	});

	// Without this, the shared password is guessable offline at network speed.
	it('rate-limits repeated failures from the same client', async () => {
		const ip = '203.0.113.7';
		const codes: number[] = [];
		for (let i = 0; i < 12; i++) {
			codes.push((await POST(login({ password: 'wrong' }, ip))).status);
		}
		expect(codes).toContain(429);
		expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
	});

	it('tells a rate-limited client when to retry', async () => {
		const ip = '203.0.113.8';
		let res: Response | undefined;
		for (let i = 0; i < 12; i++) res = await POST(login({ password: 'wrong' }, ip));
		expect(res!.status).toBe(429);
		expect(Number(res!.headers.get('retry-after'))).toBeGreaterThan(0);
	});

	// The limiter must not be bypassable by simply guessing right after N tries;
	// once locked out, even the correct password waits.
	it('keeps rate-limiting even when the correct password is finally supplied', async () => {
		const ip = '203.0.113.9';
		for (let i = 0; i < 12; i++) await POST(login({ password: 'wrong' }, ip));
		const res = await POST(login({ password: PASSWORD }, ip));
		expect(res.status).toBe(429);
	});
});
