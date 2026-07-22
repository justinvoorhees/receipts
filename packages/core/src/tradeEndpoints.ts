/**
 * Shared trade primitives: anchor addresses, the never-a-trader denylist, and the
 * log/trace decoding helpers that `decomposeRoute`, `decompose-trade`, and
 * `endpoints` all build on.
 *
 * This module once owned trade-endpoint extraction too (`extractTradeEndpoints`,
 * a USDC/WETH net-delta classifier from the v2.0 cost model). That approach was
 * superseded by `endpoints.ts#extractEndpoints`, which resolves endpoints for ANY
 * pair rather than assuming a USDC/WETH trade; the dead extractor and its
 * classifier were removed once nothing referenced them.
 */

import { decodeEventLog, parseAbiItem } from 'viem';

// ─── Constants ───
// The anchor addresses have ONE definition, in the receiptPure leaf; re-exported
// here so the route modules that already import from this file are unaffected.
import { USDC, WETH } from './receiptPure.js';
export { USDC, WETH };

const TRANSFER_EVENT = parseAbiItem(
	'event Transfer(address indexed from, address indexed to, uint256 value)',
);
const TRANSFER_TOPIC =
	'0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

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

/**
 * A callTracer node — the canonical definition for the whole package.
 *
 * This shape was previously redeclared in four modules (decomposeRoute,
 * decompose-trade, endpoints, here), three strictly typed and one with loose
 * `string` fields. The mismatch is what forced the `as never` casts at every
 * boundary between them; one definition removes both the drift and the casts.
 * Fields are the union of what those copies read, all optional — a callTracer
 * node populates them per call type.
 */
export interface TraceNode {
	from?: `0x${string}`;
	to?: `0x${string}`;
	value?: `0x${string}`; // native ETH moved by this call
	input?: `0x${string}`;
	output?: `0x${string}`;
	type?: string;
	error?: string;
	logs?: {
		address: `0x${string}`;
		data: `0x${string}`;
		topics: [`0x${string}`, ...`0x${string}`[]] | [];
	}[];
	calls?: TraceNode[];
}

// ─── Transfer extraction from trace tree ───

export interface RawTransfer {
	token: string; // lowercase
	from: string; // checksummed from log
	to: string; // checksummed from log
	value: bigint;
}

export interface LogLike {
	address: `0x${string}`;
	data: `0x${string}`;
	topics: readonly `0x${string}`[];
}

/** Flatten every log from a callTracer trace tree into a single ordered list. */
export function collectTraceLogs(trace: TraceNode): LogLike[] {
	const out: LogLike[] = [];
	const visit = (node: TraceNode) => {
		if (node.logs) out.push(...node.logs);
		if (node.calls) for (const child of node.calls) visit(child);
	};
	visit(trace);
	return out;
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
