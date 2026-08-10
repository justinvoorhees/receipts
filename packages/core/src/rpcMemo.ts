/**
 * rpcMemo.ts — request-scoped deduplication of read-only JSON-RPC calls.
 *
 * One decode issues the SAME call many times over. Measured on a 10-leg trade
 * (2026-08-10): 290 RPC calls, only 121 distinct — `getPool` went out 25 times
 * to one factory, `balanceOf` 13 times per sampled block. Nothing was wrong with
 * any single call site; the repetition is emergent, because pool discovery is
 * re-run per estimator, per sampled block, and again per leg, and no layer
 * between them remembers anything.
 *
 * This memo sits at the transport, which is the only place that sees all of it.
 *
 * ⚠️ The memo MUST be per-decode, never process-global. Pool discovery reads
 * `getPool` at the `latest` block tag, so a process-global memo would pin a
 * factory's answer for the lifetime of the server and never observe a
 * newly-deployed fee tier. Lifetime is the caller's Map — see `memoizedHttp`.
 */

import { http, type Transport } from 'viem';

export interface RpcRequestArgs {
	method: string;
	params?: unknown;
}

export type RpcRequestFn = (args: RpcRequestArgs) => Promise<unknown>;

/**
 * Read-only methods whose answer cannot change within one decode.
 *
 * An ALLOWLIST rather than a denylist of writes: an unrecognized method falls
 * through unmemoized, so the failure mode of forgetting to list something is a
 * slower decode, never a wrong one.
 *
 * Every entry is either pinned to a historical block by its caller, or (for the
 * `latest`-tagged factory lookups) reads state that is immutable once written.
 */
const MEMOIZABLE = new Set([
	'eth_call',
	'eth_getCode',
	'eth_getStorageAt',
	'eth_getBalance',
	'eth_getLogs',
	'eth_getBlockByNumber',
	'eth_getBlockByHash',
	'eth_getTransactionByHash',
	'eth_getTransactionReceipt',
	'eth_chainId',
	'eth_blockNumber',
	'debug_traceTransaction',
]);

/**
 * Wrap a request function so identical in-flight or completed calls are served
 * once. Concurrent callers share the single in-flight promise, which is what
 * collapses the four parallel estimators' overlapping discovery scans.
 *
 * ⚠️ A REJECTION IS NEVER CACHED. Callers all over the decomposition path treat
 * a failed read as evidence (`catch → null` meaning "no such pool", "fee tier
 * unreadable"), so caching a transient transport failure would let one blip
 * fan out into several wrong answers within the same receipt. On rejection the
 * entry is evicted and the next identical call goes back to the transport.
 */
export function memoizeRequest(request: RpcRequestFn, memo: Map<string, Promise<unknown>>): RpcRequestFn {
	return (args) => {
		if (!MEMOIZABLE.has(args.method)) return request(args);

		const key = `${args.method}:${JSON.stringify(args.params ?? [])}`;
		const hit = memo.get(key);
		if (hit) return hit;

		const pending = request(args).catch((err) => {
			memo.delete(key);
			throw err;
		});
		memo.set(key, pending);
		return pending;
	};
}

/**
 * An `http` transport whose read-only calls are deduplicated for the lifetime of
 * `memo`. Pass a fresh Map per decode; see the warning at the top of this file.
 */
export function memoizedHttp(url: string, memo: Map<string, Promise<unknown>>): Transport {
	const inner = http(url);
	return (config) => {
		const transport = inner(config);
		return {
			...transport,
			request: memoizeRequest(transport.request as RpcRequestFn, memo) as typeof transport.request,
		};
	};
}
