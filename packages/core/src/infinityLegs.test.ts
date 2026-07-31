import { describe, expect, it } from 'vitest';
import {
  collectInfinitySwaps,
  infinityLpFeePips,
  shouldAttemptInfinityRescue,
  synthesizeInfinityLegs,
  INFINITY_SWAP_TOPIC,
} from './infinityLegs.js';
import type { InfinitySwap } from './infinityLegs.js';

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const VAULT = '0x238a358808379702088667322f80ac48bad5e6c4';

const word = (v: bigint) => (v < 0n ? 2n ** 256n + v : v).toString(16).padStart(64, '0');
const swapLog = (
  poolId: string,
  amount0: bigint,
  amount1: bigint,
  fee: bigint,
  protocolFee: bigint,
  sqrt = 12345678n,
) => ({
  // collectInfinitySwaps filters by TOPIC, not address, so any address works.
  address: '0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b' as `0x${string}`,
  topics: [INFINITY_SWAP_TOPIC, poolId, `0x${'0'.repeat(64)}`] as unknown as readonly `0x${string}`[],
  data: `0x${word(amount0)}${word(amount1)}${word(sqrt)}${word(0n)}${word(0n)}${word(fee)}${word(protocolFee)}` as `0x${string}`,
});

describe('infinityLpFeePips', () => {
  it('inverts calculateSwapFee to the LP-only share', () => {
    // Pancake: swapFee = protocolFee + lpFee − protocolFee·lpFee/1e6.
    // id 408 emitted swapFee=70, protocolFee=23 → lpFee 47.001, and the pool
    // key's static fee for that pool reads exactly 47. Both agree.
    expect(infinityLpFeePips(70, 23)).toBeCloseTo(47.001, 2);
  });

  it('returns the whole fee when no protocol cut is taken', () => {
    expect(infinityLpFeePips(500, 0)).toBeCloseTo(500, 6);
  });

  it('is zero for a zero fee', () => {
    expect(infinityLpFeePips(0, 0)).toBe(0);
  });

  it('never returns a negative fee', () => {
    // Defensive: a protocolFee exceeding swapFee is nonsense, but must not
    // produce a negative LP fee that would later read as a rebate.
    expect(infinityLpFeePips(10, 50)).toBe(0);
  });
});

describe('collectInfinitySwaps', () => {
  it('decodes a real swap and stores the LP-ONLY fee', () => {
    // id 408's actual log: amount0 +1605452779327540 (native ETH),
    // amount1 −2991046 (USDC), fee 70, protocolFee 23.
    const out = collectInfinitySwaps([
      swapLog(`0x${'f6'.repeat(32)}`, 1605452779327540n, -2991046n, 70n, 23n),
    ] as never);
    expect(out).toHaveLength(1);
    expect(out[0]!.amount0).toBe(1605452779327540n);
    expect(out[0]!.amount1).toBe(-2991046n);
    // 47, not the event's 70 — storing the total would overstate the LP fee.
    expect(out[0]!.lpFeePips).toBeCloseTo(47.001, 2);
  });

  it('skips a swap that moved nothing', () => {
    // Same guard as V4: a no-op swap's poolId is not the pool the trade used,
    // and using it would poison the mid read.
    expect(collectInfinitySwaps([swapLog(`0x${'aa'.repeat(32)}`, 0n, 0n, 70n, 23n)] as never)).toEqual([]);
  });

  it('keeps a swap with one side zero', () => {
    expect(collectInfinitySwaps([swapLog(`0x${'bb'.repeat(32)}`, 0n, -500n, 70n, 23n)] as never)).toHaveLength(1);
  });

  it('ignores logs with another topic', () => {
    const other = { ...swapLog(`0x${'cc'.repeat(32)}`, 1n, -1n, 70n, 23n) };
    (other as unknown as { topics: string[] }).topics = [`0x${'de'.repeat(32)}`];
    expect(collectInfinitySwaps([other] as never)).toEqual([]);
  });
});

describe('synthesizeInfinityLegs', () => {
  const swap = (poolId: string, a0: bigint, a1: bigint): InfinitySwap => ({
    poolId, lpFeePips: 47, amount0: a0, amount1: a1, sqrtPriceX96: 1n,
  });

  it('maps native currency0 to the WETH sentinel', () => {
    // id 408's pool is (native ETH, USDC). The route graph is ERC-20 only, so
    // native must be remapped or the leg can never chain.
    const keys = new Map([['0xf6', { currency0: '0x0000000000000000000000000000000000000000', currency1: USDC }]]);
    const legs = synthesizeInfinityLegs([swap('0xf6', 1605452779327540n, -2991046n)], keys, WETH);
    expect(legs).toHaveLength(1);
    expect([legs[0]!.tokenIn, legs[0]!.tokenOut]).toContain(WETH);
  });

  it('uses the VERIFIED sign convention: negative == paid in', () => {
    // Pinned on id 408 (USDC→ETH): amount1 (USDC) is negative and the swapper
    // pays USDC — its magnitude matches the Vault's measured net delta exactly.
    // So the NEGATIVE side is tokenIn, same as V4.
    const keys = new Map([['0xf6', { currency0: WETH, currency1: USDC }]]);
    const legs = synthesizeInfinityLegs([swap('0xf6', 1605452779327540n, -2991046n)], keys, WETH);
    expect(legs[0]!.tokenIn).toBe(USDC);
    expect(legs[0]!.tokenOut).toBe(WETH);
    expect(legs[0]!.amountInRaw).toBe(2991046n);
    expect(legs[0]!.amountOutRaw).toBe(1605452779327540n);
  });

  it('names the venue by pool and marks the VAULT as the leg it replaces', () => {
    // The CLPoolManager emits, but transfers land at the Vault — so the Vault's
    // address-derived leg is the one these replace.
    const keys = new Map([['0xf6', { currency0: WETH, currency1: USDC }]]);
    const legs = synthesizeInfinityLegs([swap('0xf6', 1n, -1n)], keys, WETH);
    expect(legs[0]!.venue).toBe('inf:0xf6');
    expect(legs[0]!.replacesVenue).toBe(VAULT);
    expect(legs[0]!.type).toBe('pancake_infinity');
    expect(legs[0]!.infinityPoolId).toBe('0xf6');
    expect(legs[0]!.infinityFeeRaw).toBe(47);
  });

  it('drops a swap whose pool key did not resolve', () => {
    // A null key means we do not know the tokens; a leg without them is worse
    // than no leg. decomposeRoute's shortfall guard then catches the shortfall.
    expect(synthesizeInfinityLegs([swap('0xf6', 1n, -1n)], new Map(), WETH)).toEqual([]);
  });
});

describe('shouldAttemptInfinityRescue', () => {
  const s = (poolId: string): InfinitySwap => ({
    poolId, lpFeePips: 47, amount0: 1n, amount1: -1n, sqrtPriceX96: 1n,
  });

  it('fires on a failed graph with an orphan token', () => {
    expect(shouldAttemptInfinityRescue({ reconstructed: false, breakReason: { kind: 'orphan_token' }, swaps: [s('0xa')] })).toBe(true);
  });

  it('fires on a failed graph blamed on fee-on-transfer', () => {
    expect(shouldAttemptInfinityRescue({ reconstructed: false, breakReason: { kind: 'fee_on_transfer' }, swaps: [s('0xa')] })).toBe(true);
  });

  it('does NOT fire on an unrelated break reason', () => {
    expect(shouldAttemptInfinityRescue({ reconstructed: false, breakReason: { kind: 'unreconstructed' }, swaps: [s('0xa')] })).toBe(false);
  });

  it('fires on a reconstructed graph spanning more than one pool', () => {
    expect(shouldAttemptInfinityRescue({ reconstructed: true, breakReason: undefined, swaps: [s('0xa'), s('0xb')] })).toBe(true);
  });

  it('does NOT fire on a reconstructed single-pool route', () => {
    expect(shouldAttemptInfinityRescue({ reconstructed: true, breakReason: undefined, swaps: [s('0xa')] })).toBe(false);
  });

  it('counts DISTINCT pools, not swap events', () => {
    expect(shouldAttemptInfinityRescue({ reconstructed: true, breakReason: undefined, swaps: [s('0xa'), s('0xa')] })).toBe(false);
  });

  it('never fires without swaps', () => {
    expect(shouldAttemptInfinityRescue({ reconstructed: false, breakReason: { kind: 'orphan_token' }, swaps: [] })).toBe(false);
    expect(shouldAttemptInfinityRescue({ reconstructed: true, breakReason: undefined, swaps: [] })).toBe(false);
  });
});
