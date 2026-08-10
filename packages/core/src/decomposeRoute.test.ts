/**
 * decomposeRoute.test.ts — Tests for route-aware decomposition orchestrator.
 *
 * Uses recorded trace fixtures (kyber batch-01, batch-02) with injected
 * feeReader and trace dependencies to run without live RPC.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { decomposeRoute, extractNativeTransfers, detectWrapUnwrapSteps, venuesToUncostedLegs, weightedPriceImpactBps, buildFeeSinks, feeOnTransferFlag, POOL_VENUE_TYPES } from './decomposeRoute.js';
import type { FeeSink } from './tradeFees.js';
import { getLegMidAtBlock } from './routeReaders.js';
import { INFINITY_SWAP_TOPIC } from './infinityLegs.js';
import type { DecomposeTradeInput } from './decomposeTrade.js';
import type { Leg } from './routeGraph.js';

// Load trace fixtures (avoid JSON import attribute issues with NodeNext)
const __dirname = dirname(fileURLToPath(import.meta.url));
const kyberB1Trace = JSON.parse(readFileSync(resolve(__dirname, '__fixtures__/kyber-b1-trace.json'), 'utf-8'));
const kyberB2Trace = JSON.parse(readFileSync(resolve(__dirname, '__fixtures__/kyber-b2-trace.json'), 'utf-8'));
const id56Trace = JSON.parse(readFileSync(resolve(__dirname, '__fixtures__/id56-trace.json'), 'utf-8'));

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

  // An unresolved fee tier must stay distinguishable from a pool that is
  // genuinely free all the way to the leg, or the receipt renders a confident
  // "0.00bps" — a false claim rather than a missing one.
  describe('per-leg fee provenance', () => {
    const runWithFee = async (fee: { bps: number; defaulted: boolean }) => {
      const sushiPool = '0x5f0f9d3d4b1b0a5c9b0e0a0f0a0e0a0f0a0e0a0f' as `0x${string}`;
      const trader = '0x1111111111111111111111111111111111111111';
      const trace = {
        type: 'CALL', from: trader, to: sushiPool, input: '0x', logs: [
          transferLog(USDC as `0x${string}`, trader as `0x${string}`, sushiPool, 1_000000n),
          transferLog(WETH as `0x${string}`, sushiPool, trader as `0x${string}`, 500_000000000000n),
          v3SwapLog(sushiPool),
        ],
      };
      const input: DecomposeTradeInput = {
        trace: trace as any,
        txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        trader, allInCostBps: -1, notionalUsdc: 1, realizedPrice: 2000, gasCostUsd: 0,
        aggregator: 'Fabric', blockNumber: 47379575n, rpcUrl: 'unused', dustUsdc: 1e-6,
        structuralFloorUsd: 0, structuralFloorBps: 0.5,
        recognizeV3Forks: true, impureOnVenueThirdToken: true,
      };
      return decomposeRoute(input, {
        trace: trace as any,
        v3FactoryReader: async () => '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
        feeReader: async () => fee,
      });
    };

    it('marks a leg feeResolved:false when the fee reader could not resolve the tier', async () => {
      const result = await runWithFee({ bps: 0, defaulted: true });
      expect(result.legs[0]!.feeResolved).toBe(false);
    });

    it('does not mark a leg feeResolved:false when the tier was genuinely read as 0', async () => {
      const result = await runWithFee({ bps: 0, defaulted: false });
      expect(result.legs[0]!.feeResolved).not.toBe(false);
    });
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

  describe('decomposeRoute fee-on-transfer flag', () => {
    const TAX = '0xea87169699dabd028a78d4b91544b4298086baf6' as `0x${string}`;
    const poolA = '0x00000000000000000000000000000000000000c1' as `0x${string}`;
    const poolB = '0x00000000000000000000000000000000000000c2' as `0x${string}`;
    const burn = '0x000000000000000000000000000000000000dead' as `0x${string}`;

    it('emits FEE_ON_TRANSFER naming the taxed intermediate token', async () => {
      const trace = {
        from: TRADER as `0x${string}`,
        to: poolA,
        input: '0x' as `0x${string}`,
        logs: [
          transferLog(WETH as `0x${string}`, TRADER as `0x${string}`, poolA, 5n),
          // poolA's gross TAX outflow is 1000 (990 reaches poolB, 10 leaks to
          // burn on the SAME hop) — the taxed-transfer skim must sit between
          // the two legs' own gross measurements, not inside poolB's leg,
          // otherwise poolB's leg-level gross-received accounting (which
          // predates any of poolB's own outflows) still nets to 1000 and the
          // route reconciles cleanly instead of tripping fee_on_transfer.
          transferLog(TAX, poolA, poolB, 990n),
          transferLog(TAX, poolA, burn, 10n),
          transferLog(USDC as `0x${string}`, poolB, TRADER as `0x${string}`, 42n),
          // Uni V3 Swap events so both pools are recognized venues
          v3SwapLog(poolA),
          v3SwapLog(poolB),
        ],
        calls: [],
      };
      const input: DecomposeTradeInput = {
        trace: trace as any,
        txHash: '0x0000000000000000000000000000000000000000000000000000000000000002',
        trader: TRADER,
        allInCostBps: 0,
        notionalUsdc: 42,
        realizedPrice: 1,
        gasCostUsd: 0,
        aggregator: 'Unknown',
        blockNumber: 1n,
        rpcUrl: 'unused',
        dustUsdc: 1e-6,
        structuralFloorUsd: 0,
        structuralFloorBps: 0.5,
      };
      const result = await decomposeRoute(input, {
        trace: trace as any,
        feeReader: async () => ({ bps: 30, defaulted: false }),
        rfqProbe: async () => 'contract' as const,
      });
      expect(result.slippageBps).toBeNull();
      const fot = result.flags.find((f) => f.startsWith('FEE_ON_TRANSFER'));
      expect(fot).toBeDefined();
      expect(fot).toContain(`${TAX.slice(0, 6)}...${TAX.slice(-4)}`);
    });
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

    it('curated tier: retypes an unknown plain-contract leg listed in makers.json, flagged RFQ_LEG_CURATED', async () => {
      const curatedMaker = '0x3dbe077e7986657e95e1cc50089f17a5a4af0aae' as `0x${string}`;
      // trader USDC → curatedMaker → VIRTUAL → poolB → WETH; no fill event (tier 1
      // silent), rfqProbe returns 'contract' (tier 2 silent) — only the curated
      // list can classify it.
      const trace = {
        from: syntheticTrader,
        to: '0xcccccccccccccccccccccccccccccccccccccccc' as `0x${string}`,
        input: '0x' as `0x${string}`,
        logs: [
          swapLog(poolB),
          transferLog(USDC as `0x${string}`, syntheticTrader, curatedMaker, 1_000000n),
          transferLog(VIRTUAL as `0x${string}`, curatedMaker, poolB, 3_000000000000000000n),
          transferLog(WETH as `0x${string}`, poolB, syntheticTrader, 500000000000000n),
        ],
        calls: [],
      };
      const result = await decomposeRoute(makeInput(trace), {
        trace: trace as any,
        feeReader,
        rfqProbe: () => 'contract', // neither on-chain tier fires
      });
      const makerLeg = result.legs.find((l) => l.leg.venue === curatedMaker)!;
      expect(makerLeg.leg.type).toBe('rfq');
      expect(result.flags.some((f) => f.startsWith('RFQ_LEG_CURATED'))).toBe(true);
      expect(result.flags.some((f) => f.startsWith('RFQ_LEG_UNPRICED'))).toBe(false);
    });

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
    trace: nativeTrace, txHash: '0xabc', trader: TRADER,
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
      trace: traceWithUnwrap, txHash: '0xabc', trader: TRADER,
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

// ── getLegMidAtBlock (per-leg impact mid; moved here from tokenPricing) ──
// RPC-dependent routing is exercised by the live redecompose-smoke step; here we
// test edge cases that don't require an RPC client.
describe('getLegMidAtBlock', () => {
	it('returns null for a univ4 leg without v4PoolId', async () => {
		const leg: Leg = {
			venue: '0x498581ff718922c3f8e6a244956af099b2652b2b',
			type: 'univ4',
			tokenIn: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b',
			tokenOut: '0x4200000000000000000000000000000000000006',
			amountInRaw: 1000n,
			amountOutRaw: 500n,
			// no v4PoolId
		};
		// Null client is fine — we expect an early return before any RPC call.
		const result = await getLegMidAtBlock(
			null as never,
			leg,
			100n,
			async () => 18,
		);
		expect(result).toBeNull();
	});

	// Fix round 4: a MISSING poolId must degrade to the SAME reference-pool
	// discovery an `unknown` leg gets, not a hard null. This is the id-408-class
	// regression: routeVenueScan only attaches infinityPoolId when exactly one
	// DISTINCT Infinity pool was seen among NON-ZERO-amount swaps
	// (collectInfinitySwaps skips no-op swaps), so a route whose only Infinity
	// Swap moved nothing — or a rescue whose pool key failed to resolve — types
	// the leg `pancake_infinity` with no poolId. Before this fix that produced a
	// hard null (WORSE than the `unknown` typing it replaced, which reached
	// discovery and got a real mid); now it degrades exactly like `unknown`.
	//
	// getPairMidAtBlock's discovery swallows a null/failing client's errors
	// internally (see the quickswapv4/hydrex test below for the same
	// constraint), so we can't spy the RPC call directly — count decimalsOf
	// calls instead, which discovery makes and `rfq`'s deliberate null does not.
	it('routes a pancake_infinity leg without infinityPoolId to pair-mid discovery, like unknown', async () => {
		const mk = (type: Leg['type']): Leg => ({
			venue: '0x238a358808379702088667322f80ac48bad5e6c4',
			type,
			tokenIn: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
			tokenOut: '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2',
			amountInRaw: 1000n,
			amountOutRaw: 1000n,
			// no infinityPoolId
		});
		const countDecimalsCalls = async (type: Leg['type']): Promise<number> => {
			let n = 0;
			await getLegMidAtBlock(null as never, mk(type), 100n, async () => {
				n++;
				return 6;
			}).catch(() => {});
			return n;
		};

		const infinity = await countDecimalsCalls('pancake_infinity');
		const unknown = await countDecimalsCalls('unknown');
		const rfq = await countDecimalsCalls('rfq'); // deliberately unpriced: no mid read

		expect(infinity).toBe(unknown); // handled exactly like the fallback venue
		expect(infinity).toBeGreaterThan(rfq); // and, unlike rfq, it DOES attempt a mid
	});

	// The complementary branch-reachability guard: WITH a poolId, the leg must
	// reach readInfinitySlot0 (an RPC read on the CLPoolManager) rather than
	// silently falling through to discovery or a hard null. Same spy-not-null
	// technique as the univ4 test above, so a guard checking the wrong field
	// (or a reordering that skips this branch entirely) is caught by the call
	// count, not just by the final result's null-ness.
	it('reaches readInfinitySlot0 (an RPC call) for a pancake_infinity leg WITH infinityPoolId', async () => {
		const leg: Leg = {
			venue: '0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b',
			type: 'pancake_infinity',
			tokenIn: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b',
			tokenOut: '0x4200000000000000000000000000000000000006',
			amountInRaw: 1000n,
			amountOutRaw: 500n,
			infinityPoolId: '0xf6e81e5d16a7274d273905e0068f9f607b840c20bec23b2e442976ee03b29d91',
		};
		const readContract = vi.fn(async (args: { functionName: string }) => {
			expect(args.functionName).toBe('getSlot0');
			return [79228162514264337593543950336n]; // Q96 == price 1
		});
		const spyClient = { readContract } as never;
		const result = await getLegMidAtBlock(
			spyClient,
			leg,
			100n,
			async () => 18,
		);
		expect(result).not.toBeNull();
		expect(readContract).toHaveBeenCalledTimes(1);
	});

	// QuickSwap v4 is Algebra Integral: like Hydrex, its own mid isn't read by a
	// V3 slot0() call, so it must route to factory-discovery for a reference mid
	// rather than falling through to a hardcoded null (which would null its price
	// impact). We can't watch the RPC (discovery swallows client errors), but the
	// discovery path calls decimalsOf more than the null fall-through, so counting
	// those calls ties quickswapv4 to hydrex's handling without needing a client.
	it('routes a quickswapv4 leg to pair-mid discovery, like hydrex', async () => {
		const mk = (type: Leg['type']): Leg => ({
			venue: '0xd30b9fa98713425c0302593d7f8f094be31e9710',
			type,
			tokenIn: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
			tokenOut: '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2',
			amountInRaw: 1000n,
			amountOutRaw: 1000n,
		});
		const countDecimalsCalls = async (type: Leg['type']): Promise<number> => {
			let n = 0;
			await getLegMidAtBlock(null as never, mk(type), 100n, async () => {
				n++;
				return 6;
			}).catch(() => {});
			return n;
		};

		const quickswap = await countDecimalsCalls('quickswapv4');
		const hydrex = await countDecimalsCalls('hydrex');
		const rfq = await countDecimalsCalls('rfq'); // deliberately unpriced: no mid read

		expect(quickswap).toBe(hydrex); // handled exactly like the other Algebra venue
		expect(quickswap).toBeGreaterThan(rfq); // and, unlike rfq, it DOES attempt a mid
	});
});

// ─── id 56 (CLAWD→USDC): V4 multi-pool extraction ───
//
// Real on-chain route (decoded from the id56-trace.json fixture, captured via
// debug_traceTransaction/callTracer against the id-56 tx): the router
// (0x7c13…61da, denylisted) splits the trader's CLAWD three ways —
//   1. CLAWD → [V4 pool 0xcb987d4a…, fee 10000] → 0xcbb7c000… → [pancakev3
//      0xb94b2233…] → USDC
//   2. CLAWD → [univ3 0xcd55381a…] → WETH → [pancakev3 0x72ab388e…] → USDC
//   3. CLAWD → [V4 pool 0xca5e723b…, fee 10000] → native ETH →
//      [V4 pool 0x96d4b53a…, fee 500] → USDC
// converging on USDC. Legs 1 and 3 both route through the V4 PoolManager,
// which nets 3 distinct ERC-20 tokens (CLAWD in, 0xcbb7c000 out, USDC out) —
// too many for the address-derived leg builder, which requires exactly one
// net-received and one net-sent token per venue. Only the Swap-event-derived
// legs (this task's wiring) resolve pools 1 and 3; pool 2's hop (univ3 +
// pancakev3) was already reconstructable from address deltas alone.
const ID56_POOLKEYS: Record<string, { currency0: string; currency1: string }> = {
	'0xcb987d4a5945cb45ca4c0742534c25ed2948ca5933acb1b797c3b58e4347cc9d': {
		currency0: '0x9f86db9fc6f7c9408e8fda3ff8ce4e78ac7a6b07', // CLAWD
		currency1: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', // hub token
	},
	'0xca5e723ba63508f727692aa9bfd89345400786aae7f50859a4f4b1e9f0a5ccc7': {
		currency0: '0x0000000000000000000000000000000000000000', // native ETH
		currency1: '0x9f86db9fc6f7c9408e8fda3ff8ce4e78ac7a6b07', // CLAWD
	},
	'0x96d4b53a38337a5733179751781178a2613306063c511b78cd02684739288c0a': {
		currency0: '0x0000000000000000000000000000000000000000', // native ETH
		currency1: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
	},
};

// Real trade facts (id 56, tx 0xbc853779e6c5f846a08917a1afc710e17181fd0a31983723e15080497f63fe54,
// block 46842721). `realizedPrice` is USDC-per-WETH (per DecomposeTradeInput's
// contract), NOT this trade's own CLAWD/USDC price — derived here from the
// univ3→pancakev3 leg's own WETH/USDC exchange (772417861686564053 wei WETH
// for 1447.207766 USDC) since that leg is priced in the same block.
const ID56_INPUT: DecomposeTradeInput = {
	trace: id56Trace as any,
	txHash: '0xbc853779e6c5f846a08917a1afc710e17181fd0a31983723e15080497f63fe54',
	trader: '0x73f0859f844f042cd699f35bb5fe13a120f95c0f',
	allInCostBps: 283.77836898779145,
	notionalUsdc: 1841.048249,
	realizedPrice: 1873.6073280853982,
	gasCostUsd: 0.008142799535811063,
	aggregator: 'Fabric',
	blockNumber: 46842721n,
	rpcUrl: 'unused',
	dustUsdc: 1e-6,
	structuralFloorUsd: 0,
	structuralFloorBps: 0.5,
	recognizeV3Forks: true,
	impureOnVenueThirdToken: true,
};

describe('decomposeRoute V4 multi-pool extraction (id 56)', () => {
	it('reconstructs CLAWD→USDC once the V4 pool legs are synthesized', async () => {
		const v4PoolKeyReader = async (poolId: string) => ID56_POOLKEYS[poolId.toLowerCase()] ?? null;
		const result = await decomposeRoute(ID56_INPUT, {
			trace: id56Trace as any,
			feeReader: () => ({ bps: 100, defaulted: false }),
			rfqProbe: () => 'contract',
			v3FactoryReader: () => null,
			v4PoolKeyReader,
		});

		expect(result.routeShape).not.toBe('complex');
		expect(result.lpFeeBps).not.toBeNull();
		expect(result.slippageBps).not.toBeNull();
		expect(result.flags.some((f) => f.startsWith('V4_MULTIPOOL_LEGS'))).toBe(true);
	}, 15000);

	it('REJECTS the rescue when a pool key fails to resolve, rather than under-accounting', async () => {
		// `makeV4PoolKeyReader` never throws — a failed read returns null, and
		// synthesizeV4Legs then silently DROPS that swap. With 2 of 3 pools resolved
		// the `>1 distinct poolId` gate still trips, so the collapsed leg carrying
		// the FULL flow would be replaced by legs carrying only part of it.
		//
		// `reconstructed` cannot catch this: reconstructDag checks intermediate
		// conservation and that the output token receives something, never endpoint
		// totals. Only the explicit shortfall guard does.
		const firstPoolId = Object.keys(ID56_POOLKEYS)[0]!;
		const partialReader = async (poolId: string) =>
			poolId.toLowerCase() === firstPoolId ? null : (ID56_POOLKEYS[poolId.toLowerCase()] ?? null);
		const result = await decomposeRoute(ID56_INPUT, {
			trace: id56Trace as any,
			feeReader: () => ({ bps: 100, defaulted: false }),
			rfqProbe: () => 'contract',
			v3FactoryReader: () => null,
			v4PoolKeyReader: partialReader,
		});

		// The partial rescue is refused and says so, rather than silently shipping a
		// route that chains but under-accounts.
		expect(result.flags.some((f) => f.startsWith('V4_RESCUE_REJECTED'))).toBe(true);
		expect(result.flags.some((f) => f.startsWith('V4_MULTIPOOL_LEGS'))).toBe(false);
	}, 15000);
});

// ─── Fix-round-3 regression: adoptedExtraLegs carry-forward, decoupled from `changed` ───
//
// Guards two things that only `decomposeRoute` itself (not `buildRouteGraph`
// in isolation) can prove:
//   (A) a V4 rescue's synthesized legs actually reach a SUBSEQUENT Infinity
//       rescue's merge, via decomposeRoute's own `adoptedExtraLegs` wiring —
//       not just that buildRouteGraph merges a hand-built combined array
//       correctly (routeGraph.test.ts already covers that).
//   (B) the specific shape that breaks a `changed`-leg-count-based
//       carry-forward: TWO DISTINCT univ4-typed emitters with ONE pool each
//       (a real shape — id 445 has a second contract emitting the V4 Swap
//       topic, `0x60b393a76cea4a3afff00e1fb08d0f63a8f4a314`, reused as the
//       fixture's second emitter below). Each emitter's own collapsed leg is
//       individually clean, so the V4 merge drops 2 collapsed legs and adds 2
//       extras — net leg COUNT unchanged, `changed` false — even though the
//       leg SET did change. A `changed`-gated carry-forward misses this.
describe('decomposeRoute: adopted V4 legs survive a subsequent Infinity rescue (two V4 emitters, one pool each)', () => {
	const syntheticTrader = '0x00000000000000000000000000000000000000d0' as `0x${string}`;
	// The real V4 PoolManager singleton (decomposeRoute.ts's own UNISWAP_V4_POOL_MANAGER constant).
	const pmA = '0x498581ff718922c3f8e6a244956af099b2652b2b' as `0x${string}`;
	// A SECOND, distinct contract emitting the V4 Swap topic — the real fork address found in id 445.
	const pmB = '0x60b393a76cea4a3afff00e1fb08d0f63a8f4a314' as `0x${string}`;
	const vault = '0x238a358808379702088667322f80ac48bad5e6c4' as `0x${string}`;
	const HUB = '0xcccccccccccccccccccccccccccccccccccccccc' as `0x${string}`;

	const v4PoolAId = `0x${'aa'.repeat(32)}`;
	const v4PoolBId = `0x${'bb'.repeat(32)}`;
	const infPoolCId = `0x${'cc'.repeat(32)}`;
	const infPoolDId = `0x${'dd'.repeat(32)}`;

	const V4_SWAP_TOPIC = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f' as `0x${string}`;
	const ZERO_TOPIC = `0x${'0'.repeat(64)}` as `0x${string}`;
	const word = (v: bigint) => (v < 0n ? (2n ** 256n + v) : v).toString(16).padStart(64, '0');

	/** V4 Swap log: amount0/1, sqrtPriceX96, liquidity(0), tick(0), fee — 6 words. */
	function v4SwapLog(emitter: `0x${string}`, poolId: string, amount0: bigint, amount1: bigint, fee: bigint) {
		return {
			address: emitter,
			topics: [V4_SWAP_TOPIC, poolId, ZERO_TOPIC] as unknown as readonly `0x${string}`[],
			data: `0x${word(amount0)}${word(amount1)}${word(12345678n)}${word(0n)}${word(0n)}${word(fee)}` as `0x${string}`,
		};
	}
	/** Infinity Swap log: amount0/1, sqrtPriceX96, liquidity(0), tick(0), fee, protocolFee — 7 words. */
	function infSwapLog(poolId: string, amount0: bigint, amount1: bigint, fee: bigint, protocolFee: bigint) {
		return {
			address: '0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b' as `0x${string}`, // CLPoolManager; filtered by topic, not address
			topics: [INFINITY_SWAP_TOPIC as `0x${string}`, poolId as `0x${string}`, ZERO_TOPIC] as unknown as readonly `0x${string}`[],
			data: `0x${word(amount0)}${word(amount1)}${word(12345678n)}${word(0n)}${word(0n)}${word(fee)}${word(protocolFee)}` as `0x${string}`,
		};
	}

	// USDC →(pmA, 1 pool)→ HUB, USDC →(pmB, 1 pool)→ HUB, HUB →(Vault, 2 pools)→ WETH.
	// Each V4 emitter is individually a clean 1-in/1-out address-derived leg —
	// the multi-EMITTER collapse-and-replace only shows up once BOTH pools are
	// counted together (extraPoolIds), not from either emitter alone.
	const syntheticTrace = {
		from: syntheticTrader,
		to: '0xdddddddddddddddddddddddddddddddddddddddd' as `0x${string}`,
		input: '0x' as `0x${string}`,
		logs: [
			v4SwapLog(pmA, v4PoolAId, -600_000n, 600_000000000000000000n, 3000n),
			v4SwapLog(pmB, v4PoolBId, -400_000n, 400_000000000000000000n, 3000n),
			infSwapLog(infPoolCId, -600_000000000000000000n, 600_000000000n, 70n, 23n),
			infSwapLog(infPoolDId, -400_000000000000000000n, 400_000000000n, 70n, 23n),
			transferLog(USDC as `0x${string}`, syntheticTrader, pmA, 600_000n),
			transferLog(HUB, pmA, vault, 600_000000000000000000n),
			transferLog(USDC as `0x${string}`, syntheticTrader, pmB, 400_000n),
			transferLog(HUB, pmB, vault, 400_000000000000000000n),
			transferLog(WETH as `0x${string}`, vault, syntheticTrader, 1_000000000000n),
		],
		calls: [],
	};

	const input: DecomposeTradeInput = {
		trace: syntheticTrace as any,
		txHash: '0x0000000000000000000000000000000000000000000000000000000000000001',
		trader: syntheticTrader,
		allInCostBps: 5.0,
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

	const v4PoolKeyReader = async (poolId: string) => {
		const m: Record<string, { currency0: string; currency1: string }> = {
			[v4PoolAId]: { currency0: USDC, currency1: HUB },
			[v4PoolBId]: { currency0: USDC, currency1: HUB },
		};
		return m[poolId.toLowerCase()] ?? null;
	};
	const infinityPoolKeyReader = async (poolId: string) => {
		const m: Record<string, { currency0: string; currency1: string }> = {
			[infPoolCId]: { currency0: HUB, currency1: WETH },
			[infPoolDId]: { currency0: HUB, currency1: WETH },
		};
		return m[poolId.toLowerCase()] ?? null;
	};

	it('keeps the synthesized V4 per-pool legs (v4:<poolId>) after the Infinity rescue adopts', async () => {
		const result = await decomposeRoute(input, {
			trace: syntheticTrace as any,
			feeReader: () => ({ bps: 30, defaulted: false }),
			rfqProbe: () => 'contract',
			v3FactoryReader: () => null,
			v4PoolKeyReader,
			infinityPoolKeyReader,
		});

		// Both V4 emitters' synthesized per-pool legs are present — NOT their
		// naive per-emitter addresses. Fails if `adoptedExtraLegs` was not
		// carried into the Infinity rescue's buildRouteGraph call.
		expect(result.legs.some((l) => l.leg.venue === `v4:${v4PoolAId}`)).toBe(true);
		expect(result.legs.some((l) => l.leg.venue === `v4:${v4PoolBId}`)).toBe(true);
		expect(result.legs.some((l) => l.leg.venue === pmA)).toBe(false);
		expect(result.legs.some((l) => l.leg.venue === pmB)).toBe(false);
		// And both Infinity per-pool legs are present too.
		expect(result.legs.some((l) => l.leg.venue === `inf:${infPoolCId}`)).toBe(true);
		expect(result.legs.some((l) => l.leg.venue === `inf:${infPoolDId}`)).toBe(true);
		expect(result.legs).toHaveLength(4);
	}, 15000);
});

// ─── Fix-round-4: the single-pool IN-PLACE path (what the success criteria
// actually measure) had no decomposeRoute-level coverage at all — everything
// added through round 3 exercised pure units or the 2+-pool rescue. This
// guards three load-bearing lines a mutation-tester found uncovered:
//   - routeGraph.ts:235 `if (knownVenue.infinityPoolId) leg.infinityPoolId = …`
//   - decomposeRoute.ts `leg.v4FeeRaw ?? leg.infinityFeeRaw` (feeReader call)
//   - routeGraph.ts:557 `|| l.type === 'pancake_infinity'` in existingUniv4Pairs
describe('decomposeRoute: single-pool Infinity leg prices in place (no rescue)', () => {
	const syntheticTrader = '0x00000000000000000000000000000000000000d0' as `0x${string}`;
	const vault = '0x238a358808379702088667322f80ac48bad5e6c4' as `0x${string}`;
	const infPoolId = `0x${'ee'.repeat(32)}`;
	const word = (v: bigint) => (v < 0n ? (2n ** 256n + v) : v).toString(16).padStart(64, '0');

	function infSwapLog(poolId: string, amount0: bigint, amount1: bigint, fee: bigint, protocolFee: bigint) {
		return {
			address: '0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b' as `0x${string}`,
			topics: [INFINITY_SWAP_TOPIC as `0x${string}`, poolId as `0x${string}`, `0x${'0'.repeat(64)}` as `0x${string}`] as unknown as readonly `0x${string}`[],
			data: `0x${word(amount0)}${word(amount1)}${word(12345678n)}${word(0n)}${word(0n)}${word(fee)}${word(protocolFee)}` as `0x${string}`,
		};
	}

	// USDC → vault (single Infinity pool) → WETH. Already reconstructs from
	// address deltas alone (one clean 1-in/1-out leg) — no rescue should fire,
	// so this exercises routeVenueScan's single-pool in-place identity
	// attachment, not synthesizeInfinityLegs.
	const syntheticTrace = {
		from: syntheticTrader,
		to: '0xffffffffffffffffffffffffffffffffffffffff' as `0x${string}`,
		input: '0x' as `0x${string}`,
		logs: [
			infSwapLog(infPoolId, -12_071196n, 6481675202184746n, 70n, 23n), // swapFee=70, protocolFee=23 → lpFee≈47.001 pips ≈ 0.47001 bps (id 408's real values)
			transferLog(USDC as `0x${string}`, syntheticTrader, vault, 12_071196n),
			transferLog(WETH as `0x${string}`, vault, syntheticTrader, 6481675202184746n),
		],
		calls: [],
	};

	const input: DecomposeTradeInput = {
		trace: syntheticTrace as any,
		txHash: '0x0000000000000000000000000000000000000000000000000000000000000002',
		trader: syntheticTrader,
		allInCostBps: 11.0,
		notionalUsdc: 12.071196,
		realizedPrice: 1862.36,
		gasCostUsd: 0.01,
		aggregator: 'Unknown',
		blockNumber: 100n,
		rpcUrl: 'unused',
		dustUsdc: 1e-6,
		structuralFloorUsd: 0,
		structuralFloorBps: 0.5,
	};

	it('types the vault leg pancake_infinity, resolves ≈0.47 bps fee, and prices it via an injected midReader', async () => {
		const result = await decomposeRoute(input, {
			trace: syntheticTrace as any,
			// Mirrors createDefaultFeeReader's pancake_infinity/univ4 case: the fee
			// rides the leg's feeRawPips (v4FeeRaw ?? infinityFeeRaw at the call
			// site), not an RPC read.
			feeReader: async (_addr, _type, feeRawPips) =>
				feeRawPips !== undefined ? { bps: feeRawPips / 100, defaulted: false } : { bps: 0, defaulted: true },
			// price is tokenOut(WETH)-per-tokenIn(USDC), a slight markup on the
			// leg's own realized price (≈0.00053695) — a small, plausible cost.
			// Conditioned on `leg.infinityPoolId` (not just `leg.type`), matching
			// the REAL getLegMidAtBlock's own guard (routeReaders.ts): a leg that
			// reaches here without its poolId copied on is exactly the
			// routeGraph.ts:235 regression this test exists to catch, and a stub
			// keyed on type alone would not notice the field went missing.
			midReader: async (leg) =>
				leg.type === 'pancake_infinity' && leg.infinityPoolId
					? { price: 0.0005374908068253493, poolAddress: 'stub', poolKind: 'pancake_infinity' }
					: null,
		});

		expect(result.legs).toHaveLength(1);
		const leg = result.legs[0]!;
		expect(leg.leg.type).toBe('pancake_infinity');
		expect(leg.leg.venue).toBe(vault); // priced IN PLACE — no rescue, no `inf:` leg (round-1 adjudication)
		expect(leg.feeTierBps).toBeCloseTo(0.47001, 3);
		expect(leg.feeResolved).not.toBe(false);
		expect(leg.priceImpactBps).not.toBeNull();
	}, 15000);
});

// The single-pool-in-place fixture above never passes extraLegs into
// buildRouteGraph at all (no rescue fires), so it cannot exercise
// existingUniv4Pairs's type test (routeGraph.ts:557) — Finding 1's "second
// shape": two or more distinct Infinity pools where one pool key fails to
// resolve. `shouldAttemptInfinityRescue`'s pool-count check uses RAW swap
// events (collectInfinitySwaps, unaffected by key-resolution), so it still
// fires; but synthesizeInfinityLegs DROPS the unresolved swap, leaving
// exactly ONE synthesized extra — so `extraPoolIds.size` is 1 (not >1), the
// ADDRESS-based drop never fires, and the vault's original (type-only, no
// poolId — 2 distinct pools were observed, so routeVenueScan never attached
// one) collapsed leg survives untouched. Only the PAIR-based dedup
// (existingUniv4Pairs) stands between that survivor and the lone extra
// double-counting the same flow.
describe('decomposeRoute: a single surviving Infinity extra is de-duped against its own un-dropped collapsed leg', () => {
	const syntheticTrader = '0x00000000000000000000000000000000000000d0' as `0x${string}`;
	const vault = '0x238a358808379702088667322f80ac48bad5e6c4' as `0x${string}`;
	const infPoolGood = `0x${'11'.repeat(32)}`;
	const infPoolBad = `0x${'22'.repeat(32)}`;
	const word = (v: bigint) => (v < 0n ? (2n ** 256n + v) : v).toString(16).padStart(64, '0');

	function infSwapLog(poolId: string, amount0: bigint, amount1: bigint, fee: bigint, protocolFee: bigint) {
		return {
			address: '0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b' as `0x${string}`,
			topics: [INFINITY_SWAP_TOPIC as `0x${string}`, poolId as `0x${string}`, `0x${'0'.repeat(64)}` as `0x${string}`] as unknown as readonly `0x${string}`[],
			data: `0x${word(amount0)}${word(amount1)}${word(12345678n)}${word(0n)}${word(0n)}${word(fee)}${word(protocolFee)}` as `0x${string}`,
		};
	}

	// Two distinct Infinity Swap logs (routeVenueScan sees 2 distinct pools ⇒
	// the vault stays type-only), but the address-derived flow itself is a
	// single clean USDC→vault→WETH hop, exactly like the in-place fixture
	// above — only the SWAP LOGS claim two pools, not the transfers.
	const syntheticTrace = {
		from: syntheticTrader,
		to: '0xffffffffffffffffffffffffffffffffffffffff' as `0x${string}`,
		input: '0x' as `0x${string}`,
		logs: [
			infSwapLog(infPoolGood, -12_071196n, 6481675202184746n, 70n, 23n),
			infSwapLog(infPoolBad, -1n, 1n, 70n, 23n),
			transferLog(USDC as `0x${string}`, syntheticTrader, vault, 12_071196n),
			transferLog(WETH as `0x${string}`, vault, syntheticTrader, 6481675202184746n),
		],
		calls: [],
	};

	const input: DecomposeTradeInput = {
		trace: syntheticTrace as any,
		txHash: '0x0000000000000000000000000000000000000000000000000000000000000003',
		trader: syntheticTrader,
		allInCostBps: 11.0,
		notionalUsdc: 12.071196,
		realizedPrice: 1862.36,
		gasCostUsd: 0.01,
		aggregator: 'Unknown',
		blockNumber: 100n,
		rpcUrl: 'unused',
		dustUsdc: 1e-6,
		structuralFloorUsd: 0,
		structuralFloorBps: 0.5,
	};

	it('keeps exactly one leg for the flow — the extra is deduped, not stacked alongside the untouched collapsed leg', async () => {
		const result = await decomposeRoute(input, {
			trace: syntheticTrace as any,
			// Only infPoolGood resolves; infPoolBad's swap is dropped by
			// synthesizeInfinityLegs, so exactly one extra reaches buildRouteGraph.
			infinityPoolKeyReader: async (poolId: string) =>
				poolId.toLowerCase() === infPoolGood ? { currency0: USDC, currency1: WETH } : null,
		});

		expect(result.legs).toHaveLength(1);
	}, 15000);
});

// Which leg types count as LP-side decides whose retained value gets dropped from
// the Third-Party Fee row. Verified against the corpus 2026-08-01: dropping pools
// zeroed receipt 173's bogus 93.51bps, while all seven receipts whose sink IS an
// RFQ maker (36, 53, 118, 189, 208, 210, 324) were left untouched.
describe('POOL_VENUE_TYPES', () => {
	it('excludes rfq — a maker spread is a third-party fee, not an L.P. fee', () => {
		expect(POOL_VENUE_TYPES.has('rfq')).toBe(false);
	});

	it('excludes wrap/unwrap and unknown — not established as pools', () => {
		expect(POOL_VENUE_TYPES.has('wrap')).toBe(false);
		expect(POOL_VENUE_TYPES.has('unwrap')).toBe(false);
		expect(POOL_VENUE_TYPES.has('unknown')).toBe(false);
	});

	it('includes the AMM families whose retained value is an L.P. fee', () => {
		for (const t of ['aerodrome', 'aerodrome_cl', 'curve_stableng', 'univ3', 'univ4', 'univ2'] as const) {
			expect(POOL_VENUE_TYPES.has(t)).toBe(true);
		}
	});
});

describe('buildFeeSinks', () => {
	it('sorts dominant-first and splits aggFeeBps proportionally', () => {
		const sinks: FeeSink[] = [
			{ address: '0xsmall', usdcRetained: 1, wethRetained: 0, totalUsdc: 1, source: 'retained_balance' },
			{ address: '0xbig', usdcRetained: 3, wethRetained: 0, totalUsdc: 3, source: 'retained_balance' },
		];
		const out = buildFeeSinks(sinks, 20); // aggFeeBps = 20
		expect(out.map(s => s.address)).toEqual(['0xbig', '0xsmall']);
		expect(out[0]!.feeBps).toBeCloseTo(15, 6);
		expect(out[1]!.feeBps).toBeCloseTo(5, 6);
		expect(out.reduce((a, s) => a + s.feeBps, 0)).toBeCloseTo(20, 6);
		expect(out[0]!.source).toBe('retained_balance');
	});

	it('returns [] for no sinks', () => {
		expect(buildFeeSinks([], 0)).toEqual([]);
	});

	it('splits evenly when total retained is zero', () => {
		const sinks: FeeSink[] = [
			{ address: '0xa', usdcRetained: 0, wethRetained: 0, totalUsdc: 0, source: 'vault_map' },
			{ address: '0xb', usdcRetained: 0, wethRetained: 0, totalUsdc: 0, source: 'vault_map' },
		];
		const out = buildFeeSinks(sinks, 10);
		expect(out).toHaveLength(2);
		expect(out[0]!.feeBps).toBeCloseTo(5, 6);
	});
});

describe('feeOnTransferFlag', () => {
  const SWARM = '0xea871696 99dabd028a78d4b91544b4298086baf6'.replace(/ /g, '');
  const USDC_ADDR = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

  it('names a plausible token tax as FEE_ON_TRANSFER', () => {
    // Receipt id 219, verified on-chain: the VIRTUAL/SWARM pool routes exactly
    // 1.00% of its SWARM output (472.57 of 47,257) to the token's own address.
    // A real transfer tax.
    expect(feeOnTransferFlag(SWARM, 99)).toMatch(/^FEE_ON_TRANSFER: /);
    expect(feeOnTransferFlag(SWARM, 99)).toContain('0.99%');
  });

  it('refuses to call an anchor token fee-on-transfer', () => {
    // Receipt id 442 claimed USDC "loses ~99.49% between hops". USDC does not
    // tax transfers; only 36% of that route's notional was captured in legs, so
    // the intermediate simply does not balance. Naming a cause we have not
    // established is the defect.
    const f = feeOnTransferFlag(USDC_ADDR, 9949);
    expect(f).toMatch(/^UNBALANCED_INTERMEDIATE: /);
    expect(f).not.toContain('FEE_ON_TRANSFER');
  });

  it('refuses an implausibly large gap even on an unknown token', () => {
    // No tradeable token taxes 80% — a router's slippage check would reject it.
    // A gap that size means legs are missing, whatever the token is.
    expect(feeOnTransferFlag(SWARM, 8000)).toMatch(/^UNBALANCED_INTERMEDIATE: /);
  });

  it('accepts a steep but real tax on a non-anchor token', () => {
    // Extreme memecoin taxes reach the low tens of percent. 10% must still read
    // as a tax, or the honest cases get relabelled with the dishonest ones.
    expect(feeOnTransferFlag(SWARM, 1000)).toMatch(/^FEE_ON_TRANSFER: /);
  });

  it('says LP/slippage is not separable either way', () => {
    // The user-facing conclusion is identical; only the claimed CAUSE differs.
    for (const f of [feeOnTransferFlag(SWARM, 99), feeOnTransferFlag(USDC_ADDR, 9949)]) {
      expect(f).toContain('LP/slippage not separable');
    }
  });
});

/**
 * Per-leg RPC in decomposeRoute used to run one leg at a time across four
 * separate loops. Against the production endpoint that made a 10-leg trade's
 * decomposition ~4.9s of almost pure round-trip latency, with zero overlap.
 */
describe('per-leg reader fan-out', () => {
  const P1 = '0x00000000000000000000000000000000000000f1' as `0x${string}`;
  const P2 = '0x00000000000000000000000000000000000000f2' as `0x${string}`;
  const P3 = '0x00000000000000000000000000000000000000f3' as `0x${string}`;
  const TOK = '0x00000000000000000000000000000000000000e1' as `0x${string}`;
  const OUT = '0x00000000000000000000000000000000000000e2' as `0x${string}`;
  const TR = '0x00000000000000000000000000000000000000c1' as `0x${string}`;

  /** USDC -> WETH -> TOK -> OUT across three v3 pools. */
  const threeHopTrace = {
    logs: [
      transferLog(USDC as `0x${string}`, TR, P1, 1_000000n),
      transferLog(WETH as `0x${string}`, P1, P2, 500_000000000000n),
      transferLog(TOK, P2, P3, 700_000000000000n),
      transferLog(OUT, P3, TR, 900_000000000000n),
      v3SwapLog(P1), v3SwapLog(P2), v3SwapLog(P3),
    ],
  };

  const threeHopInput = (): DecomposeTradeInput => ({
    trace: threeHopTrace as any,
    txHash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    trader: TR, allInCostBps: -1, notionalUsdc: 1, realizedPrice: 2000, gasCostUsd: 0,
    aggregator: 'Fabric', blockNumber: 47379575n, rpcUrl: 'unused', dustUsdc: 1e-6,
    structuralFloorUsd: 0, structuralFloorBps: 0.5,
    recognizeV3Forks: true, impureOnVenueThirdToken: true,
  });

  function probe() {
    let inFlight = 0;
    let peak = 0;
    const order: string[] = [];
    const gate = async <T>(tag: string, value: T): Promise<T> => {
      order.push(tag);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return value;
    };
    return { gate, peak: () => peak, order: () => order };
  }

  it('resolves every leg’s fee tier concurrently', async () => {
    const p = probe();
    const result = await decomposeRoute(threeHopInput(), {
      trace: threeHopTrace as any,
      feeReader: async (addr) => p.gate(addr, { bps: 1, defaulted: false }),
    });

    expect(result.legs.length).toBeGreaterThan(1);
    expect(p.peak()).toBeGreaterThan(1);
  });

  it('reads every leg’s reference mid concurrently', async () => {
    const p = probe();
    await decomposeRoute(threeHopInput(), {
      trace: threeHopTrace as any,
      feeReader: async () => ({ bps: 1, defaulted: false }),
      midReader: async (leg) => p.gate(leg.venue, { price: 1, poolAddress: leg.venue, poolKind: 'univ3' }),
      decimalsReader: async () => 18,
    });

    expect(p.peak()).toBeGreaterThan(1);
  });

  it('keeps legs in route order regardless of which reader resolves first', async () => {
    // Leg order is the receipt's route order and feeds notional weighting, so it
    // must not follow RPC completion.
    const delays: Record<string, number> = { [P1]: 20, [P2]: 10, [P3]: 1 };
    const result = await decomposeRoute(threeHopInput(), {
      trace: threeHopTrace as any,
      feeReader: async (addr) => {
        await new Promise((r) => setTimeout(r, delays[addr.toLowerCase()] ?? 1));
        return { bps: 1, defaulted: false };
      },
    });

    const venues = result.legs.map((l) => l.leg.venue.toLowerCase());
    expect(venues).toEqual([P1, P2, P3]);
  });

  it('never asks for a mid on an rfq leg, even when legs are read in parallel', async () => {
    // RFQ fills are quoted off-chain; a null here is deliberate, not a failure.
    const asked: string[] = [];
    // P2 carries no v3 Swap log, so it stays `unknown` and is eligible for the
    // rfq retype the probe below performs.
    const trace = { logs: threeHopTrace.logs.filter((l) => !(l.address === P2 && l.topics.length === 3 && l.topics[1] === '0x' + '0'.repeat(64))) };
    await decomposeRoute({ ...threeHopInput(), trace: trace as any }, {
      trace: trace as any,
      feeReader: async () => ({ bps: 1, defaulted: false }),
      rfqProbe: async (addr) => (addr.toLowerCase() === P2 ? 'eoa' : 'contract'),
      midReader: async (leg) => {
        asked.push(leg.venue.toLowerCase());
        return { price: 1, poolAddress: leg.venue, poolKind: 'univ3' };
      },
      decimalsReader: async () => 18,
    });

    expect(asked).not.toContain(P2);
  });
});
