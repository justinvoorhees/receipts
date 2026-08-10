/**
 * rpcSession.ts — the decode scope that owns an RPC memo.
 *
 * A memo is only safe if its lifetime is exactly one decode (see rpcMemo.ts).
 * But the calls that need deduplicating are issued from fourteen separate
 * `createPublicClient` sites across eight modules — pricing, pool discovery, the
 * seven route readers, the benchmark — none of which should have to know they
 * are part of a larger decode, and all of which take only an `rpcUrl: string`.
 *
 * Threading a Map through all of them would put a transport concern in
 * twenty-odd signatures. "Which decode am I part of" is ambient by nature, so it
 * is carried ambiently, the same way Next.js scopes a request. The call sites
 * stay honest — each one names `sessionHttp` instead of `http`, so it is visible
 * at the point of use that the transport is session-aware — while the scope
 * itself stays out of the signatures.
 *
 * No active session ⇒ no memoization, exactly as before. That keeps every
 * existing caller (tests, scripts, `classifyTransaction`) behaving as it always
 * has, and makes the memo opt-in at the one place that owns a decode.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { http, type Transport } from 'viem';
import { memoizeRequest, type RpcRequestFn } from './rpcMemo.js';

const decodeMemo = new AsyncLocalStorage<Map<string, Promise<unknown>>>();

/**
 * Run `fn` as one decode, with a memo of its own. Concurrent decodes each get a
 * separate store, so a busy server never serves one request's reads to another.
 */
export function runInDecodeSession<T>(fn: () => Promise<T>): Promise<T> {
	return decodeMemo.run(new Map(), fn);
}

/** The active decode's memo, or undefined outside a session. */
export function currentDecodeMemo(): Map<string, Promise<unknown>> | undefined {
	return decodeMemo.getStore();
}

/**
 * Wrap a request function so it consults the memo of whichever decode is active
 * WHEN THE CALL IS MADE — not when the client was constructed. Long-lived
 * clients built outside a session therefore still memoize correctly for each
 * decode that borrows them.
 */
export function memoizeInSession(request: RpcRequestFn): RpcRequestFn {
	return (args) => {
		const memo = currentDecodeMemo();
		if (!memo) return request(args);
		return memoizeRequest(request, memo)(args);
	};
}

/**
 * Drop-in replacement for viem's `http` whose read-only calls are deduplicated
 * within the active decode session. Outside a session it is plain `http`.
 */
export function sessionHttp(url: string): Transport {
	const inner = http(url);
	return (config) => {
		const transport = inner(config);
		return {
			...transport,
			request: memoizeInSession(transport.request as RpcRequestFn) as typeof transport.request,
		};
	};
}
