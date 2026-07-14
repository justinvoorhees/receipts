import { createPublicClient, http, TransactionNotFoundError } from 'viem';
import { base } from 'viem/chains';
import {
	extractEndpoints,
	findCleanSwapCandidates,
	selectBeneficiary,
	type AnalyzeFailure,
	type TraceNode,
} from './endpoints.js';

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** Diagnose WHY analyzeTransaction could not produce a receipt for `hash`.
 *  Callers invoke this only on a known miss; a resolvable swap returns the
 *  defensive ANALYZE_ERROR fallback. Never throws. */
export async function classifyTransaction(
	hash: string,
	chainId: number,
	opts: { rpcUrl: string },
): Promise<AnalyzeFailure> {
	void chainId;
	if (!HASH_RE.test(hash.trim())) return { reason: 'INVALID_HASH' };

	const rpc = createPublicClient({ chain: base, transport: http(opts.rpcUrl) });
	const txHash = hash.trim() as `0x${string}`;

	let tx;
	try {
		tx = await rpc.getTransaction({ hash: txHash });
	} catch (err) {
		// Only a genuine "tx does not exist" is NOT_FOUND; a transient/unreachable
		// RPC is infra failure → ANALYZE_ERROR (mirrors the trace catch below).
		if (err instanceof TransactionNotFoundError) return { reason: 'NOT_FOUND_ONCHAIN' };
		return { reason: 'ANALYZE_ERROR' };
	}

	let trace: TraceNode;
	try {
		trace = (await (rpc.request as unknown as (r: { method: string; params: unknown[] }) => Promise<unknown>)({
			method: 'debug_traceTransaction',
			params: [txHash, { tracer: 'callTracer', tracerConfig: { withLog: true, onlyTopCall: false } }],
		})) as TraceNode;
	} catch {
		return { reason: 'ANALYZE_ERROR' };
	}

	try {
		const trader = tx.from.toLowerCase();
		// Defensive: if endpoints actually resolve, this wasn't a real failure.
		if (extractEndpoints({ trace, trader })) return { reason: 'ANALYZE_ERROR' };

		const candidates = findCleanSwapCandidates(trace, trader);
		const addrs = [...new Set(candidates.map((c) => c.address.toLowerCase()))];
		const eoaFlags = new Map<string, boolean>();
		await Promise.all(
			addrs.map(async (a) => {
				try {
					const code = await rpc.getBytecode({ address: a as `0x${string}` });
					eoaFlags.set(a, !code || code === '0x');
				} catch {
					eoaFlags.set(a, false); // unknown → treat as contract (conservative)
				}
			}),
		);
		const detail = selectBeneficiary(candidates, trader, (a) => eoaFlags.get(a.toLowerCase()) ?? false);
		if (!detail) return { reason: 'NOT_DECODABLE' };
		return { reason: 'RELAYER_THIRD_PARTY', detail };
	} catch {
		return { reason: 'ANALYZE_ERROR' };
	}
}
