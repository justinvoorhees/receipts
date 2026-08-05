/**
 * pricing.test.ts — Unit tests for priceReceipt (generic USD anchor + reference mid).
 *
 * All tests inject stub readers (the `PricingDeps` DI seam) so NO live RPC is
 * required. This mirrors the `createDefaultMidReader` pattern in decomposeRoute.ts:
 * the RPC-backed defaults are swapped for pure fakes.
 */
import { describe, expect, it } from 'vitest';
import {
  priceReceipt,
  defaultGetPairMid,
  bridgedIsIndependent,
  impliedOracleRatio,
  type PricingDeps,
  type PoolMidReaders,
} from './pricing.js';
import type { BenchmarkResult } from './benchmarkPrice.js';
import type { MarketPriceResult } from './marketPrice.js';

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
    getEstimatedMid: async () => null,
    getMarketPrice: async () => ({ tier: 'none', marketMid: null, corroboratedBy: [], flags: ['NO_ESTIMATOR'] }),
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
    expect(r.tier).toBe('full');
    expect(r.methodology).toBe('Verified: The median of three WETH/USDC pool prices agrees with the oracle reference.');
  });

  // Source-purity invariant: on the fast path, marketMid comes from the
  // oracle-validated benchmark (median of BENCHMARK_POOLS) — so the
  // before/after wings MUST come from that same benchmark apparatus, sampled
  // at the adjacent blocks, or the "deviation between blocks" figure silently
  // compares two different price sources. The three stubbed benchmark blocks
  // return clearly distinguishable values (1000 / 2000 / 3000) so any crossed
  // wiring fails loudly, not by a few bps.
  it('fast path: before/after wings come from the benchmark, sampled at adjacent blocks', async () => {
    const r = await priceReceipt(
      { ...baseArgs, inputToken: WETH, outputToken: USDC },
      makeDeps({
        benchmark: async ({ blockNumber }) => {
          if (blockNumber === baseArgs.blockNumber - 1n) return fakeBenchmark({ marketMid: 1000 }); // refBlock -> N-2
          if (blockNumber === baseArgs.blockNumber) return fakeBenchmark({ marketMid: 2000 }); // ruler, N-1
          if (blockNumber === baseArgs.blockNumber + 1n) return fakeBenchmark({ marketMid: 3000 }); // refBlock+2 -> N
          throw new Error(`unexpected benchmark blockNumber ${blockNumber}`);
        },
        getUsdValue: async () => 1000,
      }),
    );
    expect(r.marketMid).toBeCloseTo(2000, 6);
    expect(r.marketMidBefore).toBeCloseTo(1000, 6);
    expect(r.marketMidAfter).toBeCloseTo(3000, 6);
  });

  it('USDC/WETH fast-path downgrades to estimated when the oracle disagrees', async () => {
    const r = await priceReceipt(
      { ...baseArgs, inputToken: WETH, outputToken: USDC },
      makeDeps({
        benchmark: async () => fakeBenchmark({ marketMid: 1800, flags: ['ORACLE_DISAGREE'] }),
        getUsdValue: async () => 1800,
        readDecimals: async (t) => (t.toLowerCase() === USDC ? 6 : 18),
        readSymbol: async (t) => (t.toLowerCase() === USDC ? 'USDC' : 'WETH'),
      }),
    );
    expect(r.status).toBe('estimated');
    expect(r.tier).toBe('estimated');
    expect(r.marketMid).toBeCloseTo(1800, 6); // mid unchanged — still the pool median
    expect(r.methodology).toBe('Estimated: The median of three WETH/USDC pool prices disagree with the oracle reference. Showing the median of the three liquidity-based prices.');
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

  // (d) generic full: one side is a stablecoin, the apparatus corroborates a full-tier mid
  it('returns full for an exotic/USDC pair when the apparatus reports a corroborated (full) mid (USD-anchored)', async () => {
    const r = await priceReceipt(
      { ...baseArgs, inputToken: EXOTIC_A, outputToken: USDC },
      makeDeps({
        getMarketPrice: async () => ({ tier: 'full', marketMid: 0.5, corroboratedBy: ['direct', 'bridged'], flags: [] }),
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

  // apparatus reports a corroborated (full) mid but NEITHER side anchors to USD -> downgraded to estimated
  it('downgrades a full-tier apparatus mid to estimated when neither side anchors to USD', async () => {
    const r = await priceReceipt(
      { ...baseArgs, inputToken: EXOTIC_A, outputToken: EXOTIC_B },
      makeDeps({
        getMarketPrice: async () => ({ tier: 'full', marketMid: 3.3, corroboratedBy: ['direct', 'bridged'], flags: [] }),
      }),
    );
    expect(r.status).toBe('estimated');
    expect(r.marketMid).toBe(3.3);
    expect(r.tier).toBe('full'); // the apparatus's own tier is passed through verbatim
  });

  // Option D (2026-08-05 addendum, design spec §11.2): the general path's
  // wings must be produced by the SAME composition function as the centre
  // (getMarketPrice), not a direct-pool reader — that's what guarantees the
  // centre and wings share provenance (a bridged mid's wings are bridged mids
  // too). Each block returns a clearly distinguishable value (100/200/300) so
  // any crossed wiring (e.g. a stray single-pool reader) fails loudly, not by
  // a few bps.
  it('general path: wings come from the same getMarketPrice composition as the centre', async () => {
    const r = await priceReceipt(
      { ...baseArgs, inputToken: EXOTIC_A, outputToken: EXOTIC_B },
      makeDeps({
        getMarketPrice: async (_i, _o, blockNumber) => {
          const refBlock = baseArgs.blockNumber - 1n; // 99n
          if (blockNumber === refBlock - 1n) return { tier: 'full', marketMid: 100, corroboratedBy: ['direct'], flags: [] }; // N-2
          if (blockNumber === refBlock) return { tier: 'full', marketMid: 200, corroboratedBy: ['direct'], flags: [] }; // N-1, the ruler
          if (blockNumber === refBlock + 1n) return { tier: 'full', marketMid: 300, corroboratedBy: ['direct'], flags: [] }; // N
          throw new Error(`unexpected getMarketPrice blockNumber ${blockNumber}`);
        },
      }),
    );
    expect(r.marketMid).toBeCloseTo(200, 10);
    expect(r.marketMidBefore).toBeCloseTo(100, 10);
    expect(r.marketMidAfter).toBeCloseTo(300, 10);
  });

  // Block arithmetic: `getMarketPriceForPair` passes its blockNumber straight
  // to the estimators with NO internal offset (unlike `benchmark`, which
  // samples at blockNumber-1 internally) — so the general path must call
  // getMarketPrice at exactly refBlock-1n / refBlock / refBlock+1n, reusing
  // the centre call rather than issuing a fourth. An off-by-one here shifts
  // every rendered row by one block and would look entirely plausible.
  it('general path: calls getMarketPrice at exactly refBlock-1n, refBlock, refBlock+1n (3 calls, not 4)', async () => {
    const seenBlocks: bigint[] = [];
    await priceReceipt(
      { ...baseArgs, inputToken: EXOTIC_A, outputToken: EXOTIC_B },
      makeDeps({
        getMarketPrice: async (_i, _o, blockNumber) => {
          seenBlocks.push(blockNumber);
          return { tier: 'full', marketMid: 1, corroboratedBy: ['direct'], flags: [] };
        },
      }),
    );
    const refBlock = baseArgs.blockNumber - 1n; // 99n
    expect(seenBlocks).toHaveLength(3);
    const sorted = [...seenBlocks].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(sorted).toEqual([refBlock - 1n, refBlock, refBlock + 1n]);
  });

  // Prior-reviewer follow-up: a null centre must null BOTH wings, even when
  // the wing blocks would themselves resolve to a real mid — partial() hard-
  // codes marketMidBefore/After to null on every partial-tier return, and
  // that must hold regardless of what the wing calls returned.
  it('nulls both wings when the centre has no mid, even if the wing blocks would resolve', async () => {
    const refBlock = baseArgs.blockNumber - 1n; // 99n
    const r = await priceReceipt(
      { ...baseArgs, inputToken: EXOTIC_A, outputToken: EXOTIC_B },
      makeDeps({
        getMarketPrice: async (_i, _o, blockNumber) => {
          if (blockNumber === refBlock) return { tier: 'none', marketMid: null, corroboratedBy: [], flags: ['NO_LIQUIDITY'] };
          // Wings WOULD resolve if the centre didn't gate them.
          return { tier: 'full', marketMid: 42, corroboratedBy: ['direct'], flags: [] };
        },
      }),
    );
    expect(r.status).toBe('partial');
    expect(r.marketMid).toBeNull();
    expect(r.marketMidBefore).toBeNull();
    expect(r.marketMidAfter).toBeNull();
  });

  it('leaves the adjacent mids null on the partial path', async () => {
    const r = await priceReceipt(
      { ...baseArgs, inputToken: EXOTIC_A, outputToken: EXOTIC_B, inputAmountRaw: 0n, outputAmountRaw: 0n },
      makeDeps(), // getMarketPrice -> none
    );
    expect(r.status).toBe('partial');
    expect(r.marketMid).toBeNull();
    expect(r.marketMidBefore).toBeNull();
    expect(r.marketMidAfter).toBeNull();
  });

  // (c) never throws — an injected reader that throws still degrades to partial
  it('never throws: a throwing getMarketPrice degrades to partial', async () => {
    const r = await priceReceipt(
      { ...baseArgs, inputToken: EXOTIC_A, outputToken: USDC },
      makeDeps({
        getMarketPrice: async () => {
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

  it('returns estimated when no full mid exists but a bridged mid is available', async () => {
    const r = await priceReceipt(
      { ...baseArgs, inputToken: EXOTIC_A, outputToken: EXOTIC_B },
      makeDeps({
        getMarketPrice: async () => ({ tier: 'estimated', marketMid: 0.0005, corroboratedBy: ['bridged'], flags: ['SINGLE_CLASS'] }),
        getUsdValue: async () => 135, // best-effort notional from the anchored side
      }),
    );
    expect(r.status).toBe('estimated');
    expect(r.marketMid).toBeCloseTo(0.0005, 9);
    expect(r.notionalUsd).toBe(135);
    // oracle-validation fields stay null on the estimated tier
    expect(r.chainlinkPrice).toBeNull();
  });

  it('stays partial when the apparatus finds no usable mid', async () => {
    const r = await priceReceipt(
      { ...baseArgs, inputToken: EXOTIC_A, outputToken: EXOTIC_B },
      makeDeps({ getMarketPrice: async () => ({ tier: 'none', marketMid: null, corroboratedBy: [], flags: ['NO_ESTIMATOR'] }) }),
    );
    expect(r.status).toBe('partial');
    expect(r.marketMid).toBeNull();
  });

  it('prefers full over estimated when the apparatus reports a corroborated anchored mid', async () => {
    const r = await priceReceipt(
      { ...baseArgs, inputToken: EXOTIC_A, outputToken: USDC },
      makeDeps({
        getMarketPrice: async () => ({ tier: 'full', marketMid: 0.5, corroboratedBy: ['direct', 'bridged'], flags: [] }),
        getUsdValue: async () => 500,
      }),
    );
    expect(r.status).toBe('full');
    expect(r.marketMid).toBeCloseTo(0.5, 9);
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
      readLiquidity: async () => 1_000_000n, // healthy pool
      readV2Reserves: async () => null,
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
      readLiquidity: async () => 1_000_000n,
      readV2Reserves: async () => null,
      readDecimals: async () => 18,
    };
    const mid = await defaultGetPairMid(readers, EXOTIC_A, EXOTIC_B, 100n);
    expect(mid).toBeNull();
  });

  it('returns null when slot0 is unreadable/uninitialized', async () => {
    const readers: PoolMidReaders = {
      getDeepestPool: async () => ({ address: '0xpool', kind: 'univ3' }),
      readSlot0: async () => null,
      readLiquidity: async () => 1_000_000n,
      readV2Reserves: async () => null,
      readDecimals: async () => 18,
    };
    const mid = await defaultGetPairMid(readers, EXOTIC_A, EXOTIC_B, 100n);
    expect(mid).toBeNull();
  });

  it('returns null for an empty pool (liquidity below floor) — its slot0 price is a garbage mid', async () => {
    // The CLAWNCH bug: a 0-liquidity direct pool was accepted as a `full` mid.
    const readers: PoolMidReaders = {
      getDeepestPool: async () => ({ address: '0xpool', kind: 'univ3' }),
      readSlot0: async () => SQRT_PRICE_X96_FOR_4X,
      readLiquidity: async () => 0n,
      readV2Reserves: async () => null,
      readDecimals: async () => 18,
    };
    const mid = await defaultGetPairMid(readers, EXOTIC_A, EXOTIC_B, 100n);
    expect(mid).toBeNull();
  });

  it('returns null when slot0 is pinned at the max-tick boundary (empty/one-sided pool)', async () => {
    // Real CLAWNCH pool 0x8DB5…: sqrtPriceX96 = MAX_SQRT_RATIO-1, liquidity 0.
    const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
    const readers: PoolMidReaders = {
      getDeepestPool: async () => ({ address: '0xpool', kind: 'univ3' }),
      readSlot0: async () => MAX_SQRT_RATIO - 1n,
      readLiquidity: async () => 1_000_000n, // even with "liquidity", a boundary price is unusable
      readV2Reserves: async () => null,
      readDecimals: async () => 18,
    };
    const mid = await defaultGetPairMid(readers, EXOTIC_A, EXOTIC_B, 100n);
    expect(mid).toBeNull();
  });
});

describe('defaultGetPairMid — basic-AMM (v2-reserves) pool', () => {
  // token0 < token1 so no inversion; 18-decimals both sides.
  const token0 = '0x1111111111111111111111111111111111111111';
  const token1 = '0x2222222222222222222222222222222222222222';

  const readers = (kind: string): PoolMidReaders => ({
    getDeepestPool: async () => ({ address: '0xpool', kind }),
    readSlot0: async () => { throw new Error('slot0 should not be called for a basic pool'); },
    readLiquidity: async () => 0n,
    readV2Reserves: async () => [2n * 10n ** 18n, 6000n * 10n ** 18n], // 3000 token1 per token0
    readDecimals: async () => 18,
  });

  it('prices a basic pool from reserves instead of slot0', async () => {
    const res = await defaultGetPairMid(readers('aerodrome_basic'), token0, token1, 100n);
    expect(res).not.toBeNull();
    expect(res!.price).toBeCloseTo(3000, 6);
    expect(res!.poolKind).toBe('aerodrome_basic');
  });

  it('returns null on a one-sided basic pool (zero reserve)', async () => {
    const r: PoolMidReaders = { ...readers('aerodrome_basic'), readV2Reserves: async () => [0n, 5n] };
    expect(await defaultGetPairMid(r, token0, token1, 100n)).toBeNull();
  });
});

// ── priceReceipt tier wiring: routed through the single Market Price apparatus ──
const fullMid = (price: number): MarketPriceResult =>
  ({ tier: 'full', marketMid: price, corroboratedBy: ['direct', 'bridged'], flags: [] });
const estMid = (price: number): MarketPriceResult =>
  ({ tier: 'estimated', marketMid: price, corroboratedBy: ['direct'], flags: ['SINGLE_SOURCE'] });
const noMid = (): MarketPriceResult =>
  ({ tier: 'none', marketMid: null, corroboratedBy: [], flags: ['NO_LIQUIDITY'] });

describe('priceReceipt tier wiring', () => {
  it('full tier -> status full, marketMid set, methodology mentions corroboration', async () => {
    const r = await priceReceipt(
      { ...baseArgs, inputToken: EXOTIC_A, outputToken: USDC },
      makeDeps({
        getMarketPrice: async () => fullMid(1800),
        getUsdValue: async () => 1800,
        readSymbol: async (t) => (t === WETH ? 'WETH' : 'USDC'),
      }),
    );
    expect(r.status).toBe('full');
    expect(r.marketMid).toBe(1800);
    expect(r.tier).toBe('full');
    expect(r.methodology).toBe('Verified: The direct-pool price and WETH-derived price agree.');
  });

  it('estimated tier -> status estimated, marketMid set, methodology flags single-pool', async () => {
    const r = await priceReceipt(
      { ...baseArgs, inputToken: EXOTIC_A, outputToken: EXOTIC_B },
      makeDeps({
        getMarketPrice: async () => estMid(1800),
        getUsdValue: async () => 1800,
      }),
    );
    expect(r.status).toBe('estimated');
    expect(r.marketMid).toBe(1800);
    expect(r.tier).toBe('estimated');
    expect(r.methodology).toBe('Estimated: Only the direct-pool price was available.');
  });

  it('none tier -> status partial, marketMid null', async () => {
    const r = await priceReceipt(
      { ...baseArgs, inputToken: EXOTIC_A, outputToken: EXOTIC_B },
      makeDeps({ getMarketPrice: async () => noMid() }),
    );
    expect(r.status).toBe('partial');
    expect(r.marketMid).toBeNull();
    expect(r.tier).toBe('none');
  });
});

describe('methodology descriptor strings', () => {
  const run = async (mp: MarketPriceResult) => {
    const r = await priceReceipt(
      { ...baseArgs, inputToken: EXOTIC_A, outputToken: EXOTIC_B },
      makeDeps({ getMarketPrice: async () => mp, getUsdValue: async () => 1800 }),
    );
    return r.methodology;
  };
  const mp = (tier: MarketPriceResult['tier'], corroboratedBy: MarketPriceResult['corroboratedBy'], flags: string[]): MarketPriceResult =>
    ({ tier, marketMid: tier === 'none' ? null : 1800, corroboratedBy, flags });

  it('full: direct + bridged + oracle', async () =>
    expect(await run(mp('full', ['direct', 'bridged', 'oracle'], []))).toBe(
      'Verified: The direct-pool price, WETH-derived price, and oracle reference agree.'));
  it('full: direct + oracle', async () =>
    expect(await run(mp('full', ['direct', 'oracle'], []))).toBe(
      'Verified: The direct-pool price and oracle reference agree.'));
  it('full: bridged + oracle', async () =>
    expect(await run(mp('full', ['bridged', 'oracle'], []))).toBe(
      'Verified: The WETH-derived price and oracle reference agree.'));
  it('full: direct + bridged', async () =>
    expect(await run(mp('full', ['direct', 'bridged'], []))).toBe(
      'Verified: The direct-pool price and WETH-derived price agree.'));
  it('estimated: single source direct', async () =>
    expect(await run(mp('estimated', ['direct'], ['SINGLE_SOURCE']))).toBe(
      'Estimated: Only the direct-pool price was available.'));
  it('estimated: single source bridged', async () =>
    expect(await run(mp('estimated', ['bridged'], ['SINGLE_SOURCE']))).toBe(
      'Estimated: Only the WETH-derived price was available.'));
  it('estimated: liquidity disagree', async () =>
    expect(await run(mp('estimated', [], ['LIQUIDITY_DISAGREE']))).toBe(
      'Estimated: The direct-pool price and WETH-derived price disagree. Showing their median.'));
  it('estimated: oracle disagree, single direct', async () =>
    expect(await run(mp('estimated', ['direct'], ['ORACLE_DISAGREE', 'SINGLE_SOURCE']))).toBe(
      'Estimated: The direct-pool price and oracle reference disagree. Showing the direct-pool price.'));
  it('estimated: oracle disagree, single bridged', async () =>
    expect(await run(mp('estimated', ['bridged'], ['ORACLE_DISAGREE', 'SINGLE_SOURCE']))).toBe(
      'Estimated: The WETH-derived price and oracle reference disagree. Showing the WETH-derived price.'));
  it('estimated: liquidity + oracle disagree', async () =>
    expect(await run(mp('estimated', [], ['LIQUIDITY_DISAGREE', 'ORACLE_DISAGREE']))).toBe(
      'Estimated: The direct-pool price and WETH-derived price disagree, and the oracle reference does not confirm their median. Showing the median of the two liquidity-based prices.'));
  it('none', async () =>
    expect(await run(mp('none', [], ['NO_LIQUIDITY']))).toBe(
      'Unavailable: No reliable market price could be calculated.'));
});

const NATIVE = 'native';
const WBTC = '0x0555e30da8f98308edb960aa94c0db47230d2b9c';

describe('bridgedIsIndependent', () => {
  it('false when either side is literal WETH (bridge duplicates the direct pool)', () => {
    expect(bridgedIsIndependent(WETH, WBTC)).toBe(false);
    expect(bridgedIsIndependent(WBTC, WETH)).toBe(false);
  });
  it('true for native ETH (no direct native pool → the bridge is the only liquidity source)', () => {
    expect(bridgedIsIndependent(NATIVE, WBTC)).toBe(true);
    expect(bridgedIsIndependent(NATIVE, USDC)).toBe(true);
  });
  it('true for a non-WETH pair (bridge is a genuinely independent path)', () => {
    expect(bridgedIsIndependent(USDC, WBTC)).toBe(true);
  });
});

describe('impliedOracleRatio', () => {
  it('returns usdIn/usdOut when both resolve', () => {
    expect(impliedOracleRatio(2000, 50000)).toBeCloseTo(0.04, 9);
  });
  it('returns null when a side is missing or usdOut is non-positive', () => {
    expect(impliedOracleRatio(null, 50000)).toBeNull();
    expect(impliedOracleRatio(2000, null)).toBeNull();
    expect(impliedOracleRatio(2000, 0)).toBeNull();
  });
});
