/**
 * Behavior tests for the pure receipt leaf. These functions are the single source
 * of truth shared by the server modules (pricing/analyzeTransaction/marketPrice, which
 * import from here) and the dashboard (via the @fabric-tca/core/pure subpath).
 */
import { describe, expect, it } from 'vitest';
import { anchorsToUsd, baseIsOutputLeg, reconciledResult, isStable, isWeth, isNative } from './receiptPure.js';

const WETH = '0x4200000000000000000000000000000000000006';
const WBTC = '0x0555e30da8f98308edb960aa94c0db47230d2b9c';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const NATIVE = 'native';

describe('receiptPure', () => {
  it('anchorsToUsd: stables, WETH, native anchor; volatile does not (case-insensitive)', () => {
    expect(anchorsToUsd(USDC)).toBe(true);
    expect(anchorsToUsd(WETH)).toBe(true);
    expect(anchorsToUsd(NATIVE)).toBe(true);
    expect(anchorsToUsd(WBTC)).toBe(false);
    expect(anchorsToUsd(WETH.toUpperCase())).toBe(true);
  });

  it('baseIsOutputLeg: base is the weaker-anchored leg; ties → false', () => {
    expect(baseIsOutputLeg(WETH, WBTC)).toBe(true);  // buy WBTC → output is base
    expect(baseIsOutputLeg(WBTC, WETH)).toBe(false); // sell WBTC → input is base
    expect(baseIsOutputLeg(NATIVE, WBTC)).toBe(true);
    expect(baseIsOutputLeg(USDC, WETH)).toBe(true);  // stable in, WETH out → WETH is base
    expect(baseIsOutputLeg(WETH, WETH)).toBe(false); // tie
  });

  it('reconciledResult: execResult = notional × (realized/mid − 1); identity holds', () => {
    const r = reconciledResult({ marketMid: 0.0285525, realizedPrice: 0.028625, notionalUsd: 1791.14 });
    expect(r.execResultUsd).toBeCloseTo((r.qualityBps / 10_000) * 1791.14, 9);
    expect(r.execResultUsd).toBeGreaterThan(0); // realized > mid → surplus
  });

  it('isStable/isWeth/isNative', () => {
    expect(isStable(USDC)).toBe(true);
    expect(isWeth(WETH)).toBe(true);
    expect(isNative(NATIVE)).toBe(true);
    expect(isStable(WETH)).toBe(false);
    expect(isWeth(USDC)).toBe(false);
  });
});
