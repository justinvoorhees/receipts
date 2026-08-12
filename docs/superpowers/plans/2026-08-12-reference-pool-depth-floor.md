# Reference-Pool Depth Floor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a dust pool from becoming the market ruler — gate the ranked reference pool on an absolute USD depth floor, degrade the receipt honestly when it fails, and record which pool was used.

**Architecture:** Ranking already picks the deepest pool; this adds a floor on the *winner*, evaluated at selection time (once per decode, per `pinnedPool`), applied per liquidity class. A floored class is simply absent from `computeMarketPrice`'s estimator array — that reducer stays untouched and pure — so the rejection reason travels through a side-channel that `getMarketPriceForPair` merges into `flags`. The UI then separates two gates that were wrongly fused: whole-trade rows die with the ruler, per-leg rows do not.

**Tech Stack:** TypeScript, vitest, viem, Next.js (dashboard).

## Global Constraints

- `MIN_REFERENCE_DEPTH_USD = 100`. Calibrated 2026-08-12 against the 62-row corpus; see the spec's *Calibration* section.
- ⚠️ **`ESTIMATED_MID_MIN_LIQUIDITY` must be SPLIT, not raised.** It is compared against V3 virtual-liquidity `L` in one place and a `balanceOf` token amount in two others. Raising it applies a token threshold to an `L` value.
- ⚠️ **`computeMarketPrice` must not change.** It is the most heavily unit-tested function in the module and must stay pure over its existing signature.
- ⚠️ **`makeDecimalsCache` must keep throwing.** Do not add a `catch → null` (see `zero-fee-vs-unresolved-fee`).
- Methodology copy is fixed by Figma `733:504` and **must not state the threshold**:
  `Unavailable: The deepest reference pool for this token pair held $0.22 of liquidity. No reliable market price could be calculated.`
- Run tests **from the repo root** (`npx vitest run`). Running from `packages/dashboard` reports roughly half the suite.
- `npm test` does **not** typecheck. Run `npx tsc --build` and `npm run lint` separately; lint is what fails the Railway deploy.
- Baseline has **one pre-existing failure** (`resolveAggregator.test.ts`, caused by an uncommitted `configs/routers.json` edit from a parallel session, adding a `Uniswap` router with no `AGGREGATOR_SIGNATURES` entry). It is not ours. Do not fix, do not commit that file.

---

### Task 1: `depthUsd` + split the overloaded constant

**Files:**
- Modify: `packages/core/src/tokenPricing.ts:39` (constants), plus a new pure export
- Test: `packages/core/src/tokenPricing.test.ts`

**Interfaces:**
- Produces: `depthUsd(refToken: string, rawDepth: bigint, wethUsd: number, decimals: number): number | null`
- Produces: `MIN_REFERENCE_DEPTH_USD = 100`, `MIN_POOL_LIQUIDITY_L = 1n`
- Keeps: `ESTIMATED_MID_MIN_LIQUIDITY` exported as an alias of `MIN_POOL_LIQUIDITY_L` so existing importers keep compiling.

- [ ] **Step 1: Write the failing tests**

```ts
import { depthUsd, MIN_REFERENCE_DEPTH_USD, MIN_POOL_LIQUIDITY_L } from './tokenPricing.js';

const USDC_A = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const DAI_A = '0x50c5725949a6f0c72e6c4a641f24049a917db0cb';
const WETH_A = '0x4200000000000000000000000000000000000006';

describe('depthUsd', () => {
  it('values a USDC reference at its 6-decimal face', () => {
    expect(depthUsd(USDC_A, 1_500_000_000n, 1900, 6)).toBeCloseTo(1500, 6);
  });

  // The DAI trap: STABLECOINS holds USDC (6), USDbC (6) and DAI (18). Hardcoding
  // 1e6 for "a stable" would overstate a DAI pool by 1e12 and defeat the floor.
  it('uses the supplied decimals for an 18-decimal stable', () => {
    expect(depthUsd(DAI_A, 1_500_000_000_000_000_000_000n, 1900, 18)).toBeCloseTo(1500, 6);
  });

  it('values a WETH reference through wethUsd', () => {
    expect(depthUsd(WETH_A, 10n ** 18n, 1900, 18)).toBeCloseTo(1900, 6);
  });

  it('values native ETH like WETH', () => {
    expect(depthUsd('native', 10n ** 18n, 1900, 18)).toBeCloseTo(1900, 6);
  });

  it('reproduces the measured BEAN dust pool', () => {
    // 0x6945a4Bf held 115202102709082 wei WETH at wethUsd 1874.63 => $0.216
    expect(depthUsd(WETH_A, 115202102709082n, 1874.63, 18)).toBeCloseTo(0.216, 3);
  });

  it('returns null for a volatile reference token — the check is NOT performed', () => {
    expect(depthUsd('0x5c72992b83e74c4d5200a8e8920fb946214a5a5d', 10n ** 18n, 1900, 18)).toBeNull();
  });

  it('returns null rather than NaN when wethUsd is unusable', () => {
    expect(depthUsd(WETH_A, 10n ** 18n, 0, 18)).toBeNull();
    expect(depthUsd(WETH_A, 10n ** 18n, Number.NaN, 18)).toBeNull();
  });
});

describe('the split floor constants', () => {
  it('keeps the L sanity check at 1n and the USD floor separate', () => {
    expect(MIN_POOL_LIQUIDITY_L).toBe(1n);
    expect(MIN_REFERENCE_DEPTH_USD).toBe(100);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/core/src/tokenPricing.test.ts -t depthUsd`
Expected: FAIL — `depthUsd is not a function`.

- [ ] **Step 3: Implement**

Replace the `ESTIMATED_MID_MIN_LIQUIDITY` block in `tokenPricing.ts`:

```ts
/**
 * V3 virtual-liquidity (`L`) sanity floor: "this pool is not empty". This is
 * NOT a depth threshold and must never be raised to act as one — it is compared
 * against `readLiquidity()`, whose units are L, not tokens.
 */
export const MIN_POOL_LIQUIDITY_L = 1n;

/**
 * Back-compat alias. The old name was compared against BOTH an `L` value and a
 * `balanceOf` token amount, which is why the real depth floor below is a
 * separate, differently-typed constant.
 * @deprecated prefer MIN_POOL_LIQUIDITY_L
 */
export const ESTIMATED_MID_MIN_LIQUIDITY = MIN_POOL_LIQUIDITY_L;

/**
 * Absolute USD floor on the DEPTH of the ranked reference pool. Trade-independent
 * on purpose: two receipts on the same pair in the same block must get the same
 * market price (see single-ruler-market-price). Calibrated against the 62-row
 * corpus 2026-08-12 — every confirmed dust-ruler case measured <= $0.22, and the
 * next-thinnest corpus pool is $177.63.
 */
export const MIN_REFERENCE_DEPTH_USD = 100;

/**
 * USD value of a `balanceOf(refToken)` depth, or null when refToken is not
 * free-priceable (the check is then recorded as NOT PERFORMED, never as passed).
 *
 * ⚠️ `decimals` is a parameter, not an assumption: STABLECOINS holds DAI at 18
 * decimals alongside USDC/USDbC at 6. Hardcoding 1e6 for "a stable" would
 * overstate a DAI-referenced pool by 1e12 and silently defeat the floor.
 */
export function depthUsd(
  refToken: string,
  rawDepth: bigint,
  wethUsd: number,
  decimals: number,
): number | null {
  const t = refToken.toLowerCase();
  if (isStable(t)) return Number(rawDepth) / 10 ** decimals;
  if (isWeth(t) || isNative(t)) {
    if (!Number.isFinite(wethUsd) || wethUsd <= 0) return null;
    return (Number(rawDepth) / 10 ** decimals) * wethUsd;
  }
  return null;
}
```

Add `isStable, isWeth, isNative` to the existing `receiptPure.js` import in `tokenPricing.ts`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/core/src/tokenPricing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tokenPricing.ts packages/core/src/tokenPricing.test.ts
git commit -m "feat(pricing): add depthUsd and split the overloaded liquidity constant"
```

---

### Task 2: Gate the bridged class

**Files:**
- Modify: `packages/core/src/tokenPricing.ts` (`usdRef`, `getEstimatedMidAtBlock`)
- Test: `packages/core/src/tokenPricing.test.ts`

**Interfaces:**
- Produces: `export interface EstimatedMidOutcome { mid: PairMidResult | null; depthUsd: number | null; poolAddress: string | null; rejected: boolean; unverified: boolean }`
- Produces: `getEstimatedMidOutcome(readers, inputToken, outputToken, blockNumber, minLiquidity, minDepthUsd): Promise<EstimatedMidOutcome>`
- `getEstimatedMidAtBlock` keeps its exact current signature and return type, delegating to the above — existing callers are untouched.
- Consumes: `depthUsd` from Task 1.

**Reporting rule:** the reported `depthUsd`/`poolAddress` describe the **thinnest** priced side — that is the binding constraint and the one the methodology sentence must name.

- [ ] **Step 1: Write the failing test**

```ts
// Fake readers: BEAN/WETH is the measured dust pool; WETH/USDC is deep.
const WETH_L = '0x4200000000000000000000000000000000000006';
const USDC_L = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const BEAN = '0x5c72992b83e74c4d5200a8e8920fb946214a5a5d';

function fakeReaders(beanDepth: bigint) {
  return {
    getDeepestPoolWithDepth: async (a: string, b: string) => {
      const key = [a.toLowerCase(), b.toLowerCase()].sort().join('/');
      if (key === [WETH_L, USDC_L].sort().join('/')) {
        return { address: '0xdeep', depth: 20_000_000_000n, kind: 'univ3' }; // $20k USDC
      }
      return { address: '0x6945a4bf', depth: beanDepth, kind: 'univ3' };
    },
    // sqrtPriceX96 values chosen only to produce a positive mid; the gate is what's under test.
    readSlot0: async () => 79228162514264337593543950336n,
    readV2Reserves: async () => null,
    readDecimals: async (t: string) => (t.toLowerCase() === USDC_L ? 6 : 18),
  };
}

it('rejects the bridged class when the ranked winner is dust, and says why', async () => {
  const out = await getEstimatedMidOutcome(fakeReaders(115202102709082n), BEAN, USDC_L, 1n, 1n, 100);
  expect(out.mid).toBeNull();
  expect(out.rejected).toBe(true);
  expect(out.poolAddress).toBe('0x6945a4bf');
  expect(out.depthUsd).toBeLessThan(100);
});

it('admits a bridged class whose winner clears the floor, and still reports the depth', async () => {
  const out = await getEstimatedMidOutcome(fakeReaders(10n ** 18n), BEAN, USDC_L, 1n, 100);
  expect(out.rejected).toBe(false);
  expect(out.mid).not.toBeNull();
  expect(out.depthUsd).toBeGreaterThan(100); // reported even on the passing path
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/core/src/tokenPricing.test.ts -t bridged`
Expected: FAIL — `getEstimatedMidOutcome is not a function`.

- [ ] **Step 3: Implement**

Rewrite `usdRef` to return its evidence instead of a bare number, and add the outcome wrapper. `usdRef` becomes:

```ts
interface SideDepth { usd: number | null; pool: string | null; rejected: boolean; unverified: boolean }

async function usdRefGated(
  readers: EstimatedMidReaders,
  token: string,
  block: bigint,
  wethUsd: number,
  minLiquidity: bigint,
  minDepthUsd: number,
): Promise<{ price: number | null } & SideDepth> {
  const t = token.toLowerCase();
  if (t === USDC) return { price: 1, usd: null, pool: null, rejected: false, unverified: false };
  if (t === NATIVE || t === WETH) return { price: wethUsd, usd: null, pool: null, rejected: false, unverified: false };

  const disc = await readers.getDeepestPoolWithDepth(t, WETH, block);
  if (disc === null) return { price: null, usd: null, pool: null, rejected: false, unverified: false };

  const ref = pickReferenceToken(t, WETH);
  const dec = await readers.readDecimals(ref === NATIVE ? WETH : ref);
  const usd = depthUsd(ref, disc.depth, wethUsd, dec);
  // A depth we cannot value is recorded as UNVERIFIED and allowed through —
  // never silently treated as passing. See the spec's volatile/volatile gap.
  if (usd !== null && usd < minDepthUsd) {
    return { price: null, usd, pool: disc.address, rejected: true, unverified: false };
  }
  const m = await midViaDeepest(readers, t, WETH, block);
  if (m === null || m.depth < minLiquidity || m.price <= 0) {
    return { price: null, usd, pool: disc.address, rejected: false, unverified: usd === null };
  }
  return { price: m.price * wethUsd, usd, pool: disc.address, rejected: false, unverified: usd === null };
}
```

Then:

```ts
export interface EstimatedMidOutcome {
  mid: PairMidResult | null;
  depthUsd: number | null;
  poolAddress: string | null;
  rejected: boolean;
  unverified: boolean;
}

export async function getEstimatedMidOutcome(
  readers: EstimatedMidReaders,
  inputToken: string,
  outputToken: string,
  blockNumber: bigint,
  minLiquidity: bigint,
  minDepthUsd: number,
): Promise<EstimatedMidOutcome> {
  const none: EstimatedMidOutcome = { mid: null, depthUsd: null, poolAddress: null, rejected: false, unverified: false };

  const anchor = await midViaDeepest(readers, WETH, USDC, blockNumber);
  if (anchor === null || anchor.price <= 0 || anchor.depth < minLiquidity) return none;
  const wethUsd = anchor.price;

  const [a, b] = await Promise.all([
    usdRefGated(readers, inputToken, blockNumber, wethUsd, minLiquidity, minDepthUsd),
    usdRefGated(readers, outputToken, blockNumber, wethUsd, minLiquidity, minDepthUsd),
  ]);

  // Report the THINNEST priced side: it is the binding constraint and the pool
  // the methodology sentence must name.
  const sides = [a, b].filter((s) => s.usd !== null) as (typeof a)[];
  const thinnest = sides.length
    ? sides.reduce((lo, s) => ((s.usd as number) < (lo.usd as number) ? s : lo))
    : null;

  const base = {
    depthUsd: thinnest?.usd ?? null,
    poolAddress: thinnest?.pool ?? null,
    rejected: a.rejected || b.rejected,
    unverified: a.unverified || b.unverified,
  };

  if (a.price === null || b.price === null || b.price <= 0) return { ...base, mid: null };
  return { ...base, mid: { price: a.price / b.price, poolAddress: 'bridged', poolKind: 'estimated' } };
}
```

Keep the old export as a wrapper so no caller breaks:

```ts
export async function getEstimatedMidAtBlock(
  readers: EstimatedMidReaders,
  inputToken: string,
  outputToken: string,
  blockNumber: bigint,
  minLiquidity: bigint,
): Promise<PairMidResult | null> {
  const out = await getEstimatedMidOutcome(
    readers, inputToken, outputToken, blockNumber, minLiquidity, MIN_REFERENCE_DEPTH_USD,
  );
  return out.mid;
}
```

Import `pickReferenceToken` from `./poolFamilies.js`.

- [ ] **Step 4: Run the full core suite**

Run: `npx vitest run packages/core`
Expected: PASS (no regression in existing `getEstimatedMidAtBlock` tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tokenPricing.ts packages/core/src/tokenPricing.test.ts
git commit -m "feat(pricing): gate the bridged reference pool on a USD depth floor"
```

---

### Task 3: Gate the direct class, and collapse the two pool resolvers

**Files:**
- Modify: `packages/core/src/pricing.ts` (`PoolMidReaders`, `readMidFromPool` breadcrumb, `defaultGetPairMid`, `createDefaultPricingDeps`)
- Test: `packages/core/src/pricing.test.ts`

**Interfaces:**
- Changes: `PoolMidReaders.getDeepestPool` now returns `{ address: string; kind: string; depth: bigint } | null`.
- Produces: `defaultGetPairMidOutcome(readers, tokenIn, tokenOut, blockNumber, opts?: { minDepthUsd: number; wethUsd: number }): Promise<{ mid: PairMidResult | null; depthUsd: number | null; poolAddress: string | null; rejected: boolean }>`
- `defaultGetPairMid` keeps its signature, delegating with no `opts` (ungated) so the fast path and other callers are unchanged.

⚠️ In `createDefaultPricingDeps`, `resolveDeepest` and `resolveDeepestWithDepth` must **collapse into one pinned resolver**. Two separately-memoised resolvers double the RPC and, worse, could in principle gate one pool while pricing another.

- [ ] **Step 1: Write the failing test**

```ts
it('rejects a direct pool below the floor and reports it', async () => {
  const readers = {
    // Receipt 485's real shape: a v2 pool holding 3385 raw USDC = $0.0034
    getDeepestPool: async () => ({ address: '0x6e275225', kind: 'aerodrome_basic', depth: 3385n }),
    readSlot0: async () => null,
    readV2Reserves: async () => [3385n, 8778689381562459n] as [bigint, bigint],
    readLiquidity: async () => 0n,
    readDecimals: async (t: string) => (t.toLowerCase() === USDC_L ? 6 : 18),
  };
  const out = await defaultGetPairMidOutcome(readers, POD, USDC_L, 100n, { minDepthUsd: 100, wethUsd: 1900 });
  expect(out.rejected).toBe(true);
  expect(out.mid).toBeNull();
  expect(out.poolAddress).toBe('0x6e275225');
});

it('still returns the v2 mid when no floor is supplied (ungated callers unchanged)', async () => {
  const readers = { /* same as above */ };
  const out = await defaultGetPairMidOutcome(readers, POD, USDC_L, 100n);
  expect(out.rejected).toBe(false);
  expect(out.mid?.price).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/core/src/pricing.test.ts -t direct`
Expected: FAIL — `defaultGetPairMidOutcome is not a function`.

- [ ] **Step 3: Implement**

1. Widen the interface:

```ts
  getDeepestPool: (
    token0: string,
    token1: string,
    blockNumber: bigint,
  ) => Promise<{ address: string; kind: string; depth: bigint } | null>;
```

2. Add the gated outcome wrapper around the existing body of `defaultGetPairMid`; it resolves the pool once, gates, then calls the unchanged `readMidFromPool`:

```ts
export async function defaultGetPairMidOutcome(
  readers: PoolMidReaders,
  tokenIn: string,
  tokenOut: string,
  blockNumber: bigint,
  opts?: { minDepthUsd: number; wethUsd: number },
): Promise<{ mid: PairMidResult | null; depthUsd: number | null; poolAddress: string | null; rejected: boolean }> {
  const a = tokenIn.toLowerCase();
  const b = tokenOut.toLowerCase();
  const inverted = a > b;
  const pool = await readers.getDeepestPool(inverted ? b : a, inverted ? a : b, blockNumber);
  if (pool === null) return { mid: null, depthUsd: null, poolAddress: null, rejected: false };

  let usd: number | null = null;
  if (opts) {
    const ref = pickReferenceToken(a, b);
    const dec = await readers.readDecimals(isNative(ref) ? WETH : ref);
    usd = depthUsd(ref, pool.depth, opts.wethUsd, dec);
    if (usd !== null && usd < opts.minDepthUsd) {
      return { mid: null, depthUsd: usd, poolAddress: pool.address, rejected: true };
    }
  }

  const [dec0, dec1] = await Promise.all([
    readers.readDecimals(inverted ? b : a),
    readers.readDecimals(inverted ? a : b),
  ]);
  const price = await readMidFromPool(readers, pool, dec0, dec1, inverted, blockNumber);
  return {
    mid: price === null ? null : { price, poolAddress: pool.address, poolKind: pool.kind },
    depthUsd: usd,
    poolAddress: pool.address,
    rejected: false,
  };
}
```

Then reduce `defaultGetPairMid` to `(await defaultGetPairMidOutcome(readers, tokenIn, tokenOut, blockNumber)).mid`, preserving its exported signature.

3. Update the `readMidFromPool` v2 breadcrumb (`pricing.ts:194-196`) — the hole it warns about is now closed:

```ts
    // Deliberate asymmetry vs the v3 branch below: this rejects only a literal
    // zero reserve, with no depth floor beyond that. The depth guard it used to
    // ask for now lives OUTSIDE this function, in defaultGetPairMidOutcome,
    // applied in USD to the ranked winner — so basic-AMM pools are covered by
    // construction and this branch does not need its own. Corpus receipt 485 is
    // the regression: a $0.0034 aerodrome_basic pool that reaches here.
```

4. Collapse the resolvers in `createDefaultPricingDeps`:

```ts
  const resolveDeepestWithDepth = pin(async (a: string, b: string, block: bigint) => {
    const best = await getDeepestPoolWithDepth(client, a, b, block);
    return best ? { address: best.pool.address, depth: best.depth, kind: best.pool.kind } : null;
  });
```

Delete `resolveDeepest` and point `poolReaders.getDeepestPool` at `resolveDeepestWithDepth`. Remove the now-unused `getDeepestPoolForPair` import if nothing else in the file uses it.

- [ ] **Step 4: Run the full core suite**

Run: `npx vitest run packages/core`
Expected: PASS. Existing `pricing.test.ts` fake readers must be updated to return `depth` — that is expected churn, not a regression.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pricing.ts packages/core/src/pricing.test.ts
git commit -m "feat(pricing): gate the direct reference pool and collapse the pool resolvers"
```

---

### Task 4: Merge rejections into flags, without touching the reducer

**Files:**
- Modify: `packages/core/src/marketPrice.ts` (`MarketPriceDeps`, `getMarketPriceForPair`, `MarketPriceResult`)
- Test: `packages/core/src/marketPrice.test.ts`

**Interfaces:**
- Changes: `MarketPriceDeps.getDirectMid` / `getBridgedMid` return `Promise<MidOutcome>` where
  `export interface MidOutcome { price: number | null; depthUsd?: number | null; poolAddress?: string | null; rejected?: boolean; unverified?: boolean }`.
  `getOracleImpliedMid` is unchanged (`Promise<number | null>`) — the oracle has no pool.
- Changes: `MarketPriceResult` gains `referenceDepthUsd: number | null` and `referencePoolAddress: string | null`.
- ⚠️ `computeMarketPrice` is NOT modified.

- [ ] **Step 1: Write the failing test**

```ts
it('co-emits NO_LIQUIDITY and INSUFFICIENT_DEPTH when the floor emptied every class', async () => {
  const r = await getMarketPriceForPair({
    getDirectMid: async () => ({ price: null }),
    getBridgedMid: async () => ({ price: null, rejected: true, depthUsd: 0.216, poolAddress: '0x6945a4bf' }),
    getOracleImpliedMid: async () => null,
  }, 'a', 'b', 1n);

  expect(r.tier).toBe('none');
  expect(r.marketMid).toBeNull();
  expect(r.flags).toContain('NO_LIQUIDITY');      // from the reducer: zero classes
  expect(r.flags).toContain('INSUFFICIENT_DEPTH'); // from the merge: WHY
  expect(r.referenceDepthUsd).toBeCloseTo(0.216, 3);
  expect(r.referencePoolAddress).toBe('0x6945a4bf');
});

it('records depth on the PASSING path too, so a thin-but-passing ruler is visible', async () => {
  const r = await getMarketPriceForPair({
    getDirectMid: async () => ({ price: null }),
    getBridgedMid: async () => ({ price: 2, depthUsd: 250, poolAddress: '0xthin' }),
    getOracleImpliedMid: async () => null,
  }, 'a', 'b', 1n);

  expect(r.tier).toBe('estimated');
  expect(r.flags).not.toContain('INSUFFICIENT_DEPTH');
  expect(r.referenceDepthUsd).toBe(250);
  expect(r.referencePoolAddress).toBe('0xthin');
});

it('emits DEPTH_UNVERIFIED when depth could not be valued, and still allows the mid', async () => {
  const r = await getMarketPriceForPair({
    getDirectMid: async () => ({ price: 3, unverified: true }),
    getBridgedMid: async () => ({ price: null }),
    getOracleImpliedMid: async () => null,
  }, 'a', 'b', 1n);

  expect(r.marketMid).toBe(3);
  expect(r.flags).toContain('DEPTH_UNVERIFIED');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/core/src/marketPrice.test.ts -t INSUFFICIENT_DEPTH`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
export interface MidOutcome {
  price: number | null;
  depthUsd?: number | null;
  poolAddress?: string | null;
  rejected?: boolean;
  unverified?: boolean;
}

async function safeOutcome(
  fn: (a: string, b: string, blk: bigint) => Promise<MidOutcome>,
  a: string, b: string, blk: bigint,
): Promise<MidOutcome> {
  try {
    return await fn(a, b, blk);
  } catch {
    return { price: null };
  }
}

export async function getMarketPriceForPair(
  deps: MarketPriceDeps,
  inputToken: string,
  outputToken: string,
  blockNumber: bigint,
): Promise<MarketPriceResult> {
  const [d, b, o] = await Promise.all([
    safeOutcome(deps.getDirectMid, inputToken, outputToken, blockNumber),
    safeOutcome(deps.getBridgedMid, inputToken, outputToken, blockNumber),
    safeMid(deps.getOracleImpliedMid, inputToken, outputToken, blockNumber),
  ]);

  const estimators: Estimator[] = [];
  if (d.price != null) estimators.push({ price: d.price, class: 'direct', label: 'direct pool' });
  if (b.price != null) estimators.push({ price: b.price, class: 'bridged', label: 'WETH bridge' });
  if (o != null) estimators.push({ price: o, class: 'oracle', label: 'oracle ratio' });

  const base = computeMarketPrice(estimators); // UNCHANGED, still pure

  // A floored-out estimator is simply ABSENT above — byte-identical to one that
  // never existed. The reason is known only here, so it is merged in afterwards.
  const flags = [...base.flags];
  if (d.rejected || b.rejected) flags.push('INSUFFICIENT_DEPTH');
  if (d.unverified || b.unverified) flags.push('DEPTH_UNVERIFIED');

  // Prefer whichever side we actually have evidence for; on a tie the thinnest,
  // since that is the binding constraint.
  const withDepth = [d, b].filter((x) => x.depthUsd != null);
  const chosen = withDepth.length
    ? withDepth.reduce((lo, x) => ((x.depthUsd as number) < (lo.depthUsd as number) ? x : lo))
    : null;

  return {
    ...base,
    flags,
    referenceDepthUsd: chosen?.depthUsd ?? null,
    referencePoolAddress: chosen?.poolAddress ?? null,
  };
}
```

Add the two fields to `MarketPriceResult`, and have `computeMarketPrice`'s two `return` statements include `referenceDepthUsd: null, referencePoolAddress: null` so the type is satisfied without changing its behaviour.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/core/src/marketPrice.test.ts`
Expected: PASS, including every pre-existing `computeMarketPrice` test.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/marketPrice.ts packages/core/src/marketPrice.test.ts
git commit -m "feat(pricing): merge depth rejections into market-price flags"
```

---

### Task 5: Wire the deps, the methodology sentence, and the Receipt fields

**Files:**
- Modify: `packages/core/src/pricing.ts` (`createDefaultPricingDeps` closures, `methodologyFor`, `PricingResult`)
- Modify: `packages/core/src/analyzeTransaction.ts:225-250` (Receipt shape) and `:538-558` (assembly)
- Test: `packages/core/src/pricing.test.ts`

**Interfaces:**
- Consumes: `getEstimatedMidOutcome` (Task 2), `defaultGetPairMidOutcome` (Task 3), `MidOutcome` + the two new `MarketPriceResult` fields (Task 4).
- Produces: `PricingResult.referenceDepthUsd`, `PricingResult.referencePoolAddress`; same two fields on `Receipt`.

- [ ] **Step 1: Write the failing test**

```ts
it('names the pool and its measured depth, and never states the threshold', () => {
  const s = methodologyFor({
    tier: 'none', marketMid: null, corroboratedBy: [],
    flags: ['NO_LIQUIDITY', 'INSUFFICIENT_DEPTH'],
    referenceDepthUsd: 0.216, referencePoolAddress: '0x6945a4bf',
  });
  expect(s).toBe(
    'Unavailable: The deepest reference pool for this token pair held $0.22 of liquidity. ' +
    'No reliable market price could be calculated.',
  );
  expect(s).not.toContain('100');
  expect(s).not.toContain('minimum');
});

it('keeps the generic unavailable string when depth was not the reason', () => {
  const s = methodologyFor({
    tier: 'none', marketMid: null, corroboratedBy: [], flags: ['NO_LIQUIDITY'],
    referenceDepthUsd: null, referencePoolAddress: null,
  });
  expect(s).toBe('Unavailable: No reliable market price could be calculated.');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/core/src/pricing.test.ts -t threshold`
Expected: FAIL — currently returns the generic string.

- [ ] **Step 3: Implement**

1. `methodologyFor` — branch on the specific reason **before** the generic `tier === 'none'` line:

```ts
  if (mp.flags.includes('INSUFFICIENT_DEPTH')) {
    // Deliberately does NOT state the threshold: publishing the constant would
    // harden a tuning value into user-facing copy. Report the measured depth and
    // let it speak. Copy fixed by Figma 733:504.
    const d = mp.referenceDepthUsd;
    const amount = d == null ? 'negligible' : `$${d < 0.01 ? d.toPrecision(1) : d.toFixed(2)}`;
    return `Unavailable: The deepest reference pool for this token pair held ${amount} of liquidity. ` +
      'No reliable market price could be calculated.';
  }
  if (mp.tier === 'none') return 'Unavailable: No reliable market price could be calculated.';
```

2. In `createDefaultPricingDeps`, compute `wethUsd` once per pair (the anchor read is memoised by `rpcSession`, so this costs no extra round trip) and pass the outcomes through:

```ts
      getMarketPrice: async (inputToken, outputToken, blockNumber) => {
        const anchor = await midViaDeepest(bridgeReaders, WETH, USDC, blockNumber);
        const wethUsd = anchor?.price ?? null;
        return getMarketPriceForPair(
          {
            getDirectMid: async (i, o, blk) => {
              const out = await defaultGetPairMidOutcome(
                poolReaders, i, o, blk,
                wethUsd == null ? undefined : { minDepthUsd: MIN_REFERENCE_DEPTH_USD, wethUsd },
              );
              return { price: out.mid?.price ?? null, depthUsd: out.depthUsd, poolAddress: out.poolAddress, rejected: out.rejected };
            },
            getBridgedMid: async (i, o, blk) => {
              if (!bridgedIsIndependent(i, o)) return { price: null };
              const out = await getEstimatedMidOutcome(
                bridgeReaders, i, o, blk, MIN_POOL_LIQUIDITY_L, MIN_REFERENCE_DEPTH_USD,
              );
              return {
                price: out.mid?.price ?? null,
                depthUsd: out.depthUsd,
                poolAddress: out.poolAddress,
                rejected: out.rejected,
                unverified: out.unverified,
              };
            },
            getOracleImpliedMid: /* unchanged */,
          },
          inputToken, outputToken, blockNumber,
        );
      },
```

3. Add `referenceDepthUsd: number | null` and `referencePoolAddress: string | null` to `PricingResult`, to the `partial()` helper (both `null`), and to every `return` in `priceReceipt`, sourcing them from `mp`.

4. Add the same two fields to the `Receipt` interface in `analyzeTransaction.ts` and populate them in the assembly block:

```ts
			referenceDepthUsd: pricing.referenceDepthUsd,
			referencePoolAddress: pricing.referencePoolAddress,
```

⚠️ Populate them **regardless of `midReliable`** — a thin-but-passing ruler must stay visible.

- [ ] **Step 4: Run the full suite + typecheck**

Run: `npx vitest run` then `npx tsc --build`
Expected: PASS (except the known `resolveAggregator` baseline failure).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src
git commit -m "feat(pricing): surface reference depth, pool address, and the depth methodology"
```

---

### Task 6: Separate the per-leg gate from the whole-trade gate

**Files:**
- Modify: `packages/dashboard/components/receiptView.tsx:444` (Price Impact gate), `:216-218` + `:339-346` (Price Delta)
- Test: `packages/dashboard/components/receiptView.test.tsx`

**Interfaces:**
- Consumes: nothing new. `getPriceImpactRows` is already ruler-independent and already renders `N/A` (with a per-leg tooltip) or `–` for legs that have no impact — "when available" needs no new logic.

- [ ] **Step 1: Write the failing test**

```tsx
const flooredRow = {
  ...baseRow,
  pricingStatus: 'partial' as const,
  tier: 'none',
  marketMid: null, marketMidBefore: null, marketMidAfter: null,
  allInCostBps: null, slippageBps: null,
  routeReconstructed: true,
  routeLegs: [{ venue: '0x498581ff718922c3f8e6a244956af099b2652b2b', type: 'univ4',
    tokenIn: BEAN, tokenOut: WETH_L, lpFeeBps: 109.87, priceImpactBps: 61.14,
    tokenInSymbol: 'BEAN', tokenOutSymbol: 'WETH' }],
};

it('renders the real per-leg price impact even though the ruler is gone', () => {
  const html = renderToStaticMarkup(<ReceiptView row={flooredRow} />);
  expect(html).toContain('61.14bps');
});

it('still refuses the whole-trade rows, which DO depend on the ruler', () => {
  const html = renderToStaticMarkup(<ReceiptView row={flooredRow} />);
  const slippage = html.slice(html.indexOf('>Slippage<'));
  expect(slippage.slice(0, 400)).toContain('N/A');
  expect(html).toContain('>Total Execution Delta<');
});

it('drops the Price Delta row entirely when there is no market price', () => {
  const html = renderToStaticMarkup(<ReceiptView row={flooredRow} />);
  expect(html).not.toContain('>Price Delta<'); // anchored on the tag, not a substring
});
```

⚠️ Anchor label assertions on `'>Label<'`, never a bare substring — `Slippage` is a prefix of `Positive Slippage` (see `receipt-delta-labels-and-order`).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/dashboard/components/receiptView.test.tsx -t per-leg`
Expected: FAIL — Price Impact collapses to a single N/A, and Price Delta still renders.

- [ ] **Step 3: Implement**

1. Price Impact gate — drop `isPartial`, and simplify the tooltip that it made conditional:

```diff
-				{!routeReconstructed || isPartial ? (
+				{!routeReconstructed ? (
 					<BkdHeading
 						label="Price Impact"
 						value="N/A"
-						valueTooltip={routeReconstructed ? NULL_PRICE_TOOLTIP : NO_ROUTE_TOOLTIP}
+						valueTooltip={NO_ROUTE_TOOLTIP}
```

⚠️ Do **not** make this change to the Slippage / Positive Slippage / Total Execution Delta rows. Those are whole-trade quantities measured against the ruler and legitimately die with it; removing `isPartial` there would recreate the same conflation in the opposite direction.

2. Price Delta — render nothing rather than a second `N/A` under a `Market Price: N/A`:

```diff
-				<DetailRow
-					label="Price Delta"
-					subValue={priceDelta?.sub ?? undefined}
-					stackOnMobile
-					{...(hasMarketPrice ? {} : { valueTooltip: NULL_PRICE_TOOLTIP })}
-				>
-					{priceDelta?.text ?? 'N/A'}
-				</DetailRow>
+				{priceDelta != null && (
+					<DetailRow label="Price Delta" subValue={priceDelta.sub ?? undefined} stackOnMobile>
+						{priceDelta.text}
+					</DetailRow>
+				)}
```

- [ ] **Step 4: Run the dashboard suite from the repo root**

Run: `npx vitest run packages/dashboard`
Expected: PASS. Any existing test asserting `Price Delta` renders `N/A` on an unpriced receipt is now wrong by design — update it to assert absence.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/components/receiptView.tsx packages/dashboard/components/receiptView.test.tsx
git commit -m "fix(receipt): keep per-leg price impact when the market ruler is gone"
```

---

### Task 7: Link the reference pool in the methodology sentence

**Files:**
- Modify: `packages/dashboard/components/receipt/receiptDisplay.tsx` (`MethodologyText`)
- Modify: `packages/dashboard/components/receiptView.tsx` (pass `referencePoolAddress`)
- Test: `packages/dashboard/components/receiptView.test.tsx`

**Interfaces:**
- Consumes: `Receipt.referencePoolAddress` (Task 5).
- `MethodologyText` gains an optional `poolAddress?: string | null` prop. When present **and** the text contains the exact phrase `deepest reference pool`, that phrase renders as an explorer link with the standard dotted underline. Otherwise the text renders exactly as today.

- [ ] **Step 1: Write the failing test**

```tsx
it('links the deepest-reference-pool phrase to the pool that was actually used', () => {
  const html = renderToStaticMarkup(<ReceiptView row={{
    ...flooredRow,
    methodology: 'Unavailable: The deepest reference pool for this token pair held $0.22 of liquidity. No reliable market price could be calculated.',
    referencePoolAddress: '0x6945a4Bf3E7A68D86c4BFd863c6d664575D81545',
  }} />);
  expect(html).toContain('0x6945a4Bf3E7A68D86c4BFd863c6d664575D81545');
  expect(html).toContain('>deepest reference pool<');
});

it('leaves the sentence as plain text when no pool address was recorded', () => {
  const html = renderToStaticMarkup(<ReceiptView row={{
    ...flooredRow,
    methodology: 'Unavailable: The deepest reference pool for this token pair held $0.22 of liquidity. No reliable market price could be calculated.',
    referencePoolAddress: null,
  }} />);
  expect(html).toContain('deepest reference pool');
  expect(html).not.toContain('href="https://basescan.org/address/null"');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/dashboard/components/receiptView.test.tsx -t "deepest reference pool"`
Expected: FAIL — the phrase renders as plain text.

- [ ] **Step 3: Implement**

In `MethodologyText`, before the existing `/methodology` phrase-linking, split on the pool phrase:

```tsx
const POOL_PHRASE = 'deepest reference pool';

// The phrase is a link only when we know WHICH pool — the whole point of the
// field is that the reader can go and look at it.
if (poolAddress && text.includes(POOL_PHRASE)) {
  const [before, ...rest] = text.split(POOL_PHRASE);
  return (
    <>
      {before}
      <a
        href={explorerAddress(DEFAULT_CHAIN, poolAddress)}
        target="_blank"
        rel="noreferrer"
        className="underline decoration-dotted decoration-[8%] underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid"
      >
        {POOL_PHRASE}
      </a>
      {rest.join(POOL_PHRASE)}
    </>
  );
}
```

Pass `poolAddress={row.referencePoolAddress}` at the call site in `receiptView.tsx`.

- [ ] **Step 4: Run the full suite, typecheck, and lint**

Run: `npx vitest run` then `npx tsc --build` then `npm run lint`
Expected: PASS (except the known `resolveAggregator` baseline failure). Lint must be clean — it is what fails the Railway deploy.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard
git commit -m "feat(receipt): link the reference pool from the methodology sentence"
```

---

### Task 8: Prove it against the chain

**Files:**
- Modify: `packages/core/src/analyzeTransaction.e2e.test.ts` (or the existing RPC e2e file)

⚠️ The RPC e2e **skips silently** without `TCA_RPC_URL`. Export it properly — `source .env` does not export by itself:
`set -a && source .env && set +a`

- [ ] **Step 1: Write the e2e assertions**

```ts
// Bridged gate, positive sign, $81.68 notional (41x the motivating tx).
it('floors 0x7e21b6dc and refuses to publish a delta', async () => {
  const r = await analyzeTransaction('0x7e21b6dcc964e36ffb7921841d6c9bf00624dac086738843af561b7c7768b0ce', 8453, { rpcUrl });
  expect(r!.tier).toBe('none');
  expect(r!.marketMid).toBeNull();
  expect(r!.allInCostBps).toBeNull();
  expect(r!.marketPriceFlags).toContain('INSUFFICIENT_DEPTH');
  expect(r!.referenceDepthUsd!).toBeLessThan(1);
  expect(r!.referencePoolAddress!.toLowerCase()).toBe('0x6945a4bf3e7a68d86c4bfd863c6d664575d81545');
  // The route survives: per-leg impact is ruler-independent.
  expect(r!.routeLegs![0]).toMatchObject({ priceImpactBps: expect.any(Number) });
});

// The NEGATIVE-sign case. A test asserting a large POSITIVE delta would pass on
// every other case and miss this one entirely.
it('floors 0x1955c578, the windfall-shaped instance', async () => {
  const r = await analyzeTransaction('0x1955c578dab4a6dff4ca51e9bc5b7d164049868fb224dcd5aa32bb031365dcfa', 8453, { rpcUrl });
  expect(r!.tier).toBe('none');
  expect(r!.marketPriceFlags).toContain('INSUFFICIENT_DEPTH');
});

// Regression: a comfortably deep ruler must be UNAFFECTED.
it('leaves a deep reference pool alone', async () => {
  const r = await analyzeTransaction(WSTETH_TX, 8453, { rpcUrl });
  expect(r!.marketMid).not.toBeNull();
  expect(r!.marketPriceFlags).not.toContain('INSUFFICIENT_DEPTH');
  expect(r!.referenceDepthUsd!).toBeGreaterThan(100);
});
```

- [ ] **Step 2: Run with RPC**

Run: `set -a && source .env && set +a && npx vitest run packages/core/src/analyzeTransaction.e2e.test.ts`
Expected: PASS. If it reports "skipped", `TCA_RPC_URL` did not export — fix that before believing the result.

- [ ] **Step 3: Golden diff, captured SERIALLY**

Run:
```bash
node scripts/analysis/decodeGolden.mjs capture /tmp/after.json
node scripts/analysis/decodeGolden.mjs diff /tmp/before.json /tmp/after.json
```
(Capture `/tmp/before.json` on `main` first.) ⚠️ Serial only — concurrency produces false differences. Expect exactly the depth-gated receipts to change and no others; anything else is a regression.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/analyzeTransaction.e2e.test.ts
git commit -m "test(pricing): pin both depth-floor cases and a deep-pool regression"
```

---

## Self-Review

**Spec coverage.** Components 1–4 → Tasks 1, 2, 3, 5. Flag + field → Tasks 4, 5. Methodology copy + link → Tasks 5, 7. The `isPartial` / Price Delta corrections → Task 6. v2-reserves breadcrumb → Task 3 step 3. Testing section → Tasks 1–8, with the direct/v2 witness (receipt 485) used as the fake in Task 3 and the two signed cases in Task 8. **Deliberately out of scope, and recorded as such in the spec:** `getTokenUsdcValue` (the second ungated door) and rendering a depth row in the UI.

**Type consistency.** `depthUsd(refToken, rawDepth, wethUsd, decimals)` is used with four arguments in Tasks 2 and 3. `MidOutcome` is produced in Tasks 2/3 and consumed in Task 4. `referenceDepthUsd` / `referencePoolAddress` keep those exact names from `MarketPriceResult` → `PricingResult` → `Receipt` → the UI.

**Known gap.** Task 3's `defaultGetPairMidOutcome` re-derives `dec0`/`dec1` that `defaultGetPairMid` used to compute inline; confirm no caller depended on the old function's read ordering.
