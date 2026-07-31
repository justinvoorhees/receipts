import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeEventLog } from 'viem';
import { V4_SWAP_EVENT_ABI, collectV4Swaps, shouldAttemptV4Rescue, synthesizeV4Legs, type V4Swap } from './v4Legs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const swaps = JSON.parse(readFileSync(resolve(__dirname, '__fixtures__/v4-id56-swaps.json'), 'utf-8'));

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- documents the known-sold token for the human reading the console output below
const CLAWD = '0x9f86db9fc6f7c9408e8fda3ff8ce4e78ac7a6b07';

describe('v4 swap sign convention (id 56 fixture)', () => {
  it('every V4 swap has exactly one positive and one negative amount (one token in, one out)', () => {
    // This is the structural invariant the entire sign convention rests on:
    // in a single-pool V4 swap one token is paid IN (one sign) and the other is
    // paid OUT (opposite sign). If a decode bug or a degenerate swap violated
    // this, synthesizeV4Legs (Task 4) would produce a nonsense leg. Asserting it
    // here is a real regression guard, independent of WHICH sign means "in".
    expect(swaps.length).toBeGreaterThanOrEqual(2);
    for (const log of swaps) {
      const decoded = decodeEventLog({ abi: V4_SWAP_EVENT_ABI, data: log.data, topics: log.topics });
      const { id, amount0, amount1, sqrtPriceX96 } = decoded.args as {
        id: string; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint;
      };
      // Exactly one positive, one negative (both non-zero, opposite signs):
      expect(amount0).not.toBe(0n);
      expect(amount1).not.toBe(0n);
      expect(amount0 > 0n).not.toBe(amount1 > 0n);
      expect(sqrtPriceX96 > 0n).toBe(true);
      // Console line still drives the human's one-time convention pinning below;
      // the assertions above are the actual test.
      console.log('poolId', id, 'amount0', amount0.toString(), 'amount1', amount1.toString());
    }
  });
});

describe('collectV4Swaps', () => {
  it('returns one record per V4 Swap log with poolId, fee, amounts, price', () => {
    const out = collectV4Swaps(swaps);
    expect(out.length).toBe(swaps.length);
    for (const s of out) {
      expect(typeof s.poolId).toBe('string');
      expect(s.poolId.startsWith('0x')).toBe(true);
      expect(typeof s.fee).toBe('number');
      expect(s.sqrtPriceX96 > 0n).toBe(true);
    }
  });

  it('ignores non-V4 logs', () => {
    const noise = [{ address: '0xabc', topics: ['0xdeadbeef'], data: '0x' }];
    expect(collectV4Swaps(noise as never)).toEqual([]);
  });
});

const WETH = '0x4200000000000000000000000000000000000006';
const NATIVE = '0x0000000000000000000000000000000000000000';
const TOKEN_A = '0x000000000000000000000000000000000000aaaa';
const TOKEN_B = '0x000000000000000000000000000000000000bbbb';
const POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b';

describe('synthesizeV4Legs', () => {
  it('builds a univ4 leg with tokenIn=negative-amount token per the pinned convention', () => {
    // Convention pinned in Task 1: V4_AMOUNT_SIGN.positiveIsTokenIn === FALSE →
    // the NEGATIVE-amount token is paid INTO the pool (tokenIn); the positive
    // one is paid out (tokenOut). Here amount0 = +100 (token0 out), amount1 =
    // -90 (token1 in).
    const swaps: V4Swap[] = [
      { poolId: '0xpool1', fee: 3000, amount0: 100n, amount1: -90n, sqrtPriceX96: 1n, emitter: POOL_MANAGER },
    ];
    const keys = new Map([['0xpool1', { currency0: TOKEN_A, currency1: TOKEN_B }]]);
    const legs = synthesizeV4Legs(swaps, keys, WETH);
    expect(legs).toHaveLength(1);
    const leg = legs[0]!;
    expect(leg.type).toBe('univ4');
    expect(leg.v4PoolId).toBe('0xpool1');
    expect(leg.v4FeeRaw).toBe(3000);
    // positiveIsTokenIn === false: token1 (negative amount) is tokenIn, token0 (positive) is tokenOut.
    expect(leg.tokenIn).toBe(TOKEN_B);
    expect(leg.tokenOut).toBe(TOKEN_A);
    expect(leg.amountInRaw).toBe(90n);   // |amount1|
    expect(leg.amountOutRaw).toBe(100n); // |amount0|
  });

  it('maps native currency0 (address(0)) to the WETH sentinel', () => {
    const swaps: V4Swap[] = [
      { poolId: '0xpool2', fee: 500, amount0: -5n, amount1: 42n, sqrtPriceX96: 1n, emitter: POOL_MANAGER },
    ];
    const keys = new Map([['0xpool2', { currency0: NATIVE, currency1: TOKEN_B }]]);
    const legs = synthesizeV4Legs(swaps, keys, WETH);
    // positiveIsTokenIn === false: amount0 negative → token0 (native→WETH) is tokenIn;
    // amount1 positive → token1 (TOKEN_B) is tokenOut.
    expect(legs[0]!.tokenIn).toBe(WETH);
    expect(legs[0]!.tokenOut).toBe(TOKEN_B);
  });

  it('drops swaps whose poolId has no resolved key', () => {
    const swaps: V4Swap[] = [{ poolId: '0xunknown', fee: 3000, amount0: 1n, amount1: -1n, sqrtPriceX96: 1n, emitter: POOL_MANAGER }];
    expect(synthesizeV4Legs(swaps, new Map(), WETH)).toEqual([]);
  });
});

const swap = (poolId: string, fee = 500): V4Swap => ({
  poolId, fee, amount0: 1n, amount1: -1n, sqrtPriceX96: 1n, emitter: POOL_MANAGER,
});

describe('shouldAttemptV4Rescue', () => {
  it('fires on the original path: a failed graph with an orphan token', () => {
    expect(shouldAttemptV4Rescue({
      reconstructed: false, breakReason: { kind: 'orphan_token' }, v4Swaps: [swap('0xa')],
    })).toBe(true);
  });

  it('fires on the original path: a failed graph blamed on fee-on-transfer', () => {
    expect(shouldAttemptV4Rescue({
      reconstructed: false, breakReason: { kind: 'fee_on_transfer' }, v4Swaps: [swap('0xa')],
    })).toBe(true);
  });

  it('does NOT fire on a failed graph with an unrelated break reason', () => {
    // A cyclic/disconnected route is not a hidden-V4-pool problem; synthesizing
    // legs there would be guesswork.
    expect(shouldAttemptV4Rescue({
      reconstructed: false, breakReason: { kind: 'unreconstructed' }, v4Swaps: [swap('0xa')],
    })).toBe(false);
  });

  it('THE NEW PATH: fires on a graph that reconstructed over >1 distinct pool', () => {
    // ids 55/59/207/211/249 — the route chains fine, but on ONE leg that
    // collapsed several pools and took an arbitrary pool's fee tier.
    expect(shouldAttemptV4Rescue({
      reconstructed: true, breakReason: undefined,
      v4Swaps: [swap('0xa', 49), swap('0xb', 500)],
    })).toBe(true);
  });

  it('does NOT fire on a reconstructed single-pool route', () => {
    // The regression guard: 21 of 26 V4 receipts are correct today.
    expect(shouldAttemptV4Rescue({
      reconstructed: true, breakReason: undefined, v4Swaps: [swap('0xa')],
    })).toBe(false);
  });

  it('counts DISTINCT pools, not swap events', () => {
    // Two swaps through one pool is not a collapsed multi-pool leg.
    expect(shouldAttemptV4Rescue({
      reconstructed: true, breakReason: undefined,
      v4Swaps: [swap('0xa', 500), swap('0xa', 500)],
    })).toBe(false);
  });

  it('never fires without V4 swaps', () => {
    expect(shouldAttemptV4Rescue({
      reconstructed: false, breakReason: { kind: 'orphan_token' }, v4Swaps: [],
    })).toBe(false);
    expect(shouldAttemptV4Rescue({
      reconstructed: true, breakReason: undefined, v4Swaps: [],
    })).toBe(false);
  });
});

describe('collectV4Swaps zero-amount guard', () => {
  // Receipt id 402 (CHAOS→USDC, $268). Its ONLY V4 Swap log moved nothing:
  // amount0 = amount1 = 0, with sqrtPriceX96 = exactly 2^96 — the canonical
  // "price = 1" value of a pool that was never initialised with real liquidity.
  // routeVenueScan attached that poolId to the venue anyway, so getLegMidAtBlock
  // read a mid of 1.0 for a WETH/USDC leg whose real price is ~2000, producing a
  // price impact of 9999 bps that the implausibility clamp then nulled.
  const Q96 = 79228162514264337593543950336n;
  const V4_SWAP_TOPIC = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
  const PM = '0x498581ff718922c3f8e6a244956af099b2652b2b';
  const word = (v: bigint) => (v < 0n ? (2n ** 256n + v) : v).toString(16).padStart(64, '0');
  const swapLog = (poolId: string, amount0: bigint, amount1: bigint, sqrt: bigint, fee: bigint) => ({
    address: PM as `0x${string}`,
    topics: [V4_SWAP_TOPIC, poolId, `0x${'0'.repeat(64)}`] as unknown as readonly `0x${string}`[],
    data: `0x${word(amount0)}${word(amount1)}${word(sqrt)}${word(0n)}${word(0n)}${word(fee)}` as `0x${string}`,
  });

  it('skips a swap that moved nothing — its poolId is not the pool the trade used', () => {
    const logs = [swapLog(`0x${'af'.repeat(32)}`, 0n, 0n, Q96, 100n)];
    expect(collectV4Swaps(logs as never)).toEqual([]);
  });

  it('keeps a real swap even when one side is zero', () => {
    // Only BOTH sides zero is a no-op. A one-sided zero is a real (if odd) swap
    // and its poolId is genuine — dropping it would lose a leg.
    const logs = [swapLog(`0x${'bb'.repeat(32)}`, 0n, -5000n, 12345678n, 500n)];
    expect(collectV4Swaps(logs as never)).toHaveLength(1);
  });

  it('keeps ordinary swaps', () => {
    const logs = [swapLog(`0x${'cc'.repeat(32)}`, 1000n, -999n, 12345678n, 500n)];
    const out = collectV4Swaps(logs as never);
    expect(out).toHaveLength(1);
    expect(out[0]!.fee).toBe(500);
  });
});
