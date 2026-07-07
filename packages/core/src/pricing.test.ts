/**
 * pricing.test.ts — Unit tests for priceReceipt (generic USD anchor + reference mid).
 *
 * All tests inject stub readers (the `PricingDeps` DI seam) so NO live RPC is
 * required. This mirrors the `createDefaultMidReader` pattern in decomposeRoute.ts:
 * the RPC-backed defaults are swapped for pure fakes.
 */
import { describe, expect, it } from 'vitest';
import { priceReceipt, type PricingDeps } from './pricing.js';
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
});
