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
import type { Leg } from './routeGraph.js';
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
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

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

/**
 * Build one univ4 Leg per resolved V4 swap. Direction comes from the pinned
 * V4_AMOUNT_SIGN convention: the token with the positive (if positiveIsTokenIn)
 * amount is tokenIn, the other is tokenOut. Native currency (address(0)) is
 * remapped to the WETH sentinel so the ERC-20-only route graph can chain it.
 * Swaps with an unresolved poolId are dropped.
 */
export function synthesizeV4Legs(
  swaps: V4Swap[],
  poolKeys: Map<string, { currency0: string; currency1: string }>,
  wethSentinel: string,
): Leg[] {
  const out: Leg[] = [];
  for (const s of swaps) {
    const key = poolKeys.get(s.poolId);
    if (!key) continue;
    // Lowercase the reader's currencies before mapping: the default reader
    // normalizes, but a custom injected v4PoolKeyReader could return checksummed
    // addresses, which would defeat the native (ZERO_ADDRESS) remap and the
    // case-sensitive leg chaining / extraLegs de-dup downstream.
    const map = (c: string) => {
      const lc = c.toLowerCase();
      return lc === ZERO_ADDRESS ? wethSentinel : lc;
    };
    const tok0 = map(key.currency0);
    const tok1 = map(key.currency1);
    // amount0 sign tells us token0's role. Under positiveIsTokenIn, positive
    // amount0 ⇒ token0 is tokenIn. Amounts are magnitudes on the leg.
    const zeroIsIn = V4_AMOUNT_SIGN.positiveIsTokenIn ? s.amount0 > 0n : s.amount0 < 0n;
    const abs = (x: bigint) => (x < 0n ? -x : x);
    const tokenIn = zeroIsIn ? tok0 : tok1;
    const tokenOut = zeroIsIn ? tok1 : tok0;
    const amountInRaw = zeroIsIn ? abs(s.amount0) : abs(s.amount1);
    const amountOutRaw = zeroIsIn ? abs(s.amount1) : abs(s.amount0);
    out.push({
      venue: `v4:${s.poolId}`,
      type: 'univ4',
      tokenIn,
      tokenOut,
      amountInRaw,
      amountOutRaw,
      v4PoolId: s.poolId,
      v4FeeRaw: s.fee,
    });
  }
  return out;
}

/**
 * Should we try synthesizing per-pool V4 legs for this route?
 *
 * Two independent reasons, and the second is easy to miss:
 *
 *  1. The first-pass graph FAILED in a way a hidden V4 pool explains — a token
 *     consumed but never produced (`orphan_token`), or an intermediate whose
 *     captured legs under-account for it (`fee_on_transfer` classification).
 *     Other break reasons (cyclic, disconnected) are not V4 problems and
 *     synthesizing there would be guesswork.
 *
 *  2. The graph RECONSTRUCTED, but over more than one distinct V4 pool. The V4
 *     PoolManager is a singleton and routeVenueScan keys venues by emitter
 *     address, so several pools collapse into ONE leg that keeps only the last
 *     pool's fee tier and poolId. Such a route chains perfectly well — it is
 *     simply wrong. Reconstruction success is NOT evidence of correctness here.
 *
 * Distinctness, not swap count: two Swap events through the same pool are a
 * single pool and need no rescue.
 */
export function shouldAttemptV4Rescue(args: {
  reconstructed: boolean;
  breakReason?: { kind: string } | undefined;
  v4Swaps: readonly V4Swap[];
}): boolean {
  const { reconstructed, breakReason, v4Swaps } = args;
  if (v4Swaps.length === 0) return false;
  if (!reconstructed) {
    return breakReason?.kind === 'orphan_token' || breakReason?.kind === 'fee_on_transfer';
  }
  return new Set(v4Swaps.map((s) => s.poolId)).size > 1;
}
