/**
 * decompose-trade.ts — Full 3-way cost decomposition (v2.1 spike).
 *
 * Pure function `decomposeTrade(...)` takes a debug trace + DB anchors and
 * returns { lpFeeBps, aggFeeBps, slippageBps, gasBps, hops[], feeSinks[], flags[] }.
 *
 * Invariant: all_in_cost_bps = lp_fee_bps + agg_fee_bps + slippage_bps
 * (gas tracked separately).
 *
 * Only I/O: V3/V4 `fee()` view calls for unknown pool tiers.
 * No DB writes. No dashboard. READ-ONLY spike.
 */

import { createPublicClient, decodeEventLog, http, parseAbiItem } from 'viem';
import { base } from 'viem/chains';
import {
	USDC,
	WETH,
	DENYLIST,
	decodeTransferLogs,
	collectNativeEthDeltas,
	type Direction,
} from './tradeEndpoints.js';

// ─── Constants ───

const SWAP_TOPIC =
	'0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

const V3_SWAP_EVENT = parseAbiItem(
	'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
);

const V2_SWAP_TOPIC =
	'0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
const V2_SYNC_TOPIC =
	'0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';

// Aerodrome (Solidly fork) uses different Swap/Sync event signatures
const AERODROME_SWAP_TOPIC =
	'0xb3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b';
const AERODROME_SYNC_TOPIC =
	'0xcf2aa50876cdfbb541206f89af0ee78d44a2abf8d328e37fa4917f982149848a';

// WETH wrap/unwrap topics — needed to track per-address WETH burns/mints
const WITHDRAWAL_TOPIC =
	'0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
const DEPOSIT_TOPIC =
	'0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c';

const UNISWAP_V4_POOL_MANAGER =
	'0x498581ff718922c3f8e6a244956af099b2652b2b';

// Known USDC/WETH V3 pool fee tiers (raw Uniswap units: 500 = 5 bps)
const POOL_FEE_TIERS: Record<string, number> = {
	'0xd0b53d9277642d899df5c87a3966a349a798f224': 500,   // 5 bps
	'0x88a43bbdf9d098eec7bceda4e2494615dfd9bb9c': 100,   // 1 bps
	'0xb4cb800910b228ed3d0834cf79d697127bbb00e5': 100,   // 1 bps
	'0x6c561b446416e1a00e8e93e221854d6ea4171372': 3000,  // 30 bps
	'0x4c36388be6f416a29c8d8eee81c771ce6be14b18': 10000, // 100 bps
	'0x0b1c2dcbbfa744ebd3fc17ff1a96a1e1eb4b2d69': 10000, // 100 bps
};

// Known V4 pool fee tiers (bps, NOT raw Uniswap units)
// V4 PoolManager is a singleton — individual pools are identified by their key.
// For this spike we use a known-map approach.
const V4_POOL_FEE_BPS: Record<string, number> = {
	// USDC/WETH V4 pool on Base — 0.05% (5 bps), seen in Fabric txn #4
	'usdc_weth_v4_default': 5,
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

// Threshold: if an address retains more than this fraction of notional, it's
// a counterparty / venue, not a fee sink. Fee sinks skim a small fraction.
const COUNTERPARTY_THRESHOLD = 0.10; // 10% of notional

// Dust threshold in human USDC
const DUST_USDC = 0.01;

// Structural fee-sink dust floor: a retained-balance sink only counts toward
// aggFeeBps if its value exceeds max($1.00, 1 bps of notional). Below this
// floor it is still surfaced as a NEEDS REVIEW flag but excluded from the
// agg-fee total. The explicit vault-map path is unaffected.
const STRUCTURAL_FEE_FLOOR_USD = 1.00;
const STRUCTURAL_FEE_FLOOR_BPS = 1; // 1 bps of notional

// ─── Types ───

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

export interface DecomposeTradeInput {
	trace: TraceNode;
	txHash: `0x${string}`;
	trader: string;                // lowercase
	direction: Direction;
	settledIn: 'WETH' | 'ETH';
	allInCostBps: number;
	notionalUsdc: number;          // |USDC amount| in human units
	realizedPrice: number;         // USDC per WETH
	gasCostUsd: number;
	aggregator: string;
	blockNumber: bigint;
	rpcUrl: string;
}

export interface VenueHop {
	address: string;
	type: 'V3' | 'V4' | 'V2' | 'RFQ' | 'unknown';
	feeTierBps: number;
	notionalUsdc: number;
	pctOfTotal: number;
}

export interface FeeSink {
	address: string;
	usdcRetained: number;
	wethRetained: number;
	totalUsdc: number;
	source: 'vault_map' | 'retained_balance';
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

	// ── Step 1: Collect all logs and build value-flow graph ──

	const logs = collectTraceLogs(input.trace);
	const transfers = decodeTransferLogs(logs);
	const nativeEthDeltas = collectNativeEthDeltas(input.trace);

	// Per-address net deltas for USDC and WETH (in human units)
	const addrDeltas = new Map<string, { usdc: number; weth: number; nativeEth: number }>();

	const getOrInit = (addr: string) => {
		const k = addr.toLowerCase();
		if (!addrDeltas.has(k)) addrDeltas.set(k, { usdc: 0, weth: 0, nativeEth: 0 });
		return addrDeltas.get(k)!;
	};

	for (const t of transfers) {
		const token = t.token.toLowerCase();
		const fromLower = t.from.toLowerCase();
		const toLower = t.to.toLowerCase();
		const humanVal = token === USDC
			? Number(t.value) / 1e6
			: token === WETH
				? Number(t.value) / 1e18
				: 0;
		if (humanVal === 0) continue;

		const fromD = getOrInit(fromLower);
		const toD = getOrInit(toLower);
		if (token === USDC) {
			fromD.usdc -= humanVal;
			toD.usdc += humanVal;
		} else if (token === WETH) {
			fromD.weth -= humanVal;
			toD.weth += humanVal;
		}
	}

	// WETH wrap/unwrap events affect per-address WETH balances:
	// Withdrawal(src) = src burns WETH (decreases WETH balance, gets native ETH)
	// Deposit(dst) = dst mints WETH (increases WETH balance, sends native ETH)
	// Without this, intermediaries that unwrap WETH appear to "retain" it.
	for (const log of logs) {
		if (log.address.toLowerCase() !== WETH || !log.topics || log.topics.length < 2) continue;
		const topic0 = log.topics[0]!;
		if (topic0 === WITHDRAWAL_TOPIC) {
			const src = ('0x' + log.topics[1]!.slice(26)).toLowerCase();
			const amount = Number(BigInt(log.data)) / 1e18;
			const d = getOrInit(src);
			d.weth -= amount; // WETH burned
		} else if (topic0 === DEPOSIT_TOPIC) {
			const dst = ('0x' + log.topics[1]!.slice(26)).toLowerCase();
			const amount = Number(BigInt(log.data)) / 1e18;
			const d = getOrInit(dst);
			d.weth += amount; // WETH minted
		}
	}

	// Native ETH deltas
	for (const [addr, raw] of nativeEthDeltas) {
		const d = getOrInit(addr);
		d.nativeEth = Number(raw) / 1e18;
	}

	// ── Step 2: Classify addresses ──

	// Find venues: addresses that emitted a V3 Swap, V2 Swap/Sync, or are the V4 PoolManager
	const venueAddresses = new Set<string>();
	const v3SwapEvents: { pool: string; amount0: bigint; amount1: bigint }[] = [];

	for (const log of logs) {
		if (!log.topics || log.topics.length === 0) continue;
		const topic0 = log.topics[0]!;
		const addr = log.address.toLowerCase();

		if (topic0 === SWAP_TOPIC && log.topics.length >= 3) {
			venueAddresses.add(addr);
			try {
				const decoded = decodeEventLog({
					abi: [V3_SWAP_EVENT],
					data: log.data,
					topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
				});
				v3SwapEvents.push({
					pool: addr,
					amount0: decoded.args.amount0 as bigint,
					amount1: decoded.args.amount1 as bigint,
				});
			} catch {
				// Non-V3 Swap with same topic — unlikely but safe
			}
		} else if (
			topic0 === V2_SWAP_TOPIC || topic0 === V2_SYNC_TOPIC ||
			topic0 === AERODROME_SWAP_TOPIC || topic0 === AERODROME_SYNC_TOPIC
		) {
			venueAddresses.add(addr);
		}
	}

	// V4 PoolManager is always a venue
	venueAddresses.add(UNISWAP_V4_POOL_MANAGER);

	// Create an RPC client for fee() view calls
	const rpc = createPublicClient({ chain: base, transport: http(input.rpcUrl) });

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

	// Build per-address third-token position: tracks whether an address moved
	// any token other than USDC/WETH. A fee-sink candidate that moved a third
	// token is a venue (e.g. USDC→USDT stableswap), not a fee collector.
	const addrThirdTokens = new Map<string, Set<string>>();
	for (const t of transfers) {
		const token = t.token.toLowerCase();
		if (token === USDC || token === WETH) continue;
		const fromLower = t.from.toLowerCase();
		const toLower = t.to.toLowerCase();
		if (!addrThirdTokens.has(fromLower)) addrThirdTokens.set(fromLower, new Set());
		if (!addrThirdTokens.has(toLower)) addrThirdTokens.set(toLower, new Set());
		addrThirdTokens.get(fromLower)!.add(token);
		addrThirdTokens.get(toLower)!.add(token);
	}

	const feeSinks: FeeSink[] = [];

	for (const [addr, delta] of addrDeltas) {
		if (isInfra(addr)) continue;
		if (addr === USDC || addr === WETH) continue;

		// Net retained value — combine USDC + WETH@realized + nativeETH@realized
		const usdcRetained = delta.usdc;
		const wethRetained = delta.weth + delta.nativeEth;
		const totalUsdc = usdcRetained + wethRetained * input.realizedPrice;

		if (Math.abs(totalUsdc) < DUST_USDC) continue;

		// Gate: if this address moved ANY third token (non-USDC/WETH), it is a
		// venue doing a swap (e.g. USDC→USDT stableswap), not a fee collector.
		// A true fee sink only retains USDC and/or WETH.
		const thirdTokensAtAddr = addrThirdTokens.get(addr);
		if (thirdTokensAtAddr && thirdTokensAtAddr.size > 0) {
			const tokenList = [...thirdTokensAtAddr].map(t => `${t.slice(0, 6)}...${t.slice(-4)}`).join(', ');
			flags.push(
				`VENUE (third-token gate): ${addr} moved ${tokenList} — reclassified as venue, not fee sink ` +
				`(USDC retained=${usdcRetained.toFixed(4)})`,
			);
			continue;
		}

		// Classify: known vault vs unclassified retained balance
		if (knownVaults.has(addr)) {
			feeSinks.push({
				address: addr,
				usdcRetained,
				wethRetained,
				totalUsdc,
				source: 'vault_map',
			});
		} else if (totalUsdc > DUST_USDC) {
			// Check if this is a counterparty (retains the bulk of notional)
			// vs a fee sink (retains a small fraction). Counterparties are venues
			// that filled the trade — their retained value IS the trade, not a fee.
			const fractionOfNotional = totalUsdc / input.notionalUsdc;
			if (fractionOfNotional > COUNTERPARTY_THRESHOLD) {
				// Likely a counterparty / RFQ venue / solver — NOT a fee sink
				flags.push(
					`COUNTERPARTY: ${addr} retained ${totalUsdc.toFixed(4)} USDC ` +
					`(${(fractionOfNotional * 100).toFixed(1)}% of notional) — classified as venue, not fee sink`,
				);
			} else {
				// Small retained balance — potential fee sink, flag for review.
				// Apply a dust floor: only count toward aggFeeBps if the
				// retained value exceeds max($1.00, 1 bps of notional).
				// Below the floor, still surface the NEEDS REVIEW flag.
				const structuralFloor = Math.max(
					STRUCTURAL_FEE_FLOOR_USD,
					(STRUCTURAL_FEE_FLOOR_BPS / 10_000) * input.notionalUsdc,
				);
				if (totalUsdc >= structuralFloor) {
					flags.push(
						`NEEDS REVIEW: ${addr} retained ${totalUsdc.toFixed(4)} USDC ` +
						`(usdc=${usdcRetained.toFixed(4)}, weth_equiv=${(wethRetained * input.realizedPrice).toFixed(4)})`,
					);
					feeSinks.push({
						address: addr,
						usdcRetained,
						wethRetained,
						totalUsdc,
						source: 'retained_balance',
					});
				} else {
					// Below dust floor — flag for visibility but exclude
					// from the agg-fee total
					flags.push(
						`NEEDS REVIEW (dust, excluded from agg fee): ${addr} retained ` +
						`${totalUsdc.toFixed(4)} USDC ` +
						`(usdc=${usdcRetained.toFixed(4)}, weth_equiv=${(wethRetained * input.realizedPrice).toFixed(4)}, ` +
						`floor=${structuralFloor.toFixed(4)})`,
					);
				}
			}
		}
		// Negative retained (net payer) — not a fee sink, skip
	}

	const aggFeeUsdc = feeSinks.reduce((sum, s) => sum + s.totalUsdc, 0);
	// Separate known-vault vs structural (retained-balance) contributions so the
	// plausibility guard can preserve vault-map fees while discarding structural
	// mis-detections.
	const vaultMapFeeUsdc = feeSinks
		.filter(s => s.source === 'vault_map')
		.reduce((sum, s) => sum + s.totalUsdc, 0);
	const rawAggFeeBps = input.notionalUsdc > 0 ? (aggFeeUsdc / input.notionalUsdc) * 10_000 : 0;
	// Floor: agg fee is retained value and is definitionally >= 0.
	// A negative value means the fee-sink detector mis-fired (e.g. native-ETH
	// artifact counted as a fee sink). Clamp to 0.
	const aggFeeBps = Math.max(0, rawAggFeeBps);
	if (rawAggFeeBps < 0) {
		flags.push(
			`AGG_FEE_FLOORED: raw agg fee was ${rawAggFeeBps.toFixed(2)} bps — ` +
			`clamped to 0 (negative = mis-detection)`,
		);
	}

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

		// V4 fee tier — use known map
		const v4FeeBps = V4_POOL_FEE_BPS['usdc_weth_v4_default'] ?? 0;
		if (v4FeeBps === 0) {
			flags.push('NEEDS REVIEW: V4 pool fee tier unknown, defaulting to 0 bps');
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
	// A route is impure (LP/slippage not separable) only if a third token
	// (non-USDC, non-WETH) is transiently held by a trade "hub" — one of
	// the aggregator's DENYLIST router addresses that intermediates the
	// trader's tokens.
	//
	// Hub addresses are DENYLIST entries (excluding token contracts USDC/WETH
	// and pool addresses already in venueAddresses) that have nonzero USDC
	// or WETH flow. A third token only moving among peripheral filler/MM
	// addresses (not through any hub) is a co-settled batch leg → NOT impure.

	// Step 4b-i: Identify ALL hub addresses — DENYLIST routers with USDC/WETH
	// gross flow (total inflow or outflow, not net — a pass-through router has
	// net zero but still intermediates the trade).
	const hubGrossFlow = new Map<string, number>(); // addr → gross USDC+WETH volume
	for (const t of transfers) {
		const token = t.token.toLowerCase();
		if (token !== USDC && token !== WETH) continue;
		const humanVal = token === USDC ? Number(t.value) / 1e6 : Number(t.value) / 1e18;
		const fromLower = t.from.toLowerCase();
		const toLower = t.to.toLowerCase();
		// Accumulate gross flow at each address
		hubGrossFlow.set(fromLower, (hubGrossFlow.get(fromLower) ?? 0) + humanVal);
		hubGrossFlow.set(toLower, (hubGrossFlow.get(toLower) ?? 0) + humanVal);
	}
	const hubAddresses = new Set<string>();
	for (const addr of DENYLIST) {
		if (addr === USDC || addr === WETH) continue;
		if (venueAddresses.has(addr)) continue; // pools, not routers
		const grossFlow = hubGrossFlow.get(addr) ?? 0;
		if (grossFlow > DUST_USDC) {
			hubAddresses.add(addr);
		}
	}

	// Step 4b-ii: Check if any third token flows through ANY hub address
	// A third token makes the route impure only if a hub received or sent it.
	const thirdTokens = new Set<string>();
	const thirdTokenHubs = new Map<string, string>(); // token → hub address that held it

	for (const t of transfers) {
		const token = t.token.toLowerCase();
		if (token === USDC || token === WETH) continue;
		const fromLower = t.from.toLowerCase();
		const toLower = t.to.toLowerCase();
		// Check if either side of this transfer is a hub address
		if (hubAddresses.has(fromLower)) {
			thirdTokens.add(token);
			if (!thirdTokenHubs.has(token)) thirdTokenHubs.set(token, fromLower);
		}
		if (hubAddresses.has(toLower)) {
			thirdTokens.add(token);
			if (!thirdTokenHubs.has(token)) thirdTokenHubs.set(token, toLower);
		}
	}

	const isImpure = thirdTokens.size > 0;

	// ── Step 5: Slippage / Execution (signed residual) ──
	// NEVER clamp or abs — negative is valid (venues beat the reference mid)

	// ── Step 6: Gas ──

	const gasBps = input.notionalUsdc > 0
		? (input.gasCostUsd / input.notionalUsdc) * 10_000
		: 0;

	if (isImpure) {
		// Route hops through a third token via the hub — LP and slippage are not separable
		const tokenDetails = [...thirdTokens].map(t => {
			const hub = thirdTokenHubs.get(t);
			const hubStr = hub ? ` via hub ${hub.slice(0, 6)}...${hub.slice(-4)}` : '';
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
