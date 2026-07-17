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

export type FailureReason =
	| 'INVALID_HASH'
	| 'NOT_FOUND_ONCHAIN'
	| 'RELAYER_THIRD_PARTY'
	| 'NOT_DECODABLE'
	| 'ANALYZE_ERROR';

export interface RelayerDetail {
	beneficiary: string;
	inputToken: string;
	outputToken: string;
}

export interface AnalyzeFailure {
	reason: FailureReason;
	detail?: RelayerDetail;
}

export interface CleanSwap {
	address: string;
	inputToken: string;
	outputToken: string;
	inputAmountRaw: bigint;
	outputAmountRaw: bigint;
}

/** Every address whose net delta is a clean 1-in/1-out (includes `trader` if it qualifies). */
export function findCleanSwapCandidates(trace: TraceNode, trader: string): CleanSwap[] {
	void trader; // included for signature symmetry; trader filtering happens in selectBeneficiary
	const out: CleanSwap[] = [];
	for (const [address, nets] of perAddressTokenDeltas(trace)) {
		const swap = cleanSwapFromNets(nets);
		if (swap) out.push({ address, ...swap });
	}
	return out;
}

/** Pick the beneficiary: exclude trader, prefer the sole EOA, else the sole candidate. */
export function selectBeneficiary(
	candidates: CleanSwap[],
	trader: string,
	isEoa: (address: string) => boolean,
): RelayerDetail | null {
	const t = trader.toLowerCase();
	const pool = candidates.filter((c) => c.address.toLowerCase() !== t);
	const pick = (c: CleanSwap): RelayerDetail => ({
		beneficiary: c.address,
		inputToken: c.inputToken,
		outputToken: c.outputToken,
	});
	const eoas = pool.filter((c) => isEoa(c.address));
	if (eoas.length === 1) return pick(eoas[0]!);
	if (pool.length === 1) return pick(pool[0]!);
	return null;
}

/** Shared net-flow beneficiary detection: resolve EOA flags for every clean-swap
 *  candidate, then delegate to selectBeneficiary. Used by classifyTransaction
 *  (detection) and resolveTrader tier 3 (decoding) so the two never diverge. */
export async function detectBeneficiaryByNetFlow(
	trace: TraceNode,
	trader: string,
	isEoa: (address: string) => Promise<boolean>,
): Promise<RelayerDetail | null> {
	const candidates = findCleanSwapCandidates(trace, trader);
	const addrs = [...new Set(candidates.map((c) => c.address.toLowerCase()))];
	const flags = new Map<string, boolean>();
	await Promise.all(addrs.map(async (a) => flags.set(a, await isEoa(a))));
	return selectBeneficiary(candidates, trader, (a) => flags.get(a.toLowerCase()) ?? false);
}

export function extractEndpoints(args: { trace: TraceNode; trader: string }): Endpoints | null {
	const trader = args.trader.toLowerCase();
	const nets = perAddressTokenDeltas(args.trace).get(trader) ?? new Map<string, bigint>();
	const swap = cleanSwapFromNets(nets);
	if (!swap) return null;
	return { trader, ...swap };
}
