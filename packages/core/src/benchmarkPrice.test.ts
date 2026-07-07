import { describe, expect, it } from 'vitest';
import { median, computeBenchmark } from './benchmarkPrice.js';

const P = (label: string, price: number | null) => ({ label, price });
const OK = (price: number, stale = false) => ({ price, stale });

describe('median', () => {
  it('odd count returns middle', () => expect(median([3000, 3010, 2990])).toBe(3000));
  it('even count averages two middle', () => expect(median([3000, 3010])).toBe(3005));
  it('throws on empty', () => expect(() => median([])).toThrow());
});

describe('computeBenchmark', () => {
  it('3 agreeing pools + close oracle → high confidence, no flags', () => {
    const r = computeBenchmark([P('a', 3000), P('b', 3001), P('c', 2999)], { chainlink: OK(3000), offChain: OK(3000) });
    expect(r.marketMid).toBe(3000);
    // median-relative: max(|3001-3000|,|2999-3000|)/3000 × 1e4 = 3.33
    expect(r.poolDivergenceBps).toBeCloseTo(3.33, 1);
    expect(r.manipulationSuspect).toBe(false);
    expect(r.lowConfidence).toBe(false);
    expect(r.flags).toEqual([]);
  });

  it('pool spread > 15 bps → POOL_DIVERGENCE + low confidence', () => {
    const r = computeBenchmark([P('a', 3000), P('b', 3010), P('c', 2990)], { chainlink: OK(3000), offChain: OK(3000) });
    expect(r.flags).toContain('POOL_DIVERGENCE');
    expect(r.lowConfidence).toBe(true);
  });

  it('only 1 valid pool → LOW_POOL_COVERAGE + low confidence, divergence 0', () => {
    const r = computeBenchmark([P('a', 3000), P('b', null), P('c', null)], { chainlink: OK(3000), offChain: OK(3000) });
    expect(r.marketMid).toBe(3000);
    expect(r.poolDivergenceBps).toBe(0);
    expect(r.flags).toContain('LOW_POOL_COVERAGE');
    expect(r.lowConfidence).toBe(true);
  });

  it('exactly 2 valid pools → half-spread divergence, no LOW_POOL_COVERAGE', () => {
    // median([3000,3030]) = 3015; |3000-3015|/3015 × 1e4 = 49.75
    const r = computeBenchmark([P('a', 3000), P('b', 3030), P('c', null)], { chainlink: OK(3015), offChain: OK(3015) });
    expect(r.marketMid).toBe(3015);
    expect(r.poolDivergenceBps).toBeCloseTo(49.75, 1);
    expect(r.flags).not.toContain('LOW_POOL_COVERAGE');
    expect(r.flags).toContain('POOL_DIVERGENCE');
  });

  it('0 valid pools → throws', () => {
    expect(() => computeBenchmark([P('a', null), P('b', null), P('c', null)], { chainlink: null, offChain: null })).toThrow();
  });

  it('both oracles agree, median far from consensus → MANIPULATION_SUSPECT', () => {
    const r = computeBenchmark([P('a', 3000), P('b', 3001), P('c', 2999)],
      { chainlink: OK(2970), offChain: OK(2971) });
    expect(r.manipulationSuspect).toBe(true);
    expect(r.flags).toContain('MANIPULATION_SUSPECT');
    expect(r.lowConfidence).toBe(true);
  });

  it('both oracles agree, median close → no manipulation', () => {
    const r = computeBenchmark([P('a', 3000), P('b', 3001), P('c', 2999)],
      { chainlink: OK(3002), offChain: OK(3003) });
    expect(r.manipulationSuspect).toBe(false);
    expect(r.flags).not.toContain('MANIPULATION_SUSPECT');
    expect(r.lowConfidence).toBe(false);
  });

  it('oracles disagree with each other → ORACLE_DISAGREE, no manipulation', () => {
    const r = computeBenchmark([P('a', 3000), P('b', 3001), P('c', 2999)],
      { chainlink: OK(3000), offChain: OK(2950) });
    expect(r.flags).toContain('ORACLE_DISAGREE');
    expect(r.manipulationSuspect).toBe(false);
    expect(r.lowConfidence).toBe(true);
  });

  it('stale chainlink + usable offchain → CHAINLINK_STALE, manipulation judged on offchain only', () => {
    const r = computeBenchmark([P('a', 3000), P('b', 3001), P('c', 2999)],
      { chainlink: OK(2970, true), offChain: OK(3001) });
    expect(r.flags).toContain('CHAINLINK_STALE');
    expect(r.manipulationSuspect).toBe(false); // stale chainlink can't assert manipulation
    expect(r.lowConfidence).toBe(true);        // staleness alone downgrades
  });

  it('chainlink only (offchain null) → single-oracle path', () => {
    const r = computeBenchmark([P('a', 3000), P('b', 3001), P('c', 2999)],
      { chainlink: OK(2970), offChain: null });
    expect(r.flags).toContain('OFFCHAIN_UNAVAILABLE');
    expect(r.manipulationSuspect).toBe(true);
    expect(r.chainlinkDevBps).toBeCloseTo(101.01, 1);
  });

  it('both oracles null → ORACLE_UNAVAILABLE, no manipulation, confidence untouched by oracle step', () => {
    const r = computeBenchmark([P('a', 3000), P('b', 3001), P('c', 2999)],
      { chainlink: null, offChain: null });
    expect(r.flags).toContain('CHAINLINK_UNAVAILABLE');
    expect(r.flags).toContain('OFFCHAIN_UNAVAILABLE');
    expect(r.flags).toContain('ORACLE_UNAVAILABLE');
    expect(r.manipulationSuspect).toBe(false);
    expect(r.lowConfidence).toBe(false);
  });
});
