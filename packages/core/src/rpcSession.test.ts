import { describe, it, expect } from 'vitest';
import { currentDecodeMemo, memoizeInSession, runInDecodeSession } from './rpcSession.js';

function countingRequest() {
	const seen: string[] = [];
	const fn = async (args: { method: string; params?: unknown }) => {
		seen.push(`${args.method}:${JSON.stringify(args.params ?? [])}`);
		// Yield, so concurrent sessions genuinely interleave.
		await new Promise((r) => setTimeout(r, 1));
		return 'ok';
	};
	return { fn, seen };
}

describe('decode session memo', () => {
	it('deduplicates identical reads made inside one decode session', async () => {
		const { fn, seen } = countingRequest();
		const request = memoizeInSession(fn);

		await runInDecodeSession(async () => {
			await request({ method: 'eth_call', params: ['x'] });
			await request({ method: 'eth_call', params: ['x'] });
		});

		expect(seen).toHaveLength(1);
	});

	it('does not memoize when no decode session is active', async () => {
		const { fn, seen } = countingRequest();
		const request = memoizeInSession(fn);

		await request({ method: 'eth_call', params: ['x'] });
		await request({ method: 'eth_call', params: ['x'] });

		expect(seen).toHaveLength(2);
	});

	it('gives sequential decodes independent memos, so `latest` reads are never pinned across requests', async () => {
		const { fn, seen } = countingRequest();
		const request = memoizeInSession(fn);

		await runInDecodeSession(() => request({ method: 'eth_call', params: ['x'] }));
		await runInDecodeSession(() => request({ method: 'eth_call', params: ['x'] }));

		expect(seen).toHaveLength(2);
	});

	it('keeps concurrently-running decodes isolated from each other', async () => {
		const { fn, seen } = countingRequest();
		const request = memoizeInSession(fn);

		// Two overlapping decodes, each repeating the same read twice. Correct
		// behaviour is one transport call per decode: 2, not 1 (leaked across
		// requests) and not 4 (memo never engaged).
		await Promise.all([
			runInDecodeSession(async () => {
				await request({ method: 'eth_call', params: ['shared'] });
				await request({ method: 'eth_call', params: ['shared'] });
			}),
			runInDecodeSession(async () => {
				await request({ method: 'eth_call', params: ['shared'] });
				await request({ method: 'eth_call', params: ['shared'] });
			}),
		]);

		expect(seen).toHaveLength(2);
	});

	it('propagates the session across awaits deep in the call stack', async () => {
		const { fn, seen } = countingRequest();
		const request = memoizeInSession(fn);

		const deep = async () => {
			await new Promise((r) => setTimeout(r, 1));
			return request({ method: 'eth_call', params: ['x'] });
		};

		await runInDecodeSession(async () => {
			await request({ method: 'eth_call', params: ['x'] });
			await deep();
		});

		expect(seen).toHaveLength(1);
	});

	it('returns the wrapped function’s result unchanged', async () => {
		const result = await runInDecodeSession(async () => 42);
		expect(result).toBe(42);
	});
});

describe('analyzeTransaction decode scope', () => {
	it('performs its RPC work inside a decode session, so the memo is live for every read', async () => {
		const { analyzeTransaction } = await import('./analyzeTransaction.js');
		const inSession: boolean[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			// Runs inside whatever async context the transport was called from —
			// which is exactly what we want to assert about.
			inSession.push(currentDecodeMemo() !== undefined);
			return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), {
				headers: { 'content-type': 'application/json' },
			});
		}) as typeof globalThis.fetch;

		try {
			await analyzeTransaction(`0x${'11'.repeat(32)}`, 8453, { rpcUrl: 'http://127.0.0.1:9/' });
		} finally {
			globalThis.fetch = realFetch;
		}

		expect(inSession.length).toBeGreaterThan(0);
		expect(inSession.every(Boolean)).toBe(true);
	});
});
