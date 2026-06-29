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
import { decomposeRoute } from './decomposeRoute.js';
import type { DecomposeTradeInput } from './decompose-trade.js';

// Load trace fixtures (avoid JSON import attribute issues with NodeNext)
const __dirname = dirname(fileURLToPath(import.meta.url));
const kyberB1Trace = JSON.parse(readFileSync(resolve(__dirname, '__fixtures__/kyber-b1-trace.json'), 'utf-8'));
const kyberB2Trace = JSON.parse(readFileSync(resolve(__dirname, '__fixtures__/kyber-b2-trace.json'), 'utf-8'));

const PANCAKE_POOL = '0x7cb770d0513c30e0cb45e4899e4a2cbeed6f9830';

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const UNI_V3_SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

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

const VIRTUAL = '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b';
const V4_POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b';

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

  it('tags known Curve StableNG pools instead of treating them as RFQ', async () => {
    const trader = '0x00000000000000000000000000000000000000d0';
    const curvePool = '0x4545410f7601b34a779edcebc641e529f465eeaa' as const;
    const trace = {
      logs: [
        transferLog(USDC as `0x${string}`, trader as `0x${string}`, curvePool, 1_000000n),
        transferLog(WETH as `0x${string}`, curvePool, trader as `0x${string}`, 500_000000000000n),
      ],
    };
    const input: DecomposeTradeInput = {
      trace: trace as any,
      txHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
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

    const result = await decomposeRoute(input, {
      trace: trace as any,
      feeReader: async (_addr, type) => ({ bps: type === 'curve_stableng' ? 10 : 0, defaulted: false }),
    });

    expect(result.legs).toHaveLength(1);
    expect(result.legs[0]!.leg.type).toBe('curve_stableng');
    expect(result.legs[0]!.feeTierBps).toBe(10);
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

      // Per-leg detail
      expect(result.legs).toHaveLength(2);
      // First leg: PancakeSwap V3 (USDC→VIRTUAL)
      const leg0 = result.legs[0]!;
      expect(leg0.leg.type).toBe('pancakev3');
      expect(leg0.feeTierBps).toBe(5);
      // Second leg: V4 (VIRTUAL→WETH)
      const leg1 = result.legs[1]!;
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

      // Each leg should now have priceImpactBps
      expect(result.legs).toHaveLength(2);
      const leg0 = result.legs[0]!;
      const leg1 = result.legs[1]!;
      expect(leg0.priceImpactBps).not.toBeNull();
      expect(leg1.priceImpactBps).not.toBeNull();

      // V4 leg amountInRaw must be the true on-chain value (not doubled)
      expect(leg1.leg.amountInRaw).toBeLessThan(4_000000000000000000n); // ~3.018 VIRTUAL, not ~6.035

      // Per-leg invariant: lpFeeBps + priceImpactBps ≈ leg total cost
      for (const leg of result.legs) {
        if (leg.priceImpactBps === null) continue;
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

      // Per-leg detail
      expect(result.legs).toHaveLength(2);
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

});
