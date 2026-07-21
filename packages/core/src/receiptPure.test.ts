/**
 * Cross-check: the pure leaf (receiptPure.ts, imported by the dashboard's client
 * bundle) must never drift from the core originals (pricing/analyzeTransaction/
 * marketPrice, used server-side). If someone changes an anchor set or the
 * reconciliation formula in one place only, this fails.
 */
import { describe, expect, it } from 'vitest';
import { anchorsToUsd, baseIsOutputLeg, reconciledResult, isStable, isWeth, isNative } from './receiptPure.js';
import { anchorsToUsd as coreAnchorsToUsd } from './pricing.js';
import { baseIsOutputLeg as coreBaseIsOutputLeg } from './analyzeTransaction.js';
import { reconciledResult as coreReconciledResult } from './marketPrice.js';

const WETH = '0x4200000000000000000000000000000000000006';
const WBTC = '0x0555e30da8f98308edb960aa94c0db47230d2b9c';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const NATIVE = 'native';
const TKN = '0x1111111111111111111111111111111111111111';
const tokens = [WETH, WBTC, USDC, NATIVE, TKN, WETH.toUpperCase()];

describe('receiptPure matches the core originals (no drift)', () => {
  it('anchorsToUsd agrees with pricing.ts', () => {
    for (const t of tokens) expect(anchorsToUsd(t)).toBe(coreAnchorsToUsd(t));
  });

  it('baseIsOutputLeg agrees with analyzeTransaction.ts', () => {
    for (const a of tokens) for (const b of tokens) expect(baseIsOutputLeg(a, b)).toBe(coreBaseIsOutputLeg(a, b));
  });

  it('reconciledResult agrees with marketPrice.ts', () => {
    const cases = [
      { marketMid: 0.0285525, realizedPrice: 0.028625, notionalUsd: 1791.14 },
      { marketMid: 2, realizedPrice: 2.01, notionalUsd: 1000 },
      { marketMid: 100, realizedPrice: 90, notionalUsd: 500 },
    ];
    for (const c of cases) expect(reconciledResult(c)).toEqual(coreReconciledResult(c));
  });

  it('isStable/isWeth/isNative behave', () => {
    expect(isStable(USDC)).toBe(true);
    expect(isWeth(WETH)).toBe(true);
    expect(isNative(NATIVE)).toBe(true);
    expect(isStable(WETH)).toBe(false);
    expect(isWeth(USDC)).toBe(false);
  });
});
