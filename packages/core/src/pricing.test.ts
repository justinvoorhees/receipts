/**
 * pricing.test.ts — Unit tests for priceReceipt (generic USD anchor + reference mid).
 *
 * All tests inject stub readers (the `PricingDeps` DI seam) so NO live RPC is
 * required. This mirrors the `createDefaultMidReader` pattern in decomposeRoute.ts:
 * the RPC-backed defaults are swapped for pure fakes.
 */
import { describe, expect, it } from 'vitest';
import { priceReceipt, defaultGetPairMid, type PricingDeps, type PoolMidReaders } from './pricing.js';
import type { BenchmarkResult } from './benchmarkPrice.js';

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';
const EXOTIC_A = '0x1111111111111111111111111111111111111111';
const EXOTIC_B = '0x2222222222222222222222222222222222222222';

/** Build a full stub dep set; override only what a test needs. */
function makeDeps(over: Partial<PricingDeps> = {}): PricingDeps {
  return {
    benchmark: async () => {
      throw new Error('benchmark not stubbed');
    },
    getPairMid: async () => null,
    getUsdValue: async () => null,
    readDecimals: async () => 18,
    readSymbol: async () => 'TKN',
    ...over,
  };
}

function fakeBenchmark(over: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    marketMid: 1800,
    perPool: [],
    poolDivergenceBps: 3,
    chainlinkPrice: 1805,
    chainlinkDevBps: 27,
    offchainPrice: null,
    offchainDevBps: null,
    manipulationSuspect: false,
    flags: [],
    lowConfidence: false,
    chainlinkStalenessSecs: 12,
    ...over,
  };
}

const baseArgs = {
  rpcUrl: 'http://stub',
  blockNumber: 100n,
  chainId: 8453,
  inputAmountRaw: 1_000_000_000_000_000_000n,
  outputAmountRaw: 1_800_000_000n,
};

describe('priceReceipt', () => {
  // (a) partial / no-pool path
  it('degrades to partial when no reference pool / USD anchor exists', async () => {
    const r = await priceReceipt(
      { ...baseArgs, inputToken: EXOTIC_A, outputToken: EXOTIC_B, inputAmountRaw: 1000n, outputAmountRaw: 5n },
      makeDeps(), // getPairMid -> null, getUsdValue -> null
    );
    expect(r.status).toBe('partial');
    expect(r.marketMid).toBeNull();
    expect(r.notionalUsd).toBeNull();
    expect(r.chainlinkPrice).toBeNull();
    expect(r.manipulationFlag).toBe(false);
  });

  // (b) USDC/WETH full fast-path via injected fake benchmark
  it('returns full for USDC/WETH by delegating to the benchmark (WETH in, USDC out)', async () => {
    const r = await priceReceipt(
      { ...baseArgs, inputToken: WETH, outputToken: USDC },
      makeDeps({
        benchmark: async () => fakeBenchmark({ marketMid: 1800, chainlinkPrice: 1805, poolDivergenceBps: 3, manipulationSuspect: false }),
        getUsdValue: async () => 1800, // 1 WETH notional
        readDecimals: async (t) => (t.toLowerCase() === USDC ? 6 : 18),
        readSymbol: async (t) => (t.toLowerCase() === USDC ? 'USDC' : 'WETH'),
      }),
    );
    expect(r.status).toBe('full');
    expect(r.marketMid).toBeCloseTo(1800, 6); // output(USDC) per input(WETH)
    expect(r.notionalUsd).toBeCloseTo(1800, 6);
    expect(r.chainlinkPrice).toBe(1805);
    expect(r.poolDivergenceBps).toBe(3);
    expect(r.manipulationFlag).toBe(false);
    expect(r.inputSymbol).toBe('WETH');
    expect(r.outputSymbol).toBe('USDC');
    // oracle sub-fields forward from the benchmark result on the fast-path
    expect(r.chainlinkDevBps).toBe(27);
    expect(r.offchainPrice).toBeNull();
    expect(r.offchainDevBps).toBeNull();
    expect(r.chainlinkStalenessSecs).toBe(12);
  });

  it('inverts the benchmark mid for USDC in, WETH out', async () => {
    const r = await priceReceipt(
      { ...baseArgs, inputToken: USDC, outputToken: WETH },
      makeDeps({
        benchmark: async () => fakeBenchmark({ marketMid: 1800 }),
        getUsdValue: async () => 1000,
      }),
    );
    expect(r.status).toBe('full');
    expect(r.marketMid).toBeCloseTo(1 / 1800, 10); // WETH per USDC
  });

  // (d) generic full: one side is a stablecoin, a pool mid is available
  it('returns full for an exotic/USDC pair when a pool mid exists (USD-anchored)', async () => {
    const r = await priceReceipt(
      { ...baseArgs, inputToken: EXOTIC_A, outputToken: USDC },
      makeDeps({
        getPairMid: async () => ({ price: 0.5, poolAddress: '0xpool', poolKind: 'univ3' }),
        getUsdValue: async () => 500,
        readDecimals: async (t) => (t.toLowerCase() === USDC ? 6 : 18),
        readSymbol: async (t) => (t.toLowerCase() === USDC ? 'USDC' : 'AAA'),
      }),
    );
    expect(r.status).toBe('full');
    expect(r.marketMid).toBeCloseTo(0.5, 9); // output(USDC) per input(EXOTIC)
    expect(r.notionalUsd).toBe(500);
    // oracle-validation fields are null for non-WETH/USDC pairs
    expect(r.chainlinkPrice).toBeNull();
    expect(r.poolDivergenceBps).toBeNull();
    expect(r.chainlinkDevBps).toBeNull();
    expect(r.offchainPrice).toBeNull();
    expect(r.offchainDevBps).toBeNull();
    expect(r.chainlinkStalenessSecs).toBeNull();
  });

  // pool found but NO USD anchor on either side -> partial
  it('returns partial when a pool mid exists but neither side anchors to USD', async () => {
    const r = await priceReceipt(
      { ...baseArgs, inputToken: EXOTIC_A, outputToken: EXOTIC_B },
      makeDeps({
        getPairMid: async () => ({ price: 3.3, poolAddress: '0xpool', poolKind: 'univ3' }),
      }),
    );
    expect(r.status).toBe('partial');
    expect(r.marketMid).toBeNull();
  });

  // (c) never throws — an injected reader that throws still degrades to partial
  it('never throws: a throwing getPairMid degrades to partial', async () => {
    const r = await priceReceipt(
      { ...baseArgs, inputToken: EXOTIC_A, outputToken: USDC },
      makeDeps({
        getPairMid: async () => {
          throw new Error('transient RPC failure');
        },
      }),
    );
    expect(r.status).toBe('partial');
    expect(r.marketMid).toBeNull();
  });

  it('never throws: a throwing benchmark on the USDC/WETH path degrades to partial', async () => {
    const r = await priceReceipt(
      { ...baseArgs, inputToken: WETH, outputToken: USDC },
      makeDeps({
        benchmark: async () => {
          throw new Error('archive RPC down');
        },
      }),
    );
    expect(r.status).toBe('partial');
    expect(r.marketMid).toBeNull();
  });

  it('never throws: even when decimals/symbol readers throw', async () => {
    const r = await priceReceipt(
      { ...baseArgs, inputToken: EXOTIC_A, outputToken: EXOTIC_B },
      makeDeps({
        readDecimals: async () => {
          throw new Error('no decimals');
        },
        readSymbol: async () => {
          throw new Error('no symbol');
        },
      }),
    );
    expect(r.status).toBe('partial');
    expect(r.marketMid).toBeNull();
    // symbols/decimals best-effort — fall back to safe defaults, no throw
    expect(typeof r.inputSymbol).toBe('string');
    expect(typeof r.inputDecimals).toBe('number');
  });

  // (e) notional is derived from the USD-anchored OUTPUT side when the INPUT
  // token is a volatile/illiquid non-anchor. Regression for the WARP→ETH bug:
  // the input-side WARP/USDC reference pool was dead (0 liquidity) but had a
  // stale mid, over-valuing 202M WARP at ~$939 instead of the true ~$135 that
  // the realized ~0.0778 ETH output is worth. Notional must follow the anchored
  // output leg, not the mispriced input leg.
  it('prefers the USD-anchored OUTPUT side for notional when the input token is illiquid/mispriced', async () => {
    const WARP = '0xd9159ad2d5fe625cd1f54f4d328fb19cb5262b07';
    const r = await priceReceipt(
      {
        ...baseArgs,
        inputToken: WARP,
        outputToken: 'native',
        inputAmountRaw: 202_116_011_451_859_899_429_447_474n, // 202.1M WARP (18 dec)
        outputAmountRaw: 77_799_818_791_214_842n, // 0.0778 ETH
      },
      makeDeps({
        // Input side (WARP via a dead reference pool) grossly over-values; the
        // output side (native ETH via the deep WETH/USDC reference) is correct.
        getUsdValue: async (token) => (token.toLowerCase() === 'native' ? 135 : 939.66),
        readDecimals: async () => 18,
        readSymbol: async (t) => (t.toLowerCase() === 'native' ? 'ETH' : 'WARP'),
      }),
    );
    // Not the inflated $939.66 input-side figure.
    expect(r.notionalUsd).toBeCloseTo(135, 2);
  });

  it('keeps input-first notional when both sides anchor to USD (e.g. WETH→USDC)', async () => {
    const seen: string[] = [];
    const r = await priceReceipt(
      { ...baseArgs, inputToken: WETH, outputToken: USDC },
      makeDeps({
        benchmark: async () => fakeBenchmark({ marketMid: 1800 }),
        getUsdValue: async (token) => {
          seen.push(token.toLowerCase());
          return token.toLowerCase() === USDC ? 1800 : 1801;
        },
        readDecimals: async (t) => (t.toLowerCase() === USDC ? 6 : 18),
      }),
    );
    // Input (WETH) valued first → 1801, and no fall-through to the output side.
    expect(r.notionalUsd).toBe(1801);
    expect(seen[0]).toBe(WETH);
  });

  it('resolves native ETH to the "ETH" symbol (no contract to read symbol() from)', async () => {
    const r = await priceReceipt(
      { ...baseArgs, inputToken: EXOTIC_A, outputToken: 'native' },
      makeDeps({
        // native is not a contract: a real symbol() read throws → must fall back to "ETH".
        readSymbol: async (t) => {
          if (t.toLowerCase() === 'native') throw new Error('native has no contract');
          return 'TKN';
        },
      }),
    );
    expect(r.outputSymbol).toBe('ETH');
  });
});

// ── defaultGetPairMid: direct test of the orientation + inversion math ──────
//
// Every `priceReceipt` test above stubs `getPairMid` with a pre-computed
// value, so it never exercises the token-address sort → deepest-pool lookup
// → sqrtPriceX96ToPrice → `inverted ? 1/rawPrice : rawPrice` glue inside
// `defaultGetPairMid` itself. That inversion is the highest-risk line in this
// module (a silent flip would corrupt Price Impact / Slippage for every
// non-WETH/USDC pair), so it gets its own hand-computed assertions here,
// injecting a fake `PoolMidReaders` (no live RPC).
describe('defaultGetPairMid (orientation + inversion, hand-computed)', () => {
  // sqrtPriceX96 encodes price = (sqrtPriceX96 / 2^96)^2 as token1-per-token0.
  // Choosing sqrtPriceX96 = 2^97 = sqrt(4) * 2^96 gives an exact raw price of
  // 4 (token1 per token0) when dec0 === dec1, so the expected mid is exact,
  // not merely close.
  const SQRT_PRICE_X96_FOR_4X = 2n ** 97n;

  /** Fake reader set: always finds the same pool/price/decimals; records the
   * (token0, token1) order it was asked to discover a pool for. */
  function makeReaders(captured: { token0?: string; token1?: string }): PoolMidReaders {
    return {
      getDeepestPool: async (token0, token1) => {
        captured.token0 = token0;
        captured.token1 = token1;
        return { address: '0xpool', kind: 'univ3' };
      },
      readSlot0: async () => SQRT_PRICE_X96_FOR_4X,
      readDecimals: async () => 18, // dec0 === dec1 → rawPrice is exactly 4
    };
  }

  it('tokenIn < tokenOut (address order): mid is the exact raw token1-per-token0 price (4)', async () => {
    const captured: { token0?: string; token1?: string } = {};
    const mid = await defaultGetPairMid(makeReaders(captured), EXOTIC_A, EXOTIC_B, 100n);
    expect(mid).not.toBeNull();
    expect(mid!.price).toBe(4);
    // Pool discovery always gets the address-sorted (lower, higher) order,
    // regardless of which side the caller passed as tokenIn.
    expect(captured.token0).toBe(EXOTIC_A);
    expect(captured.token1).toBe(EXOTIC_B);
  });

  it('tokenIn > tokenOut (inverted): mid is the exact RECIPROCAL of the non-inverted case (0.25), same pool', async () => {
    const captured: { token0?: string; token1?: string } = {};
    const mid = await defaultGetPairMid(makeReaders(captured), EXOTIC_B, EXOTIC_A, 100n);
    expect(mid).not.toBeNull();
    expect(mid!.price).toBe(0.25);
    expect(mid!.price).toBe(1 / 4);
    // Same underlying pool (address-sorted order is unaffected by direction).
    expect(captured.token0).toBe(EXOTIC_A);
    expect(captured.token1).toBe(EXOTIC_B);
  });

  it('returns null when no deepest pool is found for the pair', async () => {
    const readers: PoolMidReaders = {
      getDeepestPool: async () => null,
      readSlot0: async () => SQRT_PRICE_X96_FOR_4X,
      readDecimals: async () => 18,
    };
    const mid = await defaultGetPairMid(readers, EXOTIC_A, EXOTIC_B, 100n);
    expect(mid).toBeNull();
  });

  it('returns null when slot0 is unreadable/uninitialized', async () => {
    const readers: PoolMidReaders = {
      getDeepestPool: async () => ({ address: '0xpool', kind: 'univ3' }),
      readSlot0: async () => null,
      readDecimals: async () => 18,
    };
    const mid = await defaultGetPairMid(readers, EXOTIC_A, EXOTIC_B, 100n);
    expect(mid).toBeNull();
  });
});
