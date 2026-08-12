import { describe, expect, it } from 'vitest';
import { computeMarketPrice, type Estimator, getMarketPriceForPair, type MarketPriceDeps } from './marketPrice.js';
import { reconciledResult } from './marketPrice.js';

const direct = (price: number): Estimator => ({ price, class: 'direct', label: 'direct pool' });
const bridged = (price: number): Estimator => ({ price, class: 'bridged', label: 'WETH bridge' });
const oracle = (price: number): Estimator => ({ price, class: 'oracle', label: 'oracle ratio' });

describe('computeMarketPrice', () => {
  it('returns none when no LIQUIDITY estimator survives (oracle alone is not a mid)', () => {
    expect(computeMarketPrice([]).tier).toBe('none');
    expect(computeMarketPrice([direct(0)]).tier).toBe('none');
    const oracleOnly = computeMarketPrice([oracle(100)]);
    expect(oracleOnly.tier).toBe('none');       // pool-relative: no pool => no market price
    expect(oracleOnly.marketMid).toBeNull();
  });

  it('single liquidity pool, no corroborator => estimated, mid = pool', () => {
    const r = computeMarketPrice([direct(100)]);
    expect(r.tier).toBe('estimated');
    expect(r.marketMid).toBe(100);
    expect(r.corroboratedBy).toEqual(['direct']);
    expect(r.flags).toContain('SINGLE_SOURCE');
  });

  it('medians multiple pools within the direct class before tiering', () => {
    const r = computeMarketPrice([direct(100), direct(102), direct(101)]);
    expect(r.marketMid).toBe(101);
    expect(r.tier).toBe('estimated'); // still one class
  });

  it('two independent liquidity classes agree => full, mid = liquidity median', () => {
    const r = computeMarketPrice([direct(100), bridged(100.2)]);
    expect(r.tier).toBe('full');
    expect(r.marketMid).toBeCloseTo(100.1, 6);
    expect(r.corroboratedBy.sort()).toEqual(['bridged', 'direct']);
  });

  it('oracle agrees => full, but the mid STAYS the pool (oracle never blended in)', () => {
    const r = computeMarketPrice([direct(100), oracle(100.2)]); // 20 bps apart, within tol
    expect(r.tier).toBe('full');
    expect(r.marketMid).toBe(100);               // NOT 100.1 — oracle does not move the mid
    expect(r.corroboratedBy).toContain('oracle');
    expect(r.corroboratedBy).toContain('direct');
  });

  it('oracle disagrees beyond tol => estimated, mid = pool, ORACLE_DISAGREE', () => {
    const r = computeMarketPrice([direct(100), oracle(110)]);
    expect(r.tier).toBe('estimated');
    expect(r.marketMid).toBe(100);
    expect(r.flags).toContain('ORACLE_DISAGREE');
    expect(r.flags).toContain('SINGLE_SOURCE');   // single liquidity source
  });

  it('single pool + disagreeing oracle => estimated with BOTH flags', () => {
    const r = computeMarketPrice([direct(100), oracle(110)]);
    expect(r.tier).toBe('estimated');
    expect(r.marketMid).toBe(100);
    expect(r.flags).toContain('ORACLE_DISAGREE');
    expect(r.flags).toContain('SINGLE_SOURCE');   // the fix: single liquidity source
    expect(r.corroboratedBy).toEqual(['direct']); // names the lone class for the descriptor
  });

  it('single bridged pool + disagreeing oracle => BOTH flags, bridged named', () => {
    const r = computeMarketPrice([bridged(100), oracle(110)]);
    expect(r.flags).toContain('ORACLE_DISAGREE');
    expect(r.flags).toContain('SINGLE_SOURCE');
    expect(r.corroboratedBy).toEqual(['bridged']);
  });

  it('two liquidity classes + disagreeing oracle => NO SINGLE_SOURCE', () => {
    const r = computeMarketPrice([direct(100), bridged(100.3), oracle(140)]);
    expect(r.flags).toContain('ORACLE_DISAGREE');
    expect(r.flags).not.toContain('SINGLE_SOURCE'); // >=2 classes: not single-source
  });

  it('liquidity corroborates even when an oracle outlier disagrees', () => {
    const r = computeMarketPrice([direct(100), bridged(100.3), oracle(140)]);
    expect(r.tier).toBe('full');                 // direct+bridged agree
    expect(r.marketMid).toBeCloseTo(100.15, 6);  // liquidity median only
    expect(r.corroboratedBy).not.toContain('oracle');
    expect(r.flags).toContain('ORACLE_DISAGREE');
  });

  it('two liquidity classes disagree + oracle near their median => estimated (not full)', () => {
    // direct=100, bridged=101.5 => median 100.75; each is ~74bps off => LIQUIDITY_DISAGREE.
    // oracle=100.75 sits on the median (within tol) but must NOT promote to full.
    const r = computeMarketPrice([direct(100), bridged(101.5), oracle(100.75)]);
    expect(r.tier).toBe('estimated');
    expect(r.flags).toContain('LIQUIDITY_DISAGREE');
    expect(r.flags).not.toContain('ORACLE_DISAGREE'); // oracle agreed with the median
    expect(r.marketMid).toBeCloseTo(100.75, 6);       // still the pool median
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

const IN = '0x4200000000000000000000000000000000000006';  // WETH
const OUT = '0x0555e30da8f98308edb960aa94c0db47230d2b9c'; // WBTC

function makeMpDeps(over: Partial<MarketPriceDeps> = {}): MarketPriceDeps {
  return {
    getDirectMid: async () => ({ price: null }),
    getBridgedMid: async () => ({ price: null }),
    getOracleImpliedMid: async () => null,
    ...over,
  };
}

describe('getMarketPriceForPair', () => {
  it('is full when direct and bridged agree', async () => {
    const deps = makeMpDeps({ getDirectMid: async () => ({ price: 100 }), getBridgedMid: async () => ({ price: 100.1 }) });
    const r = await getMarketPriceForPair(deps, IN, OUT, 100n);
    expect(r.tier).toBe('full');
    expect(r.corroboratedBy.sort()).toEqual(['bridged', 'direct']);
  });

  it('is estimated with only a direct pool', async () => {
    const deps = makeMpDeps({ getDirectMid: async () => ({ price: 100 }) });
    const r = await getMarketPriceForPair(deps, IN, OUT, 100n);
    expect(r.tier).toBe('estimated');
    expect(r.marketMid).toBe(100);
  });

  it('is none with no estimators', async () => {
    const r = await getMarketPriceForPair(makeMpDeps(), IN, OUT, 100n);
    expect(r.tier).toBe('none');
    expect(r.marketMid).toBeNull();
  });

  it('never throws — a rejecting dep just drops that estimator', async () => {
    const deps = makeMpDeps({
      getDirectMid: async () => { throw new Error('rpc'); },
      getBridgedMid: async () => ({ price: 100 }),
    });
    const r = await getMarketPriceForPair(deps, IN, OUT, 100n);
    expect(r.tier).toBe('estimated'); // only bridged survived
    expect(r.marketMid).toBe(100);
  });
});

// ── depth rejections reach the flags without touching the reducer ───────────
// A floored-out estimator is simply ABSENT from computeMarketPrice's array —
// byte-identical to one that never existed — so the reason has to be merged in
// afterwards, in getMarketPriceForPair, where the deps were actually called.
describe('getMarketPriceForPair — depth rejection side-channel', () => {
  it('co-emits NO_LIQUIDITY and INSUFFICIENT_DEPTH when the floor emptied every class', async () => {
    const deps = makeMpDeps({
      getBridgedMid: async () => ({ price: null, rejected: true, depthUsd: 0.216, poolAddress: '0x6945a4bf' }),
    });
    const r = await getMarketPriceForPair(deps, IN, OUT, 100n);

    expect(r.tier).toBe('none');
    expect(r.marketMid).toBeNull();
    expect(r.flags).toContain('NO_LIQUIDITY');       // the reducer: zero classes
    expect(r.flags).toContain('INSUFFICIENT_DEPTH');  // the merge: WHY
    expect(r.referenceDepthUsd).toBeCloseTo(0.216, 6);
    expect(r.referencePoolAddress).toBe('0x6945a4bf');
  });

  it('records depth on the PASSING path too, so a thin-but-passing ruler is visible', async () => {
    const deps = makeMpDeps({
      getBridgedMid: async () => ({ price: 2, depthUsd: 250, poolAddress: '0xthin' }),
    });
    const r = await getMarketPriceForPair(deps, IN, OUT, 100n);

    expect(r.tier).toBe('estimated');
    expect(r.flags).not.toContain('INSUFFICIENT_DEPTH');
    expect(r.referenceDepthUsd).toBe(250);
    expect(r.referencePoolAddress).toBe('0xthin');
  });

  it('emits DEPTH_UNVERIFIED when depth could not be valued, and still allows the mid', async () => {
    const deps = makeMpDeps({ getDirectMid: async () => ({ price: 3, unverified: true }) });
    const r = await getMarketPriceForPair(deps, IN, OUT, 100n);

    expect(r.marketMid).toBe(3);
    expect(r.flags).toContain('DEPTH_UNVERIFIED');
    expect(r.flags).not.toContain('INSUFFICIENT_DEPTH');
  });

  it('reports the thinnest pool when both classes carry a depth', async () => {
    const deps = makeMpDeps({
      getDirectMid: async () => ({ price: 100, depthUsd: 90_000, poolAddress: '0xfat' }),
      getBridgedMid: async () => ({ price: 100.1, depthUsd: 400, poolAddress: '0xthin' }),
    });
    const r = await getMarketPriceForPair(deps, IN, OUT, 100n);

    expect(r.referencePoolAddress).toBe('0xthin');
    expect(r.referenceDepthUsd).toBe(400);
  });

  it('leaves computeMarketPrice untouched — no depth fields invented by the reducer', () => {
    const r = computeMarketPrice([{ price: 5, class: 'direct', label: 'direct pool' }]);
    expect(r.referenceDepthUsd).toBeNull();
    expect(r.referencePoolAddress).toBeNull();
  });
});
