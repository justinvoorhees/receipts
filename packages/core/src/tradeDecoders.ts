/**
 * tradeDecoders — swap/sync/wrap event topics and the log decoders for trade
 * decomposition. Split out of decomposeTrade.ts (2026-07-21). Pure: decodes logs,
 * no RPC and no shared state. These constants stay local to decompose-trade's world
 * (deliberately NOT deduped against routeVenueScan.ts, which is a separate subsystem).
 */
import { parseAbiItem, toEventSelector, decodeEventLog } from 'viem';
import type { LogLike } from './tradeEndpoints.js';

// ─── Constants ───

export const SWAP_TOPIC =
	'0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

export const V3_SWAP_EVENT = parseAbiItem(
	'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
);

export const PANCAKE_V3_SWAP_TOPIC = '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83';
export const PANCAKE_V3_SWAP_EVENT = parseAbiItem('event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint128 protocolFeesToken0, uint128 protocolFeesToken1)');

export const V4_SWAP_EVENT = parseAbiItem(
	'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
);
export const V4_SWAP_TOPIC = toEventSelector(V4_SWAP_EVENT);

export const V2_SWAP_TOPIC =
	'0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
export const V2_SYNC_TOPIC =
	'0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';

// Aerodrome (Solidly fork) uses different Swap/Sync event signatures
export const AERODROME_SWAP_TOPIC =
	'0xb3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b';
export const AERODROME_SYNC_TOPIC =
	'0xcf2aa50876cdfbb541206f89af0ee78d44a2abf8d328e37fa4917f982149848a';

// WETH wrap/unwrap topics — needed to track per-address WETH burns/mints
export const WITHDRAWAL_TOPIC =
	'0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
export const DEPOSIT_TOPIC =
	'0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c';

export const UNISWAP_V4_POOL_MANAGER =
	'0x498581ff718922c3f8e6a244956af099b2652b2b';

/** PancakeSwap Infinity `Vault` — the token custodian, NOT a pool. Pools live
 *  behind CLPoolManager 0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b, which emits
 *  the Swap. Uniswap V4 does both jobs at one address; Pancake splits them. */
export const PANCAKE_INFINITY_VAULT =
	'0x238a358808379702088667322f80ac48bad5e6c4';

/**
 * Addresses that CUSTODY tokens for a singleton-architecture DEX.
 *
 * A singleton holds every pool's balances at one address and settles by flash
 * accounting, so tokens go in and come back out within the trade. It should net
 * to ~nothing, but the two sides are not measured identically and the residual
 * reads exactly like a retained fee — which is how receipt id 408 booked the
 * Pancake Infinity Vault as 2.810 bps of AGGREGATOR fee on a $12 trade.
 *
 * ⚠️ Probing cannot distinguish these. `computeAggFee`'s fee-sink classifier
 * falls back to calling `fee()` / `getReserves()`, and a custodian answers
 * NEITHER — its fees live per-pool inside the manager contract. So the only
 * reliable signal is structural: this list. Uniswap V4 was carved out by hand
 * for exactly this reason; every other singleton silently had its LP fee
 * reclassified as an aggregator fee until it was added here.
 *
 * ⚠️ This is the CUSTODIAN, which is not always the Swap emitter. Adding an
 * emitter here instead would leave the custodian probed and misbooked.
 *
 * Lowercase — every caller compares against lowercased addresses.
 */
export const SINGLETON_DEX_CUSTODIANS: ReadonlySet<string> = new Set([
	UNISWAP_V4_POOL_MANAGER,
	PANCAKE_INFINITY_VAULT,
]);

// ─── Helpers ───

/**
 * Decode V3-like Swap events (Uniswap V3 + optionally PancakeSwap V3) from a
 * flat log array. Returns pool address + amount0/amount1 for each decoded swap.
 * Pure function — no RPC calls.
 */
export function decodeV3LikeSwaps(
	logs: readonly LogLike[],
	recognizeForks: boolean,
): { pool: string; amount0: bigint; amount1: bigint }[] {
	const out: { pool: string; amount0: bigint; amount1: bigint }[] = [];
	for (const log of logs) {
		if (!log.topics || log.topics.length < 3) continue;
		const topic0 = log.topics[0]!.toLowerCase();
		const isUni = topic0 === SWAP_TOPIC;
		const isPancake = recognizeForks && topic0 === PANCAKE_V3_SWAP_TOPIC;
		if (!isUni && !isPancake) continue;
		try {
			const decoded = decodeEventLog({
				abi: [isPancake ? PANCAKE_V3_SWAP_EVENT : V3_SWAP_EVENT],
				data: log.data,
				topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
			});
			out.push({ pool: log.address.toLowerCase(), amount0: decoded.args.amount0 as bigint, amount1: decoded.args.amount1 as bigint });
		} catch { /* topic collision; skip */ }
	}
	return out;
}

/**
 * Decode V4 Swap events from a flat log array and return the raw `fee` values
 * (uint24, in hundredths-of-a-bps: 450 → 4.5 bps, 500 → 5 bps).
 * Pure function — no RPC calls.
 */
export function decodeV4SwapFees(logs: readonly LogLike[]): number[] {
	const fees: number[] = [];
	for (const log of logs) {
		if (!log.topics || log.topics.length < 3) continue;
		if (log.topics[0] !== V4_SWAP_TOPIC) continue;
		try {
			const decoded = decodeEventLog({
				abi: [V4_SWAP_EVENT],
				data: log.data,
				topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
			});
			fees.push(Number(decoded.args.fee));
		} catch {
			// Malformed log — skip
		}
	}
	return fees;
}
