/**
 * infinityLegs.ts — PancakeSwap Infinity per-pool leg extraction.
 *
 * Structurally the same problem as v4Legs.ts: a singleton clears every pool, so
 * address-level net deltas collapse a multi-pool route into one un-modelable
 * venue. The Swap event carries per-pool amounts + poolId, so we synthesize one
 * route-graph leg per swap.
 *
 * ⚠️ Infinity SPLITS what Uniswap V4 unifies. The CLPoolManager EMITS the Swap;
 * the Vault CUSTODIES the tokens, so it is the Vault that appears in transfers
 * and therefore the Vault's address-derived leg that these replace.
 *
 * Deliberately a sibling of v4Legs.ts rather than a shared abstraction: the V4
 * path carries three separately-earned correctness guards, and unifying the two
 * against a sample of two would put those at risk for no present gain.
 *
 * Pure module: no RPC. poolId→token resolution is injected by the caller.
 */
import { decodeEventLog, parseAbiItem, toEventSelector } from 'viem';
import type { Leg } from './routeGraph.js';
import type { LogLike } from './tradeEndpoints.js';
import { PANCAKE_INFINITY_VAULT } from './tradeDecoders.js';

// ⚠️ Address ownership, to avoid a third copy of each: the VAULT already lives
// in tradeDecoders.ts as PANCAKE_INFINITY_VAULT (shipped with the singleton
// custodian registry) and is imported here. The CLPoolManager is an RPC target,
// so it lives in poolDiscovery.ts beside V4_POOL_MANAGER — this module never
// needs it, since it filters logs by TOPIC rather than by emitter address.

/** ⚠️ Seven non-indexed fields — one MORE than V4's, which has no protocolFee. */
export const INFINITY_SWAP_EVENT_ABI = [
  parseAbiItem(
    'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee, uint16 protocolFee)',
  ),
] as const;

export const INFINITY_SWAP_TOPIC = toEventSelector(INFINITY_SWAP_EVENT_ABI[0]).toLowerCase();

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface InfinitySwap {
  poolId: string;   // lowercase bytes32
  lpFeePips: number; // LP-ONLY pips, already inverted out of the event's swapFee
  amount0: bigint;  // signed
  amount1: bigint;  // signed
  sqrtPriceX96: bigint;
}

/**
 * Recover the LP-only fee from the event's total.
 *
 * Pancake charges `swapFee = protocolFee + lpFee − protocolFee·lpFee/1e6`, so
 * `lpFee = (swapFee − protocolFee) / (1 − protocolFee/1e6)`.
 *
 * ⚠️ Persisting the event's `fee` directly would overstate the LP fee by the
 * protocol's share — 0.70 bps instead of 0.47 on id 408. Deriving it from the
 * EVENT rather than the pool key is also correct for dynamic-fee pools, where
 * the key's static value would be stale.
 */
export function infinityLpFeePips(swapFee: number, protocolFee: number): number {
  const net = swapFee - protocolFee;
  if (net <= 0) return 0;
  return net / (1 - protocolFee / 1_000_000);
}

/** Extract one InfinitySwap per Infinity Swap log. Malformed logs are skipped. */
export function collectInfinitySwaps(logs: readonly LogLike[]): InfinitySwap[] {
  const out: InfinitySwap[] = [];
  for (const log of logs) {
    if (!log.topics || log.topics.length === 0) continue;
    if (log.topics[0]!.toLowerCase() !== INFINITY_SWAP_TOPIC) continue;
    try {
      const decoded = decodeEventLog({
        abi: INFINITY_SWAP_EVENT_ABI,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      const a = decoded.args as {
        id: string;
        amount0: bigint;
        amount1: bigint;
        sqrtPriceX96: bigint;
        fee: number | bigint;
        protocolFee: number | bigint;
      };
      // A swap that moved nothing is a no-op, and its poolId is not the pool the
      // trade went through — identifying a venue from it poisons the mid read.
      // Same guard, same reason, as collectV4Swaps.
      if (a.amount0 === 0n && a.amount1 === 0n) continue;
      out.push({
        poolId: a.id.toLowerCase(),
        lpFeePips: infinityLpFeePips(Number(a.fee), Number(a.protocolFee)),
        amount0: a.amount0,
        amount1: a.amount1,
        sqrtPriceX96: a.sqrtPriceX96,
      });
    } catch {
      // malformed Infinity log — skip
    }
  }
  return out;
}

/**
 * One route-graph leg per swap.
 *
 * ⚠️ Sign convention VERIFIED on id 408, not assumed: that trade is USDC→ETH so
 * the swapper pays USDC, and the log's `amount1` (USDC) is NEGATIVE with a
 * magnitude (2.991046) matching the Vault's measured net USDC delta exactly.
 * Therefore the NEGATIVE side is tokenIn — the same convention as V4.
 *
 * Native currency (address(0)) is remapped to the WETH sentinel so the
 * ERC-20-only route graph can chain the leg. Swaps whose pool key did not
 * resolve are dropped: a leg without known tokens is worse than no leg, and
 * decomposeRoute's shortfall guard catches the resulting under-accounting.
 */
export function synthesizeInfinityLegs(
  swaps: readonly InfinitySwap[],
  poolKeys: Map<string, { currency0: string; currency1: string }>,
  wethSentinel: string,
): Leg[] {
  const out: Leg[] = [];
  for (const s of swaps) {
    const key = poolKeys.get(s.poolId);
    if (!key) continue;
    const map = (c: string) => {
      const lc = c.toLowerCase();
      return lc === ZERO_ADDRESS ? wethSentinel : lc;
    };
    const tok0 = map(key.currency0);
    const tok1 = map(key.currency1);
    const zeroIsIn = s.amount0 < 0n; // negative == paid in
    const abs = (x: bigint) => (x < 0n ? -x : x);
    out.push({
      venue: `inf:${s.poolId}`,
      type: 'pancake_infinity',
      tokenIn: zeroIsIn ? tok0 : tok1,
      tokenOut: zeroIsIn ? tok1 : tok0,
      amountInRaw: zeroIsIn ? abs(s.amount0) : abs(s.amount1),
      amountOutRaw: zeroIsIn ? abs(s.amount1) : abs(s.amount0),
      infinityPoolId: s.poolId,
      infinityFeeRaw: s.lpFeePips,
      replacesVenue: PANCAKE_INFINITY_VAULT,
    });
  }
  return out;
}

/**
 * Should we synthesize per-pool Infinity legs for this route?
 *
 * Mirrors shouldAttemptV4Rescue, for the same two reasons: the first pass FAILED
 * in a way a hidden pool explains, or it RECONSTRUCTED over more than one
 * distinct pool — which chains fine while being wrong, since the collapsed leg
 * keeps only one pool's identity. Distinctness, not swap count.
 */
export function shouldAttemptInfinityRescue(args: {
  reconstructed: boolean;
  breakReason?: { kind: string } | undefined;
  swaps: readonly InfinitySwap[];
}): boolean {
  const { reconstructed, breakReason, swaps } = args;
  if (swaps.length === 0) return false;
  if (!reconstructed) {
    return breakReason?.kind === 'orphan_token' || breakReason?.kind === 'fee_on_transfer';
  }
  return new Set(swaps.map((s) => s.poolId)).size > 1;
}
