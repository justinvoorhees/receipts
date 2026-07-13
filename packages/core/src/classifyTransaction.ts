import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import {
	extractEndpoints,
	findCleanSwapCandidates,
	selectBeneficiary,
	type AnalyzeFailure,
	type RelayerDetail,
	type TraceNode,
} from './endpoints.js';
import { createDefaultPricingDeps } from './pricing.js';

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const NATIVE = 'native';

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
	} catch {
		return { reason: 'NOT_FOUND_ONCHAIN' };
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

		// Best-effort symbols; unresolved omitted (UI falls back to short address).
		const readSymbol = createDefaultPricingDeps(opts.rpcUrl).readSymbol;
		const sym = async (token: string): Promise<string | undefined> => {
			if (token.toLowerCase() === NATIVE) return 'ETH';
			try {
				return await readSymbol(token);
			} catch {
				return undefined;
			}
		};
		const [inputSymbol, outputSymbol] = await Promise.all([sym(detail.inputToken), sym(detail.outputToken)]);
		const withSymbols: RelayerDetail = {
			...detail,
			...(inputSymbol ? { inputSymbol } : {}),
			...(outputSymbol ? { outputSymbol } : {}),
		};
		return { reason: 'RELAYER_THIRD_PARTY', detail: withSymbols };
	} catch {
		return { reason: 'ANALYZE_ERROR' };
	}
}
