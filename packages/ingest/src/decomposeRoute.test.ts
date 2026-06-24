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

describe('decomposeRoute', () => {
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
          if (addr === PANCAKE_POOL) return 5;
          // V4: fee from event / 100
          if (type === 'univ4' && v4FeeRaw !== undefined) return v4FeeRaw / 100;
          return 0;
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
          if (type === 'rfq') return 0;
          // V4: fee from event / 100 = 10000/100 = 100
          if (type === 'univ4' && v4FeeRaw !== undefined) return v4FeeRaw / 100;
          return 0;
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
});
