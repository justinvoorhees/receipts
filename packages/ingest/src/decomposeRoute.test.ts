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
