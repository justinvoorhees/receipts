import { describe, expect, it } from 'vitest';
import { computeMarketPrice, type Estimator } from './marketPrice.js';
import { reconciledResult } from './marketPrice.js';

const direct = (price: number): Estimator => ({ price, class: 'direct', label: 'direct pool' });
const bridged = (price: number): Estimator => ({ price, class: 'bridged', label: 'WETH bridge' });
const oracle = (price: number): Estimator => ({ price, class: 'oracle', label: 'oracle ratio' });

describe('computeMarketPrice', () => {
  it('returns tier none when no estimators survive', () => {
    expect(computeMarketPrice([]).tier).toBe('none');
    expect(computeMarketPrice([direct(0)]).tier).toBe('none');
    expect(computeMarketPrice([direct(Number.NaN)]).marketMid).toBeNull();
  });

  it('returns estimated with a single class present', () => {
    const r = computeMarketPrice([direct(100)]);
    expect(r.tier).toBe('estimated');
    expect(r.marketMid).toBe(100);
    expect(r.corroboratedBy).toEqual(['direct']);
    expect(r.flags).toContain('SINGLE_CLASS');
  });

  it('medians multiple pools within one class before tiering', () => {
    const r = computeMarketPrice([direct(100), direct(102), direct(101)]);
    expect(r.tier).toBe('estimated'); // still one class
    expect(r.marketMid).toBe(101);
  });

  it('returns full when two classes agree within tolerance', () => {
    const r = computeMarketPrice([direct(100), bridged(100.2)]); // 20 bps apart
    expect(r.tier).toBe('full');
    expect(r.marketMid).toBeCloseTo(100.1, 6);
    expect(r.corroboratedBy.sort()).toEqual(['bridged', 'direct']);
    expect(r.flags).toEqual([]);
  });

  it('drops to estimated (direct wins) when classes disagree beyond tolerance', () => {
    const r = computeMarketPrice([direct(100), oracle(110)]); // 1000 bps apart
    expect(r.tier).toBe('estimated');
    expect(r.marketMid).toBe(100); // direct priority
    expect(r.flags).toContain('CROSS_CLASS_DISAGREE');
  });

  it('takes the agreeing subset when a third class is an outlier', () => {
    const r = computeMarketPrice([direct(100), bridged(100.3), oracle(140)]);
    expect(r.tier).toBe('full');
    expect(r.marketMid).toBeCloseTo(100.15, 6); // median of the two agreeing
    expect(r.corroboratedBy).not.toContain('oracle');
  });
});

describe('reconciledResult (single-ruler invariant)', () => {
  // Reference ETH->WBTC row: 1 ETH -> 0.028625 WBTC; Market Price 35.0232 ETH = 1 WBTC.
  const marketMid = 1 / 35.0232;        // WBTC per ETH (output per input)
  const realizedPrice = 0.028625 / 1;   // WBTC per ETH realized
  const notionalUsd = 1791.14;          // ETH side, anchor-grade

  it('Execution Result equals qualityBps/1e4 x notional (identity holds)', () => {
    const { execResultUsd, qualityBps } = reconciledResult({ marketMid, realizedPrice, notionalUsd });
    expect(execResultUsd).toBeCloseTo((qualityBps / 10_000) * notionalUsd, 9);
  });

  it('reference row reads a small positive result (~+$4.5, ~+25 bps)', () => {
    const { execResultUsd, qualityBps } = reconciledResult({ marketMid, realizedPrice, notionalUsd });
    expect(qualityBps).toBeGreaterThan(20);
    expect(qualityBps).toBeLessThan(30);
    expect(execResultUsd).toBeGreaterThan(4);
    expect(execResultUsd).toBeLessThan(5);
  });
});
