import { describe, expect, it } from 'vitest';
import { median, computeBenchmark } from './benchmarkPrice.js';

const P = (label: string, price: number | null) => ({ label, price });

describe('median', () => {
  it('odd count returns middle', () => expect(median([3000, 3010, 2990])).toBe(3000));
  it('even count averages two middle', () => expect(median([3000, 3010])).toBe(3005));
  it('throws on empty', () => expect(() => median([])).toThrow());
});

describe('computeBenchmark', () => {
  it('3 agreeing pools + close oracle → high confidence, no flags', () => {
    const r = computeBenchmark([P('a', 3000), P('b', 3001), P('c', 2999)], 3000);
    expect(r.marketMid).toBe(3000);
    expect(r.poolDivergenceBps).toBeCloseTo(6.67, 1);
    expect(r.manipulationSuspect).toBe(false);
    expect(r.lowConfidence).toBe(false);
    expect(r.flags).toEqual([]);
  });

  it('pool spread > 15 bps → POOL_DIVERGENCE + low confidence', () => {
    const r = computeBenchmark([P('a', 3000), P('b', 3010), P('c', 2990)], 3000);
    expect(r.flags).toContain('POOL_DIVERGENCE');
    expect(r.lowConfidence).toBe(true);
  });

  it('oracle deviation > 50 bps → MANIPULATION_SUSPECT + low confidence', () => {
    const r = computeBenchmark([P('a', 3000), P('b', 3001), P('c', 2999)], 2970);
    expect(r.manipulationSuspect).toBe(true);
    expect(r.chainlinkDevBps).toBeCloseTo(101.01, 1);
    expect(r.flags).toContain('MANIPULATION_SUSPECT');
    expect(r.lowConfidence).toBe(true);
  });

  it('only 1 valid pool → LOW_POOL_COVERAGE + low confidence, divergence 0', () => {
    const r = computeBenchmark([P('a', 3000), P('b', null), P('c', null)], 3000);
    expect(r.marketMid).toBe(3000);
    expect(r.poolDivergenceBps).toBe(0);
    expect(r.flags).toContain('LOW_POOL_COVERAGE');
    expect(r.lowConfidence).toBe(true);
  });

  it('0 valid pools → throws', () => {
    expect(() => computeBenchmark([P('a', null), P('b', null), P('c', null)], 3000)).toThrow();
  });

  it('chainlink unavailable → CHAINLINK_UNAVAILABLE, no manipulation, confidence unchanged by oracle', () => {
    const r = computeBenchmark([P('a', 3000), P('b', 3001), P('c', 2999)], null);
    expect(r.chainlinkDevBps).toBeNull();
    expect(r.manipulationSuspect).toBe(false);
    expect(r.flags).toContain('CHAINLINK_UNAVAILABLE');
    expect(r.lowConfidence).toBe(false);
  });
});
