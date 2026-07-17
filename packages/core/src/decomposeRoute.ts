/**
 * decomposeRoute.ts — Route-aware cost decomposition orchestrator.
 *
 * Given a trade's debug trace and DB anchors, reconstructs the multi-hop swap
 * route, resolves per-leg LP fee tiers, values leg notionals, and rolls up to
 * trade-level LP + residual Slippage. Reuses the existing `decomposeTrade` for
 * agg-fee detection and gas — does NOT modify decompose-trade.ts.
 *
 * Invariant: all_in = LP + Agg + Slippage (when route is reconstructed).
 */

import { createPublicClient, decodeEventLog, http, parseAbiItem, toEventSelector } from 'viem';
import { base } from 'viem/chains';
import {
	USDC,
	WETH,
	DENYLIST,
	decodeTransferLogs,
} from './tradeEndpoints.js';
import { buildRouteGraph, type RouteShape, type VenueType, type Leg } from './routeGraph.js';
import { valueLegNotionalUsdc, rollupLpFee, type LegFeeInput, type LpRollup } from './legFees.js';
import { decomposeTrade, type DecomposeTradeInput, type DecomposeResult } from './decompose-trade.js';
import { getLegMidAtBlock, makeRpcDecimalsCache, type PairMidResult } from './tokenPricing.js';
import { classifyKnownVenueAddress, classifyV3Factory } from './venueClassification.js';

// ─── Constants ───

const PANCAKE_V3_SWAP_TOPIC = '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83';
const UNI_V3_SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const WETH_DEPOSIT_TOPIC = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c';
const WETH_WITHDRAWAL_TOPIC = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';

/** topic0s emitted BY a market maker's own contract when it fills an RFQ order.
 *  Seed verified on-chain 2026-07-16: emitted 8x by 0x Settler maker proxy
 *  0x69a9f156… in 0xb020…9e26. Extend like venue event-topics — never by address. */
const RFQ_FILL_TOPICS: ReadonlySet<string> = new Set([
	'0x51ab1232a73b82b6b0acb0fa91b834cf6e258a1858c4e23c72ce97241c71aa0d',
]);
/** EIP-1967 implementation slot (keccak256('eip1967.proxy.implementation') - 1). */
const EIP1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

const V4_SWAP_EVENT = parseAbiItem(
	'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
);
const V4_SWAP_TOPIC = toEventSelector(V4_SWAP_EVENT);

const V2_SWAP_TOPIC =
	'0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
const AERODROME_SWAP_TOPIC =
	'0xb3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b';
const MAVERICK_V2_SWAP_TOPIC =
	'0x103ed084e94a44c8f5f6ba8e3011507c41063177e29949083c439777d8d63f60';
const MAVERICK_V1_SWAP_TOPIC =
	'0x3b841dc9ab51e3104bda4f61b41e4271192d22cd19da5ee6e292dc8e2744f713';
const UNIPOOL_SWAP_TOPIC =
	'0xdbad2ddd1b3cac36de15036b12f92d5f32b447fc9cd0c1a72467d15bc04dc812';

/**
 * Curve StableSwap `TokenExchange(address,int128,uint256,int128,uint256)`.
 * Emitted by every StableSwap-family pool (including StableNG), so tagging on
 * the event covers pools we have never seen before. Curve's crypto pools use a
 * same-named event with uint256 ids, which hashes differently and is not
 * matched here.
 */
const CURVE_TOKEN_EXCHANGE_TOPIC =
	'0x8b3e96f2b889fa771c53c981b40daf005f63f637f1869f707052d15a3dd97140';

const UNISWAP_V4_POOL_MANAGER =
	'0x498581ff718922c3f8e6a244956af099b2652b2b';

const LEG_FEE_CAP_BPS = 300;

/**
 * Per-leg price-impact above this magnitude (in either direction) indicates a
 * bad or stale reference mid — e.g. RFQ legs priced off a stale discovery pool.
 * Null it out rather than persist garbage.
 */
const PI_IMPLAUSIBLE_CAP_BPS = 500;

/** Reconciliation residual tolerance (bps): within this → keep high confidence. */
const RECON_TOL_BPS = 5;

/** Large reconciliation threshold (bps): above this → force low confidence. */
const RECON_LOW_BPS = 25;

// ─── Interfaces ───

interface TraceNode {
	from?: `0x${string}`;
	to?: `0x${string}`;
	value?: `0x${string}`;
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

interface LogLike {
	address: `0x${string}`;
	data: `0x${string}`;
	topics: readonly `0x${string}`[];
}

export interface RouteDecomposeResult {
	lpFeeBps: number | null;
	aggFeeBps: number;
	slippageBps: number | null;
	executionBps: number | null;
	gasBps: number;
	routeShape: RouteShape;
	hopCount: number;
	legs: (LegFeeInput & { lpFeeBps: number | null; priceImpactBps: number | null })[];
	reconResidualBps: number | null;
	confidence: 'high' | 'medium' | 'low';
	flags: string[];
	/** Dominant fee-sink address (max retained value) that `aggFeeBps` is attributed to, or null when no fee sink was detected. */
	feeRecipient: string | null;
	/** How the dominant fee sink was detected: 'vault_map' | 'retained_balance', or null. */
	feeSinkSource: string | null;
}

/** Injectable dependencies for testing without live RPC. */
export interface DecomposeRouteDeps {
	/** Pre-fetched trace (skip RPC call). */
	trace?: TraceNode;
	/** Custom fee-tier reader. Signature: (poolAddr, venueType, v4FeeRaw?) → { bps, defaulted }. */
	feeReader?: (addr: string, type: VenueType, v4FeeRaw?: number) => Promise<{ bps: number; defaulted: boolean }> | { bps: number; defaulted: boolean };
	/** Custom V3-style factory reader. Signature: (poolAddr) → factory address. */
	v3FactoryReader?: (addr: string) => Promise<string | null> | string | null;
	/** Custom mid-price reader. Signature: (leg, blockNumber) → PairMidResult | null. */
	midReader?: (leg: Leg, blockNumber: bigint) => Promise<PairMidResult | null> | PairMidResult | null;
	/** Custom decimals reader (for realized-price computation). Falls back to inline USDC=6/else=18. */
	decimalsReader?: (token: string) => Promise<number> | number;
	/** Structural maker probe for the rfq retype pass (block-pinned in production). */
	rfqProbe?: (addr: string) => Promise<'eoa' | 'proxy1967' | 'contract'> | 'eoa' | 'proxy1967' | 'contract';
}

// ─── Helpers ───

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

/** Extract native ETH value transfers from a callTracer tree, modeled as WETH
 *  transfers so the ERC-20-only route graph can see native-settled legs. Skips
 *  delegate/static calls (no value), reverted frames, and zero-value frames. */
export function extractNativeTransfers(trace: TraceNode): { token: string; from: string; to: string; value: bigint }[] {
	const out: { token: string; from: string; to: string; value: bigint }[] = [];
	const visit = (node: TraceNode) => {
		const type = node.type ?? '';
		const moves = type === 'CALL' || type === 'CALLCODE';
		if (moves && !node.error && node.value && node.from && node.to) {
			const value = BigInt(node.value);
			if (value > 0n) {
				out.push({ token: WETH, from: node.from.toLowerCase(), to: node.to.toLowerCase(), value });
			}
		}
		if (node.calls) for (const child of node.calls) visit(child);
	};
	visit(trace);
	return out;
}

/** Detect WETH wrap (Deposit) / unwrap (Withdrawal) events. At most one of each,
 *  amounts summed. Emitted as informational, zero-cost route steps. */
export function detectWrapUnwrapSteps(
	logs: readonly { address: string; topics: readonly string[]; data: string }[],
): { kind: 'wrap' | 'unwrap'; amountRaw: bigint }[] {
	let wrap = 0n, unwrap = 0n, sawWrap = false, sawUnwrap = false;
	for (const log of logs) {
		if (log.address.toLowerCase() !== WETH) continue;
		const t0 = log.topics[0];
		if (t0 === WETH_DEPOSIT_TOPIC) { wrap += BigInt(log.data); sawWrap = true; }
		else if (t0 === WETH_WITHDRAWAL_TOPIC) { unwrap += BigInt(log.data); sawUnwrap = true; }
	}
	const steps: { kind: 'wrap' | 'unwrap'; amountRaw: bigint }[] = [];
	if (sawWrap) steps.push({ kind: 'wrap', amountRaw: wrap });
	if (sawUnwrap) steps.push({ kind: 'unwrap', amountRaw: unwrap });
	return steps;
}

/** Build a display-only leg entry for a wrap/unwrap step (null costs). */
function wrapUnwrapToLegEntry(
	step: { kind: 'wrap' | 'unwrap'; amountRaw: bigint },
): LegFeeInput & { lpFeeBps: number | null; priceImpactBps: number | null } {
	const isWrap = step.kind === 'wrap';
	return {
		leg: {
			venue: WETH,
			type: step.kind,
			tokenIn: isWrap ? 'native' : WETH,
			tokenOut: isWrap ? WETH : 'native',
			amountInRaw: step.amountRaw,
			amountOutRaw: step.amountRaw,
		},
		feeTierBps: 0,
		notionalUsdc: 0,
		notionalApprox: true,
		lpFeeBps: null,
		priceImpactBps: null,
	};
}

/** Best-effort uncosted "pools touched" entries for a route that could not be
 *  costed. One entry per detected venue; token pair filled only for a clean
 *  1-in-1-out net flow.
 *  Invariant: `venues` keys must already be lowercase — this function does not
 *  normalize them itself. `scanVenues` (and its augmenting helpers) always
 *  lowercase venue addresses before inserting, so this holds for all current
 *  callers. */
export function venuesToUncostedLegs(
	venues: Map<string, { type: VenueType }>,
	transfers: { token: string; from: string; to: string; value: bigint }[],
): (LegFeeInput & { lpFeeBps: null; priceImpactBps: null })[] {
	const net = new Map<string, Map<string, bigint>>();
	for (const t of transfers) {
		const from = t.from.toLowerCase(), to = t.to.toLowerCase(), tok = t.token.toLowerCase();
		if (!net.has(from)) net.set(from, new Map());
		if (!net.has(to)) net.set(to, new Map());
		net.get(from)!.set(tok, (net.get(from)!.get(tok) ?? 0n) - t.value);
		net.get(to)!.set(tok, (net.get(to)!.get(tok) ?? 0n) + t.value);
	}
	const out: (LegFeeInput & { lpFeeBps: null; priceImpactBps: null })[] = [];
	for (const [addr, info] of venues) {
		const m = net.get(addr.toLowerCase());
		let tokenIn = '', tokenOut = '';
		if (m) {
			const recv = [...m].filter(([, d]) => d > 0n).map(([t]) => t);
			const sent = [...m].filter(([, d]) => d < 0n).map(([t]) => t);
			if (recv.length === 1 && sent.length === 1) { tokenIn = recv[0]!; tokenOut = sent[0]!; }
		}
		out.push({
			leg: { venue: addr, type: info.type, tokenIn, tokenOut, amountInRaw: 0n, amountOutRaw: 0n },
			feeTierBps: 0, notionalUsdc: 0, notionalApprox: true, lpFeeBps: null, priceImpactBps: null,
		});
	}
	return out;
}

/** Simple decimals lookup for known tokens. */
function decimalsOf(token: string): number {
	if (token === USDC) return 6;
	return 18; // WETH and all others default to 18
}

// ─── Venue scanning ───

interface VenueInfo {
	type: VenueType;
	v4PoolId?: string;
	v4FeeRaw?: number;
}

/**
 * Scan trace logs for Swap events and build a venue map.
 * Recognizes: Uni V3, PancakeSwap V3, Uni V4, V2, Aerodrome.
 */
function scanVenues(logs: readonly LogLike[], recognizeForks: boolean): Map<string, VenueInfo> {
	const venues = new Map<string, VenueInfo>();

	for (const log of logs) {
		if (!log.topics || log.topics.length === 0) continue;
		const topic0 = log.topics[0]!.toLowerCase();
		const addr = log.address.toLowerCase();

		// Uni V3 Swap
		if (topic0 === UNI_V3_SWAP_TOPIC && log.topics.length >= 3) {
			if (!venues.has(addr)) {
				venues.set(addr, { type: 'univ3' });
			}
		}

		// PancakeSwap V3 Swap (only when fork recognition enabled)
		if (recognizeForks && topic0 === PANCAKE_V3_SWAP_TOPIC && log.topics.length >= 3) {
			if (!venues.has(addr)) {
				venues.set(addr, { type: 'pancakev3' });
			}
		}

		// Uni V4 Swap (emitted by PoolManager)
		if (topic0 === V4_SWAP_TOPIC && log.topics.length >= 3) {
			try {
				const decoded = decodeEventLog({
					abi: [V4_SWAP_EVENT],
					data: log.data,
					topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
				});
				const poolId = decoded.args.id as string;
				const fee = Number(decoded.args.fee);
				// V4 PoolManager can host multiple pools; use the latest fee info
				venues.set(addr, {
					type: 'univ4',
					v4PoolId: poolId,
					v4FeeRaw: fee,
				});
			} catch {
				// Malformed V4 event — set basic venue info
				if (!venues.has(addr)) {
					venues.set(addr, { type: 'univ4' });
				}
			}
		}

		// V2 Swap
		if (topic0 === V2_SWAP_TOPIC) {
			if (!venues.has(addr)) {
				venues.set(addr, { type: 'univ2' });
			}
		}

		// Aerodrome Swap
		if (topic0 === AERODROME_SWAP_TOPIC) {
			if (!venues.has(addr)) {
				venues.set(addr, { type: 'aerodrome' });
			}
		}

		// Maverick V2 PoolSwap
		if (topic0 === MAVERICK_V2_SWAP_TOPIC) {
			if (!venues.has(addr)) {
				venues.set(addr, { type: 'maverickv2' });
			}
		}

		// Maverick V1 Swap
		if (topic0 === MAVERICK_V1_SWAP_TOPIC) {
			if (!venues.has(addr)) {
				venues.set(addr, { type: 'maverickv1' });
			}
		}

		// UniPool Swap
		if (topic0 === UNIPOOL_SWAP_TOPIC) {
			if (!venues.has(addr)) {
				venues.set(addr, { type: 'unipool' });
			}
		}

		// Curve TokenExchange
		if (topic0 === CURVE_TOKEN_EXCHANGE_TOPIC) {
			if (!venues.has(addr)) {
				venues.set(addr, { type: 'curve_stableng' });
			}
		}
	}

	return venues;
}

function addKnownVenuesFromTransfers(
	venues: Map<string, VenueInfo>,
	transfers: { from: string; to: string }[],
): void {
	for (const transfer of transfers) {
		for (const addr of [transfer.from, transfer.to]) {
			const venueType = classifyKnownVenueAddress(addr);
			if (venueType != null && !venues.has(addr.toLowerCase())) {
				venues.set(addr.toLowerCase(), { type: venueType });
			}
		}
	}
}

async function addKnownFactoryVenuesFromTransfers(
	venues: Map<string, VenueInfo>,
	transfers: { from: string; to: string }[],
	factoryReader: (addr: string) => Promise<string | null> | string | null,
): Promise<void> {
	const candidates = new Set<string>();
	for (const transfer of transfers) {
		candidates.add(transfer.from.toLowerCase());
		candidates.add(transfer.to.toLowerCase());
	}
	for (const addr of candidates) {
		if (venues.has(addr)) continue;
		const factory = await factoryReader(addr);
		const venueType = classifyV3Factory(factory);
		if (venueType !== 'univ3') {
			venues.set(addr, { type: venueType });
		}
	}
}

async function refineV3VenueTypes(
	venues: Map<string, VenueInfo>,
	factoryReader: (addr: string) => Promise<string | null> | string | null,
): Promise<void> {
	for (const [addr, info] of venues) {
		if (info.type !== 'univ3') continue;
		const factory = await factoryReader(addr);
		const refinedType = classifyV3Factory(factory);
		if (refinedType !== info.type) {
			venues.set(addr, { ...info, type: refinedType });
		}
	}
}

// ─── Default fee reader (live RPC) ───

function createDefaultFeeReader(rpcUrl: string, blockNumber: bigint): (addr: string, type: VenueType, v4FeeRaw?: number) => Promise<{ bps: number; defaulted: boolean }> {
	const rpc = createPublicClient({ chain: base, transport: http(rpcUrl) });

	return async (addr: string, type: VenueType, v4FeeRaw?: number): Promise<{ bps: number; defaulted: boolean }> => {
		switch (type) {
			case 'univ3':
			case 'sushiv3':
			case 'baseswapv3':
			case 'pancakev3':
			// Hydrex is Algebra Integral: fee() returns the currently effective
			// fee (including any plugin override) on the same 1e6 scale as v3.
			case 'hydrex': {
				try {
					const fee = await rpc.readContract({
						address: addr as `0x${string}`,
						abi: [parseAbiItem('function fee() view returns (uint24)')],
						functionName: 'fee',
						blockNumber,
					});
					return { bps: Number(fee) / 100, defaulted: false };
				} catch {
					return { bps: 0, defaulted: false };
				}
			}
			case 'aerodrome_cl': {
				try {
					const fee = await rpc.readContract({
						address: addr as `0x${string}`,
						abi: [parseAbiItem('function fee() view returns (uint24)')],
						functionName: 'fee',
						blockNumber,
					});
					return { bps: Number(fee) / 100, defaulted: false };
				} catch {
					return { bps: 0, defaulted: true };
				}
			}
			case 'curve_stableng': {
				try {
					const fee = await rpc.readContract({
						address: addr as `0x${string}`,
						abi: [parseAbiItem('function fee() view returns (uint256)')],
						functionName: 'fee',
						blockNumber,
					});
					return { bps: Number(fee) / 1_000_000, defaulted: false };
				} catch {
					return { bps: 0, defaulted: true };
				}
			}
			case 'maverickv2': {
				try {
					const fee = await rpc.readContract({
						address: addr as `0x${string}`,
						abi: [parseAbiItem('function fee(bool tokenAIn) view returns (uint256)')],
						functionName: 'fee',
						args: [true],
						blockNumber,
					});
					return { bps: Number(fee) / 100_000_000_000_000, defaulted: false };
				} catch {
					return { bps: 0, defaulted: true };
				}
			}
			case 'maverickv1': {
				// Same 1e18-scaled fraction as v2, but v1's fee() takes no side arg.
				try {
					const fee = await rpc.readContract({
						address: addr as `0x${string}`,
						abi: [parseAbiItem('function fee() view returns (uint256)')],
						functionName: 'fee',
						blockNumber,
					});
					return { bps: Number(fee) / 100_000_000_000_000, defaulted: false };
				} catch {
					return { bps: 0, defaulted: true };
				}
			}
			// UniPool exposes no fee getter we can read; its LP fee stays unresolved.
			case 'unipool':
				return { bps: 0, defaulted: true };
			case 'univ4':
				return { bps: v4FeeRaw !== undefined ? v4FeeRaw / 100 : 0, defaulted: false };
			case 'univ2':
				// 30 bps is the canonical V2 fee, not a guess
				return { bps: 30, defaulted: false };
			case 'aerodrome': {
				// Aerodrome pools expose fee via stable/volatile classification.
				// Falling back to 30 bps is a guess — signal defaulted.
				return { bps: 30, defaulted: true };
			}
			case 'rfq':
				return { bps: 0, defaulted: false };
			case 'unknown':
			default:
				return { bps: 0, defaulted: true };
		}
	};
}

function createDefaultV3FactoryReader(rpcUrl: string, blockNumber: bigint): (addr: string) => Promise<string | null> {
	if (rpcUrl === 'unused') {
		return async () => null;
	}
	const rpc = createPublicClient({ chain: base, transport: http(rpcUrl) });

	return async (addr: string): Promise<string | null> => {
		try {
			const factory = await rpc.readContract({
				address: addr as `0x${string}`,
				abi: [parseAbiItem('function factory() view returns (address)')],
				functionName: 'factory',
				blockNumber,
			});
			return String(factory);
		} catch {
			return null;
		}
	};
}

function createDefaultRfqProbe(rpcUrl: string, blockNumber: bigint): (addr: string) => Promise<'eoa' | 'proxy1967' | 'contract'> {
	if (rpcUrl === 'unused' || rpcUrl === 'http://invalid') {
		return async () => 'contract';
	}
	const rpc = createPublicClient({ chain: base, transport: http(rpcUrl) });
	return async (addr: string): Promise<'eoa' | 'proxy1967' | 'contract'> => {
		try {
			const code = await rpc.getBytecode({ address: addr as `0x${string}`, blockNumber });
			if (!code || code === '0x') return 'eoa';
			const slot = await rpc.getStorageAt({ address: addr as `0x${string}`, slot: EIP1967_IMPL_SLOT as `0x${string}`, blockNumber });
			if (slot != null && BigInt(slot) !== 0n) return 'proxy1967';
			return 'contract';
		} catch {
			return 'contract'; // fail closed: an unprobeable address stays `unknown`
		}
	};
}

// ─── Default mid reader (live RPC) ───

export function createDefaultMidReader(
	rpcUrl: string,
	blockNumber: bigint,
): {
	midReader: (leg: Leg, atBlock: bigint) => Promise<PairMidResult | null>;
	decimalsReader: (token: string) => Promise<number>;
} {
	const rpc = createPublicClient({ chain: base, transport: http(rpcUrl) });
	const decCache = makeRpcDecimalsCache(rpc as never);

	return {
		midReader: async (
			leg: Leg,
			atBlock: bigint,
		): Promise<PairMidResult | null> => {
			try {
				return await getLegMidAtBlock(
					rpc as never,
					leg,
					atBlock,
					decCache,
				);
			} catch {
				// RPC failure (e.g. invalid URL in test) — treat as no mid available
				return null;
			}
		},
		decimalsReader: decCache,
	};
}

// ─── V4 settlement proxy resolution ───

/**
 * V4 PoolManager does token settlement via internal bookkeeping: the "swapper"
 * (aggregator executor) calls take/settle on the PM, and actual ERC-20 transfers
 * originate from the executor, not the PM. This means:
 *   - V4 PM net-receives tokenIn but never net-sends tokenOut (no ERC-20 out)
 *   - A settlement proxy net-sends tokenOut but net-receives nothing
 *
 * We detect this pattern and rewrite the transfers so that V4 PM is the source
 * of the outgoing tokens, enabling buildRouteGraph to chain the V4 leg correctly.
 * Settlement proxies are added to the local denylist so they don't appear as
 * spurious RFQ fillers.
 */
function resolveV4Settlement(
	transfers: { token: string; from: string; to: string; value: bigint }[],
	venues: Map<string, VenueInfo>,
	trader: string,
	denylist: ReadonlySet<string>,
): {
	transfers: { token: string; from: string; to: string; value: bigint }[];
	extendedDenylist: Set<string>;
} {
	const traderLc = trader.toLowerCase();
	const v4Venue = venues.get(UNISWAP_V4_POOL_MANAGER);
	if (!v4Venue) {
		return { transfers, extendedDenylist: new Set(denylist) };
	}

	// Compute per-address per-token net deltas
	const deltas = new Map<string, Map<string, bigint>>();
	for (const t of transfers) {
		const from = t.from.toLowerCase();
		const to = t.to.toLowerCase();
		const token = t.token.toLowerCase();
		if (!deltas.has(from)) deltas.set(from, new Map());
		if (!deltas.has(to)) deltas.set(to, new Map());
		deltas.get(from)!.set(token, (deltas.get(from)!.get(token) ?? 0n) - t.value);
		deltas.get(to)!.set(token, (deltas.get(to)!.get(token) ?? 0n) + t.value);
	}

	// Check V4 PM: does it only have net-received tokens (no net-sent)?
	const pmDeltas = deltas.get(UNISWAP_V4_POOL_MANAGER);
	if (!pmDeltas) {
		return { transfers, extendedDenylist: new Set(denylist) };
	}

	// Check if PM has any net-sent tokens (both sides present → no fix needed)
	let pmHasSent = false;
	for (const [, delta] of pmDeltas) {
		if (delta < 0n) { pmHasSent = true; break; }
	}

	if (pmHasSent) {
		return { transfers, extendedDenylist: new Set(denylist) };
	}

	// Find settlement proxies: non-venue, non-denylist, non-trader addresses
	// that have ONLY net-sent tokens (no net-received)
	const proxyAddrs = new Set<string>();
	for (const [addr, tokenMap] of deltas) {
		if (addr === traderLc) continue;
		if (addr === UNISWAP_V4_POOL_MANAGER) continue;
		if (denylist.has(addr)) continue;
		if (venues.has(addr)) continue;
		// Token contracts themselves
		if (addr === USDC || addr === WETH) continue;

		let hasReceived = false;
		let hasSent = false;
		for (const [, delta] of tokenMap) {
			if (delta > 0n) hasReceived = true;
			if (delta < 0n) hasSent = true;
		}
		// Settlement proxy: only sends, never receives net
		if (hasSent && !hasReceived) {
			proxyAddrs.add(addr);
		}
	}

	if (proxyAddrs.size === 0) {
		return { transfers, extendedDenylist: new Set(denylist) };
	}

	// Rewrite transfers: remove all proxy-involved transfers, then add
	// synthetic V4_PM↔X transfers for the proxy's outgoing flows.
	// For incoming flows to the proxy, redirect to V4 PM.
	const rewritten: typeof transfers = [];
	for (const t of transfers) {
		const fromLc = t.from.toLowerCase();
		const toLc = t.to.toLowerCase();
		const isFromProxy = proxyAddrs.has(fromLc);
		const isToProxy = proxyAddrs.has(toLc);

		if (isFromProxy && isToProxy) {
			// Self-transfer within proxies — drop
			continue;
		} else if (isFromProxy) {
			// Proxy sends → replace with V4 PM sends.
			// BUT if the destination is already V4 PM, the rewrite produces a
			// self-transfer (PM → PM) which double-counts the gross flow. Drop it.
			if (toLc === UNISWAP_V4_POOL_MANAGER) continue;
			rewritten.push({ ...t, from: UNISWAP_V4_POOL_MANAGER });
		} else if (isToProxy) {
			// Something sends to proxy → replace with something sends to V4 PM
			rewritten.push({ ...t, to: UNISWAP_V4_POOL_MANAGER });
		} else {
			rewritten.push(t);
		}
	}

	// Extend denylist with proxy addresses
	const extDenylist = new Set(denylist);
	for (const addr of proxyAddrs) {
		extDenylist.add(addr);
	}

	return { transfers: rewritten, extendedDenylist: extDenylist };
}

/**
 * Per-leg price impact as a notional-weighted contribution to the trade-level
 * cost, mirroring the LP-fee rollup weighting. For a linear leg (notional ≈ the
 * trade notional) the weight is ≈1, so this reduces to the raw impact; for
 * split/convergent legs it scales by the leg's share of the flow, so the raw
 * sum of per-leg costs reconciles with the trade-level all-in.
 */
export function weightedPriceImpactBps(
	legTotalCostBps: number,
	feeTierBps: number,
	legNotionalUsdc: number,
	tradeNotionalUsdc: number,
): number {
	const raw = legTotalCostBps - feeTierBps;
	return tradeNotionalUsdc > 0 ? raw * (legNotionalUsdc / tradeNotionalUsdc) : raw;
}

// ─── Main orchestrator ───

export async function decomposeRoute(
	input: DecomposeTradeInput,
	deps?: DecomposeRouteDeps,
): Promise<RouteDecomposeResult> {
	const routeFlags: string[] = [];

	// Step 1: Get base decomposition from decomposeTrade (reuse agg fee, gas, flags)
	const base = await decomposeTrade(input);

	// Identify the dominant fee sink (largest retained value) that `aggFeeBps` is
	// attributed to, so the receipt can record WHO received the fee, not just how
	// much. Null when no fee sink was detected.
	const dominantSink = base.feeSinks.length > 0
		? base.feeSinks.reduce((max, s) => (s.totalUsdc > max.totalUsdc ? s : max))
		: null;
	const feeRecipient = dominantSink?.address ?? null;
	const feeSinkSource = dominantSink?.source ?? null;

	// Step 2: Get trace (injected or from input)
	const trace = (deps?.trace ?? input.trace) as TraceNode;

	// Step 3: Collect logs, decode transfers, scan venues
	const logs = collectTraceLogs(trace);
	const rawTransfers = decodeTransferLogs(logs as any);
	const venues = scanVenues(logs, input.recognizeV3Forks ?? false);
	addKnownVenuesFromTransfers(venues, rawTransfers);
	const v3FactoryReader = deps?.v3FactoryReader ?? createDefaultV3FactoryReader(input.rpcUrl, input.blockNumber);
	await addKnownFactoryVenuesFromTransfers(venues, rawTransfers, v3FactoryReader);
	await refineV3VenueTypes(
		venues,
		v3FactoryReader,
	);

	// Wrap/unwrap informational steps: detected once from logs, appended
	// (never chained/costed) at both return sites below.
	const wrapUnwrapSteps = detectWrapUnwrapSteps(logs);
	const wrapEntries = wrapUnwrapSteps.filter((s) => s.kind === 'wrap').map(wrapUnwrapToLegEntry);
	const unwrapEntries = wrapUnwrapSteps.filter((s) => s.kind === 'unwrap').map(wrapUnwrapToLegEntry);

	// Step 3a: Model native ETH value transfers as WETH so the ERC-20-only route
	// graph can chain native-settled legs (e.g. a Uniswap V4 pool paying ETH).
	const nativeTransfers = extractNativeTransfers(trace);
	const rawTransfersWithNative = [...rawTransfers, ...nativeTransfers];

	// Step 3b: Resolve V4 settlement proxies — rewrite transfers so V4 PM
	// appears as the source of outgoing tokens instead of the executor
	const { transfers, extendedDenylist } = resolveV4Settlement(
		rawTransfersWithNative, venues, input.trader, DENYLIST,
	);

	// Step 4: Build route graph
	const graph = buildRouteGraph({
		transfers,
		trader: input.trader,
		venues,
		denylist: extendedDenylist,
	});

	// Round-trip netted legs (e.g. RFQ maker change flows): surface a per-leg
	// flag; the reconstructed branch caps confidence at medium because netted
	// amounts are an interpretation of the flows, not an observation.
	const nettedLegs = graph.legs.filter((l) => l.amountsNetted);
	for (const l of nettedLegs) {
		routeFlags.push(`LEG_AMOUNTS_NETTED: leg ${l.venue.slice(0, 10)} had round-trip flows; amounts use net deltas`);
	}

	// Step 4b: retype market-maker fills. A 1-in-1-out counterparty typed
	// `unknown` is re-typed `rfq` when it is provably a maker: tier 1 — it
	// emitted a known maker-fill event in THIS tx (no RPC); tier 2 — it is an
	// EOA or an EIP-1967 proxy at the trade block. Real AMM pools (plain
	// contracts, impl slot 0) stay `unknown`. ⚠️ "emitted no logs" is NOT a
	// maker signal — measured backwards on 0xb020…9e26 (the maker emitted 8
	// logs; the real pool emitted 0). See spec 2026-07-16-rfq-maker-legs.
	const rfqProbe = deps?.rfqProbe ?? createDefaultRfqProbe(input.rpcUrl, input.blockNumber);
	const fillEmitters = new Set<string>();
	for (const log of logs) {
		const topic0 = log.topics?.[0]?.toLowerCase();
		if (topic0 && RFQ_FILL_TOPICS.has(topic0)) fillEmitters.add(log.address.toLowerCase());
	}
	for (const leg of graph.legs) {
		if (leg.type !== 'unknown') continue;
		const isMaker = fillEmitters.has(leg.venue) || (await rfqProbe(leg.venue)) !== 'contract';
		if (!isMaker) continue;
		leg.type = 'rfq';
		routeFlags.push(`RFQ_LEG_UNPRICED: leg ${leg.venue.slice(0, 10)} — off-chain quote, no on-chain mid exists`);
	}

	// Step 5: Resolve fee tiers for each leg
	const feeReader = deps?.feeReader ?? createDefaultFeeReader(input.rpcUrl, input.blockNumber);
	let allFeesResolved = true;

	const legFeeInputs: LegFeeInput[] = [];
	for (const leg of graph.legs) {
		// Resolve fee tier
		const feeResult = await feeReader(leg.venue, leg.type, leg.v4FeeRaw);
		const feeTierBps = feeResult.bps;

		if (feeResult.defaulted) {
			allFeesResolved = false;
			if (leg.type === 'aerodrome') {
				routeFlags.push(`AERO_FEE_DEFAULTED: leg ${leg.venue.slice(0, 10)} used 30bps default`);
			}
		}

		// Value the leg's notional in USDC
		const { notionalUsdc, approx } = valueLegNotionalUsdc(
			leg,
			input.realizedPrice,
			input.notionalUsdc,
			decimalsOf,
		);

		legFeeInputs.push({
			leg,
			feeTierBps,
			notionalUsdc,
			notionalApprox: approx,
		});
	}

	// Step 6: Roll up LP fee
	const rollup = rollupLpFee(legFeeInputs, input.notionalUsdc);

	// Step 7: Build per-leg LP contributions (priceImpactBps populated in Step 9)
	const legsWithLp: (LegFeeInput & { lpFeeBps: number; priceImpactBps: number | null })[] =
		legFeeInputs.map((lfi) => ({
			...lfi,
			lpFeeBps: (lfi.feeTierBps * lfi.notionalUsdc) / input.notionalUsdc,
			priceImpactBps: null,
		}));

	// Step 8: Branch on reconstruction (Design Decision 7)
	const gasBps = input.notionalUsdc > 0
		? (input.gasCostUsd / input.notionalUsdc) * 10_000
		: 0;

	if (graph.reconstructed) {
		const lpFeeBps = rollup.lpFeeBps;
		const slippageBps = input.allInCostBps - lpFeeBps - base.aggFeeBps;

		// Step 9: Per-leg price-impact attribution
		// Uses injected midReader (test stubs or production callers create one).
		// When no midReader is provided, per-leg pricing is skipped (all null),
		// reconResidualBps stays null, and confidence is unchanged.
		const midReader = deps?.midReader ?? null;
		let hasNullMid = !midReader; // no reader → treat as all-null (skip loop body)
		let hasRfqLeg = false;       // rfq legs are DELIBERATELY unpriced — tracked separately

		const decReader = deps?.decimalsReader ?? null;
		for (const lwl of legsWithLp) {
			if (!midReader) continue;
			const leg = lwl.leg;
			// RFQ fills are quoted off-chain: there is no pool mid to compare to.
			// Null is deliberate (flagged RFQ_LEG_UNPRICED at retype), NOT a
			// pricing failure — do not set hasNullMid, do not call the midReader.
			if (leg.type === 'rfq') {
				lwl.priceImpactBps = null;
				hasRfqLeg = true;
				continue;
			}
			// Use RPC-backed decimals when available, else fall back to inline
			const decIn = decReader ? await decReader(leg.tokenIn) : decimalsOf(leg.tokenIn);
			const decOut = decReader ? await decReader(leg.tokenOut) : decimalsOf(leg.tokenOut);

			// Guard: amountInRaw === 0 → div-by-zero; skip this leg
			if (leg.amountInRaw === 0n) {
				lwl.priceImpactBps = null;
				hasNullMid = true;
				routeFlags.push(`AMOUNT_IN_ZERO: leg ${leg.venue.slice(0, 10)} has zero amountInRaw`);
				continue;
			}

			// Realized price: tokenOut per tokenIn in human units
			const realizedPrice = (Number(leg.amountOutRaw) / 10 ** decOut) /
				(Number(leg.amountInRaw) / 10 ** decIn);

			// Reference mid at block N-1 from the leg's own pool
			const midResult = await midReader(leg, input.blockNumber - 1n);

			if (midResult === null || midResult.price <= 0) {
				lwl.priceImpactBps = null;
				hasNullMid = true;
				routeFlags.push(`MID_NULL: leg ${leg.venue.slice(0, 10)} has no reference mid for ${leg.tokenIn.slice(0, 10)}→${leg.tokenOut.slice(0, 10)}`);
				continue;
			}

			// Leg total cost bps = (mid − realized) / mid × 10000
			// Positive = cost (less output than expected); negative = improvement.
			const legTotalCostBps = (midResult.price - realizedPrice) / midResult.price * 10_000;

			// Price impact = total cost − fee tier (LP fee is the "expected" cost),
			// notional-weighted so per-leg costs reconcile for split/convergent DAGs.
			const rawImpactBps = legTotalCostBps - lwl.feeTierBps;
			lwl.priceImpactBps = weightedPriceImpactBps(legTotalCostBps, lwl.feeTierBps, lwl.notionalUsdc, input.notionalUsdc);

			// Clamp implausible per-leg price-impact (stale-mid guard) on the RAW
			// per-leg impact, so the plausibility guard is independent of notional size.
			if (Math.abs(rawImpactBps) > PI_IMPLAUSIBLE_CAP_BPS) {
				routeFlags.push(
					`PI_IMPLAUSIBLE: leg ${leg.venue.slice(0, 10)} pi=${rawImpactBps.toFixed(1)} exceeds cap ${PI_IMPLAUSIBLE_CAP_BPS}`,
				);
				lwl.priceImpactBps = null;
				hasNullMid = true;
			}
		}

		// Step 10: Reconciliation residual
		// reconResidualBps = allIn − (Σ legLpFeeBps + Σ legPriceImpactBps + aggFeeBps)
		// Only computed when all legs have valid mids.
		let reconResidualBps: number | null = null;
		// An rfq leg's spread is real cost that per-leg PI cannot see; a residual
		// would just re-absorb it and trigger a spurious RECON_LOW downgrade.
		if (!hasNullMid && !hasRfqLeg && legsWithLp.some((l) => l.priceImpactBps !== null)) {
			const sumLp = legsWithLp.reduce((s, l) => s + l.lpFeeBps, 0);
			const sumImpact = legsWithLp.reduce((s, l) => s + (l.priceImpactBps ?? 0), 0);
			reconResidualBps = input.allInCostBps - (sumLp + sumImpact + base.aggFeeBps);
		}

		// Confidence assessment
		let confidence: 'high' | 'medium' | 'low' = 'high';

		// Downgrade to medium if any leg has approximate notional or defaulted fee
		const hasApproxLegs = legFeeInputs.some((lfi) => lfi.notionalApprox);
		if (hasApproxLegs || !allFeesResolved) {
			confidence = 'medium';
		}

		// Netted leg amounts (round-trip flows) are inferred — cap at medium.
		if (nettedLegs.length > 0 && confidence === 'high') {
			confidence = 'medium';
		}

		// Per-leg LP sanity: if any leg's contribution exceeds 300 bps, flag
		for (const lfi of legsWithLp) {
			if (lfi.lpFeeBps > LEG_FEE_CAP_BPS) {
				routeFlags.push(
					`LEG_FEE_IMPLAUSIBLE: leg ${lfi.leg.venue.slice(0, 10)} contributes ` +
					`${lfi.lpFeeBps.toFixed(2)} bps (cap=${LEG_FEE_CAP_BPS})`,
				);
				confidence = 'low';
			}
		}

		// Reconciliation-based confidence downgrade (only when mid reader was
		// injected or returned data — all-null means no pricing data available,
		// which doesn't itself warrant a downgrade since LP/slippage are still valid)
		const hasSomeMid = legsWithLp.some((l) => l.priceImpactBps !== null);
		if (hasNullMid && hasSomeMid) {
			// Partial pricing: some legs have mids but not all → incomplete recon
			confidence = 'low';
		} else if (reconResidualBps !== null) {
			const absResidual = Math.abs(reconResidualBps);
			if (absResidual > RECON_LOW_BPS) {
				confidence = 'low';
			} else if (absResidual > RECON_TOL_BPS && confidence === 'high') {
				confidence = 'medium';
			}
		}

		// hopCount: for a parallel split the legs are concurrent (one token-step
		// across N pools), so hopCount = 1; for single/linear it equals leg count.
		const hopCount = graph.shape === 'split' ? 1 : graph.legs.length;

		return {
			lpFeeBps,
			aggFeeBps: base.aggFeeBps,
			slippageBps,
			executionBps: base.executionBps,
			gasBps,
			routeShape: graph.shape,
			hopCount,
			legs: [...wrapEntries, ...legsWithLp, ...unwrapEntries],
			reconResidualBps,
			confidence,
			flags: [...base.flags, ...routeFlags],
			feeRecipient,
			feeSinkSource,
		};
	}

	// Else: !reconstructed (non-conserved, cyclic, or disconnected) — cannot
	// reliably separate LP/Slippage
	routeFlags.push(
		`ROUTE_NOT_DECOMPOSED: shape=${graph.shape}, reconstructed=${graph.reconstructed}`,
	);

	return {
		lpFeeBps: null,
		aggFeeBps: base.aggFeeBps,
		slippageBps: null,
		executionBps: base.executionBps,
		gasBps,
		routeShape: graph.shape,
		hopCount: graph.legs.length,
		legs: [
			...wrapEntries,
			...(legsWithLp.length > 0 ? legsWithLp : venuesToUncostedLegs(venues, transfers)),
			...unwrapEntries,
		],
		reconResidualBps: null,
		confidence: 'low',
		flags: [...base.flags, ...routeFlags],
		feeRecipient,
		feeSinkSource,
	};
}
