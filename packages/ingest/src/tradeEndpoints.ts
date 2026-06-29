/**
 * Trade-endpoint extractor (v2.0 cost model).
 *
 * Given an RPC URL and tx hash, fetches the debug trace (callTracer with
 * logs), extracts EVERY ERC-20 Transfer log (any token), computes per-address
 * per-token NET deltas, and classifies the trade as genuine USDC<->WETH or
 * drops it with a reason.
 *
 * This replaces the pool-centric Swap-event approach with true trade-endpoint
 * identification: the trader is the non-denylisted address whose net deltas
 * are exactly {USDC, WETH} — one positive, one negative.
 */

import { createPublicClient, decodeEventLog, http, parseAbiItem } from 'viem';
import { base } from 'viem/chains';

// ─── Constants ───

export const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const WETH = '0x4200000000000000000000000000000000000006';

const TRANSFER_EVENT = parseAbiItem(
	'event Transfer(address indexed from, address indexed to, uint256 value)',
);
const TRANSFER_TOPIC =
	'0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// WETH9 wrap/unwrap events. `wad` (the WETH amount) is the non-indexed data word.
// netUnwrap = Σ Withdrawal.wad − Σ Deposit.wad lets us value the native-ETH leg of
// a USDC↔ETH trade from logs alone (no debug trace, no extra CU).
const WITHDRAWAL_TOPIC =
	'0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
const DEPOSIT_TOPIC =
	'0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c';

// Dust thresholds — ignore rounding noise
const USDC_DUST = 0.0001; // 0.0001 USDC (raw: 100)
const WETH_DUST = 1e-8; // 1e-8 WETH (raw: 10_000_000_000 = 1e10)
const USDC_DUST_RAW = 100n;
const WETH_DUST_RAW = 10_000_000_000n; // 1e10 wei = 1e-8 WETH

// ─── Denylist ───
// Addresses that are never the trader: routers, settlement, infra, pools, tokens.

export const DENYLIST: Set<string> = new Set([
	// Aggregator routers (from configs/routers.json)
	'0x19ceead7105607cd444f5ad10dd51356436095a1', // Odos V2
	'0xdef1c0ded9bec7f1a1670819833240f027b25eff', // 0x ExchangeProxy
	'0x6131b5fae19ea4f9d964eac0408e4408b66337b5', // KyberSwap MetaAggregationRouterV2
	'0x1111111254eeb25477b68fb85ed929f73a960582', // 1inch AggregationRouterV5
	'0x111111125421ca6dc452d289314280a0f8842a65', // 1inch AggregationRouterV6
	'0x6a000f20005980200259b80c5102003040001068', // Velora AugustusV6.2
	'0x59c7c832e96d2568bea6db468c1aadcbbda08a52', // Velora AugustusV5
	'0x7c137a37742437d2212b7bd873ed135b5c4c61da', // Fabric v1
	'0xc87de04e2ec1f4282dff2933a2d58199f688fc3d', // Nordstern v1
	'0xccc88a9d1b4ed6b0eaba998850414b24f1c315be', // Relay RelayApprovalProxyV3 on Base
	// CoW GPv2Settlement
	'0x9008d19f58aabd9ed0d60971565aa8510560ab41',
	// 4337 EntryPoint
	'0x0000000071727de22e5e9d8baf0edac6f37da032',
	// Token contracts themselves
	USDC,
	WETH,
	// USDC/WETH pool addresses (these have two-sided deltas but are pools, not traders)
	'0xd0b53d9277642d899df5c87a3966a349a798f224', // 5bps
	'0xb4cb800910b228ed3d0834cf79d697127bbb00e5', // 1bps
	'0x6c561b446416e1a00e8e93e221854d6ea4171372', // 30bps
	'0x0b1c2dcbbfa744ebd3fc17ff1a96a1e1eb4b2d69', // 100bps
]);

// ─── Types ───

export type Direction = 'buy_weth' | 'sell_weth';

export interface TradeEndpointResult {
	txHash: `0x${string}`;
	kept: boolean;
	dropReason: string | null;
	/** True if any non-denylisted address had a nonzero non-USDC/WETH token delta. */
	thirdTokenSeen: boolean;
	trader: `0x${string}` | null;
	direction: Direction | null;
	/** 'WETH' = trader held ERC-20 WETH; 'ETH' = aggregator (un)wrapped to native ETH. */
	settledIn: 'WETH' | 'ETH' | null;
	/** Trader's net USDC delta (raw bigint as string for serialization). */
	usdcAmountRaw: bigint | null;
	/** Trader's net WETH-equivalent (raw). ERC-20 WETH delta, or the net wrap
	 *  amount (Withdrawal−Deposit wad) for ETH-settled trades. */
	wethAmountRaw: bigint | null;
	/** |USDC|/1e6 / |WETH|/1e18 — USDC per WETH at the trader's realized rate. */
	realizedPrice: number | null;
	/** For ambiguous cases: addresses of all candidates. */
	ambiguousAnchors?: string[];
	/** Debug: number of total Transfer logs found in trace. */
	transferCount: number;
	/** Debug: number of unique addresses with nonzero deltas. */
	uniqueAddresses: number;
}

export interface ExtractArgs {
	rpcUrl: string;
	txHash: `0x${string}`;
}

// ─── Trace node shape (callTracer with logs) ───

interface TraceNode {
	from?: `0x${string}`;
	to?: `0x${string}`;
	value?: `0x${string}`; // native ETH moved by this call
	logs?: {
		address: `0x${string}`;
		data: `0x${string}`;
		topics: [`0x${string}`, ...`0x${string}`[]] | [];
	}[];
	calls?: TraceNode[];
}

// ─── Fetchers ───
//
// Two ways to get the transfer set. Both feed the same `classifyTransfers` core.
//   • extractTradeEndpoints          — debug_traceTransaction (expensive CU)
//   • extractTradeEndpointsFromReceipt — eth_getTransactionReceipt logs (cheap)
// All ERC-20 Transfers are emitted as receipt logs regardless of call depth, so
// the receipt path is sufficient for net-delta classification and far cheaper —
// preferred for bulk discovery. The receipt path also returns the block number.

export async function extractTradeEndpoints(args: ExtractArgs): Promise<TradeEndpointResult> {
	const client = createPublicClient({ chain: base, transport: http(args.rpcUrl) });

	// Fetch debug trace with callTracer + logs (same pattern as decoder.ts)
	const rawTrace = await (
		client.request as unknown as (req: { method: string; params: unknown[] }) => Promise<unknown>
	)({
		method: 'debug_traceTransaction',
		params: [
			args.txHash,
			{ tracer: 'callTracer', tracerConfig: { withLog: true, onlyTopCall: false } },
		],
	});

	// Flatten every log, derive transfers + WETH wrap-net, and (trace-only) the
	// exact per-address native-ETH deltas — the precise WETH-equivalent for the
	// USDC↔ETH path, superseding the wrap-net proxy where available.
	const trace = rawTrace as TraceNode;
	const logs = collectTraceLogs(trace);
	return classifyTransfers(
		args.txHash,
		decodeTransferLogs(logs),
		collectWrapNet(logs),
		collectNativeEthDeltas(trace),
	);
}

export interface ReceiptExtractResult extends TradeEndpointResult {
	/** Block the tx settled in — sourced from the receipt, for market-mid lookup. */
	blockNumber: bigint;
}

export async function extractTradeEndpointsFromReceipt(
	args: ExtractArgs,
): Promise<ReceiptExtractResult> {
	const client = createPublicClient({ chain: base, transport: http(args.rpcUrl) });
	const receipt = await client.getTransactionReceipt({ hash: args.txHash });
	const result = classifyTransfers(
		args.txHash,
		decodeTransferLogs(receipt.logs),
		collectWrapNet(receipt.logs),
	);
	return { ...result, blockNumber: receipt.blockNumber };
}

// ─── Classification core (shared by both fetchers) ───

function classifyTransfers(
	txHash: `0x${string}`,
	transfers: RawTransfer[],
	wrapNetRaw: bigint,
	nativeEthByAddr?: Map<string, bigint>,
): TradeEndpointResult {
	// Compute per-address per-token net deltas
	// Map<lowercaseAddress, Map<lowercaseToken, bigint>>
	const deltas = new Map<string, Map<string, bigint>>();

	const getOrInit = (addr: string, token: string): void => {
		const lower = addr.toLowerCase();
		const tokenLower = token.toLowerCase();
		if (!deltas.has(lower)) deltas.set(lower, new Map());
		const m = deltas.get(lower)!;
		if (!m.has(tokenLower)) m.set(tokenLower, 0n);
	};

	for (const t of transfers) {
		const tokenLower = t.token.toLowerCase();
		const fromLower = t.from.toLowerCase();
		const toLower = t.to.toLowerCase();

		getOrInit(fromLower, tokenLower);
		getOrInit(toLower, tokenLower);

		deltas.get(fromLower)!.set(
			tokenLower,
			deltas.get(fromLower)!.get(tokenLower)! - t.value,
		);
		deltas.get(toLower)!.set(
			tokenLower,
			deltas.get(toLower)!.get(tokenLower)! + t.value,
		);
	}

	// Check for third-token presence among non-denylisted addresses
	let thirdTokenSeen = false;
	for (const [addr, tokenMap] of deltas) {
		if (DENYLIST.has(addr)) continue;
		for (const [token, val] of tokenMap) {
			if (token === USDC || token === WETH) continue;
			if (val !== 0n) {
				thirdTokenSeen = true;
				break;
			}
		}
		if (thirdTokenSeen) break;
	}

	// Find trader candidates: non-denylisted addresses whose nonzero net deltas
	// (after dust filtering) are EXACTLY {USDC, WETH}, one positive and one negative.
	interface Candidate {
		address: string;
		usdcDelta: bigint;
		wethDelta: bigint;
		direction: Direction;
	}

	const candidates: Candidate[] = [];
	// USDC-only anchors (no ERC-20 WETH) — candidates for the native-ETH path.
	const usdcOnly: { address: string; usdcDelta: bigint }[] = [];

	for (const [addr, tokenMap] of deltas) {
		if (DENYLIST.has(addr)) continue;

		// Get USDC and WETH deltas (0 if not present)
		const usdcDelta = tokenMap.get(USDC) ?? 0n;
		const wethDelta = tokenMap.get(WETH) ?? 0n;

		const usdcSignificant = absBI(usdcDelta) >= USDC_DUST_RAW;
		const wethSignificant = absBI(wethDelta) >= WETH_DUST_RAW;

		// This address must not move any third token to be a clean trader.
		let hasThirdToken = false;
		for (const [token, val] of tokenMap) {
			if (token === USDC || token === WETH) continue;
			if (val !== 0n) { hasThirdToken = true; break; }
		}
		if (hasThirdToken) continue;

		if (usdcSignificant && wethSignificant) {
			// Two-sided USDC↔WETH: one positive, one negative.
			if (!((usdcDelta > 0n && wethDelta < 0n) || (usdcDelta < 0n && wethDelta > 0n))) continue;
			const direction: Direction = usdcDelta < 0n && wethDelta > 0n ? 'buy_weth' : 'sell_weth';
			candidates.push({ address: addr, usdcDelta, wethDelta, direction });
		} else if (usdcSignificant && !wethSignificant) {
			// USDC moved but no ERC-20 WETH — the WETH leg may be native ETH.
			usdcOnly.push({ address: addr, usdcDelta });
		}
	}

	const baseResult = {
		txHash,
		thirdTokenSeen,
		transferCount: transfers.length,
		uniqueAddresses: deltas.size,
	};

	const priceOf = (usdcRaw: bigint, wethRaw: bigint) =>
		(Math.abs(Number(usdcRaw)) / 1e6) / (Math.abs(Number(wethRaw)) / 1e18);

	// Exactly one clean USDC↔WETH (ERC-20) trader — the strong case.
	if (candidates.length === 1) {
		const c = candidates[0]!;
		return {
			...baseResult,
			kept: true,
			dropReason: null,
			settledIn: 'WETH',
			trader: c.address as `0x${string}`,
			direction: c.direction,
			usdcAmountRaw: c.usdcDelta,
			wethAmountRaw: c.wethDelta,
			realizedPrice: priceOf(c.usdcDelta, c.wethDelta),
		};
	}

	// Multiple clean USDC↔WETH anchors — ambiguous (batch / split / MM).
	if (candidates.length > 1) {
		const tentative = [...candidates].sort((a, b) => Number(absBI(b.wethDelta) - absBI(a.wethDelta)))[0]!;
		return {
			...baseResult,
			kept: false,
			dropReason: `ambiguous_multiple_anchors (${candidates.length} candidates)`,
			settledIn: null,
			trader: tentative.address as `0x${string}`,
			direction: tentative.direction,
			usdcAmountRaw: tentative.usdcDelta,
			wethAmountRaw: tentative.wethDelta,
			realizedPrice: priceOf(tentative.usdcDelta, tentative.wethDelta),
			ambiguousAnchors: candidates.map((c) => c.address),
		};
	}

	// No ERC-20 WETH anchor. Native-ETH path: a USDC-only trader whose WETH leg
	// settled as native ETH. Value that leg by the trader's EXACT native-ETH delta
	// from the trace when available (precise); otherwise fall back to the wrap-net
	// proxy (Σ Withdrawal−Deposit). Sign must agree — buy (USDC out) ⇒ ETH in (>0);
	// sell (USDC in) ⇒ ETH out (<0).
	if (usdcOnly.length >= 1) {
		const t = [...usdcOnly].sort((a, b) => Number(absBI(b.usdcDelta) - absBI(a.usdcDelta)))[0]!;
		const nativeDelta = nativeEthByAddr?.get(t.address) ?? 0n;
		const wethEquiv = absBI(nativeDelta) >= WETH_DUST_RAW ? nativeDelta : wrapNetRaw;
		if (absBI(wethEquiv) >= WETH_DUST_RAW) {
			const usdcOut = t.usdcDelta < 0n;
			const signsAgree = (usdcOut && wethEquiv > 0n) || (!usdcOut && wethEquiv < 0n);
			if (signsAgree) {
				return {
					...baseResult,
					kept: true,
					dropReason: null,
					settledIn: 'ETH',
					trader: t.address as `0x${string}`,
					direction: usdcOut ? 'buy_weth' : 'sell_weth',
					usdcAmountRaw: t.usdcDelta,
					wethAmountRaw: wethEquiv,
					realizedPrice: priceOf(t.usdcDelta, wethEquiv),
				};
			}
		}
	}

	return {
		...baseResult,
		kept: false,
		dropReason: thirdTokenSeen ? 'routing_hop_third_token' : 'no_clean_anchor',
		settledIn: null,
		trader: null,
		direction: null,
		usdcAmountRaw: null,
		wethAmountRaw: null,
		realizedPrice: null,
	};
}

// ─── Transfer extraction from trace tree ───

interface RawTransfer {
	token: string; // lowercase
	from: string; // checksummed from log
	to: string; // checksummed from log
	value: bigint;
}

interface LogLike {
	address: `0x${string}`;
	data: `0x${string}`;
	topics: readonly `0x${string}`[];
}

/** Decode a flat list of logs (e.g. receipt.logs) into Transfer rows. */
export function decodeTransferLogs(logs: readonly LogLike[]): RawTransfer[] {
	const out: RawTransfer[] = [];
	for (const logEntry of logs) {
		if (
			!logEntry.topics ||
			logEntry.topics.length < 3 ||
			logEntry.topics[0] !== TRANSFER_TOPIC
		) {
			continue;
		}
		try {
			const decoded = decodeEventLog({
				abi: [TRANSFER_EVENT],
				data: logEntry.data,
				topics: logEntry.topics as [`0x${string}`, ...`0x${string}`[]],
			});
			out.push({
				token: logEntry.address.toLowerCase(),
				from: decoded.args.from as string,
				to: decoded.args.to as string,
				value: decoded.args.value as bigint,
			});
		} catch {
			// Non-Transfer log that happened to have the right topic0 — ignore
		}
	}
	return out;
}

/** Net WETH (un)wrapped: Σ Withdrawal.wad − Σ Deposit.wad. Positive = net WETH→ETH
 *  (ETH out); negative = net ETH→WETH (ETH in). `wad` is the non-indexed data word. */
export function collectWrapNet(logs: readonly LogLike[]): bigint {
	let net = 0n;
	for (const l of logs) {
		if (l.address.toLowerCase() !== WETH || !l.topics || l.topics.length === 0) continue;
		if (l.topics[0] === WITHDRAWAL_TOPIC) net += BigInt(l.data);
		else if (l.topics[0] === DEPOSIT_TOPIC) net -= BigInt(l.data);
	}
	return net;
}

/** Exact per-address native-ETH deltas from a callTracer tree: each call's `value`
 *  is a native transfer from→to. Used to value the ETH leg of a USDC↔ETH trade. */
export function collectNativeEthDeltas(trace: TraceNode): Map<string, bigint> {
	const d = new Map<string, bigint>();
	const add = (a: string | undefined, v: bigint) => {
		if (!a) return;
		const k = a.toLowerCase();
		d.set(k, (d.get(k) ?? 0n) + v);
	};
	const visit = (n: TraceNode) => {
		if (n.value && n.value !== '0x' && n.value !== '0x0') {
			const v = BigInt(n.value);
			if (v > 0n) { add(n.from, -v); add(n.to, v); }
		}
		if (n.calls) for (const c of n.calls) visit(c);
	};
	visit(trace);
	return d;
}

/** Flatten every log from a callTracer trace tree into a single ordered list. */
function collectTraceLogs(trace: TraceNode): LogLike[] {
	const out: LogLike[] = [];
	const visit = (node: TraceNode) => {
		if (node.logs) out.push(...node.logs);
		if (node.calls) {
			for (const child of node.calls) visit(child);
		}
	};
	visit(trace);
	return out;
}

// ─── Helpers ───

function absBI(n: bigint): bigint {
	return n < 0n ? -n : n;
}
