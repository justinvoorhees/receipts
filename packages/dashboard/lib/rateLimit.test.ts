import { describe, it, expect } from 'vitest';
import { createMemoryStore, createRateLimiter, clientKeyFromHeaders } from './rateLimit';

/** A controllable clock so window expiry is tested without real waiting. */
function fakeClock(start = 1_000_000) {
	let t = start;
	return { now: () => t, advance: (ms: number) => (t += ms) };
}

const limiter = (clock: { now: () => number }, limit = 3, windowMs = 60_000) =>
	createRateLimiter(createMemoryStore(clock.now), { limit, windowMs, now: clock.now });

describe('createRateLimiter', () => {
	it('allows requests up to the limit', async () => {
		const clock = fakeClock();
		const check = limiter(clock);
		for (let i = 0; i < 3; i++) {
			expect((await check('1.2.3.4')).allowed).toBe(true);
		}
	});

	it('blocks the request after the limit is reached', async () => {
		const clock = fakeClock();
		const check = limiter(clock);
		for (let i = 0; i < 3; i++) await check('1.2.3.4');
		expect((await check('1.2.3.4')).allowed).toBe(false);
	});

	it('reports how many requests remain', async () => {
		const clock = fakeClock();
		const check = limiter(clock);
		expect((await check('1.2.3.4')).remaining).toBe(2);
		expect((await check('1.2.3.4')).remaining).toBe(1);
		expect((await check('1.2.3.4')).remaining).toBe(0);
	});

	it('tracks each client key separately', async () => {
		const clock = fakeClock();
		const check = limiter(clock);
		for (let i = 0; i < 3; i++) await check('1.2.3.4');
		expect((await check('1.2.3.4')).allowed).toBe(false);
		expect((await check('5.6.7.8')).allowed).toBe(true);
	});

	it('allows again once the window has elapsed', async () => {
		const clock = fakeClock();
		const check = limiter(clock);
		for (let i = 0; i < 3; i++) await check('1.2.3.4');
		expect((await check('1.2.3.4')).allowed).toBe(false);
		clock.advance(60_001);
		expect((await check('1.2.3.4')).allowed).toBe(true);
	});

	it('does not reset early — the window is fixed from the first hit', async () => {
		const clock = fakeClock();
		const check = limiter(clock);
		await check('1.2.3.4');
		clock.advance(59_000);
		await check('1.2.3.4');
		await check('1.2.3.4');
		expect((await check('1.2.3.4')).allowed).toBe(false);
	});

	it('reports a positive retryAfterSecs when blocked', async () => {
		const clock = fakeClock();
		const check = limiter(clock);
		for (let i = 0; i < 3; i++) await check('1.2.3.4');
		clock.advance(10_000);
		const res = await check('1.2.3.4');
		expect(res.allowed).toBe(false);
		expect(res.retryAfterSecs).toBe(50);
	});
});

// An in-memory store that never forgets is itself a memory-exhaustion vector:
// one request per spoofed IP would grow the map without bound.
describe('createMemoryStore', () => {
	it('prunes entries whose window has expired instead of growing forever', async () => {
		const clock = fakeClock();
		const store = createMemoryStore(clock.now);
		for (let i = 0; i < 500; i++) await store.hit(`ip-${i}`, 60_000);
		expect(store.size()).toBe(500);
		clock.advance(60_001);
		await store.hit('fresh', 60_000);
		expect(store.size()).toBe(1);
	});
});

// The key must come from the proxy header Railway/Vercel set, but a caller can
// send any x-forwarded-for they like — so only the FIRST hop is trusted, and a
// missing header must not collapse every client into one shared bucket.
describe('clientKeyFromHeaders', () => {
	const h = (init: Record<string, string>) => new Headers(init);

	it('uses the first address in x-forwarded-for', () => {
		expect(clientKeyFromHeaders(h({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1, 10.0.0.2' }))).toBe('1.2.3.4');
	});

	it('trims whitespace around the address', () => {
		expect(clientKeyFromHeaders(h({ 'x-forwarded-for': '  1.2.3.4  , 10.0.0.1' }))).toBe('1.2.3.4');
	});

	it('falls back to x-real-ip when x-forwarded-for is absent', () => {
		expect(clientKeyFromHeaders(h({ 'x-real-ip': '9.9.9.9' }))).toBe('9.9.9.9');
	});

	it('returns a distinct unknown bucket when no client address is present', () => {
		expect(clientKeyFromHeaders(h({}))).toBe('unknown');
	});

	it('ignores an empty x-forwarded-for rather than keying on empty string', () => {
		expect(clientKeyFromHeaders(h({ 'x-forwarded-for': '   ' }))).toBe('unknown');
	});
});
