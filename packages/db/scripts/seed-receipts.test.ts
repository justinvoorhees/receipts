// packages/db/scripts/seed-receipts.test.ts
import { describe, it, expect } from 'vitest';
import { mapSmokeToReceipt } from './seed-receipts.js';

const base = {
  txHash: '0xabc', aggregator: 'odos', trader: '0xt', direction: 'buy_weth',
  settledIn: 'WETH', usdcAmount: '1000', wethAmount: '0.3', realizedPrice: '3333',
  marketMid: '3300', allInCostBps: '5', blockNumber: 30000000,
  lpFeeBps: '1', aggFeeBps: '2', slippageBps: '1', executionBps: '2', gasCostUsd: '0.01',
  routePure: true, routeShape: 'single', hopCount: 1, routeLegs: [], reconResidualBps: '0',
  decompConfidence: 'high', settlementEventName: null, settlementEventTopic0: null,
  settlementEventSeen: false, normalizeFlags: [], chainlinkPrice: null, chainlinkDevBps: null,
  poolDivergenceBps: null, manipulationFlag: false, offchainPrice: null, offchainDevBps: null,
  chainlinkStalenessSecs: null, loadedAt: new Date('2026-06-27T00:00:00Z'),
} as any;

describe('mapSmokeToReceipt', () => {
  it('maps a buy_weth smoke row to a generalized receipt', () => {
    const r = mapSmokeToReceipt(base);
    expect(r.inputSymbol).toBe('USDC');
    expect(r.outputSymbol).toBe('WETH');
    expect(r.inputAmount).toBe('1000');
    expect(r.outputAmount).toBe('0.3');
    expect(r.pricingStatus).toBe('full');
    expect(r.notionalUsd).toBe('1000');
  });
});
