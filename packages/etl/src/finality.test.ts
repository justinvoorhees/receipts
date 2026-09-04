import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RpcResponseLike } from './finality.js';
import { classifyRange, rpcCall } from './finality.js';

describe('rpcCall', () => {
	it('never lets a malformed RPC URL leak its secret through a fetch rejection', async () => {
		// No scheme, so fetch() throws at URL-parse time rather than returning a
		// response — Node's parse-time TypeError echoes the whole input string
		// back in its .message, which is exactly where the API key lives.
		const secret = 'sk_live_TESTSECRET';
		const malformedUrl = `rpc.example.invalid/v2/${secret}`;

		let caught: unknown;
		try {
			await rpcCall(malformedUrl, 'eth_blockNumber', []);
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).not.toContain(secret);
	});
});

describe('rpcCall retry with backoff', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** A fake `RpcResponseLike` — no real `Response` construction needed. */
	function fakeResponse(
		status: number,
		body: unknown,
		headers: Record<string, string> = {},
	): RpcResponseLike {
		return {
			ok: status >= 200 && status < 300,
			status,
			headers: { get: (name) => headers[name.toLowerCase()] ?? null },
			json: async () => body,
		};
	}

	// A secret-bearing URL is reused across these tests: the point of retry is
	// that it happens on the URL a real caller would use, key and all.
	const secret = 'sk_live_TESTSECRET';
	const secretUrl = `https://rpc.example.invalid/v2/${secret}`;

	it('retries a 429 and succeeds once the server recovers, with the correct result', async () => {
		const responses = [fakeResponse(429, {}), fakeResponse(200, { result: 42 })];
		const fetchFn = vi.fn(async () => responses.shift()!);
		const delayFn = vi.fn(async () => {});

		const result = await rpcCall<number>(secretUrl, 'eth_blockNumber', [], { fetchFn, delayFn });

		expect(result).toBe(42);
		expect(fetchFn).toHaveBeenCalledTimes(2);
		expect(delayFn).toHaveBeenCalledTimes(1);
	});

	it('stops retrying at the attempt cap and reports a sanitized error', async () => {
		const fetchFn = vi.fn(async () => fakeResponse(429, {}));
		const delayFn = vi.fn(async () => {});

		await expect(
			rpcCall(secretUrl, 'eth_blockNumber', [], { fetchFn, delayFn }),
		).rejects.toThrow(/^RPC eth_blockNumber failed: HTTP 429$/);
		// 1 initial attempt + 3 retries = 4 total; one fewer delay than attempts.
		expect(fetchFn).toHaveBeenCalledTimes(4);
		expect(delayFn).toHaveBeenCalledTimes(3);
	});

	it('does not retry a plain 4xx — a 400 is deterministic, not transient', async () => {
		const fetchFn = vi.fn(async () => fakeResponse(400, {}));
		const delayFn = vi.fn(async () => {});

		await expect(rpcCall(secretUrl, 'eth_blockNumber', [], { fetchFn, delayFn })).rejects.toThrow(
			/HTTP 400/,
		);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(delayFn).not.toHaveBeenCalled();
	});

	it('honours a Retry-After header over the computed backoff', async () => {
		const responses = [
			fakeResponse(429, {}, { 'retry-after': '2' }),
			fakeResponse(200, { result: 'ok' }),
		];
		const fetchFn = vi.fn(async () => responses.shift()!);
		const delayFn = vi.fn(async () => {});

		await rpcCall(secretUrl, 'eth_blockNumber', [], { fetchFn, delayFn });

		expect(delayFn).toHaveBeenCalledWith(2000);
	});

	it('grows the backoff delay between successive retries', async () => {
		// Full jitter draws from [0, cap]; pin Math.random at its max so the
		// observed delay equals the cap exactly, making growth deterministic.
		vi.spyOn(Math, 'random').mockReturnValue(1);
		const fetchFn = vi.fn(async () => fakeResponse(429, {}));
		const delayFn = vi.fn(async (_ms: number) => {});

		await expect(rpcCall(secretUrl, 'eth_blockNumber', [], { fetchFn, delayFn })).rejects.toThrow();

		const delays: number[] = delayFn.mock.calls.map(([ms]) => ms);
		expect(delays.length).toBeGreaterThanOrEqual(2);
		delays.slice(1).forEach((delay, i) => {
			expect(delay).toBeGreaterThan(delays[i]!);
		});
	});

	/**
	 * A 200 carrying a JSON-RPC error is the ONE path where provider-controlled
	 * text used to be interpolated verbatim into a thrown Error. Providers echo
	 * the request URL back on auth and quota errors, so that text is a live
	 * secret-exfiltration channel — onto stderr and into every CI log.
	 */
	it('never lets a JSON-RPC error message leak the URL it echoes back', async () => {
		const fetchFn = vi.fn(async () =>
			fakeResponse(200, {
				error: { code: -32000, message: `unauthorized for ${secretUrl}` },
			}),
		);
		const delayFn = vi.fn(async () => {});

		let caught: unknown;
		try {
			await rpcCall(secretUrl, 'eth_blockNumber', [], { fetchFn, delayFn });
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(Error);
		const error = caught as Error;
		expect(error.message).not.toContain(secret);
		expect(error.message).not.toContain('rpc.example.invalid');
		expect(error.stack ?? '').not.toContain(secret);
		expect(error.cause).toBeUndefined();
		// Still diagnostic: the JSON-RPC code is a defined scalar, not provider prose.
		expect(error.message).toBe('RPC eth_blockNumber failed: JSON-RPC error code -32000');
	});

	it('reports a JSON-RPC error with no numeric code without leaking the message', async () => {
		const fetchFn = vi.fn(async () =>
			fakeResponse(200, { error: { message: `bad key in ${secretUrl}` } }),
		);
		const delayFn = vi.fn(async () => {});

		await expect(rpcCall(secretUrl, 'eth_blockNumber', [], { fetchFn, delayFn })).rejects.toThrow(
			'RPC eth_blockNumber failed: JSON-RPC error code unknown',
		);
	});

	/**
	 * `json()` is this package's own injected seam (`RpcResponseLike`), so its
	 * rejection is whatever the implementation throws. undici's current parse
	 * error text ends with " at <request URL>" — the API key included.
	 */
	it('never lets a body-parse rejection leak the URL it names', async () => {
		const fetchFn = vi.fn(async () => ({
			ok: true,
			status: 200,
			headers: { get: () => null },
			json: async () => {
				throw new SyntaxError(`Unexpected token '<' at ${secretUrl}`);
			},
		}));
		const delayFn = vi.fn(async () => {});

		let caught: unknown;
		try {
			await rpcCall(secretUrl, 'eth_blockNumber', [], { fetchFn, delayFn });
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(Error);
		const error = caught as Error;
		expect(error.message).not.toContain(secret);
		expect(error.message).not.toContain('rpc.example.invalid');
		expect(error.stack ?? '').not.toContain(secret);
		expect(error.cause).toBeUndefined();
		expect(error.message).toBe('RPC eth_blockNumber failed: response body was not valid JSON');
	});

	it('never lets the planted secret reach the error message on the exhausted-retry path', async () => {
		const fetchFn = vi.fn(async () => fakeResponse(500, {}));
		const delayFn = vi.fn(async () => {});

		let caught: unknown;
		try {
			await rpcCall(secretUrl, 'eth_blockNumber', [], { fetchFn, delayFn });
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).not.toContain(secret);
		expect((caught as Error).message).not.toContain('rpc.example.invalid');
		expect((caught as Error).cause).toBeUndefined();
	});
});

describe('classifyRange', () => {
	it('admits a range entirely at or below the finalized head', () => {
		expect(classifyRange(50831209, 50831209, false)).toBe('finalized');
		expect(classifyRange(50831000, 50831209, false)).toBe('finalized');
	});

	it('refuses a range above the finalized head by default', () => {
		expect(() => classifyRange(50831210, 50831209, false)).toThrow(/--allow-unfinalized/);
	});

	it('names the exact overshoot so the caller can just move the range back', () => {
		expect(() => classifyRange(50831500, 50831209, false)).toThrow(/291 block/);
	});

	it('permits an unfinalized range only when explicitly allowed, and marks it', () => {
		expect(classifyRange(50831210, 50831209, true)).toBe('unsafe');
	});
});
