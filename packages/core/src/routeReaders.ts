/**
 * routeReaders — the RPC-backed default readers for route decomposition.
 *
 * Split out of decomposeRoute.ts (2026-07-21): every viem/RPC call in the
 * decomposition path lives here. The orchestrator uses these only as fallbacks
 * (`deps?.X ?? createDefaultX(...)`), so tests inject fakes and never hit this
 * module. getLegMidAtBlock lives here too — createDefaultMidReader is its only
 * production caller, so co-locating them keeps the graph acyclic.
 */
import { createPublicClient, http, parseAbiItem, type PublicClient } from 'viem';
import { base } from 'viem/chains';
import type { VenueType, Leg } from './routeGraph.js';
import { getPairMidAtBlock, makeRpcDecimalsCache, type PairMidResult } from './tokenPricing.js';
import { readSlot0, readV2Reserves, readV4Slot0, V4_POOL_MANAGER, readInfinityPoolKey } from './poolDiscovery.js';
import { sqrtPriceX96ToPrice, v2MidFromReserves } from './priceMath.js';

/** Sort two token addresses into Uniswap (token0, token1) order (lower = token0). */
function sortLegTokens(a: string, b: string): { token0: string; token1: string; inverted: boolean } {
	const aLc = a.toLowerCase();
	const bLc = b.toLowerCase();
	if (aLc < bLc) return { token0: aLc, token1: bLc, inverted: false };
	return { token0: bLc, token1: aLc, inverted: true };
}

/**
 * Read the mid price from a leg's OWN pool at a given block.
 *
 * Returns the price as "tokenOut per tokenIn" in human units, so the caller
 * can compute price-impact as `(mid - realized) / mid` where
 * `realized = amountOut / amountIn` in the same orientation.
 *
 * Routing logic:
 *   - `univ3` / `pancakev3` -> readSlot0(leg.venue) -> sqrtPriceX96ToPrice
 *   - `univ2` / `aerodrome` -> readV2Reserves(leg.venue) -> v2MidFromReserves
 *   - `univ4`               -> readV4Slot0(leg.v4PoolId) -> sqrtPriceX96ToPrice
 *   - `rfq` / `unknown`    -> factory discovery for (tokenIn, tokenOut)
 */
export async function getLegMidAtBlock(
	client: PublicClient,
	leg: Leg,
	blockNumber: bigint,
	decimalsOf: (address: string) => Promise<number>,
): Promise<PairMidResult | null> {
	const tokenIn = leg.tokenIn.toLowerCase();
	const tokenOut = leg.tokenOut.toLowerCase();

	// Sort tokens into Uniswap convention (lower address = token0)
	const { token0, token1, inverted } = sortLegTokens(tokenIn, tokenOut);
	// inverted = true means tokenIn > tokenOut, i.e. tokenIn=token1, tokenOut=token0
	// We want "tokenOut per tokenIn". sqrtPriceX96ToPrice returns "token1 per token0".

	const [dec0, dec1] = await Promise.all([decimalsOf(token0), decimalsOf(token1)]);

	const type = leg.type;

	// V3-style pools: read slot0 from the pool address
	if (type === 'univ3' || type === 'sushiv3' || type === 'baseswapv3' || type === 'pancakev3' || type === 'aerodrome_cl') {
		const sqrtPriceX96 = await readSlot0(client, leg.venue as `0x${string}`, blockNumber);
		if (sqrtPriceX96 === null) return null;
		const rawPrice = sqrtPriceX96ToPrice(sqrtPriceX96, dec0, dec1);
		const price = inverted ? (rawPrice > 0 ? 1 / rawPrice : 0) : rawPrice;
		return { price, poolAddress: leg.venue, poolKind: type };
	}

	// V2-style pools: read reserves from the pair address
	if (type === 'univ2' || type === 'aerodrome') {
		const reserves = await readV2Reserves(client, leg.venue as `0x${string}`, blockNumber);
		if (reserves === null) return null;
		const rawPrice = v2MidFromReserves(reserves[0], reserves[1], dec0, dec1);
		const price = inverted ? (rawPrice > 0 ? 1 / rawPrice : 0) : rawPrice;
		return { price, poolAddress: leg.venue, poolKind: type };
	}

	// V4 pools: read via StateView getSlot0(poolId). V4 may use native ETH instead
	// of WETH, so the pool's currency0/currency1 order may differ from the address
	// sort; compute the raw sqrtPrice both ways and pick the one consistent with the
	// leg's realized price direction.
	if (type === 'univ4') {
		if (!leg.v4PoolId) return null;
		const sqrtPriceX96 = await readV4Slot0(client, leg.v4PoolId as `0x${string}`, blockNumber);
		if (sqrtPriceX96 === null) return null;

		const priceA = sqrtPriceX96ToPrice(sqrtPriceX96, dec0, dec1); // token1/token0 if sorted-order matches pool
		const priceB = priceA > 0 ? 1 / priceA : 0;                  // inverse

		// Realized price = tokenOut / tokenIn (in human units)
		const decIn = tokenIn === token0 ? dec0 : dec1;
		const decOut = tokenOut === token0 ? dec0 : dec1;
		const realized = leg.amountInRaw > 0n
			? (Number(leg.amountOutRaw) / 10 ** decOut) / (Number(leg.amountInRaw) / 10 ** decIn)
			: 0;

		const candidateA = inverted ? priceB : priceA; // address-sort assumption
		const candidateB = inverted ? priceA : priceB; // flipped assumption (V4 + native ETH)

		let price: number;
		if (realized <= 0) {
			price = candidateA; // default to address-sort if no realized available
		} else {
			const ratioA = candidateA > 0 ? Math.abs(Math.log(candidateA / realized)) : Infinity;
			const ratioB = candidateB > 0 ? Math.abs(Math.log(candidateB / realized)) : Infinity;
			price = ratioA <= ratioB ? candidateA : candidateB;
		}

		return { price, poolAddress: V4_POOL_MANAGER, poolKind: 'univ4' };
	}

	// RFQ fills are quoted off-chain — no pool mid to read. Deliberate null.
	if (type === 'rfq') return null;

	// Unknown / venues whose own mid we cannot read directly -> factory discovery.
	// Algebra Integral pools (hydrex, quickswapv4) expose their mid via
	// globalState(), not the V3 slot0() this reader uses, so they take the
	// discovery path for a reference mid like the rest.
	if (
		type === 'unknown' || type === 'maverickv1' || type === 'maverickv2' ||
		type === 'curve_stableng' || type === 'hydrex' || type === 'quickswapv4' || type === 'unipool'
	) {
		return getPairMidAtBlock(client, tokenIn, tokenOut, blockNumber, decimalsOf);
	}

	return null;
}

/** EIP-1967 implementation slot (keccak256('eip1967.proxy.implementation') - 1). */
const EIP1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

// ─── Default fee reader (live RPC) ───

/**
 * Report a fee we could not resolve, then let the caller fall back to 0 bps.
 *
 * `defaulted: true` is the load-bearing part: a 0 bps fee reported as RESOLVED
 * is indistinguishable from a pool that is genuinely free, and renders on the
 * receipt as a confident "0.00bps" — a false claim rather than a missing one.
 * The warn names the consequence, mirroring `resolveAggregator.ts` /
 * `settlementDecoders.ts`, so a systematically broken reader cannot stay silent.
 */
function unresolvedFee(addr: string, type: VenueType, cause: string): { bps: number; defaulted: boolean } {
	console.warn(
		`[createDefaultFeeReader] could not resolve the fee tier for ${type} pool ${addr} — ` +
		`its LP fee will read 0 bps and be reported as unresolved: ${cause}`,
	);
	return { bps: 0, defaulted: true };
}

export function createDefaultFeeReader(rpcUrl: string, blockNumber: bigint): (addr: string, type: VenueType, v4FeeRaw?: number) => Promise<{ bps: number; defaulted: boolean }> {
	const rpc = createPublicClient({ chain: base, transport: http(rpcUrl) });

	return async (addr: string, type: VenueType, v4FeeRaw?: number): Promise<{ bps: number; defaulted: boolean }> => {
		switch (type) {
			case 'univ3':
			case 'sushiv3':
			case 'baseswapv3':
			case 'pancakev3':
			// Hydrex and QuickSwap v4 are Algebra Integral: fee() returns the
			// currently effective fee (including any plugin override) on the same
			// 1e6 scale as v3.
			case 'hydrex':
			case 'quickswapv4': {
				try {
					const fee = await rpc.readContract({
						address: addr as `0x${string}`,
						abi: [parseAbiItem('function fee() view returns (uint24)')],
						functionName: 'fee',
						blockNumber,
					});
					return { bps: Number(fee) / 100, defaulted: false };
				} catch (err) {
					return unresolvedFee(addr, type, err instanceof Error ? err.message : String(err));
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
				// The fee rides on the V4 Swap event. When it is absent the event was
				// malformed (routeVenueScan sets `{type:'univ4'}` with no v4FeeRaw),
				// so there is nothing to read on-chain — report it, do not imply free.
				return v4FeeRaw !== undefined
					? { bps: v4FeeRaw / 100, defaulted: false }
					: unresolvedFee(addr, type, 'the V4 Swap event carried no fee (v4FeeRaw undefined)');
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

export function createDefaultV3FactoryReader(rpcUrl: string, blockNumber: bigint): (addr: string) => Promise<string | null> {
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

export function createDefaultRfqProbe(rpcUrl: string, blockNumber: bigint): (addr: string) => Promise<'eoa' | 'proxy1967' | 'contract'> {
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
	// The returned midReader takes its own `atBlock` per leg, so this outer block
	// is vestigial; kept for call-site compatibility.
	_blockNumber: bigint,
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

// ─── V4 poolId → currencies reader ───

export type V4PoolKeyReader = (poolId: string) => Promise<{ currency0: string; currency1: string } | null>;
export type V4InitLog = { args: { currency0: string; currency1: string } };

// PoolManager deployment block on Base. Confirm on-chain before shipping; a
// too-late value silently misses older pools (reader returns null → graceful).
const V4_POOL_MANAGER_DEPLOY_BLOCK = 25_350_988n;
const V4_INITIALIZE_EVENT = parseAbiItem(
	'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
);

/**
 * Pure decode + per-poolId cache over an injected Initialize-log fetcher.
 * Returns lowercased currencies from the first Initialize log, caches the
 * result (including a null miss), and never throws — a failing fetch yields a
 * cached null so callers degrade to the un-decomposed path. No viem here, so
 * the decode/cache contract is unit-testable with a stub fetcher.
 */
export function makeV4PoolKeyReader(
	fetchInitLogs: (poolId: string) => Promise<V4InitLog[]>,
): V4PoolKeyReader {
	const cache = new Map<string, { currency0: string; currency1: string } | null>();
	return async (poolId: string): Promise<{ currency0: string; currency1: string } | null> => {
		const key = poolId.toLowerCase();
		if (cache.has(key)) return cache.get(key)!;
		let result: { currency0: string; currency1: string } | null = null;
		try {
			const logs = await fetchInitLogs(key);
			const init = logs[0];
			if (init) {
				result = {
					currency0: init.args.currency0.toLowerCase(),
					currency1: init.args.currency1.toLowerCase(),
				};
			}
		} catch {
			result = null;
		}
		cache.set(key, result);
		return result;
	};
}

/**
 * Production V4 poolId → currencies reader: queries the PoolManager's indexed
 * Initialize event via viem and delegates decode/cache to makeV4PoolKeyReader.
 */
export function createDefaultV4PoolKeyReader(rpcUrl: string, toBlock: bigint): V4PoolKeyReader {
	if (!rpcUrl || rpcUrl === 'unused' || rpcUrl === 'http://invalid') return async () => null;
	const rpc = createPublicClient({ chain: base, transport: http(rpcUrl) });
	return makeV4PoolKeyReader(async (poolId: string) => {
		const logs = await rpc.getLogs({
			address: V4_POOL_MANAGER,
			event: V4_INITIALIZE_EVENT,
			args: { id: poolId as `0x${string}` },
			fromBlock: V4_POOL_MANAGER_DEPLOY_BLOCK,
			toBlock,
		});
		return logs as unknown as V4InitLog[];
	});
}

// ─── Infinity poolId → currencies reader ───

/**
 * Pure cache over an injected Infinity pool-key fetcher. Lowercases the
 * currencies, caches per poolId INCLUDING a null miss so a failed read is not
 * retried on every leg, and never throws.
 */
export function makeInfinityPoolKeyReader(
	fetchKey: (poolId: string) => Promise<{ currency0: string; currency1: string } | null>,
): V4PoolKeyReader {
	const cache = new Map<string, { currency0: string; currency1: string } | null>();
	return async (poolId: string) => {
		const key = poolId.toLowerCase();
		if (cache.has(key)) return cache.get(key)!;
		let result: { currency0: string; currency1: string } | null = null;
		try {
			const k = await fetchKey(key);
			if (k) {
				result = { currency0: k.currency0.toLowerCase(), currency1: k.currency1.toLowerCase() };
			}
		} catch {
			result = null;
		}
		cache.set(key, result);
		return result;
	};
}

/**
 * Live Infinity pool-key reader.
 *
 * ⚡ A single eth_call. V4's equivalent has to scan historical Initialize logs
 * because Uniswap's PoolManager exposes no poolIdToPoolKey; Infinity does.
 */
export function createDefaultInfinityPoolKeyReader(rpcUrl: string, blockNumber: bigint): V4PoolKeyReader {
	if (!rpcUrl || rpcUrl === 'unused' || rpcUrl === 'http://invalid') return async () => null;
	const rpc = createPublicClient({ chain: base, transport: http(rpcUrl) });
	return makeInfinityPoolKeyReader((poolId) =>
		readInfinityPoolKey(rpc as never, poolId as `0x${string}`, blockNumber),
	);
}
