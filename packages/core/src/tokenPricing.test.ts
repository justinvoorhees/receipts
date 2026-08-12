/**
 * tokenPricing.test.ts — Unit tests for generalized pair-mid pricing.
 *
 * Tests the pure-math functions: sqrtPriceX96ToPrice, v2MidFromReserves,
 * and decimals-cache behavior. RPC-dependent integration (getPairMidAtBlock,
 * getTokenUsdcValue) is validated via a separate tsx snippet, not here.
 */
import { describe, expect, it, vi } from 'vitest';
import { sqrtPriceX96ToPrice, v2MidFromReserves, makeDecimalsCache, getTokenUsdcValue, getEstimatedMidAtBlock, getEstimatedMidOutcome, midViaDeepest, depthUsd, MIN_POOL_LIQUIDITY_L, MIN_REFERENCE_DEPTH_USD, type EstimatedMidReaders } from './tokenPricing.js';
import { type PublicClient } from 'viem';

// ── sqrtPriceX96ToPrice ─────────────────────────────────────────────────────

describe('sqrtPriceX96ToPrice', () => {
  it('reproduces the USDC/WETH ×10^12 case from referencePrice.ts', () => {
    // Real sqrtPriceX96 from Base USDC/WETH V3 pool slot0 at block 47379623
    // (kyber-b1 block - 1). Pool 0xd0b53D…, token0=WETH(18), token1=USDC(6).
    // sqrtPriceX96ToUsdcPerWeth (referencePrice.ts) returns 1829.686… for this.
    const sqrtPriceX96 = 3388971581595881503726442n;

    // dec0=18 (WETH, token0 by address sort), dec1=6 (USDC, token1)
    const result = sqrtPriceX96ToPrice(sqrtPriceX96, 18, 6);

    // Must produce a reasonable USDC/WETH price (~1829 area)
    expect(result).toBeGreaterThan(1800);
    expect(result).toBeLessThan(1900);

    // Cross-check: must match the referencePrice.ts formula exactly
    // (sqrtPriceX96^2 * 10^12 * PRECISION) / 2^192 / PRECISION
    const Q192 = 1n << 192n;
    const PRECISION = 10n ** 8n;
    const DECIMAL_ADJUST = 10n ** 12n;
    const expected = Number(sqrtPriceX96 * sqrtPriceX96 * DECIMAL_ADJUST * PRECISION / Q192) / Number(PRECISION);

    expect(result).toBeCloseTo(expected, 4);
  });

  it('handles equal decimals (e.g. WETH/DAI, both 18)', () => {
    // With equal decimals, decimalAdjust = 10^0 = 1
    // price = (sqrtPriceX96 / 2^96)^2
    // For sqrtPriceX96 = 2^96 (= 79228162514264337593543950336):
    //   price = 1.0
    const sqrtPriceX96 = 79228162514264337593543950336n; // 2^96
    const result = sqrtPriceX96ToPrice(sqrtPriceX96, 18, 18);
    expect(result).toBeCloseTo(1.0, 6);
  });

  it('returns token1-per-token0 (not inverted)', () => {
    // With dec0=6, dec1=18 (opposite of WETH/USDC), decimalAdjust = 10^(-12)
    // A sqrtPriceX96 of 2^96 → raw_price = 1.0
    // Adjusted = 1.0 * 10^(6-18) = 1e-12
    const sqrtPriceX96 = 79228162514264337593543950336n; // 2^96
    const result = sqrtPriceX96ToPrice(sqrtPriceX96, 6, 18);
    expect(result).toBeCloseTo(1e-12, 20);
  });
});

// ── v2MidFromReserves ───────────────────────────────────────────────────────

describe('v2MidFromReserves', () => {
  it('computes mid price from V2 reserves (equal decimals)', () => {
    // 1000 token0, 2000 token1, both 18 decimals
    // price = reserve1 / reserve0 = 2.0 token1 per token0
    const result = v2MidFromReserves(
      1000n * 10n ** 18n,
      2000n * 10n ** 18n,
      18,
      18,
    );
    expect(result).toBeCloseTo(2.0, 6);
  });

  it('adjusts for different decimals (e.g. WETH(18)/USDC(6))', () => {
    // 1 WETH = 10^18 raw, 2500 USDC = 2500 * 10^6 raw
    // raw_price = (2500e6) / (1e18) = 2.5e-9
    // adjusted = raw_price * 10^(18-6) = 2.5e-9 * 1e12 = 2500
    const result = v2MidFromReserves(
      10n ** 18n,          // 1 WETH (dec0=18)
      2500n * 10n ** 6n,   // 2500 USDC (dec1=6)
      18,
      6,
    );
    expect(result).toBeCloseTo(2500, 2);
  });

  it('handles zero reserves gracefully', () => {
    const result = v2MidFromReserves(0n, 1000n, 18, 18);
    expect(result).toBe(0);
  });
});

// ── makeDecimalsCache ───────────────────────────────────────────────────────

describe('makeDecimalsCache', () => {
  it('returns known USDC decimals without calling RPC', async () => {
    let rpcCalls = 0;
    const cache = makeDecimalsCache(async (_addr: string) => {
      rpcCalls++;
      return 18; // fallback
    });
    const dec = await cache('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    expect(dec).toBe(6);
    expect(rpcCalls).toBe(0);
  });

  it('returns known WETH decimals without calling RPC', async () => {
    let rpcCalls = 0;
    const cache = makeDecimalsCache(async (_addr: string) => {
      rpcCalls++;
      return 6;
    });
    const dec = await cache('0x4200000000000000000000000000000000000006');
    expect(dec).toBe(18);
    expect(rpcCalls).toBe(0);
  });

  it('calls RPC for unknown tokens and caches the result', async () => {
    let rpcCalls = 0;
    const cache = makeDecimalsCache(async (_addr: string) => {
      rpcCalls++;
      return 8;
    });
    const dec1 = await cache('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(dec1).toBe(8);
    expect(rpcCalls).toBe(1);

    // Second call should be cached
    const dec2 = await cache('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(dec2).toBe(8);
    expect(rpcCalls).toBe(1); // no additional RPC call
  });

  it('normalizes addresses to lowercase for cache hits', async () => {
    let rpcCalls = 0;
    const cache = makeDecimalsCache(async (_addr: string) => {
      rpcCalls++;
      return 12;
    });
    await cache('0xDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEf');
    const dec = await cache('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(dec).toBe(12);
    expect(rpcCalls).toBe(1); // only one RPC call despite different casing
  });
});

// ── getTokenUsdcValue — precomputedWethUsd override ─────────────────────────

describe('getTokenUsdcValue', () => {
  it('uses precomputedWethUsd for WETH without any pool read', async () => {
    const client = { readContract: vi.fn() } as unknown as PublicClient; // throws if used
    const decimalsOf = async () => 18;
    const WETH = '0x4200000000000000000000000000000000000006';
    const oneWeth = 10n ** 18n;
    const val = await getTokenUsdcValue(client, WETH, oneWeth, 100n, decimalsOf, 3000);
    expect(val).toBeCloseTo(3000, 6);
    expect((client.readContract as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('prices native ETH as WETH (1:1, 18 dec) without reading decimals("native")', async () => {
    // A real decimals()/pool read on the "native" pseudo-address would revert.
    // The decimalsOf fake throws to prove native is priced before any such read.
    const client = { readContract: vi.fn() } as unknown as PublicClient;
    const decimalsOf = async () => {
      throw new Error('decimals("native") must not be called');
    };
    const halfEth = 5n * 10n ** 17n; // 0.5 ETH
    const val = await getTokenUsdcValue(client, 'native', halfEth, 100n, decimalsOf, 3000);
    expect(val).toBeCloseTo(1500, 6); // 0.5 × 3000
    expect((client.readContract as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

// ── getEstimatedMidAtBlock ───────────────────────────────────────────────────

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';
const NATIVE = 'native';
const WARP = '0xd9159ad2d5fe625cd1f54f4d328fb19cb5262b07';
// sqrtPriceX96 encoding token1-per-token0 = 1 for equal-decimal tokens (2**96).
const SQRT_1 = 79228162514264337593543950336n; // 2**96

// A WETH/USDC pool priced so WETH = 2000 USDC, and a WARP/WETH pool priced so
// WARP = 0.0005 WETH. Both deep. Then market mid (ETH per WARP) for WARP->native
// = usdRef(WARP)/usdRef(ETH) = (0.0005*2000) / 2000 = 0.0005.
function makeReaders(over: Partial<EstimatedMidReaders> = {}): EstimatedMidReaders {
  return {
    getDeepestPoolWithDepth: async (a, b) => {
      const key = [a.toLowerCase(), b.toLowerCase()].sort().join('|');
      if (key === [WETH, USDC].sort().join('|')) return { address: '0xwethusdc', depth: 10n ** 24n, kind: 'univ3' };
      if (key === [WARP, WETH].sort().join('|')) return { address: '0xwarpweth', depth: 10n ** 24n, kind: 'univ3' };
      return null;
    },
    readSlot0: async () => SQRT_1, // both fake pools priced at raw 1:1 (see decimals below)
    readV2Reserves: async () => null,
    readDecimals: async () => 18,
    ...over,
  };
}

describe('getEstimatedMidAtBlock', () => {
  it('bridges a volatile token to a USD anchor via its deepest token/WETH pool', async () => {
    // With SQRT_1 and equal decimals every pool reads raw price 1, so
    // usdRef(WARP)=1*1=1, usdRef(native)=1 → mid=1 (output-per-input). We only
    // assert it produced a positive, finite mid via the bridged path here.
    const res = await getEstimatedMidAtBlock(makeReaders(), WARP, NATIVE, 100n, 1n);
    expect(res).not.toBeNull();
    expect(res!.price).toBeGreaterThan(0);
    expect(res!.poolKind).toBe('estimated');
  });

  it('returns null when the volatile token’s deepest pool is below the liquidity floor', async () => {
    const readers = makeReaders({
      getDeepestPoolWithDepth: async (a, b) => {
        const key = [a.toLowerCase(), b.toLowerCase()].sort().join('|');
        if (key === [WETH, USDC].sort().join('|')) return { address: '0xwethusdc', depth: 10n ** 24n, kind: 'univ3' };
        if (key === [WARP, WETH].sort().join('|')) return { address: '0xwarpweth', depth: 0n, kind: 'univ3' }; // dead
        return null;
      },
    });
    const res = await getEstimatedMidAtBlock(readers, WARP, NATIVE, 100n, 1n);
    expect(res).toBeNull();
  });

  it('returns null when no WETH/USDC anchor pool is available', async () => {
    const readers = makeReaders({ getDeepestPoolWithDepth: async () => null });
    const res = await getEstimatedMidAtBlock(readers, WARP, NATIVE, 100n, 1n);
    expect(res).toBeNull();
  });

  it('returns null when the WETH/USDC anchor pool itself is below the liquidity floor', async () => {
    const readers = makeReaders({
      getDeepestPoolWithDepth: async (a, b) => {
        const key = [a.toLowerCase(), b.toLowerCase()].sort().join('|');
        if (key === [WETH, USDC].sort().join('|')) return { address: '0xwethusdc', depth: 0n, kind: 'univ3' }; // dead
        if (key === [WARP, WETH].sort().join('|')) return { address: '0xwarpweth', depth: 10n ** 24n, kind: 'univ3' };
        return null;
      },
    });
    const res = await getEstimatedMidAtBlock(readers, WARP, NATIVE, 100n, 1n);
    expect(res).toBeNull();
  });
});

// ── midViaDeepest — basic-AMM (reserves) branch ─────────────────────────────

describe('midViaDeepest', () => {
  it('prices a basic-AMM deepest pool from reserves', async () => {
    const token0 = '0x1111111111111111111111111111111111111111';
    const token1 = '0x2222222222222222222222222222222222222222';
    const readers = {
      getDeepestPoolWithDepth: async () => ({ address: '0xpool', depth: 5n, kind: 'aerodrome_basic' as const }),
      readSlot0: async () => { throw new Error('slot0 not for basic'); },
      readV2Reserves: async () => [1n * 10n ** 18n, 2500n * 10n ** 18n] as [bigint, bigint],
      readDecimals: async () => 18,
    };
    const res = await midViaDeepest(readers as never, token0, token1, 100n);
    expect(res!.price).toBeCloseTo(2500, 6);
  });

  it('returns null when the deepest basic-AMM pool has a one-sided reserve', async () => {
    const token0 = '0x1111111111111111111111111111111111111111';
    const token1 = '0x2222222222222222222222222222222222222222';
    const readers = {
      getDeepestPoolWithDepth: async () => ({ address: '0xpool', depth: 5n, kind: 'aerodrome_basic' as const }),
      readSlot0: async () => { throw new Error('slot0 not for basic'); },
      readV2Reserves: async () => [0n, 5n] as [bigint, bigint],
      readDecimals: async () => 18,
    };
    const res = await midViaDeepest(readers as never, token0, token1, 100n);
    expect(res).toBeNull();
  });
});

// ── depthUsd + the split floor constants ────────────────────────────────────

describe('depthUsd', () => {
  const USDC_A = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const DAI_A = '0x50c5725949a6f0c72e6c4a641f24049a917db0cb';
  const WETH_A = '0x4200000000000000000000000000000000000006';
  const BEAN_A = '0x5c72992b83e74c4d5200a8e8920fb946214a5a5d';

  it('values a USDC reference at its 6-decimal face', () => {
    expect(depthUsd(USDC_A, 1_500_000_000n, 1900, 6)).toBeCloseTo(1500, 6);
  });

  // The DAI trap: STABLECOINS holds USDC (6), USDbC (6) and DAI (18). Hardcoding
  // 1e6 for "a stable" would overstate a DAI pool by 1e12 and defeat the floor.
  it('uses the supplied decimals for an 18-decimal stable', () => {
    expect(depthUsd(DAI_A, 1_500_000_000_000_000_000_000n, 1900, 18)).toBeCloseTo(1500, 6);
  });

  it('values a WETH reference through wethUsd', () => {
    expect(depthUsd(WETH_A, 10n ** 18n, 1900, 18)).toBeCloseTo(1900, 6);
  });

  it('values native ETH like WETH', () => {
    expect(depthUsd('native', 10n ** 18n, 1900, 18)).toBeCloseTo(1900, 6);
  });

  it('reproduces the measured BEAN dust pool', () => {
    // 0x6945a4Bf held 115202102709082 wei WETH at wethUsd 1874.63 => $0.216
    expect(depthUsd(WETH_A, 115202102709082n, 1874.63, 18)).toBeCloseTo(0.216, 3);
  });

  it('returns null for a volatile reference token — the check is NOT performed', () => {
    expect(depthUsd(BEAN_A, 10n ** 18n, 1900, 18)).toBeNull();
  });

  it('returns null rather than NaN when wethUsd is unusable', () => {
    expect(depthUsd(WETH_A, 10n ** 18n, 0, 18)).toBeNull();
    expect(depthUsd(WETH_A, 10n ** 18n, Number.NaN, 18)).toBeNull();
  });
});

describe('the split floor constants', () => {
  it('keeps the L sanity check at 1n and the USD floor separate', () => {
    expect(MIN_POOL_LIQUIDITY_L).toBe(1n);
    expect(MIN_REFERENCE_DEPTH_USD).toBe(100);
  });
});

// ── the bridged depth gate ──────────────────────────────────────────────────

describe('getEstimatedMidOutcome — bridged depth floor', () => {
  // WETH/USDC anchor is deep; the WARP/WETH side's depth is the variable under test.
  // readDecimals returns 18 throughout, so a WETH depth of 1e18 wei reads as 1 WETH.
  function readersWithSideDepth(sideDepth: bigint): EstimatedMidReaders {
    return makeReaders({
      getDeepestPoolWithDepth: async (a, b) => {
        const key = [a.toLowerCase(), b.toLowerCase()].sort().join('|');
        if (key === [WETH, USDC].sort().join('|')) return { address: '0xwethusdc', depth: 10n ** 24n, kind: 'univ3' };
        if (key === [WARP, WETH].sort().join('|')) return { address: '0x6945a4bf', depth: sideDepth, kind: 'univ3' };
        return null;
      },
    });
  }

  it('rejects the bridged class when the ranked winner is dust, and says why', async () => {
    // 0.001 WETH at wethUsd 1 => $0.001, far under the $100 floor.
    const out = await getEstimatedMidOutcome(readersWithSideDepth(10n ** 15n), WARP, NATIVE, 100n, 1n, 100);
    expect(out.mid).toBeNull();
    expect(out.rejected).toBe(true);
    expect(out.poolAddress).toBe('0x6945a4bf');
    expect(out.depthUsd!).toBeLessThan(100);
  });

  it('admits a winner that clears the floor, and reports depth on the PASSING path too', async () => {
    // 1e6 WETH at wethUsd 1 => $1,000,000.
    const out = await getEstimatedMidOutcome(readersWithSideDepth(10n ** 24n), WARP, NATIVE, 100n, 1n, 100);
    expect(out.rejected).toBe(false);
    expect(out.mid).not.toBeNull();
    expect(out.depthUsd!).toBeGreaterThan(100);
    expect(out.poolAddress).toBe('0x6945a4bf');
  });

  it('gates the WETH/USDC anchor itself against its own USDC-denominated depth', async () => {
    const readers = makeReaders({
      getDeepestPoolWithDepth: async (a, b) => {
        const key = [a.toLowerCase(), b.toLowerCase()].sort().join('|');
        // 1 unit of USDC at 18 fake decimals => $1, under the floor.
        if (key === [WETH, USDC].sort().join('|')) return { address: '0xwethusdc', depth: 10n ** 18n, kind: 'univ3' };
        if (key === [WARP, WETH].sort().join('|')) return { address: '0x6945a4bf', depth: 10n ** 24n, kind: 'univ3' };
        return null;
      },
    });
    const out = await getEstimatedMidOutcome(readers, WARP, NATIVE, 100n, 1n, 100);
    expect(out.mid).toBeNull();
    expect(out.rejected).toBe(true);
  });

  it('reports the THINNEST side, since that is the binding constraint', async () => {
    const readers = makeReaders({
      getDeepestPoolWithDepth: async (a, b) => {
        const key = [a.toLowerCase(), b.toLowerCase()].sort().join('|');
        if (key === [WETH, USDC].sort().join('|')) return { address: '0xwethusdc', depth: 10n ** 24n, kind: 'univ3' };
        if (key === [WARP, WETH].sort().join('|')) return { address: '0xthin', depth: 200n * 10n ** 18n, kind: 'univ3' };
        if (key === [USDC, WARP].sort().join('|')) return { address: '0xfat', depth: 10n ** 24n, kind: 'univ3' };
        return null;
      },
    });
    // WARP -> USDC: only the WARP side needs a pool, so it is trivially thinnest.
    const out = await getEstimatedMidOutcome(readers, WARP, USDC, 100n, 1n, 100);
    expect(out.poolAddress).toBe('0xthin');
    expect(out.depthUsd).toBeCloseTo(200, 6);
    expect(out.rejected).toBe(false);
  });

  it('getEstimatedMidAtBlock keeps its old signature and stays a thin wrapper', async () => {
    const res = await getEstimatedMidAtBlock(readersWithSideDepth(10n ** 24n), WARP, NATIVE, 100n, 1n);
    expect(res).not.toBeNull();
    expect(res!.poolKind).toBe('estimated');
  });
});
