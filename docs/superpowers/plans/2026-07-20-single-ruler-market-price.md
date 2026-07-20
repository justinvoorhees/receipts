# Single-Ruler Market Price Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two-ruler pricing path with one corroborated Market Price scalar per pair at block N-1, from which every USD figure derives — so Execution Result is the dollarized form of Total Execution Quality by construction.

**Architecture:** A pure `computeMarketPrice(estimators)` reduces independent estimators (direct pool, WETH bridge, oracle-implied ratio) of the *same* output-per-input scalar into one price plus a confidence tier (`full` / `estimated` / `none`). A DI-injected reader `getMarketPriceForPair` gathers those estimators from live readers. `priceReceipt` consumes the result; the existing per-leg Price Impact layer is untouched.

**Tech Stack:** TypeScript (ESM, NodeNext), viem, vitest. Core package builds with `tsc --build`; tests run with `npx vitest run`.

**Scope:** This plan is **Phase 1** of the spec (`docs/superpowers/specs/2026-07-20-single-ruler-market-price-design.md`): the apparatus + its reconciliation guarantee, wired behind `priceReceipt`. **Phase 2** (dashboard receipt rows, methodology string, retiring `anchor_price_usd` as a display price) and **Phase 3** (module collapse / moving `getLegMidAtBlock`) are separate plans authored after this interface lands.

## Global Constraints

- **One ruler.** No code path may price the two sides of a swap from different sources. Oracles enter only as (a) the USD anchor/backbone for dollarizing, or (b) a corroborator of the single pair ratio — never as a side's display price.
- **Never throw.** `priceReceipt` and every reader degrade to a lower tier / null on any error (transient RPC, decode). A thrown error is a bug.
- **Do not touch the per-leg impact layer.** `getLegMidAtBlock` (in `tokenPricing.ts`, consumed by `decomposeRoute.ts`) and Price Impact / Slippage / Total Execution Quality are out of scope for this plan.
- **Corroboration tolerance:** `CORROBORATE_TOL_BPS = 50` (reuses the benchmark's `MANIPULATION_TOL_BPS`). Cross-class disagreement beyond this drops the tier; it never averages disagreeing estimators.
- **Estimator priority when uncorroborated:** `direct` > `bridged` > `oracle`.
- All addresses compared lowercased. Prices are **output-per-input**, human units.
- Test command: `npx vitest run packages/core/src/<file>.test.ts` from repo root.

---

### Task 1: Pure `computeMarketPrice` + tier logic

**Files:**
- Create: `packages/core/src/marketPrice.ts`
- Test: `packages/core/src/marketPrice.test.ts`

**Interfaces:**
- Consumes: `median` from `./benchmarkPrice.js` (existing: `export function median(xs: number[]): number`).
- Produces:
  - `type MarketPriceTier = 'full' | 'estimated' | 'none'`
  - `type EstimatorClass = 'direct' | 'bridged' | 'oracle'`
  - `interface Estimator { price: number; class: EstimatorClass; label: string }`
  - `interface MarketPriceResult { tier: MarketPriceTier; marketMid: number | null; corroboratedBy: EstimatorClass[]; flags: string[] }`
  - `const CORROBORATE_TOL_BPS = 50`
  - `function computeMarketPrice(estimators: Estimator[], tolBps?: number): MarketPriceResult`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/marketPrice.test.ts
import { describe, expect, it } from 'vitest';
import { computeMarketPrice, type Estimator } from './marketPrice.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/marketPrice.test.ts`
Expected: FAIL — `computeMarketPrice` is not defined / module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/marketPrice.ts
/**
 * marketPrice.ts — the single Market Price apparatus (pure reducer).
 *
 * ONE ruler: every estimator here prices the SAME output-per-input scalar for
 * the traded pair. Estimators of different CLASSES (a direct pool mid, a WETH
 * bridge, an oracle-implied ratio) corroborate that one number; they are never
 * used to price the two sides of the swap separately. See
 * docs/superpowers/specs/2026-07-20-single-ruler-market-price-design.md.
 */
import { median } from './benchmarkPrice.js';

export type MarketPriceTier = 'full' | 'estimated' | 'none';
export type EstimatorClass = 'direct' | 'bridged' | 'oracle';

export interface Estimator {
  /** output-per-input price for the pair, human units. */
  price: number;
  class: EstimatorClass;
  /** provenance for the methodology string, e.g. "direct pool". */
  label: string;
}

export interface MarketPriceResult {
  tier: MarketPriceTier;
  /** output-per-input mid; null iff tier === 'none'. */
  marketMid: number | null;
  corroboratedBy: EstimatorClass[];
  flags: string[];
}

/** Cross-class agreement tolerance (matches benchmark MANIPULATION_TOL_BPS). */
export const CORROBORATE_TOL_BPS = 50;

const CLASS_PRIORITY: EstimatorClass[] = ['direct', 'bridged', 'oracle'];

export function computeMarketPrice(
  estimators: Estimator[],
  tolBps: number = CORROBORATE_TOL_BPS,
): MarketPriceResult {
  const valid = estimators.filter((e) => Number.isFinite(e.price) && e.price > 0);
  if (valid.length === 0) {
    return { tier: 'none', marketMid: null, corroboratedBy: [], flags: ['NO_ESTIMATOR'] };
  }

  // Reduce to one price per class (median of that class's pools/reads).
  const byClass = new Map<EstimatorClass, number>();
  for (const cls of CLASS_PRIORITY) {
    const prices = valid.filter((e) => e.class === cls).map((e) => e.price);
    if (prices.length > 0) byClass.set(cls, median(prices));
  }

  const classes = [...byClass.keys()];
  if (classes.length === 1) {
    const only = classes[0]!;
    return { tier: 'estimated', marketMid: byClass.get(only)!, corroboratedBy: [only], flags: ['SINGLE_CLASS'] };
  }

  // >=2 classes: the agreeing subset is those within tol of all class prices' median.
  const classPrices = classes.map((c) => byClass.get(c)!);
  const m = median(classPrices);
  const agree = classes.filter((c) => (Math.abs(byClass.get(c)! - m) / m) * 10_000 <= tolBps);

  if (agree.length >= 2) {
    return {
      tier: 'full',
      marketMid: median(agree.map((c) => byClass.get(c)!)),
      corroboratedBy: agree,
      flags: [],
    };
  }

  // No corroboration: fall back to the highest-priority class, flagged.
  const pick = CLASS_PRIORITY.find((c) => byClass.has(c))!;
  return { tier: 'estimated', marketMid: byClass.get(pick)!, corroboratedBy: [pick], flags: ['CROSS_CLASS_DISAGREE'] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/marketPrice.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/marketPrice.ts packages/core/src/marketPrice.test.ts
git commit -m "feat(core): computeMarketPrice pure tier reducer (single-ruler)"
```

---

### Task 2: Reconciliation invariant guardrail

The single-ruler guarantee, as an executable test: with one mid, the dollar Execution Result equals `qualityBps/10000 × notional`. This fails loudly if a second ruler ever returns.

**Files:**
- Modify: `packages/core/src/marketPrice.ts` (add `reconciledResult`)
- Test: `packages/core/src/marketPrice.test.ts` (append)

**Interfaces:**
- Produces: `function reconciledResult(args: { marketMid: number; realizedPrice: number; notionalUsd: number }): { execResultUsd: number; qualityBps: number }`
  - `qualityBps = (realizedPrice / marketMid - 1) * 10_000`
  - `execResultUsd = notionalUsd * (realizedPrice / marketMid - 1)`
  - Both output-per-input; positive = surplus (received more output than mid).

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/core/src/marketPrice.test.ts
import { reconciledResult } from './marketPrice.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/marketPrice.test.ts -t reconciledResult`
Expected: FAIL — `reconciledResult` is not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to packages/core/src/marketPrice.ts
/**
 * The single-ruler identity: from ONE market mid, the dollar execution result and
 * the bps execution quality are two views of the same number. A test asserts
 * execResultUsd === qualityBps/1e4 * notionalUsd; if that ever breaks, a second
 * ruler has re-entered. All prices are output-per-input.
 */
export function reconciledResult(args: {
  marketMid: number;
  realizedPrice: number;
  notionalUsd: number;
}): { execResultUsd: number; qualityBps: number } {
  const ratio = args.realizedPrice / args.marketMid - 1;
  return { execResultUsd: args.notionalUsd * ratio, qualityBps: ratio * 10_000 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/marketPrice.test.ts`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/marketPrice.ts packages/core/src/marketPrice.test.ts
git commit -m "test(core): single-ruler reconciliation invariant (reference ETH->WBTC)"
```

---

### Task 3: `getMarketPriceForPair` estimator reader (DI, fake-testable)

**Files:**
- Modify: `packages/core/src/marketPrice.ts` (add reader + deps type)
- Test: `packages/core/src/marketPrice.test.ts` (append)

**Interfaces:**
- Consumes: `computeMarketPrice`, `Estimator`, `MarketPriceResult` (Task 1).
- Produces:
  - `interface MarketPriceDeps { getDirectMid; getBridgedMid; getOracleImpliedMid }` — each `(inputToken: string, outputToken: string, blockNumber: bigint) => Promise<number | null>`, returning output-per-input or null.
  - `function getMarketPriceForPair(deps: MarketPriceDeps, inputToken: string, outputToken: string, blockNumber: bigint): Promise<MarketPriceResult>`
  - Never throws; a rejected/throwing dep contributes no estimator.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/core/src/marketPrice.test.ts
import { getMarketPriceForPair, type MarketPriceDeps } from './marketPrice.js';

const IN = '0x4200000000000000000000000000000000000006';  // WETH
const OUT = '0x0555e30da8f98308edb960aa94c0db47230d2b9c'; // WBTC

function makeMpDeps(over: Partial<MarketPriceDeps> = {}): MarketPriceDeps {
  return {
    getDirectMid: async () => null,
    getBridgedMid: async () => null,
    getOracleImpliedMid: async () => null,
    ...over,
  };
}

describe('getMarketPriceForPair', () => {
  it('is full when direct and bridged agree', async () => {
    const deps = makeMpDeps({ getDirectMid: async () => 100, getBridgedMid: async () => 100.1 });
    const r = await getMarketPriceForPair(deps, IN, OUT, 100n);
    expect(r.tier).toBe('full');
    expect(r.corroboratedBy.sort()).toEqual(['bridged', 'direct']);
  });

  it('is estimated with only a direct pool', async () => {
    const deps = makeMpDeps({ getDirectMid: async () => 100 });
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
      getBridgedMid: async () => 100,
    });
    const r = await getMarketPriceForPair(deps, IN, OUT, 100n);
    expect(r.tier).toBe('estimated'); // only bridged survived
    expect(r.marketMid).toBe(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/marketPrice.test.ts -t getMarketPriceForPair`
Expected: FAIL — `getMarketPriceForPair` is not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to packages/core/src/marketPrice.ts
export interface MarketPriceDeps {
  /** Guarded deepest direct pool mid (output-per-input), or null. */
  getDirectMid: (inputToken: string, outputToken: string, blockNumber: bigint) => Promise<number | null>;
  /** (in/WETH) x (WETH/out) bridged mid (output-per-input), or null. */
  getBridgedMid: (inputToken: string, outputToken: string, blockNumber: bigint) => Promise<number | null>;
  /** usd(in)/usd(out) implied ratio when BOTH sides have USD feeds, else null. */
  getOracleImpliedMid: (inputToken: string, outputToken: string, blockNumber: bigint) => Promise<number | null>;
}

async function safeMid(
  fn: (a: string, b: string, blk: bigint) => Promise<number | null>,
  a: string, b: string, blk: bigint,
): Promise<number | null> {
  try {
    return await fn(a, b, blk);
  } catch {
    return null;
  }
}

export async function getMarketPriceForPair(
  deps: MarketPriceDeps,
  inputToken: string,
  outputToken: string,
  blockNumber: bigint,
): Promise<MarketPriceResult> {
  const [d, b, o] = await Promise.all([
    safeMid(deps.getDirectMid, inputToken, outputToken, blockNumber),
    safeMid(deps.getBridgedMid, inputToken, outputToken, blockNumber),
    safeMid(deps.getOracleImpliedMid, inputToken, outputToken, blockNumber),
  ]);
  const estimators: Estimator[] = [];
  if (d != null) estimators.push({ price: d, class: 'direct', label: 'direct pool' });
  if (b != null) estimators.push({ price: b, class: 'bridged', label: 'WETH bridge' });
  if (o != null) estimators.push({ price: o, class: 'oracle', label: 'oracle ratio' });
  return computeMarketPrice(estimators);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/marketPrice.test.ts`
Expected: PASS (12 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/marketPrice.ts packages/core/src/marketPrice.test.ts
git commit -m "feat(core): getMarketPriceForPair estimator assembly (DI, never-throw)"
```

---

### Task 4: Wire the apparatus into `priceReceipt`

Replace the ad-hoc `full | estimated | partial` branching in `priceReceipt` with the apparatus. `priceReceipt`'s existing return shape is preserved (so `analyzeTransaction`, which keys off `marketMid != null`, is unaffected) and gains three fields: `tier`, `methodology`, `marketPriceFlags`.

**Files:**
- Modify: `packages/core/src/pricing.ts` (imports; `PricingResult`; `PricingDeps`; branches 2/2.5/3 in `priceReceipt`; `createDefaultPricingDeps`)
- Test: `packages/core/src/pricing.test.ts`

**Interfaces:**
- Consumes: `getMarketPriceForPair`, `MarketPriceDeps`, `MarketPriceTier`, `computeMarketPrice` (Tasks 1&3); existing `defaultGetPairMid`, `getEstimatedMidAtBlock`, `readTokenUsd` (from `./tokenOracle.js`), `getBenchmarkMid`.
- Produces: `PricingResult` additionally carries `tier: MarketPriceTier`, `methodology: string`, `marketPriceFlags: string[]`. `PricingDeps` additionally carries `getMarketPrice: (inputToken, outputToken, blockNumber) => Promise<MarketPriceResult>`.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/core/src/pricing.test.ts
import type { MarketPriceResult } from './marketPrice.js';

const fullMid = (price: number): MarketPriceResult =>
  ({ tier: 'full', marketMid: price, corroboratedBy: ['direct', 'bridged'], flags: [] });
const estMid = (price: number): MarketPriceResult =>
  ({ tier: 'estimated', marketMid: price, corroboratedBy: ['direct'], flags: ['SINGLE_CLASS'] });
const noMid = (): MarketPriceResult =>
  ({ tier: 'none', marketMid: null, corroboratedBy: [], flags: ['NO_ESTIMATOR'] });

describe('priceReceipt tier wiring', () => {
  it('full tier -> status full, marketMid set, methodology mentions corroboration', async () => {
    const r = await priceReceipt(baseArgs, makeDeps({
      getMarketPrice: async () => fullMid(1800),
      getUsdValue: async () => 1800,
      readSymbol: async (t) => (t === WETH ? 'WETH' : 'USDC'),
    }), );
    expect(r.status).toBe('full');
    expect(r.marketMid).toBe(1800);
    expect(r.tier).toBe('full');
    expect(r.methodology.toLowerCase()).toContain('corroborat');
  });

  it('estimated tier -> status estimated, marketMid set, methodology flags single-pool', async () => {
    const r = await priceReceipt(baseArgs, makeDeps({
      getMarketPrice: async () => estMid(1800),
      getUsdValue: async () => 1800,
    }));
    expect(r.status).toBe('estimated');
    expect(r.marketMid).toBe(1800);
    expect(r.tier).toBe('estimated');
    expect(r.methodology.toLowerCase()).toContain('single');
  });

  it('none tier -> status partial, marketMid null', async () => {
    const r = await priceReceipt(baseArgs, makeDeps({ getMarketPrice: async () => noMid() }));
    expect(r.status).toBe('partial');
    expect(r.marketMid).toBeNull();
    expect(r.tier).toBe('none');
  });
});
```

Also update `makeDeps` in `pricing.test.ts` to include the new dep (find the object returned by `makeDeps`, add the line):

```ts
    getMarketPrice: async () => ({ tier: 'none', marketMid: null, corroboratedBy: [], flags: ['NO_ESTIMATOR'] }),
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/pricing.test.ts -t "tier wiring"`
Expected: FAIL — `getMarketPrice` not on `PricingDeps`; `tier`/`methodology` not on `PricingResult`.

- [ ] **Step 3: Write minimal implementation**

In `packages/core/src/pricing.ts`:

3a. Add imports near the top imports block:

```ts
import {
  getMarketPriceForPair,
  type MarketPriceResult,
  type MarketPriceTier,
} from './marketPrice.js';
import { readTokenUsd } from './tokenOracle.js';
```

3b. Extend `PricingResult` (add three fields after `manipulationFlag` line):

```ts
  tier: MarketPriceTier;
  methodology: string;
  marketPriceFlags: string[];
```

3c. Extend `PricingDeps` (add after `getEstimatedMid`):

```ts
  /** The single Market Price apparatus: one corroborated mid + tier. */
  getMarketPrice: (inputToken: string, outputToken: string, blockNumber: bigint) => Promise<MarketPriceResult>;
```

3d. Add a methodology-string builder (module scope, near `fallbackSymbolFor`):

```ts
function methodologyFor(mp: MarketPriceResult): string {
  if (mp.tier === 'none') return 'No reliable market price available.';
  if (mp.tier === 'estimated') {
    return mp.flags.includes('CROSS_CLASS_DISAGREE')
      ? 'Estimated: price sources disagreed; showing the deepest pool mid.'
      : 'Estimated: single uncorroborated pool mid at block N-1.';
  }
  return `Corroborated market price (${mp.corroboratedBy.join(' + ')}) at block N-1.`;
}
```

3e. In `createDefaultPricingDeps`, add the real `getMarketPrice` to the returned object. It composes the existing readers as estimator sources:

```ts
    getMarketPrice: (inputToken, outputToken, blockNumber) =>
      getMarketPriceForPair(
        {
          getDirectMid: async (i, o, blk) => (await defaultGetPairMid(poolReaders, i, o, blk))?.price ?? null,
          getBridgedMid: async (i, o, blk) => (await getEstimatedMidAtBlock(
            {
              getDeepestPoolWithDepth: async (a, b, b2) => {
                const best = await getDeepestPoolWithDepth(client, a, b, b2);
                return best ? { address: best.pool.address, depth: best.depth } : null;
              },
              readSlot0: (pool, b2) => readSlot0(client, pool as `0x${string}`, b2),
              readDecimals: decCache,
            }, i, o, blk, ESTIMATED_MID_MIN_LIQUIDITY))?.price ?? null,
          getOracleImpliedMid: async (i, o, blk) => {
            const [ui, uo] = await Promise.all([
              readTokenUsd(i, blk + 1n, rpcUrl),
              readTokenUsd(o, blk + 1n, rpcUrl),
            ]);
            return ui != null && uo != null && uo > 0 ? ui / uo : null; // output-per-input = usd(in)/usd(out)
          },
        },
        inputToken,
        outputToken,
        blockNumber,
      ),
```

Note: `readTokenUsd` samples at `blockNumber - 1` internally, so pass `blk + 1n` (blk here is already `refBlock = N-1`). Only ETH/WBTC/stables resolve; everything else yields null (no oracle-implied estimator), which is correct.

3f. Rewrite branches 2 / 2.5 / 3 of `priceReceipt` to use the apparatus. Replace the block from `// ── Branch 2/3: generic pair ──` down to `return partial(notionalUsd);` (keep Branch 1 USDC/WETH fast-path as-is for now — Phase 3 folds it in) with:

```ts
    // ── Generic pair via the single Market Price apparatus ──
    const mp = await deps.getMarketPrice(inputToken, outputToken, refBlock);
    const anchored = anchorsToUsd(inputToken) || anchorsToUsd(outputToken);
    const methodology = methodologyFor(mp);

    if (mp.marketMid != null && mp.marketMid > 0) {
      const notionalUsd = await bestEffortNotional(deps, args, refBlock);
      const status: PricingResult['status'] = mp.tier === 'full' && anchored ? 'full' : 'estimated';
      return {
        status,
        marketMid: mp.marketMid,
        notionalUsd,
        inputSymbol, outputSymbol, inputDecimals, outputDecimals,
        chainlinkPrice: null, poolDivergenceBps: null, manipulationFlag: false,
        chainlinkDevBps: null, offchainPrice: null, offchainDevBps: null, chainlinkStalenessSecs: null,
        tier: mp.tier, methodology, marketPriceFlags: mp.flags,
      };
    }

    const notionalUsd = await bestEffortNotional(deps, args, refBlock);
    return { ...partial(notionalUsd), tier: 'none', methodology, marketPriceFlags: mp.flags };
```

3g. Update the `partial()` helper to include the three new fields so every return path is type-complete:

```ts
  const partial = (notionalUsd: number | null = null): PricingResult => ({
    status: 'partial',
    marketMid: null,
    notionalUsd,
    inputSymbol, outputSymbol, inputDecimals, outputDecimals,
    chainlinkPrice: null, poolDivergenceBps: null, manipulationFlag: false,
    chainlinkDevBps: null, offchainPrice: null, offchainDevBps: null, chainlinkStalenessSecs: null,
    tier: 'none', methodology: 'No reliable market price available.', marketPriceFlags: [],
  });
```

3h. In Branch 1 (USDC/WETH fast-path `return`), add the three fields to its returned object:

```ts
        tier: 'full', methodology: 'Corroborated WETH/USD benchmark (median pools + oracle) at block N-1.', marketPriceFlags: bench.flags,
```

- [ ] **Step 4: Run the full core suite to verify green**

Run: `npx vitest run packages/core/src/pricing.test.ts packages/core/src/marketPrice.test.ts`
Expected: PASS. Then `npx tsc --build packages/core` — expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pricing.ts packages/core/src/pricing.test.ts
git commit -m "feat(core): route priceReceipt through the single Market Price apparatus + tier/methodology"
```

---

### Task 5: Full-suite regression + verify no second ruler in core

**Files:**
- Test: run existing suites (no new files)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Run the full core test suite**

Run: `npx vitest run packages/core`
Expected: PASS. If `analyzeTransaction.test.ts` or `benchmarkPrice.test.ts` reference the old branch behavior, reconcile them to assert on `marketMid`/`tier` (do not weaken the reconciliation intent). Show any failing output before editing.

- [ ] **Step 2: Typecheck the workspace**

Run: `npx tsc --build`
Expected: no errors. (If the dashboard references `PricingResult` fields, they are additive — existing reads still compile.)

- [ ] **Step 3: Commit any test reconciliations**

```bash
git add -A
git commit -m "test(core): reconcile existing suites with the Market Price apparatus"
```

---

---

## Phase 1b — Corroboration fixes (from the final whole-branch review)

The final review found the corroboration was hollow for WETH-anchored pairs (direct and bridged collapse to the same pool) and the oracle-implied corroborator never fired (only WBTC mapped). User decision: the oracle **confirms confidence only — it never moves the Market Price** (the mid stays pool-relative, preserving `Execution Result ≡ Execution Quality`). These two tasks make corroboration real.

### Task 6: `computeMarketPrice` — oracle corroborates, never sets the mid

Rewrite the reducer so the mid comes only from **liquidity** classes (`direct`, `bridged`); the **oracle** class corroborates the tier but is never medianed into the mid.

**Files:**
- Modify: `packages/core/src/marketPrice.ts` (`computeMarketPrice` body + a `LIQUIDITY_CLASSES` const)
- Modify: `packages/core/src/marketPrice.test.ts` (replace the Task 1 `computeMarketPrice` describe block; keep Task 2/3 blocks untouched)

**Interfaces:**
- Consumes: `median` from `./benchmarkPrice.js`; existing `Estimator`/`MarketPriceResult`/`EstimatorClass`/`CORROBORATE_TOL_BPS` (unchanged shapes).
- Produces: same `computeMarketPrice(estimators, tolBps?)` signature; new behavior. Flags vocabulary: `NO_LIQUIDITY`, `SINGLE_SOURCE`, `ORACLE_DISAGREE`, `LIQUIDITY_DISAGREE`.

- [ ] **Step 1: Replace the Task 1 `computeMarketPrice` describe block with these tests**

```ts
// REPLACE the existing describe('computeMarketPrice', ...) block in marketPrice.test.ts
// (leave the reconciledResult and getMarketPriceForPair blocks unchanged)
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
  });

  it('liquidity corroborates even when an oracle outlier disagrees', () => {
    const r = computeMarketPrice([direct(100), bridged(100.3), oracle(140)]);
    expect(r.tier).toBe('full');                 // direct+bridged agree
    expect(r.marketMid).toBeCloseTo(100.15, 6);  // liquidity median only
    expect(r.corroboratedBy).not.toContain('oracle');
    expect(r.flags).toContain('ORACLE_DISAGREE');
  });
});
```

- [ ] **Step 2: Run to verify the new expectations fail against the old reducer**

Run: `npx vitest run packages/core/src/marketPrice.test.ts -t computeMarketPrice`
Expected: FAIL (old reducer blends oracle into the mid / treats oracle as a mid source).

- [ ] **Step 3: Rewrite `computeMarketPrice`**

```ts
// In packages/core/src/marketPrice.ts, add near CLASS_PRIORITY:
const LIQUIDITY_CLASSES: EstimatorClass[] = ['direct', 'bridged'];

// REPLACE the entire body of computeMarketPrice with:
export function computeMarketPrice(
  estimators: Estimator[],
  tolBps: number = CORROBORATE_TOL_BPS,
): MarketPriceResult {
  const valid = estimators.filter((e) => Number.isFinite(e.price) && e.price > 0);

  // The mid is pool-relative: it comes ONLY from liquidity classes. Median within
  // each class first, then the mid is the median across the liquidity classes.
  const liq = new Map<EstimatorClass, number>();
  for (const cls of LIQUIDITY_CLASSES) {
    const prices = valid.filter((e) => e.class === cls).map((e) => e.price);
    if (prices.length > 0) liq.set(cls, median(prices));
  }
  if (liq.size === 0) {
    return { tier: 'none', marketMid: null, corroboratedBy: [], flags: ['NO_LIQUIDITY'] };
  }

  const liqClasses = [...liq.keys()];
  const marketMid = median([...liq.values()]);
  const within = (p: number) => (Math.abs(p - marketMid) / marketMid) * 10_000 <= tolBps;

  const flags: string[] = [];
  const corroboratedBy: EstimatorClass[] = [];
  for (const c of liqClasses) if (within(liq.get(c)!)) corroboratedBy.push(c);

  // Independent liquidity corroboration: >=2 liquidity classes that all agree.
  const liquidityCorroborated = liqClasses.length >= 2 && liqClasses.every((c) => within(liq.get(c)!));
  if (liqClasses.length >= 2 && !liquidityCorroborated) flags.push('LIQUIDITY_DISAGREE');

  // Oracle: corroborate-only. It confirms the tier but never enters the mid.
  const oraclePrices = valid.filter((e) => e.class === 'oracle').map((e) => e.price);
  let oracleCorroborated = false;
  if (oraclePrices.length > 0) {
    if (within(median(oraclePrices))) {
      oracleCorroborated = true;
      corroboratedBy.push('oracle');
    } else {
      flags.push('ORACLE_DISAGREE');
    }
  }

  const corroborated = liquidityCorroborated || oracleCorroborated;
  if (!corroborated && flags.length === 0) flags.push('SINGLE_SOURCE');
  return { tier: corroborated ? 'full' : 'estimated', marketMid, corroboratedBy, flags };
}
```

Remove the now-unused `CLASS_PRIORITY` const if nothing else references it (grep first; the old disagreement fallback used it).

- [ ] **Step 4: Run tests — the whole file — to confirm green and no regression in Task 2/3 blocks**

Run: `npx vitest run packages/core/src/marketPrice.test.ts`
Expected: PASS (all blocks). Then `npx tsc --build packages/core` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/marketPrice.ts packages/core/src/marketPrice.test.ts
git commit -m "fix(core): oracle corroborates tier only; Market Price mid stays pool-relative"
```

---

### Task 7: Make the oracle fire + suppress the redundant WETH bridge

Wire real corroboration into `createDefaultPricingDeps`: (1) the oracle-implied estimator resolves each side's *independent* USD (stable=$1, WETH/native via the WETH/USD backbone, mapped feeds via `readTokenUsd`) so it actually fires; (2) the bridged estimator returns null when either endpoint is WETH/native (it would duplicate direct). Two small pure helpers make the decisions testable.

**Files:**
- Modify: `packages/core/src/pricing.ts` (add exported pure helpers `bridgedIsIndependent`, `impliedOracleRatio`; rewrite the `getMarketPrice` closure's `getBridgedMid`/`getOracleImpliedMid`; update `methodologyFor`; refresh the stale top-of-module docstring)
- Modify: `packages/core/src/pricing.test.ts` (add unit tests for the two pure helpers)

**Interfaces:**
- Consumes: existing `isStable`, `isWeth`, `isNative` (already in `pricing.ts`); `getBenchmarkMid` (already imported); `readTokenUsd` (already imported from Task 4); `defaultGetPairMid`, `getEstimatedMidAtBlock`, pool readers (already in the closure).
- Produces:
  - `export function bridgedIsIndependent(inputToken: string, outputToken: string): boolean` — false iff either endpoint is WETH or native.
  - `export function impliedOracleRatio(usdIn: number | null, usdOut: number | null): number | null` — `usdIn/usdOut` when both are finite and `usdOut > 0`, else null.

- [ ] **Step 1: Write the failing helper tests**

```ts
// append to packages/core/src/pricing.test.ts
import { bridgedIsIndependent, impliedOracleRatio } from './pricing.js';

const NATIVE = 'native';
const WBTC = '0x0555e30da8f98308edb960aa94c0db47230d2b9c';

describe('bridgedIsIndependent', () => {
  it('false when either side is literal WETH (bridge duplicates the direct pool)', () => {
    expect(bridgedIsIndependent(WETH, WBTC)).toBe(false);
    expect(bridgedIsIndependent(WBTC, WETH)).toBe(false);
  });
  it('true for native ETH (no direct native pool → the bridge is the only liquidity source)', () => {
    expect(bridgedIsIndependent(NATIVE, WBTC)).toBe(true);
    expect(bridgedIsIndependent(NATIVE, USDC)).toBe(true);
  });
  it('true for a non-WETH pair (bridge is a genuinely independent path)', () => {
    expect(bridgedIsIndependent(USDC, WBTC)).toBe(true);
  });
});

describe('impliedOracleRatio', () => {
  it('returns usdIn/usdOut when both resolve', () => {
    expect(impliedOracleRatio(2000, 50000)).toBeCloseTo(0.04, 9);
  });
  it('returns null when a side is missing or usdOut is non-positive', () => {
    expect(impliedOracleRatio(null, 50000)).toBeNull();
    expect(impliedOracleRatio(2000, null)).toBeNull();
    expect(impliedOracleRatio(2000, 0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run packages/core/src/pricing.test.ts -t "bridgedIsIndependent|impliedOracleRatio"`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Implement**

3a. Add the two pure helpers near the other small helpers in `pricing.ts` (e.g. after `anchorsToUsd`):

```ts
/** The WETH bridge is an independent estimator UNLESS a side is literal WETH — in
 *  which case the direct estimator already reads that same WETH pool and the bridge
 *  collapses to it. Native ETH is NOT suppressed: `defaultGetPairMid` returns null
 *  for the synthetic `'native'` endpoint (no direct pool), so the bridge is the only
 *  liquidity estimator for native pairs and must be kept. */
export function bridgedIsIndependent(inputToken: string, outputToken: string): boolean {
  return !isWeth(inputToken) && !isWeth(outputToken);
}

/** Oracle-implied output-per-input ratio from independent per-side USD refs, or
 *  null. A single ratio (one number) — never a per-side display price. */
export function impliedOracleRatio(usdIn: number | null, usdOut: number | null): number | null {
  if (usdIn == null || usdOut == null || !Number.isFinite(usdIn) || !Number.isFinite(usdOut) || usdOut <= 0) {
    return null;
  }
  return usdIn / usdOut;
}
```

3b. In `createDefaultPricingDeps`, replace the `getBridgedMid` and `getOracleImpliedMid` fields of the `getMarketPrice` closure with:

```ts
          getBridgedMid: async (i, o, blk) => {
            if (!bridgedIsIndependent(i, o)) return null; // duplicates direct for WETH pairs
            return (await getEstimatedMidAtBlock(
              {
                getDeepestPoolWithDepth: async (a, b, b2) => {
                  const best = await getDeepestPoolWithDepth(client, a, b, b2);
                  return best ? { address: best.pool.address, depth: best.depth } : null;
                },
                readSlot0: (pool, b2) => readSlot0(client, pool as `0x${string}`, b2),
                readDecimals: decCache,
              }, i, o, blk, ESTIMATED_MID_MIN_LIQUIDITY))?.price ?? null;
          },
          getOracleImpliedMid: async (i, o, blk) => {
            // Independent per-side USD: stable=$1, WETH/native via the WETH/USD
            // backbone, mapped feeds (e.g. WBTC->BTC/USD) via readTokenUsd. Fires
            // only when BOTH sides resolve. readTokenUsd/benchmark sample at
            // blockNumber-1 internally, so pass blk+1n (blk is already N-1).
            const usdIndep = async (token: string): Promise<number | null> => {
              const t = token.toLowerCase();
              if (isStable(t)) return 1;
              if (isWeth(t) || isNative(t)) {
                try {
                  const b = await getBenchmarkMid({ rpcUrl, blockNumber: blk + 1n });
                  return b.marketMid > 0 ? b.marketMid : null;
                } catch { return null; }
              }
              return readTokenUsd(t, blk + 1n, rpcUrl);
            };
            const [ui, uo] = await Promise.all([usdIndep(i), usdIndep(o)]);
            return impliedOracleRatio(ui, uo);
          },
```

3c. Replace `methodologyFor` with tier-and-flag-aware copy:

```ts
function methodologyFor(mp: MarketPriceResult): string {
  if (mp.tier === 'none') return 'No reliable market price available.';
  if (mp.tier === 'estimated') {
    if (mp.flags.includes('ORACLE_DISAGREE')) return 'Estimated: oracle disagreed with the pool mid; showing the pool mid.';
    if (mp.flags.includes('LIQUIDITY_DISAGREE')) return 'Estimated: pools disagreed; showing the median pool mid.';
    return 'Estimated: single uncorroborated pool mid at block N-1.';
  }
  return `Corroborated market price (${mp.corroboratedBy.join(' + ')}) at block N-1.`;
}
```

3d. Replace the stale top-of-module docstring (the block describing the old "find the deepest pool… → full/partial" algorithm) with an accurate summary:

```ts
/**
 * pricing.ts — receipt pricing via the single Market Price apparatus.
 *
 * `priceReceipt` produces one pool-relative Market Price (output-per-input) at
 * block N-1 from `getMarketPriceForPair` (marketPrice.ts): liquidity pools set the
 * mid, an independent oracle-implied ratio corroborates the confidence tier
 * (full/estimated/none) but never moves the mid. A USD anchor (stable / WETH-ETH
 * benchmark) dollarizes the one ratio into a best-effort notional. NEVER THROWS —
 * any failure degrades to a complete `partial`/none result. The Branch-1 USDC/WETH
 * fast-path is retained pending the Phase-3 module collapse.
 */
```

- [ ] **Step 4: Run helper tests, then the pricing + apparatus suites, THEN the full core suite, then typecheck**

Run: `npx vitest run packages/core/src/pricing.test.ts packages/core/src/marketPrice.test.ts`
Expected: PASS.

This task changes LIVE pricing behavior that `analyzeTransaction` depends on, so the full core suite is a REQUIRED gate (a narrower run misses regressions in native-ETH trades):

Run: `npx vitest run packages/core`
Expected: PASS with the SAME test count as the pre-task baseline (283 passing). If any `analyzeTransaction` test regresses, STOP — do not commit; report which tests and the failure output. A common cause: suppressing the bridge for a `native` endpoint (the predicate must suppress only literal WETH). Then `npx tsc --build packages/core` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pricing.ts packages/core/src/pricing.test.ts
git commit -m "fix(core): oracle-implied corroborator fires (backbone+stables+feeds); suppress redundant WETH bridge"
```

---

## Self-Review

**Spec coverage (Phase 1 scope only):**
- One-scalar Market Price + estimator classes → Task 1 (`computeMarketPrice`), Task 3 (`getMarketPriceForPair`). ✓
- `full` / `estimated` / `none` tiers + corroboration tolerance + priority fallback → Task 1. ✓
- Oracles as corroborators only (never side-pricers) → Task 4 step 3e (`getOracleImpliedMid` = `usd(in)/usd(out)`, feeds a single ratio estimator; never used per-side). ✓
- Reconciliation invariant as a shipped test → Task 2. ✓
- Never-throw degradation → Tasks 3 (`safeMid`) & 4 (`partial` fallback). ✓
- Wire behind existing `priceReceipt` interface, preserve `marketMid` semantics → Task 4. ✓
- Methodology string surfaced (data layer) → Task 4 step 3d. ✓
- **Deferred to Phase 2 plan:** dashboard receipt rows, `~Size`, retiring `anchor_price_usd` as a display price, `singleAnchorNotionals` cleanup. **Deferred to Phase 3 plan:** module collapse, moving `getLegMidAtBlock`, folding `isUsdcWethPair`. These are called out in the spec's Sequencing and are intentionally out of this plan.

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `MarketPriceResult` shape identical across Tasks 1/3/4; `MarketPriceDeps` mid-reader signature `(inputToken, outputToken, blockNumber) => Promise<number|null>` consistent between Task 3 definition and Task 4 step 3e construction; `PricingResult` new fields (`tier`, `methodology`, `marketPriceFlags`) added to *every* return path in Task 4 (branches 1, generic, partial). ✓

---

## Execution Handoff

Phase 1 is a standalone deliverable: the hardened apparatus + reconciliation guarantee, live behind `priceReceipt`, with the full core suite green. Phases 2 (dashboard rewire + retire the second ruler) and 3 (module collapse) get their own plans once this interface is real.
