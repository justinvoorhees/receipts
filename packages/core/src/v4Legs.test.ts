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
