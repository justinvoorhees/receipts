# Estimated Pricing Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show Execution Price, Market Price, and Price Delta for illiquid/multi-hop trades (e.g. WARP→ETH) by adding a best-effort `estimated` pricing tier, without a DB migration.

**Architecture:** Add an `estimated` value to `pricingStatus`. Ungate Execution Price (already computed from amounts). Derive a best-effort Market Price by pricing each side through its own **liquidity-floor-gated deepest `token/WETH` pool** and taking the ratio (Approach A) — deliberately NOT through the direct `token/USDC` pool, which is the dead-pool trap. Price Delta follows once Market exists. Best-effort numbers get a distinct UI treatment; Execution Price always renders solid.

**Tech Stack:** TypeScript, viem, Drizzle (no migration here), Next.js/React (dashboard), Vitest.

## Global Constraints

- `pricingStatus` stays a `text` column; the new `estimated` value needs **no migration**. (spec §1)
- Reuse existing on-chain, block-N-1 primitives; **no external price sources** and **no route-leg chaining** in this plan (Approaches B and C are deferred). (spec Non-goals)
- The estimated Market Price MUST be derived via the volatile token's deepest `token/WETH` pool, gated by a liquidity floor — never the direct `token/USDC` pool (that reintroduces the dead-pool bug fixed in commit 1ba9a32). (spec §3)
- Execution Price always renders solid (it is a fact); only Market Price and Price Delta carry the best-effort treatment on `estimated`. (spec §2, §6)
- NEVER-THROW contract of `priceReceipt` is preserved: any failure degrades to `partial`. (existing pricing.ts contract)
- Run all suites with `npx vitest run --exclude '**/.claude/**'` from repo root (stray agent worktrees otherwise pollute the run). Live-DB `queries.test.ts` needs `.env`; it is unrelated to this work.

---

### Task 1: Floor-gated bridged mid primitive (`getEstimatedMidAtBlock`)

**Files:**
- Modify: `packages/core/src/poolDiscovery.ts` (add `getDeepestPoolWithDepth`, refactor `getDeepestPoolForPair` to reuse it)
- Modify: `packages/core/src/tokenPricing.ts` (add `EstimatedMidReaders`, `getEstimatedMidAtBlock`, `ESTIMATED_MID_MIN_LIQUIDITY`)
- Test: `packages/core/src/tokenPricing.test.ts`

**Interfaces:**
- Consumes: `PairMidResult` (`{ price: number; poolAddress: string; poolKind: string }`), `sqrtPriceX96ToPrice(sqrtPriceX96: bigint, dec0: number, dec1: number): number`, `DiscoveredPool` (`{ address: \`0x${string}\`; kind: PoolKind }`), `readSlot0`, `readLiquidity` from `poolDiscovery.ts`.
- Produces:
  - `poolDiscovery.getDeepestPoolWithDepth(client, tokenA, tokenB, blockNumber?): Promise<{ pool: DiscoveredPool; depth: bigint } | null>`
  - `tokenPricing.EstimatedMidReaders` = `{ getDeepestPoolWithDepth: (a: string, b: string, block: bigint) => Promise<{ address: string; depth: bigint } | null>; readSlot0: (pool: string, block: bigint) => Promise<bigint | null>; readDecimals: (addr: string) => Promise<number> }`
  - `tokenPricing.getEstimatedMidAtBlock(readers: EstimatedMidReaders, inputToken: string, outputToken: string, blockNumber: bigint, minLiquidity: bigint): Promise<PairMidResult | null>` — returns output-per-input mid or null.
  - `tokenPricing.ESTIMATED_MID_MIN_LIQUIDITY: bigint`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/tokenPricing.test.ts` (create the file's imports if the file is new — check first; it already exists):

```ts
import { describe, expect, it } from 'vitest';
import { getEstimatedMidAtBlock, type EstimatedMidReaders } from './tokenPricing.js';

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';
const NATIVE = 'native';
const WARP = '0xd9159ad2d5fe625cd1f54f4d328fb19cb5262b07';
// sqrtPriceX96 encoding token1-per-token0 = 1 for equal-decimal tokens (2**96).
const SQRT_1 = 79228162514264337593543950336n; // 2**96

// A WETH/USDC pool priced so WETH = 2000 USDC, and a WARP/WETH pool priced so
// WARP = 0.0005 WETH. Both deep. Then market mid (ETH per WARP) for WARP->native
// = usdRef(WARP)/usdRef(ETH) = (0.0005*2000) / 2000 = 0.0005.
function makeReaders(over: Partial<EstimatedMidReaders> = {}): EstimatedMidReaders {
  return {
    getDeepestPoolWithDepth: async (a, b) => {
      const key = [a.toLowerCase(), b.toLowerCase()].sort().join('|');
      if (key === [WETH, USDC].sort().join('|')) return { address: '0xwethusdc', depth: 10n ** 24n };
      if (key === [WARP, WETH].sort().join('|')) return { address: '0xwarpweth', depth: 10n ** 24n };
      return null;
    },
    readSlot0: async () => SQRT_1, // both fake pools priced at raw 1:1 (see decimals below)
    readDecimals: async () => 18,
    ...over,
  };
}

describe('getEstimatedMidAtBlock', () => {
  it('bridges a volatile token to a USD anchor via its deepest token/WETH pool', async () => {
    // With SQRT_1 and equal decimals every pool reads raw price 1, so
    // usdRef(WARP)=1*1=1, usdRef(native)=1 → mid=1 (output-per-input). We only
    // assert it produced a positive, finite mid via the bridged path here.
    const res = await getEstimatedMidAtBlock(makeReaders(), WARP, NATIVE, 100n, 1n);
    expect(res).not.toBeNull();
    expect(res!.price).toBeGreaterThan(0);
    expect(res!.poolKind).toBe('estimated');
  });

  it('returns null when the volatile token’s deepest pool is below the liquidity floor', async () => {
    const readers = makeReaders({
      getDeepestPoolWithDepth: async (a, b) => {
        const key = [a.toLowerCase(), b.toLowerCase()].sort().join('|');
        if (key === [WETH, USDC].sort().join('|')) return { address: '0xwethusdc', depth: 10n ** 24n };
        if (key === [WARP, WETH].sort().join('|')) return { address: '0xwarpweth', depth: 0n }; // dead
        return null;
      },
    });
    const res = await getEstimatedMidAtBlock(readers, WARP, NATIVE, 100n, 1n);
    expect(res).toBeNull();
  });

  it('returns null when no WETH/USDC anchor pool is available', async () => {
    const readers = makeReaders({ getDeepestPoolWithDepth: async () => null });
    const res = await getEstimatedMidAtBlock(readers, WARP, NATIVE, 100n, 1n);
    expect(res).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --exclude '**/.claude/**' packages/core/src/tokenPricing.test.ts -t "getEstimatedMidAtBlock"`
Expected: FAIL — `getEstimatedMidAtBlock` is not exported.

- [ ] **Step 3: Add `getDeepestPoolWithDepth` to `poolDiscovery.ts`**

In `packages/core/src/poolDiscovery.ts`, replace the tail of `getDeepestPoolForPair` (the ranking loop that currently returns `best?.pool ?? null`, lines ~303-317) so the depth-bearing variant is the primitive and the existing function delegates:

```ts
  // Rank initialized candidates by depth. `liquidity()` may be unreadable on
  // some forks; such pools still qualify (depth treated as 0) so we never lose
  // an initialized pool purely because its depth read reverted.
  let best: { pool: DiscoveredPool; depth: bigint } | null = null;
  for (const cand of candidates) {
    const sqrtPriceX96 = await readSlot0(client, cand.address, blockNumber);
    if (sqrtPriceX96 === null || sqrtPriceX96 <= 0n) continue; // uninitialized
    const depth = (await readLiquidity(client, cand.address, blockNumber)) ?? 0n;
    if (best === null || depth > best.depth) {
      best = { pool: cand, depth };
    }
  }

  return best;
}

/**
 * Same discovery/ranking as `getDeepestPoolForPair` but returns only the pool
 * (back-compat for callers that don't need depth).
 */
export async function getDeepestPoolForPair(
  client: PublicClient,
  tokenA: string,
  tokenB: string,
  blockNumber?: bigint,
): Promise<DiscoveredPool | null> {
  const best = await getDeepestPoolWithDepth(client, tokenA, tokenB, blockNumber);
  return best?.pool ?? null;
}
```

Then rename the current `export async function getDeepestPoolForPair(...)` **declaration** (the one containing the candidate-gathering body) to `export async function getDeepestPoolWithDepth(...)` and change its return type to `Promise<{ pool: DiscoveredPool; depth: bigint } | null>`. (The candidate-gathering body above the ranking loop is unchanged.) Net: `getDeepestPoolWithDepth` holds the real logic and returns `{ pool, depth }`; `getDeepestPoolForPair` is the thin back-compat wrapper shown above.

- [ ] **Step 4: Add the estimated-mid derivation to `tokenPricing.ts`**

In `packages/core/src/tokenPricing.ts`, near the top constants (after the `NATIVE` constant added in commit 1ba9a32) add the floor, and near `getPairMidAtBlock` add the readers interface and function:

```ts
/**
 * Liquidity floor for the best-effort ("estimated") market mid. The deepest
 * `token/WETH` pool backing a volatile side must clear this in-range
 * `liquidity()` depth, else we refuse to quote a mid (tier stays `partial`).
 * A depth of 0 (dead pool) is always rejected. Conservative default — tune up
 * as we learn what depth is "trustworthy enough" for a given token.
 */
export const ESTIMATED_MID_MIN_LIQUIDITY = 1n;

export interface EstimatedMidReaders {
  getDeepestPoolWithDepth: (a: string, b: string, block: bigint) => Promise<{ address: string; depth: bigint } | null>;
  readSlot0: (pool: string, block: bigint) => Promise<bigint | null>;
  readDecimals: (addr: string) => Promise<number>;
}

/** WETH-per-token (or USDC-per-WETH for the anchor) via the deepest pool, no floor. */
async function midViaDeepest(
  readers: EstimatedMidReaders,
  tokenA: string,
  tokenB: string,
  block: bigint,
): Promise<{ price: number; depth: bigint } | null> {
  const disc = await readers.getDeepestPoolWithDepth(tokenA, tokenB, block);
  if (!disc) return null;
  const sqrt = await readers.readSlot0(disc.address, block);
  if (sqrt === null || sqrt <= 0n) return null;
  const inverted = tokenA.toLowerCase() > tokenB.toLowerCase();
  const token0 = inverted ? tokenB : tokenA;
  const token1 = inverted ? tokenA : tokenB;
  const [dec0, dec1] = await Promise.all([readers.readDecimals(token0), readers.readDecimals(token1)]);
  const raw = sqrtPriceX96ToPrice(sqrt, dec0, dec1); // token1 per token0
  const price = inverted ? (raw > 0 ? 1 / raw : 0) : raw; // tokenB per tokenA
  return { price, depth: disc.depth };
}

/** USD value of one unit of `token`, floor-gated for volatile tokens. */
async function usdRef(
  readers: EstimatedMidReaders,
  token: string,
  block: bigint,
  wethUsd: number,
  minLiquidity: bigint,
): Promise<number | null> {
  const t = token.toLowerCase();
  if (t === USDC) return 1;
  if (t === NATIVE || t === WETH) return wethUsd;
  // Volatile: price via the floor-gated deepest token/WETH pool. NEVER the
  // direct token/USDC pool (dead-pool trap).
  const m = await midViaDeepest(readers, t, WETH, block); // WETH per token
  if (m === null || m.depth < minLiquidity || m.price <= 0) return null;
  return m.price * wethUsd;
}

/**
 * Best-effort ("estimated") output-per-input market mid for a pair whose direct
 * pool is illiquid/absent. Prices each side independently through its deepest
 * `token/WETH` pool (Approach A) and returns the ratio. Returns null when either
 * side can't be priced above the liquidity floor. NEVER the direct token/USDC
 * pool. Reference block is the caller's (already N-1).
 */
export async function getEstimatedMidAtBlock(
  readers: EstimatedMidReaders,
  inputToken: string,
  outputToken: string,
  blockNumber: bigint,
  minLiquidity: bigint,
): Promise<PairMidResult | null> {
  const anchor = await midViaDeepest(readers, WETH, USDC, blockNumber); // USDC per WETH
  if (anchor === null || anchor.price <= 0) return null;
  const wethUsd = anchor.price;
  const usdIn = await usdRef(readers, inputToken, blockNumber, wethUsd, minLiquidity);
  const usdOut = await usdRef(readers, outputToken, blockNumber, wethUsd, minLiquidity);
  if (usdIn === null || usdOut === null || usdOut <= 0) return null;
  return { price: usdIn / usdOut, poolAddress: 'bridged', poolKind: 'estimated' };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run --exclude '**/.claude/**' packages/core/src/tokenPricing.test.ts`
Expected: PASS (existing tokenPricing tests + the 3 new ones).

- [ ] **Step 6: Build core to confirm no type breakage**

Run: `npm run build --workspace @fabric-tca/core`
Expected: no errors (the `getDeepestPoolForPair` refactor keeps its signature).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/poolDiscovery.ts packages/core/src/tokenPricing.ts packages/core/src/tokenPricing.test.ts
git commit -m "feat(core): floor-gated bridged market-mid primitive (Approach A)"
```

---

### Task 2: `estimated` tier in `priceReceipt`

**Files:**
- Modify: `packages/core/src/pricing.ts` (widen `PricingResult.status`, add `getEstimatedMid` to `PricingDeps` + default wiring, insert estimated branch)
- Test: `packages/core/src/pricing.test.ts`

**Interfaces:**
- Consumes: `getEstimatedMidAtBlock`, `EstimatedMidReaders`, `ESTIMATED_MID_MIN_LIQUIDITY` (Task 1); `getDeepestPoolWithDepth` (Task 1); existing `PricingResult`, `PricingDeps`, `bestEffortNotional`.
- Produces:
  - `PricingResult.status: 'full' | 'estimated' | 'partial'`
  - `PricingDeps.getEstimatedMid: (inputToken: string, outputToken: string, blockNumber: bigint) => Promise<PairMidResult | null>`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/pricing.test.ts`. First extend the `makeDeps` stub (in that file) to include the new dep — add this line inside the returned object of `makeDeps`, after `getUsdValue`:

```ts
    getEstimatedMid: async () => null,
```

Then add the tests:

```ts
  it('returns estimated when no full mid exists but a bridged mid is available', async () => {
    const r = await priceReceipt(
      { ...baseArgs, inputToken: EXOTIC_A, outputToken: EXOTIC_B },
      makeDeps({
        getPairMid: async () => null, // no direct pool → not full
        getEstimatedMid: async () => ({ price: 0.0005, poolAddress: 'bridged', poolKind: 'estimated' }),
        getUsdValue: async () => 135, // best-effort notional from the anchored side
      }),
    );
    expect(r.status).toBe('estimated');
    expect(r.marketMid).toBeCloseTo(0.0005, 9);
    expect(r.notionalUsd).toBe(135);
    // oracle-validation fields stay null on the estimated tier
    expect(r.chainlinkPrice).toBeNull();
  });

  it('stays partial when neither a full nor a bridged mid is available', async () => {
    const r = await priceReceipt(
      { ...baseArgs, inputToken: EXOTIC_A, outputToken: EXOTIC_B },
      makeDeps({ getPairMid: async () => null, getEstimatedMid: async () => null }),
    );
    expect(r.status).toBe('partial');
    expect(r.marketMid).toBeNull();
  });

  it('prefers full over estimated when a direct anchored mid exists', async () => {
    const r = await priceReceipt(
      { ...baseArgs, inputToken: EXOTIC_A, outputToken: USDC },
      makeDeps({
        getPairMid: async () => ({ price: 0.5, poolAddress: '0xpool', poolKind: 'univ3' }),
        getEstimatedMid: async () => ({ price: 999, poolAddress: 'bridged', poolKind: 'estimated' }),
        getUsdValue: async () => 500,
      }),
    );
    expect(r.status).toBe('full');
    expect(r.marketMid).toBeCloseTo(0.5, 9);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --exclude '**/.claude/**' packages/core/src/pricing.test.ts -t "estimated"`
Expected: FAIL — `status` is `'partial'` (no estimated branch yet) / `getEstimatedMid` unknown.

- [ ] **Step 3: Widen the status type**

In `packages/core/src/pricing.ts`, change the `PricingResult` status field:

```ts
  status: 'full' | 'estimated' | 'partial';
```

- [ ] **Step 4: Add the dep to the interface and default wiring**

In the `PricingDeps` interface add:

```ts
  /** Best-effort bridged mid (output-per-input) for illiquid pairs, or null. */
  getEstimatedMid: (inputToken: string, outputToken: string, blockNumber: bigint) => Promise<PairMidResult | null>;
```

Update the imports at the top of `pricing.ts` to include the new symbols:

```ts
import {
  makeRpcDecimalsCache,
  sqrtPriceX96ToPrice,
  getTokenUsdcValue,
  getEstimatedMidAtBlock,
  ESTIMATED_MID_MIN_LIQUIDITY,
  type PairMidResult,
} from './tokenPricing.js';
import { getDeepestPoolForPair, getDeepestPoolWithDepth, readSlot0 } from './poolDiscovery.js';
```

In `createDefaultPricingDeps` (where `decCache` and `poolReaders` are built, around line 170-200), add the default wiring to the returned deps object:

```ts
    getEstimatedMid: (inputToken, outputToken, blockNumber) =>
      getEstimatedMidAtBlock(
        {
          getDeepestPoolWithDepth: async (a, b, block) => {
            const best = await getDeepestPoolWithDepth(client, a, b, block);
            return best ? { address: best.pool.address, depth: best.depth } : null;
          },
          readSlot0: (pool, block) => readSlot0(client, pool as `0x${string}`, block),
          readDecimals: decCache,
        },
        inputToken,
        outputToken,
        blockNumber,
        ESTIMATED_MID_MIN_LIQUIDITY,
      ),
```

- [ ] **Step 5: Insert the estimated branch in `priceReceipt`**

In `priceReceipt`, between the Branch 2 `full` return (ends line ~351) and the final `partial` return (line ~353-355), insert:

```ts
    // ── Branch 2.5: best-effort estimated mid (illiquid/multi-hop pair) ──
    // No direct anchored pool, but we can bridge each side through its deepest
    // token/WETH pool above the liquidity floor. Best-effort, not oracle-validated.
    const estMid = await deps.getEstimatedMid(inputToken, outputToken, refBlock);
    if (estMid !== null && estMid.price > 0) {
      const notionalUsd = await bestEffortNotional(deps, args, refBlock);
      return {
        status: 'estimated',
        marketMid: estMid.price,
        notionalUsd,
        inputSymbol,
        outputSymbol,
        inputDecimals,
        outputDecimals,
        chainlinkPrice: null,
        poolDivergenceBps: null,
        manipulationFlag: false,
        chainlinkDevBps: null,
        offchainPrice: null,
        offchainDevBps: null,
        chainlinkStalenessSecs: null,
      };
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run --exclude '**/.claude/**' packages/core/src/pricing.test.ts`
Expected: PASS (all existing + 3 new).

- [ ] **Step 7: Build core**

Run: `npm run build --workspace @fabric-tca/core`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/pricing.ts packages/core/src/pricing.test.ts
git commit -m "feat(core): add 'estimated' pricing tier via bridged mid"
```

---

### Task 3: Ungate Execution/Market/Delta in `analyzeTransaction`

**Files:**
- Modify: `packages/core/src/analyzeTransaction.ts` (lines ~201, ~206-213, ~308-310)

**Interfaces:**
- Consumes: `PricingResult.status` now tri-state; `pricing.marketMid` populated on `estimated`.
- Produces: `Receipt.pricingStatus: 'full' | 'estimated' | 'partial'` (the `Receipt` interface field is currently typed `'full' | 'partial'` — widen it). `realizedPrice` non-null whenever `inputAmount > 0`; `marketMid`/`allInCostBps` non-null whenever a mid exists (full or estimated).

- [ ] **Step 1: Widen the Receipt type and read the current gating**

In `packages/core/src/analyzeTransaction.ts`, change the `Receipt` interface field:

```ts
  pricingStatus: 'full' | 'estimated' | 'partial';
```

Confirm the current computation block (around lines 201-213):

```ts
const isFull = pricing.status === 'full';
// ...
const realizedPrice = inputAmount > 0 ? outputAmount / inputAmount : null; // output per input
// ...
const marketMid = pricing.marketMid; // output-per-input, or null when partial
const allInCostBps =
  isFull && marketMid != null && marketMid > 0 && realizedPrice != null
    ? signedDeviationBps('sell_weth', marketMid, realizedPrice)
    : null;
```

- [ ] **Step 2: Add a `priced` flag and drop `isFull` from the price-field gates**

Immediately after `const isFull = pricing.status === 'full';` add:

```ts
// A market mid exists on both the oracle-validated (full) and best-effort
// (estimated) tiers; the Execution/Market/Delta rows key off THIS, not isFull.
const priced = pricing.marketMid != null;
```

Change the `allInCostBps` computation to drop `isFull`:

```ts
const allInCostBps =
  marketMid != null && marketMid > 0 && realizedPrice != null
    ? signedDeviationBps('sell_weth', marketMid, realizedPrice)
    : null;
```

- [ ] **Step 3: Ungate the three fields in the returned receipt**

In the returned object (around lines 308-310), change:

```ts
			realizedPrice: toDisplayPrice(realizedPrice, baseIsOutput),
			marketMid: priced ? toDisplayPrice(marketMid, baseIsOutput) : null,
			allInCostBps,
```

(Leave `executionBps`, `slippageBps`, `reconResidualBps`, and per-leg `priceImpactBps` gated on `isFull` — those are route-decomposition fields, out of scope for this plan. `pricingStatus: pricing.status` already passes the value through unchanged.)

- [ ] **Step 4: Build core**

Run: `npm run build --workspace @fabric-tca/core`
Expected: no errors.

- [ ] **Step 5: Run the core suite (regression)**

Run: `npx vitest run --exclude '**/.claude/**' packages/core`
Expected: PASS. (Behavior for `full`/`partial` trades is unchanged: `full` still has `marketMid` so `priced` is true; `partial` still has `marketMid == null` so Market/Delta stay null, and `realizedPrice` is now populated — no existing core test asserts `realizedPrice == null` for partial; if one does, update it to expect the computed value.)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/analyzeTransaction.ts
git commit -m "feat(core): ungate Execution Price; emit Market/Delta on estimated tier"
```

---

### Task 4: Receipt UI — best-effort treatment + Execution Price on every tier

**Files:**
- Modify: `packages/dashboard/components/ReceiptView.tsx` (lines ~263, ~344-371)
- Test: `packages/dashboard/components/ReceiptView.test.tsx`

**Interfaces:**
- Consumes: `row.pricingStatus` now `'full' | 'estimated' | 'partial'`; `row.marketMid` non-null on `estimated`.
- Produces: no exported API change (render behavior only).

- [ ] **Step 1: Write the failing tests**

Add to `packages/dashboard/components/ReceiptView.test.tsx` a new describe block (reuse the `fullUsdcWethRow` fixture already in that file):

```ts
describe('Receipt estimated pricing tier', () => {
  const estimatedRow = {
    ...fullUsdcWethRow,
    aggregator: 'fabric',
    pricingStatus: 'estimated',
    // best-effort mid + realized price present, but no oracle fields
    realizedPrice: '0.00000068',
    marketMid: '0.00000069',
    allInCostBps: '14',
    chainlinkPrice: null,
    manipulationFlag: false,
  };

  it('renders Execution, Market, and Delta on an estimated receipt with a best-effort marker', async () => {
    const { ReceiptView } = await import('./ReceiptView');
    const html = renderToStaticMarkup(
      <ReceiptView trade={estimatedRow as never} hash={estimatedRow.txHash} />,
    );
    // The three rows are present (not "Unavailable for this pair").
    expect(html).toContain('Realized Execution Price');
    expect(html).toContain('Market Price');
    expect(html).toContain('Price Delta');
    // Best-effort marker + honest tooltip, and NOT the oracle-validated copy.
    expect(html).toContain('est.');
    expect(html).toContain('not oracle-validated');
    expect(html).not.toContain('cross-referenced against an on-chain price oracle');
  });

  it('shows Execution Price on a fully partial receipt but leaves Market/Delta unavailable', async () => {
    const { ReceiptView } = await import('./ReceiptView');
    const partialRow = {
      ...fullUsdcWethRow,
      pricingStatus: 'partial',
      realizedPrice: '0.00000068',
      marketMid: null,
      allInCostBps: null,
    };
    const html = renderToStaticMarkup(
      <ReceiptView trade={partialRow as never} hash={partialRow.txHash} />,
    );
    // Execution Price now renders (previously "Unavailable for this pair").
    expect(html).toContain('Realized Execution Price');
    // Market/Delta still unavailable — exactly one "Unavailable" per those 2 rows.
    expect(html).toContain('Unavailable for this pair');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --exclude '**/.claude/**' packages/dashboard/components/ReceiptView.test.tsx -t "estimated pricing tier"`
Expected: FAIL — no `est.` marker; partial receipt shows `Unavailable` for Execution Price.

- [ ] **Step 3: Add tier flags in the component**

In `packages/dashboard/components/ReceiptView.tsx`, replace the `isPartial` line (~263) with:

```ts
	const isPartial = row.pricingStatus === 'partial';
	const isEstimated = row.pricingStatus === 'estimated';
	// Market Price / Price Delta render whenever a mid exists (full OR estimated).
	const hasMarketPrice = row.marketMid != null;
	const marketTooltip = isEstimated
		? 'Best-effort reference from the deepest on-chain pool at block N-1; not oracle-validated.'
		: 'Median of the traded pair’s reference pools at the trade’s block, cross-referenced against an on-chain price oracle';
	const estMark = isEstimated ? <span className="ml-2 text-[var(--color-secondary)]">est.</span> : null;
```

- [ ] **Step 4: Ungate Execution Price and re-gate Market/Delta**

Replace the three `DetailRow`s (Realized Execution Price / Market Price / Price Delta, lines ~344-371) with:

```tsx
				<DetailRow
					label="Realized Execution Price"
					subvalue={row.realizedPrice == null ? undefined : formatSubvalueUsd(Number(row.realizedPrice))}
				>
					{row.realizedPrice == null ? UNAVAILABLE : formatExecutionPrice(row.realizedPrice, priceUnit)}
				</DetailRow>
				<DetailRow
					label="Market Price"
					tooltip={marketTooltip}
					subvalue={hasMarketPrice ? formatSubvalueUsd(Number(row.marketMid)) : undefined}
				>
					{hasMarketPrice ? formatExecutionPrice(row.marketMid, priceUnit) : UNAVAILABLE}
					{hasMarketPrice ? estMark : null}
					{hasMarketPrice && row.manipulationFlag ? (
						<span
							className="ml-2"
							style={{ color: 'var(--color-yellow)' }}
							title="Median pool mid deviates from the reference oracle by more than 0.5% at N-1"
						>
							⚠ Possible manipulation
						</span>
					) : null}
				</DetailRow>
				<DetailRow
					label="Price Delta"
					subvalue={hasMarketPrice ? priceDeltaComparison(row.marketMid, row.realizedPrice) : undefined}
				>
					{hasMarketPrice ? formatDelta(row.marketMid, row.realizedPrice) : UNAVAILABLE}
					{hasMarketPrice ? estMark : null}
				</DetailRow>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run --exclude '**/.claude/**' packages/dashboard/components/ReceiptView.test.tsx`
Expected: PASS (existing + 2 new). If a pre-existing partial-state test asserted `Unavailable` for Execution Price, update it to expect the rendered execution price instead.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/components/ReceiptView.tsx packages/dashboard/components/ReceiptView.test.tsx
git commit -m "feat(dashboard): show Execution always; best-effort Market/Delta on estimated tier"
```

---

### Task 5: End-to-end verification on the real WARP→ETH tx

**Files:**
- Test: `packages/core/src/analyzeTransaction.test.ts` (add an RPC-gated e2e case alongside the existing ones)

**Interfaces:**
- Consumes: the full `analyzeTransaction` pipeline with all prior tasks.

- [ ] **Step 1: Inspect how existing RPC-gated e2e tests in this file guard on env**

Run: `grep -n "TCA_RPC_URL\|it.skipIf\|describe.skipIf\|process.env" packages/core/src/analyzeTransaction.test.ts`
Expected: shows the guard pattern (e.g. `it.skipIf(!process.env.TCA_RPC_URL)`). Use the SAME guard so the test skips without RPC.

- [ ] **Step 2: Write the e2e test using that guard**

Add to `packages/core/src/analyzeTransaction.test.ts` (match the file's existing guard style — shown here with `skipIf`):

```ts
it.skipIf(!process.env.TCA_RPC_URL)(
  'prices the WARP->ETH tx on the estimated tier (bridged mid + execution + delta)',
  async () => {
    const { analyzeTransaction } = await import('./analyzeTransaction.js');
    const r = await analyzeTransaction(
      '0xa21e4d82b961726614ce6f310e30e29a4b55b8eca1d6a46621c3adaf8edf6ab1',
      8453,
      { rpcUrl: process.env.TCA_RPC_URL! },
    );
    expect(r).not.toBeNull();
    expect(r!.pricingStatus).toBe('estimated');
    expect(r!.realizedPrice).not.toBeNull(); // execution price now populated
    expect(r!.marketMid).not.toBeNull();      // bridged via WARP/WETH
    expect(r!.allInCostBps).not.toBeNull();    // price delta follows
    // Oracle fields stay null on the estimated tier.
    expect(r!.chainlinkPrice).toBeNull();
  },
  30_000,
);
```

- [ ] **Step 3: Run the e2e test with RPC**

Run: `node --env-file=.env node_modules/.bin/vitest run --exclude '**/.claude/**' packages/core/src/analyzeTransaction.test.ts -t "estimated tier"`
Expected: PASS. (Without `.env` it SKIPS — that is acceptable, but run it once with `.env` to confirm real behavior.)

- [ ] **Step 4: Full suite regression**

Run: `npx vitest run --exclude '**/.claude/**'`
Expected: all pass (live-DB `queries.test.ts` needs `.env`; unrelated).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/analyzeTransaction.test.ts
git commit -m "test(core): e2e WARP->ETH lands on the estimated pricing tier"
```

---

## Self-Review

**Spec coverage:**
- §1 three-tier model → Task 2 (status widen) + Task 3 (Receipt type widen); no migration (text column) ✓
- §2 Execution Price ungated → Task 3 (realizedPrice always) + Task 4 (UI) ✓
- §3 Market Price via Approach A + liquidity floor, never direct token/USDC → Task 1 (`getEstimatedMidAtBlock` prices via `token/WETH` only, floor-gated) + Task 2 (branch) ✓
- §4 Price Delta follows when mid exists → Task 3 (`allInCostBps` gate drops `isFull`) ✓
- §5 tier classification & data flow, no migration → Tasks 2-3 ✓
- §6 UI: full unchanged, estimated distinct treatment, partial shows Execution only → Task 4 ✓
- §Testing: unit (Tasks 1,2), UI (Task 4), e2e WARP (Task 5) ✓
- Deferred B/C → not in any task (correctly out of scope) ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. Floor value is a concrete constant (`ESTIMATED_MID_MIN_LIQUIDITY = 1n`) with a documented tuning note, not a placeholder.

**Type consistency:** `getDeepestPoolWithDepth` returns `{ pool, depth }` (Task 1) and is adapted to `{ address, depth }` in the Task 2 default wiring ✓. `PricingResult.status` and `Receipt.pricingStatus` both widened to the same union ✓. `getEstimatedMid` signature identical in `PricingDeps` (Task 2), default wiring (Task 2), and stub (Task 2 test) ✓. `EstimatedMidReaders` shape identical in Task 1 definition, Task 1 test, and Task 2 wiring ✓.
