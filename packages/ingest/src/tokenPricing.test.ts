/**
 * tokenPricing.test.ts — Unit tests for generalized pair-mid pricing.
 *
 * Tests the pure-math functions: sqrtPriceX96ToPrice, v2MidFromReserves,
 * and decimals-cache behavior. RPC-dependent integration (getPairMidAtBlock,
 * getTokenUsdcValue) is validated via a separate tsx snippet, not here.
 */
import { describe, expect, it } from 'vitest';
import { sqrtPriceX96ToPrice, v2MidFromReserves, makeDecimalsCache } from './tokenPricing.js';

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
