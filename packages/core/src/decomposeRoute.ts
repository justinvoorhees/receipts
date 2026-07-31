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

import {
	USDC,
	WETH,
	DENYLIST,
	decodeTransferLogs,
	collectTraceLogs,
	type TraceNode,
} from './tradeEndpoints.js';
import { buildRouteGraph, type RouteShape, type VenueType, type Leg, type RouteBreakReason } from './routeGraph.js';
import { valueLegNotionalUsdc, rollupLpFee, type LegFeeInput } from './legFees.js';
import { anchorsToUsd } from './receiptPure.js';
import { decomposeTrade, type DecomposeTradeInput } from './decomposeTrade.js';
import { type FeeSink } from './tradeFees.js';
import { type PairMidResult } from './tokenPricing.js';
import {
	scanVenues,
	addKnownVenuesFromTransfers,
	addKnownFactoryVenuesFromTransfers,
	refineV3VenueTypes,
	type VenueInfo,
} from './routeVenueScan.js';
import {
	createDefaultFeeReader,
	createDefaultV3FactoryReader,
	createDefaultRfqProbe,
	createDefaultV4PoolKeyReader,
	createDefaultInfinityPoolKeyReader,
	type V4PoolKeyReader,
} from './routeReaders.js';
import { isCuratedMaker } from './makerRegistry.js';
import { collectV4Swaps, shouldAttemptV4Rescue, synthesizeV4Legs } from './v4Legs.js';
import { collectInfinitySwaps, shouldAttemptInfinityRescue, synthesizeInfinityLegs } from './infinityLegs.js';

// ─── Fee sinks ───

export interface FeeSinkOut {
	address: string;
	feeBps: number;
	source: string;
}

/**
 * Map the internal FeeSink[] to the persisted/output shape: dominant-first,
 * with aggFeeBps split across sinks proportionally to retained value. When the
 * total retained value is zero (e.g. vault_map sinks with no measured USDC),
 * split evenly. Pure — no RPC.
 */
export function buildFeeSinks(sinks: FeeSink[], aggFeeBps: number): FeeSinkOut[] {
	if (sinks.length === 0) return [];
	const sorted = [...sinks].sort((a, b) => b.totalUsdc - a.totalUsdc);
	const totalRetained = sorted.reduce((a, s) => a + s.totalUsdc, 0);
	return sorted.map((s) => ({
		address: s.address,
		feeBps: totalRetained > 0 ? aggFeeBps * (s.totalUsdc / totalRetained) : aggFeeBps / sorted.length,
		source: s.source,
	}));
}

// ─── Constants ───

const WETH_DEPOSIT_TOPIC = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c';
const WETH_WITHDRAWAL_TOPIC = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';

/** topic0s emitted BY a market maker's own contract when it fills an RFQ order.
 *  Seed verified on-chain 2026-07-16: emitted 8x by 0x Settler maker proxy
 *  0x69a9f156… in 0xb020…9e26. Extend like venue event-topics — never by address. */
const RFQ_FILL_TOPICS: ReadonlySet<string> = new Set([
	'0x51ab1232a73b82b6b0acb0fa91b834cf6e258a1858c4e23c72ce97241c71aa0d',
]);
const UNISWAP_V4_POOL_MANAGER =
	'0x498581ff718922c3f8e6a244956af099b2652b2b';

const LEG_FEE_CAP_BPS = 300;

/**
 * The largest gap that could plausibly be a transfer tax, in bps.
 *
 * Real fee-on-transfer tokens tax a few percent — receipt id 219's SWARM takes
 * exactly 1.00%, verified on-chain. Extreme memecoins reach the low tens. Beyond
 * ~30% a token is untradeable through a router (its slippage check would reject
 * the fill), so a gap that large is not a tax: it means legs are missing.
 */
const FOT_PLAUSIBLE_CAP_BPS = 3000;

/**
 * Describe an intermediate token whose inflow and outflow disagree.
 *
 * `diagnoseBreak` classifies ANY such token as `fee_on_transfer`, but an
 * unbalanced intermediate has several causes and a token tax is only one — an
 * uncaptured leg produces exactly the same signature. Receipt id 442 reported
 * "USDC loses ~99.49% between hops", which is not a tax; only 36% of that
 * route's notional was captured in legs.
 *
 * So only claim a tax when one is plausible. The conclusion for the user is the
 * same either way — LP and slippage are not separable — but we must not assert
 * a CAUSE we have not established.
 *
 * ⚠️ This governs the FLAG only. The break `kind` is deliberately left alone:
 * it drives `shouldAttemptV4Rescue`, and a large unexplained gap is exactly when
 * a hidden V4 pool might be the explanation.
 */
export function feeOnTransferFlag(token: string, gapBps: number): string {
  const short = `${token.slice(0, 6)}...${token.slice(-4)}`;
  const pct = (gapBps / 100).toFixed(2);
  // Anchor tokens (stables, WETH, native) are never fee-on-transfer.
  if (anchorsToUsd(token) || gapBps > FOT_PLAUSIBLE_CAP_BPS) {
    return (
      `UNBALANCED_INTERMEDIATE: token ${short} inflow and outflow differ by ~${pct}% — ` +
      `too large for a transfer tax, so legs are likely incomplete; LP/slippage not separable`
    );
  }
  return `FEE_ON_TRANSFER: token ${short} loses ~${pct}% between hops — LP/slippage not separable`;
}


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
	/** All detected fee sinks, dominant-first, each with its proportional share of aggFeeBps. Empty when none. */
	feeSinks: FeeSinkOut[];
}

/** Injectable dependencies for testing without live RPC. */
export interface DecomposeRouteDeps {
	/** Pre-fetched trace (skip RPC call). */
	trace?: TraceNode;
	/** Custom fee-tier reader. Signature: (poolAddr, venueType, feeRawPips?) → { bps, defaulted }. */
	feeReader?: (addr: string, type: VenueType, feeRawPips?: number) => Promise<{ bps: number; defaulted: boolean }> | { bps: number; defaulted: boolean };
	/** Custom V3-style factory reader. Signature: (poolAddr) → factory address. */
	v3FactoryReader?: (addr: string) => Promise<string | null> | string | null;
	/** Custom mid-price reader. Signature: (leg, blockNumber) → PairMidResult | null. */
	midReader?: (leg: Leg, blockNumber: bigint) => Promise<PairMidResult | null> | PairMidResult | null;
	/** Custom decimals reader (for realized-price computation). Falls back to inline USDC=6/else=18. */
	decimalsReader?: (token: string) => Promise<number> | number;
	/** Structural maker probe for the rfq retype pass (block-pinned in production). */
	rfqProbe?: (addr: string) => Promise<'eoa' | 'proxy1967' | 'contract'> | 'eoa' | 'proxy1967' | 'contract';
	/** Resolve a V4 poolId → its two currencies (block-pinned in production). */
	v4PoolKeyReader?: V4PoolKeyReader;
	/** Resolve an Infinity poolId → its two currencies (block-pinned in production). */
	infinityPoolKeyReader?: V4PoolKeyReader;
}

// ─── Helpers ───

/** Flatten every log from a callTracer trace tree into a single ordered list. */
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
	// True once the V4 multi-pool rescue actually replaced the collapsed leg.
	// Used to suppress decomposeTrade's averaged-fee flag, which describes a
	// value this route no longer uses (see the flags merge at the end).
	let v4RescueAdopted = false;

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
	const feeSinks = buildFeeSinks(base.feeSinks, base.aggFeeBps);

	// Step 2: Get trace (injected or from input)
	const trace = (deps?.trace ?? input.trace) as TraceNode;

	// Step 3: Collect logs, decode transfers, scan venues
	const logs = collectTraceLogs(trace);
	const rawTransfers = decodeTransferLogs(logs);
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

	// Step 4: Build route graph from address-derived legs (first pass).
	let graph = buildRouteGraph({
		transfers,
		trader: input.trader,
		venues,
		denylist: extendedDenylist,
	});

	// Step 4b: V4 multi-pool RESCUE — gated on a first-pass token-conservation
	// break. The V4 singleton PoolManager hides a pool's flow two ways: a token
	// consumed but never produced (`orphan_token`, e.g. id 56), or an
	// intermediate whose captured legs under-account for it because a V4 pool
	// also moved it (`fee_on_transfer` classification, e.g. id 251's WETH). Both
	// are candidates for V4-leg synthesis. Routes that already reconstruct (incl.
	// single-pool V4 via resolveV4Settlement, RFQ/AMM hybrids, convergent splits)
	// are excluded by `!graph.reconstructed` — synthesizing legs there would
	// double-count and BREAK them. And we adopt the V4-augmented graph ONLY if it
	// then reconstructs, so a genuine fee-on-transfer token (no V4 orphan, e.g.
	// id 219's SWARM) never gets a spurious rescue.
	const v4Swaps = collectV4Swaps(logs);
	if (
		shouldAttemptV4Rescue({
			reconstructed: graph.reconstructed,
			breakReason: graph.breakReason,
			v4Swaps,
		})
	) {
		const pmTokens = new Set<string>();
		for (const t of transfers) {
			const from = t.from.toLowerCase();
			const to = t.to.toLowerCase();
			if (from === UNISWAP_V4_POOL_MANAGER || to === UNISWAP_V4_POOL_MANAGER) {
				pmTokens.add(t.token.toLowerCase());
			}
		}
		if (pmTokens.size > 1) {
			const keyReader = deps?.v4PoolKeyReader
				?? createDefaultV4PoolKeyReader(input.rpcUrl, input.blockNumber);
			const poolKeys = new Map<string, { currency0: string; currency1: string }>();
			for (const s of v4Swaps) {
				if (poolKeys.has(s.poolId)) continue;
				const key = await keyReader(s.poolId);
				if (key) poolKeys.set(s.poolId, key);
			}
			const extraV4Legs = synthesizeV4Legs(v4Swaps, poolKeys, WETH);
			if (extraV4Legs.length > 0) {
				const v4Graph = buildRouteGraph({
					transfers,
					trader: input.trader,
					venues,
					denylist: extendedDenylist,
					extraLegs: extraV4Legs,
				});
				// ⚠️ `reconstructed` is NOT a completeness check. reconstructDag only
				// verifies that INTERMEDIATE tokens conserve and that the output token
				// receives something — it never compares endpoint totals against the
				// trade. So it accepts a rescue that UNDER-accounts: a v4PoolKeyReader
				// returning null drops that swap silently (v4Legs.ts), and 2-of-3
				// resolved pools still trips `poolIds.size > 1`, so the collapsed leg
				// carrying the FULL flow gets replaced by legs carrying two thirds of
				// it. It also accepted OVER-accounting, which is exactly how receipts
				// 55 and 207 were corrupted in production mid-branch. Compare the
				// input-token outflow against the pre-rescue graph and reject a
				// shortfall rather than trusting reconstruction.
				// Baseline is what the TRADER actually sent, not the pre-rescue graph:
				// on the original rescue path that graph is un-reconstructed by
				// definition, so measuring against it would compare one broken number
				// with another. The trader's own outflow is ground truth.
				const traderLc = input.trader.toLowerCase();
				const traderSent = transfers
					.filter((t) => t.from.toLowerCase() === traderLc && t.token.toLowerCase() === v4Graph.inputToken)
					.reduce((s, t) => s + t.value, 0n);
				const afterIn = v4Graph.legs
					.filter((l) => l.tokenIn === v4Graph.inputToken)
					.reduce((s, l) => s + l.amountInRaw, 0n);
				// The same 0.1% dust tolerance routeGraph's `conserved()` uses. Only a
				// SHORTFALL is rejected: an excess is double-counting, which the
				// per-emitter drop now prevents structurally, and rejecting on excess
				// would also fire on legitimate splits that gain resolution.
				const shortfall =
					traderSent > 0n && afterIn < traderSent && (traderSent - afterIn) * 1000n > traderSent;
				if (v4Graph.reconstructed && !shortfall) {
					// Only claim a rescue when the leg set actually changed. With exactly
					// one pool resolved the single extra is de-duped away and v4Graph is
					// identical to graph — flagging that advertises work not done.
					const changed = v4Graph.legs.length !== graph.legs.length;
					graph = v4Graph;
					if (changed) {
						routeFlags.push(`V4_MULTIPOOL_LEGS: synthesized ${extraV4Legs.length} V4 pool leg(s) from Swap events`);
						v4RescueAdopted = true;
					}
				} else if (shortfall) {
					routeFlags.push(
						`V4_RESCUE_REJECTED: synthesized legs consume ${afterIn} of the ${traderSent} input`
						+ ` the trader sent (a pool key likely failed to resolve); keeping the un-rescued route`,
					);
				}
			}
		}
	}

	// PancakeSwap Infinity — same shape as the V4 rescue above, separate because
	// the two singletons are deliberately not unified (see infinityLegs.ts).
	const infinitySwaps = collectInfinitySwaps(logs);
	if (
		shouldAttemptInfinityRescue({
			reconstructed: graph.reconstructed,
			breakReason: graph.breakReason,
			swaps: infinitySwaps,
		})
	) {
		const keyReader = deps?.infinityPoolKeyReader
			?? createDefaultInfinityPoolKeyReader(input.rpcUrl, input.blockNumber);
		const poolKeys = new Map<string, { currency0: string; currency1: string }>();
		for (const s of infinitySwaps) {
			if (poolKeys.has(s.poolId)) continue;
			const key = await keyReader(s.poolId);
			if (key) poolKeys.set(s.poolId, key);
		}
		const extraLegs = synthesizeInfinityLegs(infinitySwaps, poolKeys, WETH);
		if (extraLegs.length > 0) {
			const infGraph = buildRouteGraph({
				transfers,
				trader: input.trader,
				venues,
				denylist: extendedDenylist,
				extraLegs,
			});
			// Same completeness guard as the V4 rescue, for the same reason:
			// `reconstructed` compares no endpoint totals, so it accepts a rescue
			// that under-accounts when a pool key fails to resolve.
			const traderLc = input.trader.toLowerCase();
			const traderSent = transfers
				.filter((t) => t.from.toLowerCase() === traderLc && t.token.toLowerCase() === infGraph.inputToken)
				.reduce((s, t) => s + t.value, 0n);
			const afterIn = infGraph.legs
				.filter((l) => l.tokenIn === infGraph.inputToken)
				.reduce((s, l) => s + l.amountInRaw, 0n);
			const shortfall =
				traderSent > 0n && afterIn < traderSent && (traderSent - afterIn) * 1000n > traderSent;
			if (infGraph.reconstructed && !shortfall) {
				const changed = infGraph.legs.length !== graph.legs.length;
				graph = infGraph;
				if (changed) {
					routeFlags.push(`INFINITY_LEGS: synthesized ${extraLegs.length} Infinity pool leg(s) from Swap events`);
				}
			} else if (shortfall) {
				routeFlags.push(
					`INFINITY_RESCUE_REJECTED: synthesized legs consume ${afterIn} of the ${traderSent} input`
					+ ` the trader sent (a pool key likely failed to resolve); keeping the un-rescued route`,
				);
			}
		}
	}

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
		const proven = fillEmitters.has(leg.venue) || (await rfqProbe(leg.venue)) !== 'contract';
		const curated = !proven && isCuratedMaker(leg.venue);
		if (!proven && !curated) continue;
		leg.type = 'rfq';
		routeFlags.push(
			proven
				? `RFQ_LEG_UNPRICED: leg ${leg.venue.slice(0, 10)} — off-chain quote, no on-chain mid exists`
				: `RFQ_LEG_CURATED: leg ${leg.venue.slice(0, 10)} — curated market maker (human-attested), no on-chain mid exists`,
		);
	}

	// Step 5: Resolve fee tiers for each leg
	const feeReader = deps?.feeReader ?? createDefaultFeeReader(input.rpcUrl, input.blockNumber);
	let allFeesResolved = true;

	const legFeeInputs: LegFeeInput[] = [];
	for (const leg of graph.legs) {
		// Resolve fee tier. Both singleton venues (V4 and Infinity) carry their
		// fee on the Swap event rather than on-chain, which is why it arrives as
		// a parameter here instead of being read by the reader itself. A leg is
		// only ever one venue type, so exactly one of the two fields is set and
		// `??` cannot pick the wrong one.
		const feeResult = await feeReader(leg.venue, leg.type, leg.v4FeeRaw ?? leg.infinityFeeRaw);
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
			feeResolved: !feeResult.defaulted,
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
			// decomposeTrade averages V4 fee tiers for ITS OWN route-level rollup and
			// flags that it did. When the rescue replaced the collapsed leg, every V4
			// leg now carries its own real tier and no averaged value survives into
			// this receipt — so the flag would be user-visible misinformation sitting
			// beside the per-pool numbers that disprove it. Drop it here rather than
			// in decomposeTrade, which still serves callers that DO use the average.
			flags: [
				...(v4RescueAdopted
					? base.flags.filter((f) => !f.includes('multiple V4 Swap fees detected'))
					: base.flags),
				...routeFlags,
			],
			feeRecipient,
			feeSinkSource,
			feeSinks,
		};
	}

	// Else: !reconstructed (non-conserved, cyclic, or disconnected) — cannot
	// reliably separate LP/Slippage. Name the specific cause when we know it.
	const br: RouteBreakReason | undefined = graph.breakReason;
	if (br?.kind === 'fee_on_transfer') {
		routeFlags.push(feeOnTransferFlag(br.token, br.gapBps));
	} else if (br?.kind === 'orphan_token') {
		const short = `${br.token.slice(0, 6)}...${br.token.slice(-4)}`;
		routeFlags.push(
			`MISSING_LEG: token ${short} is consumed but never produced (un-modeled venue, likely V4 multi-pool) — LP/slippage not separable`,
		);
	}
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
		feeSinks,
	};
}
