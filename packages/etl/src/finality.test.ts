import { describe, expect, it } from 'vitest';
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
