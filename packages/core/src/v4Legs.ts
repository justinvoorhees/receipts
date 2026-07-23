/**
 * v4Legs.ts — Uniswap V4 per-pool leg extraction.
 *
 * The V4 singleton PoolManager clears every pool through one address, so
 * address-level net deltas collapse a multi-pool route into an un-modelable
 * multi-token venue. The V4 Swap event, however, carries per-pool amounts +
 * poolId, so we synthesize one route-graph leg per swap here.
 *
 * Pure module: no RPC. poolId→token resolution is injected by the caller.
 */
import { decodeEventLog, parseAbiItem, toEventSelector } from 'viem';
import type { LogLike } from './tradeEndpoints.js';

export const V4_SWAP_EVENT_ABI = [
  parseAbiItem(
    'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
  ),
] as const;

/**
 * PINNED FROM id 56 (CLAWD→USDC) on 2026-07-22. In the V4 Swap event, a
 * token amount is NEGATIVE when the swapper PAYS it in (tokenIn), POSITIVE
 * when the swapper RECEIVES it (tokenOut). Therefore: the token with the
 * NEGATIVE amount is the leg's tokenIn; the token with the POSITIVE amount
 * is tokenOut.
 *
 * Observed directly on the id-56 fixture, not inferred: cross-referenced
 * each V4 Swap log against the CLAWD ERC20 `Transfer` logs in the same
 * receipt. Two independent exact-magnitude matches, in different amount
 * slots (ruling out a fixed amount0-vs-amount1 coincidence):
 *   - Pool `0xcb987d4a…` (fee 10000): CLAWD Transfer of
 *     20084640107556443569474410 FROM the router TO the PoolManager (CLAWD
 *     paid in) exactly matches this swap's amount0 = -20084640107556443569474410.
 *     CLAWD sorts as currency0 here (0x9f86… < 0xcbb7c0…).
 *   - Pool `0xca5e723b…` (fee 10000): a second CLAWD Transfer of
 *     4016928021511288713894883 FROM the router TO the PoolManager (paid
 *     in) exactly matches this swap's amount1 = -4016928021511288713894883
 *     (CLAWD is currency1 in this pool's pair).
 * Both paid-in CLAWD legs decoded NEGATIVE. The third pool (`0x96d4b53a…`)
 * corroborates by symmetry: the intermediate "hub" token's magnitude
 * (34644869767736354) is +amount0 in pool `0xca5e723b…` (received by the
 * router, i.e. tokenOut) and -amount0 in pool `0x96d4b53a…` (paid back in
 * as that pool's input) — same token, opposite sign as it flips from
 * output to input, consistent with the CLAWD observations.
 */
export const V4_AMOUNT_SIGN = {
  /** Set true if positive amount == token paid INTO the pool (tokenIn). */
  positiveIsTokenIn: false,
} as const;

export interface V4Swap {
  poolId: string; // lowercase bytes32
  fee: number; // raw V4 fee (pips)
  amount0: bigint; // signed
  amount1: bigint; // signed
  sqrtPriceX96: bigint;
}

const V4_SWAP_TOPIC = toEventSelector(V4_SWAP_EVENT_ABI[0]).toLowerCase();

/** Extract one V4Swap per Uniswap V4 Swap log. Malformed logs are skipped. */
export function collectV4Swaps(logs: readonly LogLike[]): V4Swap[] {
  const out: V4Swap[] = [];
  for (const log of logs) {
    if (!log.topics || log.topics.length === 0) continue;
    if (log.topics[0]!.toLowerCase() !== V4_SWAP_TOPIC) continue;
    try {
      const decoded = decodeEventLog({
        abi: V4_SWAP_EVENT_ABI,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      const a = decoded.args as {
        id: string;
        amount0: bigint;
        amount1: bigint;
        sqrtPriceX96: bigint;
        fee: number | bigint;
      };
      out.push({
        poolId: a.id.toLowerCase(),
        fee: Number(a.fee),
        amount0: a.amount0,
        amount1: a.amount1,
        sqrtPriceX96: a.sqrtPriceX96,
      });
    } catch {
      // malformed V4 log — skip
    }
  }
  return out;
}
