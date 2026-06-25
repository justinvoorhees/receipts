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

// ─── Constants ───

const PANCAKE_V3_SWAP_TOPIC = '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83';
const UNI_V3_SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

const V4_SWAP_EVENT = parseAbiItem(
	'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
);
const V4_SWAP_TOPIC = toEventSelector(V4_SWAP_EVENT);

const V2_SWAP_TOPIC =
	'0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
const AERODROME_SWAP_TOPIC =
	'0xb3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b';

const UNISWAP_V4_POOL_MANAGER =
	'0x498581ff718922c3f8e6a244956af099b2652b2b';

const LEG_FEE_CAP_BPS = 300;

// ─── Interfaces ───

interface TraceNode {
	from?: `0x${string}`;
	to?: `0x${string}`;
	value?: `0x${string}`;
	input?: `0x${string}`;
	output?: `0x${string}`;
	type?: string;
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
	legs: (LegFeeInput & { lpFeeBps: number })[];
	reconResidualBps: number | null; // Phase 2
	confidence: 'high' | 'medium' | 'low';
	flags: string[];
}

/** Injectable dependencies for testing without live RPC. */
export interface DecomposeRouteDeps {
	/** Pre-fetched trace (skip RPC call). */
	trace?: TraceNode;
	/** Custom fee-tier reader. Signature: (poolAddr, venueType, v4FeeRaw?) → { bps, defaulted }. */
	feeReader?: (addr: string, type: VenueType, v4FeeRaw?: number) => Promise<{ bps: number; defaulted: boolean }> | { bps: number; defaulted: boolean };
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
	}

	return venues;
}

// ─── Default fee reader (live RPC) ───

function createDefaultFeeReader(rpcUrl: string, blockNumber: bigint): (addr: string, type: VenueType, v4FeeRaw?: number) => Promise<{ bps: number; defaulted: boolean }> {
	const rpc = createPublicClient({ chain: base, transport: http(rpcUrl) });

	return async (addr: string, type: VenueType, v4FeeRaw?: number): Promise<{ bps: number; defaulted: boolean }> => {
		switch (type) {
			case 'univ3':
			case 'pancakev3': {
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
			// Proxy sends → replace with V4 PM sends
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

// ─── Main orchestrator ───

export async function decomposeRoute(
	input: DecomposeTradeInput,
	deps?: DecomposeRouteDeps,
): Promise<RouteDecomposeResult> {
	const routeFlags: string[] = [];

	// Step 1: Get base decomposition from decomposeTrade (reuse agg fee, gas, flags)
	const base = await decomposeTrade(input);

	// Step 2: Get trace (injected or from input)
	const trace = (deps?.trace ?? input.trace) as TraceNode;

	// Step 3: Collect logs, decode transfers, scan venues
	const logs = collectTraceLogs(trace);
	const rawTransfers = decodeTransferLogs(logs as any);
	const venues = scanVenues(logs, input.recognizeV3Forks ?? false);

	// Step 3b: Resolve V4 settlement proxies — rewrite transfers so V4 PM
	// appears as the source of outgoing tokens instead of the executor
	const { transfers, extendedDenylist } = resolveV4Settlement(
		rawTransfers, venues, input.trader, DENYLIST,
	);

	// Step 4: Build route graph
	const graph = buildRouteGraph({
		transfers,
		trader: input.trader,
		venues,
		denylist: extendedDenylist,
	});

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

	// Step 7: Build per-leg LP contributions
	const legsWithLp = legFeeInputs.map((lfi) => ({
		...lfi,
		lpFeeBps: (lfi.feeTierBps * lfi.notionalUsdc) / input.notionalUsdc,
	}));

	// Step 8: Branch on reconstruction (Design Decision 7)
	const gasBps = input.notionalUsdc > 0
		? (input.gasCostUsd / input.notionalUsdc) * 10_000
		: 0;

	if (graph.reconstructed && (graph.shape === 'single' || graph.shape === 'linear' || graph.shape === 'split')) {
		const lpFeeBps = rollup.lpFeeBps;
		const slippageBps = input.allInCostBps - lpFeeBps - base.aggFeeBps;

		// Confidence assessment
		let confidence: 'high' | 'medium' | 'low' = 'high';

		// Downgrade to medium if any leg has approximate notional or defaulted fee
		const hasApproxLegs = legFeeInputs.some((lfi) => lfi.notionalApprox);
		if (hasApproxLegs || !allFeesResolved) {
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
			legs: legsWithLp,
			reconResidualBps: null, // Phase 2
			confidence,
			flags: [...base.flags, ...routeFlags],
		};
	}

	// Else: split/complex/!reconstructed — cannot reliably separate LP/Slippage
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
		legs: legsWithLp,
		reconResidualBps: null, // Phase 2
		confidence: 'low',
		flags: [...base.flags, ...routeFlags],
	};
}
