import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, TransactionNotFoundError } from 'viem';
import { sessionHttp } from './rpcSession.js';
import { base } from 'viem/chains';
import {
	extractEndpoints,
	detectBeneficiaryByNetFlow,
	type AnalyzeFailure,
	type TraceNode,
} from './endpoints.js';
import { collectTraceLogs } from './tradeEndpoints.js';
import { hasBridgeLegMarker, loadBridges } from './settlementDecoders.js';

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGES = await loadBridges(path.resolve(__dirname, '../../../configs/bridges.json'));

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

	const rpc = createPublicClient({ chain: base, transport: sessionHttp(opts.rpcUrl) });
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

		const isEoa = async (a: string): Promise<boolean> => {
			try {
				const code = await rpc.getBytecode({ address: a as `0x${string}` });
				return !code || code === '0x';
			} catch {
				return false; // unknown → treat as contract (conservative)
			}
		};
		// Cross-chain legs are checked BEFORE net-flow: a bridge's own event is a
		// protocol declaration, while the beneficiary detector is a heuristic over
		// token flow. Declaration wins — the same precedence resolveTrader gives
		// its UniswapX/ERC-4337 tiers over its net-flow tier.
		if (hasBridgeLegMarker(collectTraceLogs(trace), BRIDGES)) return { reason: 'CROSS_CHAIN_LEG' };

		const detail = await detectBeneficiaryByNetFlow(trace, trader, isEoa);
		if (!detail) return { reason: 'NOT_DECODABLE' };
		return { reason: 'RELAYER_THIRD_PARTY', detail };
	} catch {
		return { reason: 'ANALYZE_ERROR' };
	}
}
