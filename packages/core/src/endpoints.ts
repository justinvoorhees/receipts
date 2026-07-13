/**
 * Generic, trader-anchored endpoint extraction.
 *
 * Generalizes `normalizeSmokeTrade.ts:buildSmokeRow`'s hardcoded USDC/WETH
 * matching to ANY token pair: given a trace and the trader address, sum the
 * trader's signed net movement per token (ERC-20 Transfers + native ETH),
 * then pick input = the token with the most-negative net and output = the
 * token with the most-positive net. Requires a clean 2-token flow (exactly
 * one negative-net token, exactly one positive-net token) — anything else
 * (no flow, one-sided flow, three-or-more-token flow) returns null.
 *
 * Reuses `decodeTransferLogs` and `collectNativeEthDeltas` from
 * tradeEndpoints.ts; does not reimplement Transfer decoding.
 */
import { collectNativeEthDeltas, decodeTransferLogs } from './tradeEndpoints.js';

export interface Endpoints {
	trader: string;
	inputToken: string; // token address, or 'native' for native ETH
	outputToken: string;
	inputAmountRaw: bigint;
	outputAmountRaw: bigint;
}

// Same minimal callTracer-with-logs shape used across tradeEndpoints.ts /
// normalizeSmokeTrade.ts.
export interface TraceNode {
	from?: string;
	to?: string;
	value?: string;
	logs?: { address: string; data: string; topics: readonly string[] }[];
	calls?: TraceNode[];
}

const NATIVE = 'native';

/** Flatten every log from a callTracer trace tree into a single ordered list.
 *  Mirrors the private `collectTraceLogs` in tradeEndpoints.ts (not exported
 *  there) / normalizeSmokeTrade.ts — trivial flattening, not decode logic. */
function collectTraceLogs(
	trace: TraceNode,
): { address: string; data: string; topics: readonly string[] }[] {
	const out: { address: string; data: string; topics: readonly string[] }[] = [];
	const visit = (n: TraceNode) => {
		if (n.logs) out.push(...n.logs);
		n.calls?.forEach(visit);
	};
	visit(trace);
	return out;
}

/** address (lowercased) → (token or 'native' → signed net). */
export function perAddressTokenDeltas(trace: TraceNode): Map<string, Map<string, bigint>> {
	const per = new Map<string, Map<string, bigint>>();
	const bump = (addr: string, token: string, v: bigint) => {
		const a = addr.toLowerCase();
		const m = per.get(a) ?? new Map<string, bigint>();
		m.set(token, (m.get(token) ?? 0n) + v);
		per.set(a, m);
	};
	const logs = collectTraceLogs(trace);
	for (const t of decodeTransferLogs(logs as never)) {
		const token = t.token.toLowerCase();
		bump(t.from, token, -t.value);
		bump(t.to, token, t.value);
	}
	for (const [addr, v] of collectNativeEthDeltas(trace as never)) {
		if (v !== 0n) bump(addr, NATIVE, v);
	}
	return per;
}

/** The clean 1-in/1-out predicate over a single address's net map. */
export function cleanSwapFromNets(
	nets: Map<string, bigint>,
): { inputToken: string; outputToken: string; inputAmountRaw: bigint; outputAmountRaw: bigint } | null {
	const nonzero = [...nets.entries()].filter(([, v]) => v !== 0n);
	const negatives = nonzero.filter(([, v]) => v < 0n);
	const positives = nonzero.filter(([, v]) => v > 0n);
	if (negatives.length !== 1 || positives.length !== 1) return null;
	const [inputToken, inputNet] = negatives[0]!;
	const [outputToken, outputNet] = positives[0]!;
	return { inputToken, outputToken, inputAmountRaw: -inputNet, outputAmountRaw: outputNet };
}

export function extractEndpoints(args: { trace: TraceNode; trader: string }): Endpoints | null {
	const trader = args.trader.toLowerCase();
	const nets = perAddressTokenDeltas(args.trace).get(trader) ?? new Map<string, bigint>();
	const swap = cleanSwapFromNets(nets);
	if (!swap) return null;
	return { trader, ...swap };
}
