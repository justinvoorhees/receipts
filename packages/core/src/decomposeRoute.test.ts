/**
 * decomposeRoute.test.ts — Tests for route-aware decomposition orchestrator.
 *
 * Uses recorded trace fixtures (kyber batch-01, batch-02) with injected
 * feeReader and trace dependencies to run without live RPC.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decomposeRoute, extractNativeTransfers, detectWrapUnwrapSteps, venuesToUncostedLegs, weightedPriceImpactBps } from './decomposeRoute.js';
import type { DecomposeTradeInput } from './decompose-trade.js';

// Load trace fixtures (avoid JSON import attribute issues with NodeNext)
const __dirname = dirname(fileURLToPath(import.meta.url));
const kyberB1Trace = JSON.parse(readFileSync(resolve(__dirname, '__fixtures__/kyber-b1-trace.json'), 'utf-8'));
const kyberB2Trace = JSON.parse(readFileSync(resolve(__dirname, '__fixtures__/kyber-b2-trace.json'), 'utf-8'));

const PANCAKE_POOL = '0x7cb770d0513c30e0cb45e4899e4a2cbeed6f9830';

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEPOSIT_TOPIC = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c';
const WITHDRAWAL_TOPIC = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
const UNI_V3_SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

// Test constants for extractNativeTransfers
const TRADER = '0x00000000000000000000000000000000000000a1';
const POOL_A = '0x00000000000000000000000000000000000000b1';
const u256 = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');
const pad32 = (addr: string) => '0x' + addr.replace(/^0x/, '').toLowerCase().padStart(64, '0');

/** Build a minimal ERC-20 Transfer log entry for a synthetic trace. */
function transferLog(
  tokenAddr: `0x${string}`,
  from: `0x${string}`,
  to: `0x${string}`,
  value: bigint,
): { address: `0x${string}`; data: `0x${string}`; topics: [`0x${string}`, `0x${string}`, `0x${string}`] } {
  const pad = (addr: string) => ('0x' + addr.slice(2).padStart(64, '0')) as `0x${string}`;
  const hexVal = ('0x' + value.toString(16).padStart(64, '0')) as `0x${string}`;
  return {
    address: tokenAddr,
    data: hexVal,
    topics: [TRANSFER_TOPIC as `0x${string}`, pad(from), pad(to)],
  };
}

function v3SwapLog(pool: `0x${string}`): { address: `0x${string}`; data: `0x${string}`; topics: [`0x${string}`, `0x${string}`, `0x${string}`] } {
  const zeroTopic = ('0x' + '0'.repeat(64)) as `0x${string}`;
  return {
    address: pool,
    data: '0x',
    topics: [UNI_V3_SWAP_TOPIC as `0x${string}`, zeroTopic, zeroTopic],
  };
}

/** Curve StableSwap `TokenExchange` — the on-chain signature every Curve pool emits. */
const CURVE_TOKEN_EXCHANGE_TOPIC = '0x8b3e96f2b889fa771c53c981b40daf005f63f637f1869f707052d15a3dd97140';
/** Maverick v1 `Swap(address,address,bool,bool,uint256,uint256,int32)`. */
const MAVERICK_V1_SWAP_TOPIC = '0x3b841dc9ab51e3104bda4f61b41e4271192d22cd19da5ee6e292dc8e2744f713';
/** UniPool `Swap(address,uint256,uint256,address,bool)`. */
const UNIPOOL_SWAP_TOPIC = '0xdbad2ddd1b3cac36de15036b12f92d5f32b447fc9cd0c1a72467d15bc04dc812';
/** Algebra factory behind the Hydrex deployment on Base. */
const HYDREX_FACTORY = '0x36077d39cdc65e1e3fb65810430e5b2c4d5fa29e';

/** Build a venue swap log carrying only `topic0` — enough for venue-type scanning. */
function venueSwapLog(pool: `0x${string}`, topic0: string): { address: `0x${string}`; data: `0x${string}`; topics: [`0x${string}`] } {
  return { address: pool, data: '0x', topics: [topic0 as `0x${string}`] };
}

/** Minimal single-hop USDC→WETH trade input for venue-tagging tests. */
function taggingInput(trader: string, txHash: string, trace: unknown): DecomposeTradeInput {
  return {
    trace: trace as any,
    txHash: txHash as `0x${string}`,
    trader,
    direction: 'buy_weth',
    settledIn: 'WETH',
    allInCostBps: -1,
    notionalUsdc: 1,
    realizedPrice: 2000,
    gasCostUsd: 0,
    aggregator: 'Velora',
    blockNumber: 47380988n,
    rpcUrl: 'unused',
    dustUsdc: 1e-6,
    structuralFloorUsd: 0,
    structuralFloorBps: 0.5,
    recognizeV3Forks: true,
    impureOnVenueThirdToken: true,
  };
}

const VIRTUAL = '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b';
const V4_POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b';

describe('weightedPriceImpactBps', () => {
  it('equals the raw impact when the leg carries the full notional (linear)', () => {
    // legTotal 30, fee 5 → raw impact 25; weight = 1000/1000 = 1
    expect(weightedPriceImpactBps(30, 5, 1000, 1000)).toBeCloseTo(25, 10);
  });
  it('scales the impact by the leg notional share (split leg carries 40%)', () => {
    // raw impact 25, weight = 400/1000 → 10
    expect(weightedPriceImpactBps(30, 5, 400, 1000)).toBeCloseTo(10, 10);
  });
});

describe('decomposeRoute', () => {
  it('refines v3-shaped route venues by pool factory', async () => {
    const trader = '0x00000000000000000000000000000000000000d0';
    const sushiPool = '0x482fe995c4a52bc79271ab29a53591363ee30a89' as const;
    const trace = {
      logs: [
        transferLog(USDC as `0x${string}`, trader as `0x${string}`, sushiPool, 1_000000n),
        transferLog(WETH as `0x${string}`, sushiPool, trader as `0x${string}`, 500_000000000000n),
        v3SwapLog(sushiPool),
      ],
    };
    const input: DecomposeTradeInput = {
      trace: trace as any,
      txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      trader,
      direction: 'buy_weth',
      settledIn: 'WETH',
      allInCostBps: -1,
      notionalUsdc: 1,
      realizedPrice: 2000,
      gasCostUsd: 0,
      aggregator: 'Fabric',
      blockNumber: 47379575n,
      rpcUrl: 'unused',
      dustUsdc: 1e-6,
      structuralFloorUsd: 0,
      structuralFloorBps: 0.5,
      recognizeV3Forks: true,
      impureOnVenueThirdToken: true,
    };

    const result = await decomposeRoute(input, {
      trace: trace as any,
      v3FactoryReader: async () => '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
      feeReader: async () => ({ bps: 1, defaulted: false }),
    });

    expect(result.legs).toHaveLength(1);
    expect(result.legs[0]!.leg.type).toBe('sushiv3');
  });

  // Curve pools are recognised by the `TokenExchange` event every StableSwap pool
  // emits, so a pool that has never been seen before still tags correctly. The
  // address below is deliberately NOT one of the previously hardcoded pools.
  it('tags never-before-seen Curve pools by their TokenExchange event', async () => {
    const trader = '0x00000000000000000000000000000000000000d0';
    const curvePool = '0xe093c7056f1d5f46f88de7bf366b3569e1839778' as const;
    const trace = {
      logs: [
        venueSwapLog(curvePool, CURVE_TOKEN_EXCHANGE_TOPIC),
        transferLog(USDC as `0x${string}`, trader as `0x${string}`, curvePool, 1_000000n),
        transferLog(WETH as `0x${string}`, curvePool, trader as `0x${string}`, 500_000000000000n),
      ],
    };
    const input = taggingInput(trader, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', trace);

    const result = await decomposeRoute(input, {
      trace: trace as any,
      feeReader: async (_addr, type) => ({ bps: type === 'curve_stableng' ? 10 : 0, defaulted: false }),
    });

    expect(result.legs).toHaveLength(1);
    expect(result.legs[0]!.leg.type).toBe('curve_stableng');
    expect(result.legs[0]!.feeTierBps).toBe(10);
  });

  it('tags Maverick v1 pools by their Swap event', async () => {
    const trader = '0x00000000000000000000000000000000000000d0';
    const pool = '0xdcc8a6ba71a6c0053cbb32f935e9b4b64d465ea3' as const;
    const trace = {
      logs: [
        venueSwapLog(pool, MAVERICK_V1_SWAP_TOPIC),
        transferLog(USDC as `0x${string}`, trader as `0x${string}`, pool, 1_000000n),
        transferLog(WETH as `0x${string}`, pool, trader as `0x${string}`, 500_000000000000n),
      ],
    };
    const input = taggingInput(trader, '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', trace);

    const result = await decomposeRoute(input, {
      trace: trace as any,
      feeReader: async (_addr, type) => ({ bps: type === 'maverickv1' ? 0.2 : 0, defaulted: false }),
    });

    expect(result.legs).toHaveLength(1);
    expect(result.legs[0]!.leg.type).toBe('maverickv1');
    expect(result.legs[0]!.feeTierBps).toBe(0.2);
  });

  it('tags UniPool pools by their Swap event', async () => {
    const trader = '0x00000000000000000000000000000000000000d0';
    const pool = '0xa9ab48b7e1577eef7ff6babc0870bd0f00131f76' as const;
    const trace = {
      logs: [
        venueSwapLog(pool, UNIPOOL_SWAP_TOPIC),
        transferLog(USDC as `0x${string}`, trader as `0x${string}`, pool, 1_000000n),
        transferLog(WETH as `0x${string}`, pool, trader as `0x${string}`, 500_000000000000n),
      ],
    };
    const input = taggingInput(trader, '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', trace);

    const result = await decomposeRoute(input, { trace: trace as any });

    expect(result.legs).toHaveLength(1);
    expect(result.legs[0]!.leg.type).toBe('unipool');
  });

  it('tags Hydrex pools by their Algebra factory', async () => {
    const trader = '0x00000000000000000000000000000000000000d0';
    const pool = '0xb1383dc47d9971fc999c3a9088f79e744b376e97' as const;
    const trace = {
      logs: [
        transferLog(USDC as `0x${string}`, trader as `0x${string}`, pool, 1_000000n),
        transferLog(WETH as `0x${string}`, pool, trader as `0x${string}`, 500_000000000000n),
      ],
    };
    const input = taggingInput(trader, '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', trace);

    const result = await decomposeRoute(input, {
      trace: trace as any,
      v3FactoryReader: (addr) => (addr.toLowerCase() === pool ? HYDREX_FACTORY : null),
      feeReader: async (_addr, type) => ({ bps: type === 'hydrex' ? 0.5 : 0, defaulted: false }),
    });

    expect(result.legs).toHaveLength(1);
    expect(result.legs[0]!.leg.type).toBe('hydrex');
    expect(result.legs[0]!.feeTierBps).toBe(0.5);
  });

  it('tags known Maverick v2 pools instead of treating them as RFQ', async () => {
    const trader = '0x00000000000000000000000000000000000000d0';
    const maverickPool = '0xdf033790907c60c9b81ae355f76f74f52f92114a' as const;
    const trace = {
      logs: [
        transferLog(USDC as `0x${string}`, trader as `0x${string}`, maverickPool, 1_000000n),
        transferLog(WETH as `0x${string}`, maverickPool, trader as `0x${string}`, 500_000000000000n),
      ],
    };
    const input: DecomposeTradeInput = {
      trace: trace as any,
      txHash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      trader,
      direction: 'buy_weth',
      settledIn: 'WETH',
      allInCostBps: -1,
      notionalUsdc: 1,
      realizedPrice: 2000,
      gasCostUsd: 0,
      aggregator: 'Velora',
      blockNumber: 47380991n,
      rpcUrl: 'unused',
      dustUsdc: 1e-6,
      structuralFloorUsd: 0,
      structuralFloorBps: 0.5,
      recognizeV3Forks: true,
      impureOnVenueThirdToken: true,
    };

    const result = await decomposeRoute(input, {
      trace: trace as any,
      feeReader: async (_addr, type) => ({ bps: type === 'maverickv2' ? 1 : 0, defaulted: false }),
    });

    expect(result.legs).toHaveLength(1);
    expect(result.legs[0]!.leg.type).toBe('maverickv2');
    expect(result.legs[0]!.feeTierBps).toBe(1);
  });

  describe('kyber batch-01 (PancakeSwap V3 5bps + V4 4.5bps)', () => {
    const input: DecomposeTradeInput = {
      trace: kyberB1Trace as any,
      txHash: '0x1ca5f7caf6543e0c0cbe7c82a17939c1561bf1bb5bc87b94d5a399c745c29f97',
      trader: '0xf8917d5362652e8a7043c87b1b65e606c2191b62',
      direction: 'buy_weth',
      settledIn: 'WETH',
      allInCostBps: -3.1515262596560336,
      notionalUsdc: 1.973174,
      realizedPrice: 1829.1098816709925,
      gasCostUsd: 0.004111118344703013,
      aggregator: 'KyberSwap',
      blockNumber: 47379624n,
      rpcUrl: 'unused',
      dustUsdc: 1e-6,
      structuralFloorUsd: 0,
      structuralFloorBps: 0.5,
      recognizeV3Forks: true,
      impureOnVenueThirdToken: true,
    };

    it('reconstructs a linear 2-hop route with correct LP, slippage, and confidence', async () => {
      const result = await decomposeRoute(input, {
        trace: kyberB1Trace as any,
        feeReader: async (addr, type, v4FeeRaw) => {
          // PancakeSwap V3 pool: fee() = 500 → 5 bps
          if (addr === PANCAKE_POOL) return { bps: 5, defaulted: false };
          // V4: fee from event / 100
          if (type === 'univ4' && v4FeeRaw !== undefined) return { bps: v4FeeRaw / 100, defaulted: false };
          return { bps: 0, defaulted: false };
        },
      });

      expect(result.routeShape).toBe('linear');
      expect(result.hopCount).toBe(2);
      // LP = 5 + 4.5 = 9.5 bps (each leg processes ~full trade notional)
      expect(result.lpFeeBps).toBeCloseTo(9.5, 1);
      // Slippage = allIn - lp - agg = -3.15 - 9.5 - 0 = -12.65
      expect(result.slippageBps).toBeCloseTo(
        input.allInCostBps - 9.5 - 0, 1,
      );
      expect(result.aggFeeBps).toBeCloseTo(0, 2);
      expect(result.confidence).toBe('high');
      expect(result.gasBps).toBeGreaterThan(0);

      // Per-leg detail — fixture includes a real WETH wrap (Deposit) event,
      // prepended as an informational (null-cost) leg ahead of the pool legs.
      expect(result.legs).toHaveLength(3);
      expect(result.legs[0]!.leg.type).toBe('wrap');
      // First pool leg: PancakeSwap V3 (USDC→VIRTUAL)
      const leg0 = result.legs[1]!;
      expect(leg0.leg.type).toBe('pancakev3');
      expect(leg0.feeTierBps).toBe(5);
      // Second pool leg: V4 (VIRTUAL→WETH)
      const leg1 = result.legs[2]!;
      expect(leg1.leg.type).toBe('univ4');
      expect(leg1.feeTierBps).toBeCloseTo(4.5, 1);
    });

    it('computes per-leg priceImpactBps and tight reconResidualBps with injected midReader', async () => {
      // Stub mid prices derived from each leg's OWN pool at block N-1.
      // Now that Fix (a) corrects V4 settlement doubling, the V4 leg's
      // amountInRaw is the true on-chain value (~3.018 VIRTUAL, not 6.035).
      //
      // Leg 0 (USDC→VIRTUAL via PancakeSwap V3): mid calibrated near realized
      //   so leg total cost ≈ 2 bps → priceImpact ≈ -3 bps (improvement).
      //
      // Leg 1 (VIRTUAL→WETH via V4): mid calibrated so leg total cost ≈ -5.15 bps
      //   (price improvement during execution).
      //
      // Combined: legTotal0 + legTotal1 ≈ allInCostBps, giving |recon| ≈ 0 bps.
      const stubMids: Record<string, number> = {
        // key = `${tokenIn}:${tokenOut}` in leg direction
        [`${USDC}:${VIRTUAL}`]: 1.5295963548,       // VIRTUAL per USDC (calibrated)
        [`${VIRTUAL}:${WETH}`]: 0.00035731120,       // WETH per VIRTUAL (un-doubled, calibrated)
      };

      const result = await decomposeRoute(input, {
        trace: kyberB1Trace as any,
        feeReader: async (addr, type, v4FeeRaw) => {
          if (addr === PANCAKE_POOL) return { bps: 5, defaulted: false };
          if (type === 'univ4' && v4FeeRaw !== undefined) return { bps: v4FeeRaw / 100, defaulted: false };
          return { bps: 0, defaulted: false };
        },
        midReader: async (leg) => {
          const key = `${leg.tokenIn}:${leg.tokenOut}`;
          const price = stubMids[key];
          if (price === undefined) return null;
          return { price, poolAddress: 'stub', poolKind: 'stub' };
        },
      });

      // LP and slippage MUST be unchanged from the non-midReader test
      expect(result.lpFeeBps).toBeCloseTo(9.5, 1);
      expect(result.slippageBps).toBeCloseTo(input.allInCostBps - 9.5 - 0, 1);

      // Each pool leg should now have priceImpactBps (wrap leg stays null-cost)
      expect(result.legs).toHaveLength(3);
      expect(result.legs[0]!.leg.type).toBe('wrap');
      const leg0 = result.legs[1]!;
      const leg1 = result.legs[2]!;
      expect(leg0.priceImpactBps).not.toBeNull();
      expect(leg1.priceImpactBps).not.toBeNull();

      // V4 leg amountInRaw must be the true on-chain value (not doubled)
      expect(leg1.leg.amountInRaw).toBeLessThan(4_000000000000000000n); // ~3.018 VIRTUAL, not ~6.035

      // Per-leg invariant: lpFeeBps + priceImpactBps ≈ leg total cost
      for (const leg of result.legs) {
        if (leg.priceImpactBps === null || leg.lpFeeBps === null) continue;
        const decIn = leg.leg.tokenIn === USDC ? 6 : 18;
        const decOut = leg.leg.tokenOut === USDC ? 6 : 18;
        const realized = (Number(leg.leg.amountOutRaw) / 10 ** decOut) /
                         (Number(leg.leg.amountInRaw) / 10 ** decIn);
        const key = `${leg.leg.tokenIn}:${leg.leg.tokenOut}`;
        const mid = stubMids[key]!;
        const legTotalCost = (mid - realized) / mid * 10_000;
        expect(leg.lpFeeBps + leg.priceImpactBps).toBeCloseTo(legTotalCost, 0);
      }

      // Reconciliation residual should be small (< 5 bps)
      expect(result.reconResidualBps).not.toBeNull();
      expect(Math.abs(result.reconResidualBps!)).toBeLessThan(5);

      // Confidence should be high when residual is tight
      expect(result.confidence).toBe('high');
    });
  });

  describe('kyber batch-02 (RFQ filler + V4 100bps)', () => {
    const input: DecomposeTradeInput = {
      trace: kyberB2Trace as any,
      txHash: '0x710f173aff460c85f573d8ca88877f6101732dc8d4d64e509536fb0c53071fb4',
      trader: '0xf8917d5362652e8a7043c87b1b65e606c2191b62',
      direction: 'buy_weth',
      settledIn: 'WETH',
      allInCostBps: -10.094432648421446,
      notionalUsdc: 1.802734,
      realizedPrice: 1827.8398744730662,
      gasCostUsd: 0.010953769129349722,
      aggregator: 'KyberSwap',
      blockNumber: 47379642n,
      rpcUrl: 'unused',
      dustUsdc: 1e-6,
      structuralFloorUsd: 0,
      structuralFloorBps: 0.5,
      recognizeV3Forks: true,
      impureOnVenueThirdToken: true,
    };

    it('reconstructs an RFQ + V4 route with correct LP, agg fee, slippage', async () => {
      const result = await decomposeRoute(input, {
        trace: kyberB2Trace as any,
        feeReader: async (addr, type, v4FeeRaw) => {
          // RFQ leg: fee = 0
          if (type === 'rfq') return { bps: 0, defaulted: false };
          // V4: fee from event / 100 = 10000/100 = 100
          if (type === 'univ4' && v4FeeRaw !== undefined) return { bps: v4FeeRaw / 100, defaulted: false };
          return { bps: 0, defaulted: false };
        },
      });

      expect(result.routeShape).toBe('linear');
      expect(result.hopCount).toBe(2);
      // LP: RFQ=0 + V4=100, both process full notional → 100 bps
      expect(result.lpFeeBps).toBeCloseTo(100, 0);
      // aggFeeBps from base decomposeTrade (the 0x4f..eb29 skim)
      expect(result.aggFeeBps).toBeCloseTo(1.66, 0);
      // Slippage = allIn - lp - agg = -10.09 - 100 - 1.66 = -111.75
      expect(result.slippageBps).toBeCloseTo(
        input.allInCostBps - 100 - result.aggFeeBps, 0,
      );
      // Confidence: route is linear and reconstructed, no approx legs,
      // all fee tiers resolved (rfq=0 is fine, V4 from event is fine).
      // However, per-leg LP sanity: V4 leg contributes 100 bps which is < 300 cap.
      // RFQ fee is 0 which is the correct default, not a "defaulted" scenario.
      // So confidence should be 'high'.
      expect(result.confidence).toBe('high');

      // Per-leg detail — fixture includes a real WETH wrap (Deposit) event,
      // prepended as an informational (null-cost) leg ahead of the pool legs.
      expect(result.legs).toHaveLength(3);
      expect(result.legs[0]!.leg.type).toBe('wrap');
    });
  });

  describe('PI_IMPLAUSIBLE clamp (stale-mid guard)', () => {
    // Synthetic 2-hop linear: trader → poolA (USDC→VIRTUAL) → poolB (VIRTUAL→WETH) → trader
    // poolB returns a deliberately stale mid so its priceImpactBps exceeds 500 bps.
    const syntheticTrader = '0x00000000000000000000000000000000000000d0' as `0x${string}`;
    const poolA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
    const poolB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;

    const UNI_V3_SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67' as `0x${string}`;

    function swapLog(pool: `0x${string}`): { address: `0x${string}`; data: `0x${string}`; topics: [`0x${string}`, `0x${string}`, `0x${string}`] } {
      return {
        address: pool,
        data: '0x' + '00'.repeat(160) as `0x${string}`,
        topics: [UNI_V3_SWAP_TOPIC, '0x' + '00'.repeat(32) as `0x${string}`, '0x' + '00'.repeat(32) as `0x${string}`],
      };
    }

    const syntheticTrace = {
      from: syntheticTrader,
      to: '0xcccccccccccccccccccccccccccccccccccccccc' as `0x${string}`,
      input: '0x' as `0x${string}`,
      logs: [
        swapLog(poolA),
        swapLog(poolB),
        // Leg 0: trader → poolA (USDC), poolA → poolB (VIRTUAL)
        transferLog(USDC as `0x${string}`, syntheticTrader, poolA, 1_000000n),       // 1 USDC
        transferLog(VIRTUAL as `0x${string}`, poolA, poolB, 3_000000000000000000n),    // 3 VIRTUAL
        // Leg 1: poolB → trader (WETH)
        transferLog(WETH as `0x${string}`, poolB, syntheticTrader, 500000000000000n),  // 0.0005 WETH
      ],
      calls: [],
    };

    const input: DecomposeTradeInput = {
      trace: syntheticTrace as any,
      txHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      trader: syntheticTrader,
      direction: 'buy_weth',
      settledIn: 'WETH',
      allInCostBps: -5.0,
      notionalUsdc: 1.0,
      realizedPrice: 1800,
      gasCostUsd: 0.001,
      aggregator: 'Unknown',
      blockNumber: 100n,
      rpcUrl: 'unused',
      dustUsdc: 1e-6,
      structuralFloorUsd: 0,
      structuralFloorBps: 0.5,
    };

    it('nulls priceImpactBps and reconResidualBps when a leg exceeds PI_IMPLAUSIBLE_CAP_BPS', async () => {
      // Leg 0 mid is reasonable; leg 1 mid is deliberately stale so PI > 500 bps.
      // Leg 1 realized: (0.0005 WETH / 3 VIRTUAL) = 0.000166667 WETH/VIRTUAL
      // Stale mid: 0.001 WETH/VIRTUAL → legTotalCost = (0.001 - 0.000166667)/0.001 * 10000 ≈ 8333 bps
      // priceImpactBps = 8333 - 5 (feeTier) ≈ 8328 bps → well above 500 cap
      const stubMids: Record<string, number> = {
        [`${USDC}:${VIRTUAL}`]: 3.0,    // reasonable: 3 VIRTUAL per USDC
        [`${VIRTUAL}:${WETH}`]: 0.001,  // STALE: real is ~0.000167, 6x off
      };

      const result = await decomposeRoute(input, {
        trace: syntheticTrace as any,
        feeReader: async () => ({ bps: 5, defaulted: false }),
        midReader: async (leg) => {
          const key = `${leg.tokenIn}:${leg.tokenOut}`;
          const price = stubMids[key];
          if (price === undefined) return null;
          return { price, poolAddress: 'stub', poolKind: 'stub' };
        },
      });

      // Leg 0 should have a valid priceImpactBps (well under cap)
      expect(result.legs[0]!.priceImpactBps).not.toBeNull();

      // Leg 1 should be clamped to null
      expect(result.legs[1]!.priceImpactBps).toBeNull();

      // Flags should include PI_IMPLAUSIBLE
      expect(result.flags.some(f => f.startsWith('PI_IMPLAUSIBLE'))).toBe(true);

      // reconResidualBps should be null (hasNullMid cascades)
      expect(result.reconResidualBps).toBeNull();

      // Confidence downgraded from high (partial pricing: some legs have mids but not all)
      expect(result.confidence).not.toBe('high');
    });
  });

  describe('clean parallel split (Fix 2 — direct-pair decomposition)', () => {
    // Synthetic trace: trader fans out USDC to two V3 pools, each returns WETH.
    // Pool A: 5 bps fee tier, pool B: 30 bps fee tier. Equal notional split.
    const syntheticTrader = '0x00000000000000000000000000000000000000d0' as `0x${string}`;
    const poolA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
    const poolB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;

    // Swap event topic for Uni V3 (identifies pools as venues)
    const UNI_V3_SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67' as `0x${string}`;

    /** Build a minimal V3 Swap log (only topic0 + 2 indexed topics needed for venue scan). */
    function swapLog(pool: `0x${string}`): { address: `0x${string}`; data: `0x${string}`; topics: [`0x${string}`, `0x${string}`, `0x${string}`] } {
      return {
        address: pool,
        data: '0x' + '00'.repeat(160) as `0x${string}`,
        topics: [UNI_V3_SWAP_TOPIC, '0x' + '00'.repeat(32) as `0x${string}`, '0x' + '00'.repeat(32) as `0x${string}`],
      };
    }

    const syntheticTrace = {
      from: syntheticTrader,
      to: '0xcccccccccccccccccccccccccccccccccccccccc' as `0x${string}`,
      input: '0x' as `0x${string}`,
      logs: [
        // Swap events to register both pools as venues
        swapLog(poolA),
        swapLog(poolB),
        // ERC-20 transfers
        transferLog(USDC as `0x${string}`, syntheticTrader, poolA, 1_000000n),
        transferLog(WETH as `0x${string}`, poolA, syntheticTrader, 500_000000000000000n),
        transferLog(USDC as `0x${string}`, syntheticTrader, poolB, 1_000000n),
        transferLog(WETH as `0x${string}`, poolB, syntheticTrader, 500_000000000000000n),
      ],
      calls: [],
    };

    const input: DecomposeTradeInput = {
      trace: syntheticTrace as any,
      txHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      trader: syntheticTrader,
      direction: 'buy_weth',
      settledIn: 'WETH',
      allInCostBps: -5.0,
      notionalUsdc: 2.0,
      realizedPrice: 1800,
      gasCostUsd: 0.001,
      aggregator: 'Unknown',
      blockNumber: 1n,
      rpcUrl: 'unused',
      dustUsdc: 1e-6,
      structuralFloorUsd: 0,
      structuralFloorBps: 0.5,
    };

    it('decomposes a clean 2-pool split with correct LP, slippage, hopCount, confidence', async () => {
      const result = await decomposeRoute(input, {
        trace: syntheticTrace as any,
        feeReader: async (addr) => {
          if (addr === poolA.toLowerCase()) return { bps: 5, defaulted: false };
          if (addr === poolB.toLowerCase()) return { bps: 30, defaulted: false };
          return { bps: 0, defaulted: false };
        },
      });

      expect(result.routeShape).toBe('split');
      // Parallel split = 1 hop (one token-step across N pools)
      expect(result.hopCount).toBe(1);
      // LP = notional-weighted average: (1*5 + 1*30) / 2 = 17.5
      expect(result.lpFeeBps).toBeCloseTo(17.5, 1);
      // Slippage = allIn - lp - agg
      expect(result.slippageBps).toBeCloseTo(input.allInCostBps - 17.5 - result.aggFeeBps, 1);
      expect(result.slippageBps).not.toBeNull();
      expect(result.confidence).toBe('high');
      expect(result.legs).toHaveLength(2);
    });
  });

  describe('convergent DAG: split-then-merge reconciliation (Task 3 coverage)', () => {
    // Three-leg convergent DAG for a USDC->WETH trade:
    //   leg1: USDC --(poolC, univ3 5bps)--> VIRTUAL
    //   leg2: VIRTUAL --(poolD, univ3 5bps)--> WETH
    //   leg3: USDC --(poolE, univ3 30bps)--> WETH   (direct, parallel to leg1+leg2)
    // Flow splits at USDC (leg1 + leg3 both draw from the trader) and reconverges
    // at WETH (leg2 + leg3 both pay the trader). VIRTUAL is a pure intermediate —
    // poolC's VIRTUAL-out feeds poolD's VIRTUAL-in exactly (never touches the
    // trader) — so the DAG conserves and reconstructDag() places [leg1, leg2, leg3]
    // as a 'split'-shaped route (two legs share tokenIn=USDC).
    //
    // Raw amounts and stub mids were derived (see below) so each leg's realized
    // price sits close to its own mid — per-leg total cost ~= fee tier +/- 1-2bps
    // of genuine impact — and allInCostBps is set to the notional-weighted sum of
    // (lpFeeBps + priceImpactBps) so the trade-level reconciliation residual is
    // near zero by construction (the only slack is bigint rounding-to-the-nearest-
    // wei noise, far under the 5bps tolerance).
    //
    // Derivation (human units):
    //   leg1: 1.2 USDC in @ mid 1.53 VIRTUAL/USDC, cost 4bps (fee 5, impact -1)
    //     -> realized 1.529388 -> 1.8352656 VIRTUAL out
    //   leg2: 1.8352656 VIRTUAL in @ mid 0.00036 WETH/VIRTUAL, cost 6bps (fee 5, impact +1)
    //     -> realized 0.0003599784 -> 0.00066029... WETH out
    //   leg3: 0.8 USDC in @ mid 1/1800 WETH/USDC, cost 28bps (fee 30, impact -2)
    //     -> realized 0.000554 -> 0.0004432 WETH out
    //   notional1=1.2 (USDC endpoint), notional3=0.8 (USDC endpoint),
    //   notional2=leg2 WETH-out * realizedPrice(1800) ~= 1.18854 (slightly below
    //   1.2 because leg1's own cost shaves a hair off the value flowing into leg2)
    //   lpFeeBps = (5*1.2 + 5*1.18854 + 30*0.8) / 2.0 ~= 17.9713
    //   weighted impacts: leg1 -0.6, leg2 +0.5943, leg3 -0.8 -> sum ~= -0.80573
    //   allInCostBps = 17.9713 + (-0.80573) + 0 (aggFeeBps) ~= 17.16562
    const syntheticTrader = '0x00000000000000000000000000000000000000d0' as `0x${string}`;
    const poolC = '0xcccccccccccccccccccccccccccccccccccccccc' as `0x${string}`;
    const poolD = '0xdddddddddddddddddddddddddddddddddddddddd' as `0x${string}`;
    const poolE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as `0x${string}`;

    // Locally-scoped Swap log with a full zero-filled data payload (5 words:
    // amount0, amount1, sqrtPriceX96, liquidity, tick) so decodeV3LikeSwaps (used
    // internally by decomposeTrade's Step 1, not just decomposeRoute's own venue
    // scan) successfully decodes it and adds the pool to venueAddresses — the
    // module-level `v3SwapLog` helper uses `data: '0x'`, which decodeEventLog
    // rejects, leaving the pool unclassified and triggering a live RPC probe
    // (fee()/getReserves() against rpcUrl 'unused') that hangs the test.
    function swapLog(pool: `0x${string}`): { address: `0x${string}`; data: `0x${string}`; topics: [`0x${string}`, `0x${string}`, `0x${string}`] } {
      return {
        address: pool,
        data: '0x' + '00'.repeat(160) as `0x${string}`,
        topics: [UNI_V3_SWAP_TOPIC as `0x${string}`, '0x' + '00'.repeat(32) as `0x${string}`, '0x' + '00'.repeat(32) as `0x${string}`],
      };
    }

    const syntheticTrace = {
      from: syntheticTrader,
      to: '0xffffffffffffffffffffffffffffffffffffffff' as `0x${string}`,
      input: '0x' as `0x${string}`,
      logs: [
        // Swap events register poolC/D/E as univ3 venues (drives both the route
        // graph's venue map here AND decomposeTrade's own venue-vs-fee-sink gate,
        // so none of the three pools are misclassified as agg-fee sinks).
        swapLog(poolC),
        swapLog(poolD),
        swapLog(poolE),
        // leg1: trader -> poolC (USDC in), poolC -> poolD (VIRTUAL out = leg2 in)
        transferLog(USDC as `0x${string}`, syntheticTrader, poolC, 1_200000n),
        transferLog(VIRTUAL as `0x${string}`, poolC, poolD, 1_835265600000000000n),
        // leg2: poolD -> trader (WETH out)
        transferLog(WETH as `0x${string}`, poolD, syntheticTrader, 660299198630400n),
        // leg3: trader -> poolE (USDC in), poolE -> trader (WETH out), direct
        transferLog(USDC as `0x${string}`, syntheticTrader, poolE, 800000n),
        transferLog(WETH as `0x${string}`, poolE, syntheticTrader, 443200000000000n),
      ],
      calls: [],
    };

    const input: DecomposeTradeInput = {
      trace: syntheticTrace as any,
      txHash: '0x0000000000000000000000000000000000000000000000000000000000000001',
      trader: syntheticTrader,
      direction: 'buy_weth',
      settledIn: 'WETH',
      allInCostBps: 17.1656156726039,
      notionalUsdc: 2.0,
      realizedPrice: 1800,
      gasCostUsd: 0,
      aggregator: 'Unknown',
      blockNumber: 1n,
      rpcUrl: 'unused',
      dustUsdc: 1e-6,
      structuralFloorUsd: 0,
      structuralFloorBps: 0.5,
    };

    it('reconciles LP, price-impact, and residual for a split+merge convergent DAG', async () => {
      // Note: decomposeTrade's Step 1 (invoked internally, no dep injection) does
      // real RPC probing (fee()/token0()/token1()) against rpcUrl 'unused' for
      // each unrecognized V3-like pool. With 3 synthetic pools that latency runs
      // past the 5s default — bump the timeout rather than dropping a leg.
      const stubMids: Record<string, number> = {
        [`${USDC}:${VIRTUAL}`]: 1.53,      // leg1 mid: VIRTUAL per USDC
        [`${VIRTUAL}:${WETH}`]: 0.00036,   // leg2 mid: WETH per VIRTUAL
        [`${USDC}:${WETH}`]: 1 / 1800,     // leg3 mid: WETH per USDC (direct)
      };

      const result = await decomposeRoute(input, {
        trace: syntheticTrace as any,
        feeReader: async (addr) => {
          if (addr === poolC) return { bps: 5, defaulted: false };
          if (addr === poolD) return { bps: 5, defaulted: false };
          if (addr === poolE) return { bps: 30, defaulted: false };
          return { bps: 0, defaulted: false };
        },
        midReader: async (leg) => {
          const key = `${leg.tokenIn}:${leg.tokenOut}`;
          const price = stubMids[key];
          if (price === undefined) return null;
          return { price, poolAddress: 'stub', poolKind: 'stub' };
        },
      });

      // Route reconstructed as a convergent DAG (not the orphan/stalled fallback).
      expect(['split', 'complex']).toContain(result.routeShape);
      expect(result.lpFeeBps).not.toBeNull();
      expect(result.slippageBps).not.toBeNull();
      expect(result.flags.some(f => f.startsWith('ROUTE_NOT_DECOMPOSED'))).toBe(false);

      // Exactly 3 costed legs (no wrap/unwrap in this synthetic trace), all priced.
      expect(result.legs).toHaveLength(3);
      for (const leg of result.legs) {
        expect(typeof leg.priceImpactBps).toBe('number');
      }

      // LP roll-up: Sigma(feeTier x legNotional) / tradeNotional (see derivation above).
      expect(result.lpFeeBps).toBeCloseTo(17.9713, 3);

      // aggFeeBps is 0 for this clean synthetic trace (poolC/D/E are all tagged
      // as venues by their Swap logs, so decomposeTrade's fee-sink scan skips them
      // entirely) -> slippageBps reduces to the notional-weighted sum of impacts.
      expect(result.aggFeeBps).toBeCloseTo(0, 6);
      expect(result.slippageBps).toBeCloseTo(-0.80573, 3);

      // Per-leg notional-weighted price impact, in reconstructDag's topological
      // placement order [leg1 (poolC), leg2 (poolD), leg3 (poolE)].
      const [leg1, leg2, leg3] = result.legs;
      expect(leg1!.leg.venue).toBe(poolC);
      expect(leg2!.leg.venue).toBe(poolD);
      expect(leg3!.leg.venue).toBe(poolE);
      expect(leg1!.priceImpactBps).toBeCloseTo(-0.6, 2);
      expect(leg2!.priceImpactBps).toBeCloseTo(0.5943, 3);
      expect(leg3!.priceImpactBps).toBeCloseTo(-0.8, 2);

      // Reconciliation: allInCostBps was calibrated to the notional-weighted sum
      // of lpFeeBps + priceImpactBps + aggFeeBps, so the residual should be ~0
      // (only bigint rounding-to-the-nearest-wei noise remains) — well inside the
      // documented RECON_TOL_BPS(5) gate.
      expect(result.reconResidualBps).not.toBeNull();
      expect(Math.abs(result.reconResidualBps!)).toBeLessThan(0.01);

      // Tight residual -> high confidence.
      expect(result.confidence).toBe('high');
    }, 15000);
  });

  describe('non-reconstructed fallback (Design Decision 7)', () => {
    // Synthetic trace: two orphan legs that don't chain from inputToken to
    // outputToken. This exercises the !reconstructed branch without RPC.
    //
    // Transfers:
    //   Trader → poolA: USDC 1e6     (poolA receives USDC)
    //   poolA  → Trader: tokenX 2e18 (poolA sends tokenX)
    //   Trader → poolB: tokenY 5e17  (poolB receives tokenY)
    //   poolB  → Trader: WETH 1e17   (poolB sends WETH)
    //
    // Trader net: USDC -1e6, tokenX +2e18, tokenY -5e17, WETH +1e17
    // Largest negative = tokenY (5e17 > 1e6), largest positive = tokenX (2e18 > 1e17)
    // → inputToken = tokenY, outputToken = tokenX
    // poolA leg: USDC→tokenX (tokenIn ≠ inputToken → orphan)
    // poolB leg: tokenY→WETH (tokenOut ≠ outputToken → stalled chain)
    // → shape = 'complex', reconstructed = false

    const syntheticTrader = '0x00000000000000000000000000000000000000d0' as `0x${string}`;
    const poolA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
    const poolB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;
    const tokenX = '0x1111111111111111111111111111111111111111' as `0x${string}`;
    const tokenY = '0x2222222222222222222222222222222222222222' as `0x${string}`;

    const syntheticTrace = {
      from: syntheticTrader,
      to: '0xcccccccccccccccccccccccccccccccccccccccc' as `0x${string}`,
      input: '0x' as `0x${string}`,
      logs: [
        transferLog(USDC as `0x${string}`, syntheticTrader, poolA, 1_000000n),
        transferLog(tokenX, poolA, syntheticTrader, 2_000000000000000000n),
        transferLog(tokenY, syntheticTrader, poolB, 500_000000000000000n),
        transferLog(WETH as `0x${string}`, poolB, syntheticTrader, 100_000000000000000n),
      ],
      calls: [],
    };

    const input: DecomposeTradeInput = {
      trace: syntheticTrace as any,
      txHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      trader: syntheticTrader,
      direction: 'buy_weth',
      settledIn: 'WETH',
      allInCostBps: -5.0,
      notionalUsdc: 1.0,
      realizedPrice: 1800,
      gasCostUsd: 0.001,
      aggregator: 'Unknown',
      blockNumber: 1n,
      rpcUrl: 'unused',
      dustUsdc: 1e-6,
      structuralFloorUsd: 0,
      structuralFloorBps: 0.5,
    };

    it('yields null LP/slippage, low confidence, and ROUTE_NOT_DECOMPOSED flag', async () => {
      const result = await decomposeRoute(input, {
        trace: syntheticTrace as any,
        feeReader: async () => ({ bps: 0, defaulted: false }),
      });

      expect(result.lpFeeBps).toBeNull();
      expect(result.slippageBps).toBeNull();
      expect(result.confidence).toBe('low');
      expect(result.flags.some(f => f.startsWith('ROUTE_NOT_DECOMPOSED'))).toBe(true);
      // Route should not be reconstructed
      expect(result.routeShape).toBe('complex');
    });
  });

  describe('RFQ maker round-trip netting (id 189 shape)', () => {
    // 2-hop linear USDC→VIRTUAL→WETH where the FIRST hop is an event-less
    // maker with a round-trip in the intermediate token: it sends 3.5 VIRTUAL
    // gross through a helper, gets 0.5 back as change, and only 3.0 reaches
    // the V3 pool. Pre-fix the VIRTUAL conservation check failed → complex.
    const syntheticTrader = '0x00000000000000000000000000000000000000d0' as `0x${string}`;
    const maker = '0x69a9f1560000000000000000000000000000dddd' as `0x${string}`;
    const helper = '0x7c9768010000000000000000000000000000eeee' as `0x${string}`;
    const poolB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;

    const UNI_V3_SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67' as `0x${string}`;
    function swapLog(pool: `0x${string}`): { address: `0x${string}`; data: `0x${string}`; topics: [`0x${string}`, `0x${string}`, `0x${string}`] } {
      return {
        address: pool,
        data: '0x' + '00'.repeat(160) as `0x${string}`,
        topics: [UNI_V3_SWAP_TOPIC, '0x' + '00'.repeat(32) as `0x${string}`, '0x' + '00'.repeat(32) as `0x${string}`],
      };
    }

    const syntheticTrace = {
      from: syntheticTrader,
      to: '0xcccccccccccccccccccccccccccccccccccccccc' as `0x${string}`,
      input: '0x' as `0x${string}`,
      logs: [
        swapLog(poolB), // only the pool has a Swap event; the maker is event-less
        transferLog(USDC as `0x${string}`, syntheticTrader, maker, 1_000000n),
        transferLog(VIRTUAL as `0x${string}`, maker, helper, 3_500000000000000000n),
        transferLog(VIRTUAL as `0x${string}`, helper, maker, 500000000000000000n),   // change
        transferLog(VIRTUAL as `0x${string}`, helper, poolB, 3_000000000000000000n),
        transferLog(WETH as `0x${string}`, poolB, syntheticTrader, 500000000000000n),
      ],
      calls: [],
    };

    const input: DecomposeTradeInput = {
      trace: syntheticTrace as any,
      txHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      trader: syntheticTrader,
      direction: 'buy_weth',
      settledIn: 'WETH',
      allInCostBps: -5.0,
      notionalUsdc: 1.0,
      realizedPrice: 1800,
      gasCostUsd: 0.001,
      aggregator: 'Unknown',
      blockNumber: 100n,
      rpcUrl: 'unused',
      dustUsdc: 1e-6,
      structuralFloorUsd: 0,
      structuralFloorBps: 0.5,
    };

    it('reconstructs, flags LEG_AMOUNTS_NETTED, and caps confidence at medium', async () => {
      const result = await decomposeRoute(input, {
        trace: syntheticTrace as any,
        // Both tiers resolved (defaulted: false) so any confidence downgrade
        // must come from the netting cap, not the defaulted-fee path.
        feeReader: async (_addr, type) =>
          type === 'univ3' ? { bps: 5, defaulted: false } : { bps: 0, defaulted: false },
      });

      // Pre-fix this was complex/not-reconstructed with null LP/slippage.
      expect(result.routeShape).toBe('linear');
      expect(result.lpFeeBps).not.toBeNull();
      expect(result.slippageBps).not.toBeNull();
      expect(result.flags.some((f) => f.startsWith('LEG_AMOUNTS_NETTED'))).toBe(true);
      expect(result.flags.some((f) => f.startsWith('ROUTE_NOT_DECOMPOSED'))).toBe(false);
      // Netted amounts are inferred, not observed → never 'high'.
      expect(result.confidence).toBe('medium');
    });
  });

  describe('rfq maker retype pass', () => {
    const syntheticTrader = '0x00000000000000000000000000000000000000d0' as `0x${string}`;
    const maker = '0x69a9f1560000000000000000000000000000aaaa' as `0x${string}`;
    const poolB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;
    const UNI_V3_SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67' as `0x${string}`;
    const RFQ_FILL_TOPIC = '0x51ab1232a73b82b6b0acb0fa91b834cf6e258a1858c4e23c72ce97241c71aa0d' as `0x${string}`;
    function swapLog(pool: `0x${string}`): { address: `0x${string}`; data: `0x${string}`; topics: [`0x${string}`, `0x${string}`, `0x${string}`] } {
      return {
        address: pool,
        data: '0x' + '00'.repeat(160) as `0x${string}`,
        topics: [UNI_V3_SWAP_TOPIC, '0x' + '00'.repeat(32) as `0x${string}`, '0x' + '00'.repeat(32) as `0x${string}`],
      };
    }
    // trader USDC → maker → VIRTUAL → poolB → WETH (2-hop linear)
    function makeTrace(withFillEvent: boolean) {
      return {
        from: syntheticTrader,
        to: '0xcccccccccccccccccccccccccccccccccccccccc' as `0x${string}`,
        input: '0x' as `0x${string}`,
        logs: [
          ...(withFillEvent ? [{
            address: maker,
            data: '0x' + '00'.repeat(96) as `0x${string}`,
            topics: [RFQ_FILL_TOPIC, '0x' + '00'.repeat(32) as `0x${string}`] as [`0x${string}`, `0x${string}`],
          }] : []),
          swapLog(poolB),
          transferLog(USDC as `0x${string}`, syntheticTrader, maker, 1_000000n),
          transferLog(VIRTUAL as `0x${string}`, maker, poolB, 3_000000000000000000n),
          transferLog(WETH as `0x${string}`, poolB, syntheticTrader, 500000000000000n),
        ],
        calls: [],
      };
    }
    function makeInput(trace: unknown): DecomposeTradeInput {
      return {
        trace: trace as any,
        txHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
        trader: syntheticTrader,
        direction: 'buy_weth',
        settledIn: 'WETH',
        allInCostBps: -5.0,
        notionalUsdc: 1.0,
        realizedPrice: 1800,
        gasCostUsd: 0.001,
        aggregator: 'Unknown',
        blockNumber: 100n,
        rpcUrl: 'unused',
        dustUsdc: 1e-6,
        structuralFloorUsd: 0,
        structuralFloorBps: 0.5,
      };
    }
    const feeReader = async (_addr: string, type: string) =>
      type === 'univ3' ? { bps: 5, defaulted: false } : { bps: 0, defaulted: false };

    it('tier 1: retypes a leg whose venue emitted a known maker-fill topic (no probe call)', async () => {
      const trace = makeTrace(true);
      const probeCalls: string[] = [];
      const result = await decomposeRoute(makeInput(trace), {
        trace: trace as any,
        feeReader,
        rfqProbe: (addr) => { probeCalls.push(addr); return 'contract'; },
      });
      const makerLeg = result.legs.find((l) => l.leg.venue === maker)!;
      expect(makerLeg.leg.type).toBe('rfq');
      expect(result.flags.some((f) => f.startsWith('RFQ_LEG_UNPRICED'))).toBe(true);
      expect(probeCalls).not.toContain(maker); // tier 1 short-circuits tier 2
    });

    it('tier 2: retypes an EOA / EIP-1967-proxy counterparty; plain contracts stay unknown', async () => {
      const trace = makeTrace(false);
      for (const [probeResult, expected] of [['eoa', 'rfq'], ['proxy1967', 'rfq'], ['contract', 'unknown']] as const) {
        const result = await decomposeRoute(makeInput(trace), {
          trace: trace as any,
          feeReader,
          rfqProbe: (addr) => (addr === maker ? probeResult : 'contract'),
        });
        const makerLeg = result.legs.find((l) => l.leg.venue === maker)!;
        expect(makerLeg.leg.type).toBe(expected);
      }
    }, 20_000);

    it('never retypes or probes a recognized venue', async () => {
      const trace = makeTrace(false);
      const probeCalls: string[] = [];
      const result = await decomposeRoute(makeInput(trace), {
        trace: trace as any,
        feeReader,
        rfqProbe: (addr) => { probeCalls.push(addr); return 'eoa'; },
      });
      const poolLeg = result.legs.find((l) => l.leg.venue === poolB)!;
      expect(poolLeg.leg.type).toBe('univ3');
      expect(probeCalls).not.toContain(poolB); // only `unknown` legs are candidates
    });

    it('prices around an rfq leg: deliberate null, no confidence downgrade, recon null', async () => {
      const trace = makeTrace(true); // tier-1 maker
      const stubMids: Record<string, number> = {
        [`${VIRTUAL}:${WETH}`]: 0.000166667, // matches realized → tiny PI for poolB
      };
      const result = await decomposeRoute(makeInput(trace), {
        trace: trace as any,
        feeReader,
        rfqProbe: () => 'contract',
        midReader: async (leg) => {
          if (leg.type === 'rfq') throw new Error('midReader must never see an rfq leg');
          const price = stubMids[`${leg.tokenIn}:${leg.tokenOut}`];
          return price === undefined ? null : { price, poolAddress: 'stub', poolKind: 'stub' };
        },
      });
      const makerLeg = result.legs.find((l) => l.leg.type === 'rfq')!;
      expect(makerLeg.priceImpactBps).toBeNull();       // deliberate null
      const poolLeg = result.legs.find((l) => l.leg.type === 'univ3')!;
      expect(poolLeg.priceImpactBps).not.toBeNull();     // other legs still priced
      expect(result.reconResidualBps).toBeNull();        // recon incomplete by design
      // The rfq null is NOT a pricing failure: no MID_NULL flag, confidence 'high'
      // (fees resolved, no approx legs, no netting — only the rfq null could downgrade).
      expect(result.flags.some((f) => f.startsWith('MID_NULL'))).toBe(false);
      expect(result.confidence).toBe('high');
    });
  });
});

describe('extractNativeTransfers', () => {
  it('collects value-moving CALL frames as WETH transfers, skipping delegate/static/reverted/zero', () => {
    const trace = {
      type: 'CALL', from: TRADER, to: POOL_A, value: '0x0',
      calls: [
        { type: 'CALL', from: POOL_A, to: TRADER, value: u256(5n) },
        { type: 'DELEGATECALL', from: POOL_A, to: TRADER, value: u256(9n) },
        { type: 'CALL', from: POOL_A, to: TRADER, value: u256(7n), error: 'execution reverted' },
        { type: 'STATICCALL', from: POOL_A, to: TRADER, value: u256(3n) },
        { type: 'CALL', from: POOL_A, to: TRADER, value: '0x0',
          calls: [{ type: 'CALL', from: TRADER, to: POOL_A, value: u256(11n) }] },
      ],
    };
    const out = extractNativeTransfers(trace as never);
    expect(out).toEqual([
      { token: WETH, from: POOL_A, to: TRADER, value: 5n },
      { token: WETH, from: TRADER, to: POOL_A, value: 11n }, // nested frame collected
    ]);
  });
});

describe('native-ETH decomposition (Step 3a)', () => {
  const nativeTrace = {
    type: 'CALL', from: TRADER, to: POOL_A, value: '0x0',
    logs: [
      { address: USDC, topics: [TRANSFER_TOPIC, pad32(TRADER), pad32(POOL_A)], data: u256(2_000000n) },
    ],
    calls: [
      { type: 'CALL', from: POOL_A, to: TRADER, value: u256(1_000000000000000000n) }, // 1 ETH out
    ],
  };
  const input = {
    trace: nativeTrace, txHash: '0xabc', trader: TRADER, direction: 'sell_weth', settledIn: 'ETH',
    allInCostBps: 0, notionalUsdc: 2, realizedPrice: 2000, gasCostUsd: 0, aggregator: 'unknown',
    blockNumber: 100n, rpcUrl: 'http://invalid', dustUsdc: 1e-6, structuralFloorUsd: 0,
    structuralFloorBps: 0.5, recognizeV3Forks: true, impureOnVenueThirdToken: true,
  } as never;

  it('decomposes a USDC→native-ETH single hop into one costed leg', async () => {
    const result = await decomposeRoute(input, {
      trace: nativeTrace as never,
      feeReader: async () => ({ bps: 30, defaulted: false }),
    });
    expect(result.legs).toHaveLength(1);
    expect(result.legs[0]!.leg.venue).toBe(POOL_A);
    expect(result.legs[0]!.leg.tokenIn).toBe(USDC);
    expect(result.legs[0]!.leg.tokenOut).toBe(WETH); // native modeled as WETH
    expect(typeof result.legs[0]!.lpFeeBps).toBe('number');
    expect(result.routeShape === 'single' || result.routeShape === 'linear').toBe(true);
  });
});

describe('wrap/unwrap informational steps', () => {
  it('detectWrapUnwrapSteps returns one summed unwrap and one wrap', () => {
    const logs = [
      { address: WETH, topics: [WITHDRAWAL_TOPIC, pad32(TRADER)], data: u256(3n) },
      { address: WETH, topics: [WITHDRAWAL_TOPIC, pad32(TRADER)], data: u256(4n) },
      { address: WETH, topics: [DEPOSIT_TOPIC, pad32(TRADER)], data: u256(10n) },
      { address: USDC, topics: [TRANSFER_TOPIC, pad32(TRADER), pad32(POOL_A)], data: u256(1n) },
    ];
    expect(detectWrapUnwrapSteps(logs)).toEqual([
      { kind: 'wrap', amountRaw: 10n },
      { kind: 'unwrap', amountRaw: 7n },
    ]);
  });

  it('appends an unwrap leg (null cost) after the costed pool legs', async () => {
    const traceWithUnwrap = {
      type: 'CALL', from: TRADER, to: POOL_A, value: '0x0',
      logs: [
        { address: USDC, topics: [TRANSFER_TOPIC, pad32(TRADER), pad32(POOL_A)], data: u256(2_000000n) },
        { address: WETH, topics: [WITHDRAWAL_TOPIC, pad32(POOL_A)], data: u256(1_000000000000000000n) },
      ],
      calls: [{ type: 'CALL', from: POOL_A, to: TRADER, value: u256(1_000000000000000000n) }],
    };
    const input = {
      trace: traceWithUnwrap, txHash: '0xabc', trader: TRADER, direction: 'sell_weth', settledIn: 'ETH',
      allInCostBps: 0, notionalUsdc: 2, realizedPrice: 2000, gasCostUsd: 0, aggregator: 'unknown',
      blockNumber: 100n, rpcUrl: 'http://invalid', dustUsdc: 1e-6, structuralFloorUsd: 0,
      structuralFloorBps: 0.5, recognizeV3Forks: true, impureOnVenueThirdToken: true,
    } as never;
    const result = await decomposeRoute(input, {
      trace: traceWithUnwrap as never, feeReader: async () => ({ bps: 30, defaulted: false }),
    });
    const unwrap = result.legs.find((l) => l.leg.type === 'unwrap');
    expect(unwrap).toBeDefined();
    expect(unwrap!.lpFeeBps).toBeNull();
    expect(result.legs[result.legs.length - 1]!.leg.type).toBe('unwrap'); // appended last
    expect(result.legs.some((l) => typeof l.lpFeeBps === 'number')).toBe(true); // pool leg still costed
  });
});

describe('venuesToUncostedLegs (pools-touched fallback)', () => {
  it('emits one uncosted entry per venue with best-effort token pair', () => {
    const venues = new Map([[POOL_A, { type: 'univ3' as const }]]);
    const transfers = [
      { token: USDC, from: TRADER, to: POOL_A, value: 2n },
      { token: WETH, from: POOL_A, to: TRADER, value: 1n },
    ];
    const out = venuesToUncostedLegs(venues, transfers);
    expect(out).toHaveLength(1);
    expect(out[0]!.leg.venue).toBe(POOL_A);
    expect(out[0]!.leg.type).toBe('univ3');
    expect(out[0]!.leg.tokenIn).toBe(USDC);
    expect(out[0]!.leg.tokenOut).toBe(WETH);
    expect(out[0]!.lpFeeBps).toBeNull();
  });

  it('leaves token pair empty for an ambiguous multi-token venue', () => {
    const venues = new Map([[POOL_A, { type: 'univ4' as const }]]);
    const transfers = [
      { token: USDC, from: TRADER, to: POOL_A, value: 2n },
      { token: WETH, from: TRADER, to: POOL_A, value: 5n }, // two net-received tokens
      { token: WETH, from: POOL_A, to: TRADER, value: 1n },
    ];
    const out = venuesToUncostedLegs(venues, transfers);
    expect(out[0]!.leg.tokenIn).toBe('');
    expect(out[0]!.leg.tokenOut).toBe('');
  });
});
