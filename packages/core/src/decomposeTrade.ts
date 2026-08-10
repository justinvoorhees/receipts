/**
 * decomposeTrade.ts — Full 3-way cost decomposition (v2.1 spike).
 *
 * Orchestrator: `decomposeTrade(...)` takes a debug trace + DB anchors and returns
 * { lpFeeBps, aggFeeBps, slippageBps, gasBps, hops[], feeSinks[], flags[] }. The pure
 * steps live in sibling modules (2026-07-21 split): the value-flow graph in
 * `tradeValueGraph`, the fee steps in `tradeFees`, the log decoders/constants in
 * `tradeDecoders`. This file keeps the RPC-bound Steps 2 (classify) and 4 (LP fee)
 * plus slippage/gas/assembly.
 *
 * Invariant: all_in_cost_bps = lp_fee_bps + agg_fee_bps + slippage_bps
 * (gas tracked separately).
 *
 * Only I/O: V3/V4 `fee()` view calls for unknown pool tiers.
 * No DB writes. No dashboard. READ-ONLY spike.
 */

import { createPublicClient, parseAbiItem } from 'viem';
import { sessionHttp } from './rpcSession.js';
import { base } from 'viem/chains';
import {
	USDC,
	WETH,
	DENYLIST,
	type TraceNode,
} from './tradeEndpoints.js';
import {
	V2_SWAP_TOPIC,
	V2_SYNC_TOPIC,
	AERODROME_SWAP_TOPIC,
	AERODROME_SYNC_TOPIC,
	UNISWAP_V4_POOL_MANAGER,
	SINGLETON_DEX_CUSTODIANS,
	decodeV3LikeSwaps,
	decodeV4SwapFees,
} from './tradeDecoders.js';
import { buildValueFlowGraph } from './tradeValueGraph.js';
import { computeAggFee, detectRoutePurity, type FeeSink, DUST_USDC } from './tradeFees.js';

// ─── Constants ───

// Known USDC/WETH V3 pool fee tiers (raw Uniswap units: 500 = 5 bps)
const POOL_FEE_TIERS: Record<string, number> = {
	'0xd0b53d9277642d899df5c87a3966a349a798f224': 500,   // 5 bps
	'0x88a43bbdf9d098eec7bceda4e2494615dfd9bb9c': 100,   // 1 bps
	'0xb4cb800910b228ed3d0834cf79d697127bbb00e5': 100,   // 1 bps
	'0x6c561b446416e1a00e8e93e221854d6ea4171372': 3000,  // 30 bps
	'0x4c36388be6f416a29c8d8eee81c771ce6be14b18': 10000, // 100 bps
	'0x0b1c2dcbbfa744ebd3fc17ff1a96a1e1eb4b2d69': 10000, // 100 bps
};

// Per-aggregator known fee-vault addresses
const AGG_FEE_VAULTS: Record<string, Set<string>> = {
	'Velora': new Set([
		'0x00700052c0608f670705380a4900e0a8080010cc', // Velora fee vault (from txn #3)
	]),
	'Odos': new Set([
		'0xe093c7056f1d5f46f88de7bf366b3569e1839778', // Odos fee sink (from txn #2)
	]),
	'Relay': new Set([
		'0xf70da97812cb96acdf810712aa562db8dfa3dbef', // Relay fee (from txn #6)
	]),
};

// Structural fee-sink dust floor: a retained-balance sink only counts toward
// aggFeeBps if its value exceeds max($1.00, 1 bps of notional). Below this
// floor it is still surfaced as a NEEDS REVIEW flag but excluded from the
// agg-fee total. The explicit vault-map path is unaffected.
const STRUCTURAL_FEE_FLOOR_USD = 1.00;
const STRUCTURAL_FEE_FLOOR_BPS = 1; // 1 bps of notional

// ─── Types ───

export interface DecomposeTradeInput {
	trace: TraceNode;
	txHash: `0x${string}`;
	trader: string;                // lowercase
	/** Transaction submitter when it is NOT the trader (ERC-4337 bundler,
	 *  relayer). Excluded from fee sinks — its native credit is a gas
	 *  reimbursement, already counted in gasCostUsd. Omit → today's behavior. */
	gasPayer?: string;
	allInCostBps: number;
	notionalUsdc: number;          // |USDC amount| in human units
	realizedPrice: number;         // USDC per WETH
	gasCostUsd: number;
	aggregator: string;
	blockNumber: bigint;
	rpcUrl: string;
	/** Fee-floor + route-classification profile. Smoke set passes tighter values;
	 *  funnel callers omit these → current v2.1 behavior. */
	dustUsdc?: number;                 // default 0.01  (fee-sink dust gate)
	structuralFloorUsd?: number;       // default 1.00  (unknown-sink absolute floor)
	structuralFloorBps?: number;       // default 1     (unknown-sink bps floor)
	recognizeV3Forks?: boolean;        // default false (count PancakeSwap V3 LP fees)
	impureOnVenueThirdToken?: boolean; // default false (3rd token at a venue ⇒ impure)
}

export interface VenueHop {
	address: string;
	type: 'V3' | 'V4' | 'V2' | 'RFQ' | 'unknown';
	feeTierBps: number;
	notionalUsdc: number;
	pctOfTotal: number;
}

export interface DecomposeResult {
	lpFeeBps: number | null;
	aggFeeBps: number;
	slippageBps: number | null;
	executionBps: number | null;
	gasBps: number;
	hops: VenueHop[];
	feeSinks: FeeSink[];
	flags: string[];
}

// ─── Main decomposition function ───

export async function decomposeTrade(input: DecomposeTradeInput): Promise<DecomposeResult> {
	const flags: string[] = [];
	const traderLower = input.trader.toLowerCase();

	// Resolve optional profile parameters (defaults preserve v2.1 funnel behavior)
	const dustUsdc = input.dustUsdc ?? DUST_USDC;
	const structFloorUsd = input.structuralFloorUsd ?? STRUCTURAL_FEE_FLOOR_USD;
	const structFloorBps = input.structuralFloorBps ?? STRUCTURAL_FEE_FLOOR_BPS;

	// ── Step 1: Collect all logs and build value-flow graph ──
	const { logs, transfers, addrDeltas } = buildValueFlowGraph(input.trace);

	// ── Step 2: Classify addresses ──

	// Find venues: addresses that emitted a V3/PancakeV3 Swap, V2 Swap/Sync, or are the V4 PoolManager
	const venueAddresses = new Set<string>();

	// Decode V3-like swaps (Uniswap V3 + optionally PancakeSwap V3)
	const v3SwapEvents = decodeV3LikeSwaps(logs, input.recognizeV3Forks ?? false);
	for (const swap of v3SwapEvents) {
		venueAddresses.add(swap.pool);
	}

	// Detect V2/Aerodrome venue addresses from remaining logs
	for (const log of logs) {
		if (!log.topics || log.topics.length === 0) continue;
		const topic0 = log.topics[0]!;
		const addr = log.address.toLowerCase();

		if (
			topic0 === V2_SWAP_TOPIC || topic0 === V2_SYNC_TOPIC ||
			topic0 === AERODROME_SWAP_TOPIC || topic0 === AERODROME_SYNC_TOPIC
		) {
			venueAddresses.add(addr);
		}
	}

	// Singleton-architecture DEXes are always venues, never fee sinks. Their
	// custodian holds every pool's balances and settles by flash accounting, so a
	// small unmatched residual is normal — and reads exactly like a retained fee
	// to the classifier below. It cannot be probed away: a custodian answers
	// neither fee() nor getReserves(). See SINGLETON_DEX_CUSTODIANS.
	for (const custodian of SINGLETON_DEX_CUSTODIANS) venueAddresses.add(custodian);

	// Create an RPC client for fee() view calls
	const rpc = createPublicClient({ chain: base, transport: sessionHttp(input.rpcUrl) });

	// Collect all known vaults for this aggregator (skip probing these)
	const knownVaults = AGG_FEE_VAULTS[input.aggregator] ?? new Set<string>();
	const allKnownVaults = new Set<string>();
	for (const vaults of Object.values(AGG_FEE_VAULTS)) {
		for (const v of vaults) allKnownVaults.add(v);
	}

	// Probe unclassified addresses with retained balances — if they respond to
	// fee() (with valid tier) or getReserves(), they're pools/venues, not fee
	// sinks. Skip known fee vaults so we don't accidentally classify them as pools
	// (some contracts have a fee() function that returns unrelated values).
	for (const [addr, delta] of addrDeltas) {
		if (venueAddresses.has(addr) || DENYLIST.has(addr) || addr === traderLower) continue;
		if (addr === USDC || addr === WETH) continue;
		if (allKnownVaults.has(addr)) continue; // Don't probe known fee vaults
		const wethRetained = delta.weth + delta.nativeEth;
		const totalRetained = Math.abs(delta.usdc) + Math.abs(wethRetained) * input.realizedPrice;
		// Intentional: this and the other structural thresholds (V4 detection, RFQ
		// gap, hub qualification) use the fixed DUST_USDC constant, NOT the profile's
		// `dustUsdc`. Only the fee-sink classification gates (the two checks in Step 3)
		// scale with the smoke profile. Don't "unify" these — it would alter funnel.
		if (totalRetained < DUST_USDC) continue;

		// Try fee() — V3 pool. Only accept if fee is a plausible Uniswap tier
		// (1 to 100_000 = 0.01 to 1000 bps). Some non-pool contracts have a
		// fee() function returning garbage values (e.g. 6_000_000).
		try {
			const fee = await rpc.readContract({
				address: addr as `0x${string}`,
				abi: [parseAbiItem('function fee() view returns (uint24)')],
				functionName: 'fee',
				blockNumber: input.blockNumber,
			});
			const feeNum = Number(fee);
			if (feeNum > 0 && feeNum <= 100_000) {
				venueAddresses.add(addr);
				continue;
			}
		} catch {
			// Not a V3 pool
		}

		// Try getReserves() — V2/Aerodrome pool
		try {
			await rpc.readContract({
				address: addr as `0x${string}`,
				abi: [parseAbiItem('function getReserves() view returns (uint112, uint112, uint32)')],
				functionName: 'getReserves',
				blockNumber: input.blockNumber,
			});
			venueAddresses.add(addr);
		} catch {
			// Not a V2 pool either
		}
	}

	// Denylist addresses are infrastructure, not fee sinks
	const isInfra = (addr: string) =>
		DENYLIST.has(addr) || venueAddresses.has(addr) || addr === traderLower;

	// ── Step 3: Agg fee (≥ 0) ──

	const structuralFloor = Math.max(
		structFloorUsd,
		(structFloorBps / 10_000) * input.notionalUsdc,
	);
	const aggFee = computeAggFee({
		transfers, addrDeltas, isInfra, knownVaults,
		...(input.gasPayer ? { gasPayer: input.gasPayer } : {}),
		dustUsdc, structuralFloor,
		realizedPrice: input.realizedPrice,
		notionalUsdc: input.notionalUsdc,
	});
	const { aggFeeBps, feeSinks, vaultMapFeeUsdc } = aggFee;
	flags.push(...aggFee.flags);

	// ── Step 4: LP fee (notional-weighted) ──

	const hops: VenueHop[] = [];
	let hasV4 = false;

	// Check if V4 PoolManager has nonzero balance (indicating V4 swap happened)
	const v4Delta = addrDeltas.get(UNISWAP_V4_POOL_MANAGER);
	if (v4Delta && (Math.abs(v4Delta.usdc) > DUST_USDC || Math.abs(v4Delta.weth) > 0.000001 || Math.abs(v4Delta.nativeEth) > 0.000001)) {
		hasV4 = true;
	}

	// Process V3 Swap events
	// Cache pool token info to avoid redundant calls
	const poolTokenCache = new Map<string, { token0: string; token1: string }>();

	for (const swap of v3SwapEvents) {
		const pool = swap.pool;
		// Use hardcoded cache only for known static-fee USDC/WETH pools.
		// All other pools get a fresh fee() call at the trade's block to handle
		// dynamic-fee pools (e.g., Algebra/KyberSwap) correctly.
		let feeTierRaw = POOL_FEE_TIERS[pool];

		if (feeTierRaw === undefined) {
			// Try on-chain fee() view call at the trade block
			try {
				const fee = await rpc.readContract({
					address: pool as `0x${string}`,
					abi: [parseAbiItem('function fee() view returns (uint24)')],
					functionName: 'fee',
					blockNumber: input.blockNumber,
				});
				feeTierRaw = Number(fee);
				// Do NOT cache in POOL_FEE_TIERS — dynamic-fee pools change
				// between blocks, and caching across txns gives wrong values
			} catch {
				flags.push(`NEEDS REVIEW: could not read fee() for V3 pool ${pool}`);
				feeTierRaw = 0;
			}
		}

		const feeTierBps = feeTierRaw / 100;

		// Determine notional USDC through this hop. Need to know which token
		// is token0 vs token1 so we can decode amounts with correct decimals.
		let poolTokens = poolTokenCache.get(pool);
		if (!poolTokens) {
			try {
				const [t0, t1] = await Promise.all([
					rpc.readContract({
						address: pool as `0x${string}`,
						abi: [parseAbiItem('function token0() view returns (address)')],
						functionName: 'token0',
					}),
					rpc.readContract({
						address: pool as `0x${string}`,
						abi: [parseAbiItem('function token1() view returns (address)')],
						functionName: 'token1',
					}),
				]);
				poolTokens = {
					token0: (t0 as string).toLowerCase(),
					token1: (t1 as string).toLowerCase(),
				};
				poolTokenCache.set(pool, poolTokens);
			} catch {
				// Fallback: try heuristic based on amount magnitudes
				poolTokens = { token0: 'unknown', token1: 'unknown' };
			}
		}

		const amount0 = swap.amount0;
		const amount1 = swap.amount1;
		let hopNotionalUsdc: number;

		// Determine USDC-equivalent notional from whichever side is USDC or WETH
		if (poolTokens.token0 === USDC) {
			hopNotionalUsdc = Math.abs(Number(amount0)) / 1e6;
		} else if (poolTokens.token1 === USDC) {
			hopNotionalUsdc = Math.abs(Number(amount1)) / 1e6;
		} else if (poolTokens.token0 === WETH) {
			hopNotionalUsdc = (Math.abs(Number(amount0)) / 1e18) * input.realizedPrice;
		} else if (poolTokens.token1 === WETH) {
			hopNotionalUsdc = (Math.abs(Number(amount1)) / 1e18) * input.realizedPrice;
		} else {
			// Neither token is USDC or WETH — can't determine USDC equivalent
			// Use the trade notional as a rough proxy (the pool participated in the path)
			hopNotionalUsdc = input.notionalUsdc;
			flags.push(
				`NEEDS REVIEW: pool ${pool} has no USDC or WETH token, ` +
				`using trade notional as proxy for hop notional`,
			);
		}

		hops.push({
			address: pool,
			type: 'V3',
			feeTierBps,
			notionalUsdc: hopNotionalUsdc,
			pctOfTotal: 0, // fill in below
		});
	}

	// Process V4 (if seen)
	if (hasV4) {
		// Determine V4 notional from PoolManager's net balance change
		const pm = addrDeltas.get(UNISWAP_V4_POOL_MANAGER)!;
		const v4UsdcNotional = Math.abs(pm.usdc) > DUST_USDC
			? Math.abs(pm.usdc)
			: (Math.abs(pm.weth) + Math.abs(pm.nativeEth)) * input.realizedPrice;

		// V4 fee tier — decoded from V4 Swap event(s) in the trace logs
		const v4RawFees = decodeV4SwapFees(logs);
		let v4FeeBps: number;
		if (v4RawFees.length === 0) {
			v4FeeBps = 0;
			flags.push('NEEDS REVIEW: V4 pool fee tier unknown, defaulting to 0 bps');
		} else {
			const uniqueFees = [...new Set(v4RawFees)];
			if (uniqueFees.length === 1) {
				v4FeeBps = uniqueFees[0]! / 100;
			} else {
				// Multiple differing V4 fee tiers — use simple average
				const avg = v4RawFees.reduce((s, f) => s + f, 0) / v4RawFees.length;
				v4FeeBps = avg / 100;
				flags.push(
					`NEEDS REVIEW: multiple V4 Swap fees detected (${v4RawFees.join(', ')}), using average=${v4FeeBps.toFixed(2)} bps`,
				);
			}
		}

		hops.push({
			address: UNISWAP_V4_POOL_MANAGER,
			type: 'V4',
			feeTierBps: v4FeeBps,
			notionalUsdc: v4UsdcNotional,
			pctOfTotal: 0,
		});
	}

	// Detect RFQ/OTC gap: if total hop notional is less than the trade notional,
	// the difference represents flow through RFQ/OTC venues (0 LP fee).
	// Weight LP fee against the FULL trade notional so RFQ portions dilute it.
	const poolHopNotional = hops.reduce((sum, h) => sum + h.notionalUsdc, 0);
	const rfqGap = Math.max(0, input.notionalUsdc - poolHopNotional);

	if (rfqGap > DUST_USDC && poolHopNotional > DUST_USDC) {
		// Mixed route: some pool hops + RFQ/OTC fill for the rest
		hops.push({
			address: 'rfq_fill',
			type: 'RFQ',
			feeTierBps: 0,
			notionalUsdc: rfqGap,
			pctOfTotal: 0,
		});
	} else if (hops.length === 0) {
		// Pure RFQ: no pool hops at all
		hops.push({
			address: 'rfq_fill',
			type: 'RFQ',
			feeTierBps: 0,
			notionalUsdc: input.notionalUsdc,
			pctOfTotal: 100,
		});
	}

	// Compute total notional across hops and percentages.
	// Use MAX(totalHopNotional, tradeNotional) as denominator to avoid
	// over-counting when sequential hops inflate the sum beyond the actual
	// trade notional (each hop processes the full amount in sequence).
	const totalHopNotional = hops.reduce((sum, h) => sum + h.notionalUsdc, 0);
	const lpDenominator = Math.max(totalHopNotional, input.notionalUsdc);
	for (const h of hops) {
		h.pctOfTotal = lpDenominator > 0 ? (h.notionalUsdc / lpDenominator) * 100 : 0;
	}

	// Notional-weighted LP fee. Using lpDenominator ensures:
	// - Parallel splits: weights sum to ~100%, LP fee is correct
	// - Sequential hops: weights sum to >100% naturally (fee accumulates), but
	//   using max(total, notional) = total keeps proportions right
	// - Mixed pool+RFQ: RFQ portion contributes 0 LP fee, diluting correctly
	const lpFeeBps = lpDenominator > 0
		? hops.reduce((sum, h) => sum + (h.notionalUsdc / lpDenominator) * h.feeTierBps, 0)
		: 0;

	// ── Step 4b: Route-purity detection ──
	const { isImpure, thirdTokens, thirdTokenHubs } = detectRoutePurity({
		transfers, venueAddresses,
		impureOnVenueThirdToken: input.impureOnVenueThirdToken ?? false,
	});

	// ── Step 5: Slippage / Execution (signed residual) ──
	// NEVER clamp or abs — negative is valid (venues beat the reference mid)

	// ── Step 6: Gas ──

	const gasBps = input.notionalUsdc > 0
		? (input.gasCostUsd / input.notionalUsdc) * 10_000
		: 0;

	if (isImpure) {
		// Route hops through a third token via the hub — LP and slippage are not separable
		const tokenDetails = [...thirdTokens].map(t => {
			const hubEntry = thirdTokenHubs.get(t);
			let hubStr = '';
			if (hubEntry) {
				const [source, addr] = hubEntry.split(':');
				hubStr = addr ? ` via ${source} ${addr.slice(0, 6)}...${addr.slice(-4)}` : ` via ${hubEntry}`;
			}
			return `${t.slice(0, 6)}...${t.slice(-4)}${hubStr}`;
		}).join(', ');
		flags.push(`MULTI-HOP: route touches ${tokenDetails} — LP/slippage not separable`);
		const executionBps = input.allInCostBps - aggFeeBps;
		return {
			lpFeeBps: null,
			aggFeeBps,
			slippageBps: null,
			executionBps,
			gasBps,
			hops,
			feeSinks,
			flags,
		};
	}

	// PURE route — standard 3-way split
	const slippageBps = input.allInCostBps - lpFeeBps - aggFeeBps;

	// ── Plausibility guard ──
	// No genuine aggregator fee on a liquid USDC/WETH trade exceeds ~100 bps,
	// and residual slippage blowing past ±100 bps means the per-hop split is
	// unreliable. Collapse to impure-style execution when non-physical.
	const PLAUSIBILITY_CAP_BPS = 100;
	if (aggFeeBps > PLAUSIBILITY_CAP_BPS || Math.abs(slippageBps) > PLAUSIBILITY_CAP_BPS) {
		// Determine how much agg fee to keep: only the known fee-vault map
		// contribution (trusted), not structural retained-balance detections.
		const vaultMapFeeBps = input.notionalUsdc > 0
			? (vaultMapFeeUsdc / input.notionalUsdc) * 10_000
			: 0;
		const guardedAggFeeBps = Math.max(0, vaultMapFeeBps);
		const guardedExecutionBps = input.allInCostBps - guardedAggFeeBps;
		flags.push(
			`NON_PHYSICAL_SPLIT: components exceeded plausibility bounds ` +
			`(aggFee=${aggFeeBps.toFixed(2)}, slippage=${slippageBps.toFixed(2)}, cap=±${PLAUSIBILITY_CAP_BPS}) ` +
			`— collapsed to execution`,
		);
		return {
			lpFeeBps: null,
			aggFeeBps: guardedAggFeeBps,
			slippageBps: null,
			executionBps: guardedExecutionBps,
			gasBps,
			hops,
			feeSinks,
			flags,
		};
	}

	const executionBps = lpFeeBps + slippageBps;

	return {
		lpFeeBps,
		aggFeeBps,
		slippageBps,
		executionBps,
		gasBps,
		hops,
		feeSinks,
		flags,
	};
}

