/**
 * Behavior tests for the pure receipt leaf. These functions are the single source
 * of truth shared by the server modules (pricing/analyzeTransaction/marketPrice, which
 * import from here) and the dashboard (via the @fabric-tca/core/pure subpath).
 */
import { describe, expect, it } from 'vitest';
import {
  anchorsToUsd,
  baseIsOutputLeg,
  reconciledResult,
  isStable,
  isWeth,
  isNative,
  costedLegs,
  priceImpactCoverage,
  isFullyPriced,
} from './receiptPure.js';

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

describe('attribution coverage', () => {
  // wrap/unwrap legs are informational: they carry no notional and no price
  // impact, so counting them would drag every wrapped route's coverage down.
  const leg = (notionalUsdc: number, priceImpactBps: number | null, type = 'swap') =>
    ({ type, notionalUsdc, priceImpactBps });

  it('costedLegs drops wrap and unwrap, keeps everything else', () => {
    const legs = [leg(0, null, 'wrap'), leg(100, 1), leg(0, null, 'unwrap'), leg(50, null, 'rfq')];
    expect(costedLegs(legs).map((l) => l.type)).toEqual(['swap', 'rfq']);
  });

  it('priceImpactCoverage weights by notional, not by leg count', () => {
    // 1 of 2 legs priced, but that leg is 90% of the notional.
    const legs = [leg(900, 3.5), leg(100, null)];
    expect(priceImpactCoverage(legs)).toBeCloseTo(0.9, 12);
  });

  it('priceImpactCoverage matches the measured value for receipt id 210', () => {
    // Real row: 6 costed legs, 5 priced. Notional-weighted: 20754.93 / 26882.37
    // = 77.2065% (verified via `node -e`; the formula, not this number, is the spec).
    const legs = [
      leg(13094.06, 4.19), leg(3061.23, 2.11), leg(2044.98, 5.02),
      leg(1533.11, 3.90), leg(1021.55, 4.15), leg(6127.44, null),
    ];
    const cov = priceImpactCoverage(legs)!;
    expect(Math.floor(100 * cov)).toBe(77);
  });

  it('priceImpactCoverage excludes wrap/unwrap from the denominator', () => {
    // Without the exclusion this would be 100/(100+0) = 1 anyway; the point is
    // that an unpriced wrap leg must not make coverage < 1.
    expect(priceImpactCoverage([leg(0, null, 'wrap'), leg(100, 2)])).toBe(1);
  });

  it('priceImpactCoverage returns null when there is nothing to weigh', () => {
    expect(priceImpactCoverage([])).toBeNull();
    expect(priceImpactCoverage([leg(0, null, 'wrap')])).toBeNull();
    expect(priceImpactCoverage([leg(0, 1), leg(0, null)])).toBeNull(); // zero total notional
  });

  it('isFullyPriced is true only when every costed leg carries an impact', () => {
    expect(isFullyPriced([leg(100, 1), leg(50, 2)])).toBe(true);
    expect(isFullyPriced([leg(100, 1), leg(50, null)])).toBe(false);
    // wrap/unwrap are exempt — they are never priced and never should be.
    expect(isFullyPriced([leg(0, null, 'wrap'), leg(100, 1)])).toBe(true);
  });

  it('isFullyPriced is false on an empty route', () => {
    // A route we never decomposed priced 0% of itself. Vacuous truth here would
    // let a no-legs receipt keep printing a confident Slippage number.
    expect(isFullyPriced([])).toBe(false);
    expect(isFullyPriced([leg(0, null, 'wrap')])).toBe(false);
  });

  it('isFullyPriced disagrees with 100% coverage on a zero-notional unpriced leg', () => {
    // This is WHY they are two functions: the gate is leg-count, the percentage
    // is notional-weighted, and a $0 unpriced leg splits them.
    const legs = [leg(1000, 2), leg(0, null)];
    expect(priceImpactCoverage(legs)).toBe(1);
    expect(isFullyPriced(legs)).toBe(false);
  });
});
