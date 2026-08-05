# Three-Price Receipt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the receipt a Price Range section whose Market Price row shows the pool mid at three adjacent blocks plus their dispersion, without changing the pricing ruler.

**Architecture:** Core resolves the reference pool **once** and reads its state at three block tags (N−2 / N−1 / N), persisting two new mids alongside the existing `market_mid`. The dashboard renders the triple as a three-row table and derives the dispersion figure at read time. Separately, the receipt's three renderings of the execution delta are re-pointed at the single `reconciledResult` object they already partly share.

**Tech Stack:** TypeScript, Node 20, Next.js 15 (App Router), React 19, Tailwind v4, Drizzle ORM + PostgreSQL, viem, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-04-three-price-receipt-design.md`

**Branch:** `feat/three-price-receipt` (already created, off `main` at `2836e37`)

## Global Constraints

- **The pricing ruler does not move.** `pricing.ts:407` keeps `refBlock = blockNumber - 1n`. No task may change what `market_mid` means.
- **Row → block mapping is N−2 / N−1 / N** for Before / At / After. `At Block` is the ruler.
- **All three mids come from ONE pool**, resolved once. Re-discovering per block is forbidden — it would make the dispersion figure spatial rather than temporal.
- **Stored mids are display-oriented**, via `toDisplayPrice(mid, baseIsOutput)`. All three columns use the same orientation.
- **`(mid − realized)/mid` is NOT invariant under that inversion.** Any read-time derivation must go through `receiptDollars` (`qualityNotionals.ts:53`), never the stored columns directly.
- **Absent ≠ measured.** A failed block read renders `–`, never `0`. A dispersion figure over fewer than 3 points is omitted, never narrowed.
- **`npm test` does NOT typecheck.** Every task runs `npx tsc --build` as well.
- **Never run root `npm run build` while a dev server is live** — it writes into the same `.next`. Use `npx tsc --build`, or a detached worktree for a real build.
- **Do not push this branch to `main`.** `main` auto-deploys to Railway.
- Section heading is **"Transaction Cost"**, not "Cost Breakdown" (renamed in `2836e37`; Figma 650-3993 is stale).
- Figma's `0.1bps` in node 647-3470 is a **placeholder**. Never assert it.

---

## File Structure

**Core (`packages/core/src/`)**
- `pricing.ts` — modify. Extract `readMidFromPool` out of `defaultGetPairMid`; add `getPairMidTriple`; extend `PricingResult` with `marketMidBefore` / `marketMidAfter`.
- `analyzeTransaction.ts` — modify. Persist the two new mids under the same `midReliable` gate as `marketMid`.

**DB (`packages/db/`)**
- `src/schema.ts` — modify. Two nullable numeric columns.
- `drizzle/0003_*.sql` — generated.

**Dashboard (`packages/dashboard/components/receipt/`)**
- `priceDispersion.ts` — **create**. Pure σ-in-bps helper. No JSX, no imports from React. Its own file because it is the one piece of new math and deserves isolated tests.
- `receiptRows.tsx` — modify. Add `MarketPriceTable` (the three-row block).
- `priceFormat.ts` — modify. Token-denominated Price Delta sourced from `dollars`.
- `../receiptView.tsx` — modify. Section restructure, Gas Cost move, notional removal, bps re-pointing.

**Scripts (`scripts/`)**
- `snapshotReceipts.mjs` — **create**. Full-column corpus dump.
- `repopulateReceipts.mjs` — modify. `--snapshot=<path>` flag.

---

### Task 1: Database columns

**Files:**
- Modify: `packages/db/src/schema.ts:53`
- Create: `packages/db/drizzle/0003_*.sql` (generated — do not hand-write)

**Interfaces:**
- Consumes: nothing.
- Produces: `receipts.marketMidBefore` and `receipts.marketMidAfter`, both `numeric(...)` mapping to `market_mid_before` / `market_mid_after`, both nullable.

- [ ] **Step 1: Add the columns to the schema**

In `packages/db/src/schema.ts`, immediately after the `marketMid` line (currently line 53):

```typescript
		marketMid: numeric('market_mid'),
		// Mid at the two blocks adjacent to the ruler, for the receipt's intra-block
		// table. Same display orientation as marketMid (toDisplayPrice), same
		// midReliable gate — a partially-populated triple is not a valid state.
		// before = N-2, marketMid = N-1 (the ruler, "At Block"), after = N.
		marketMidBefore: numeric('market_mid_before'),
		marketMidAfter: numeric('market_mid_after'),
```

- [ ] **Step 2: Generate the migration**

```bash
npm run db:generate
```

Expected: a new `packages/db/drizzle/0003_<name>.sql` containing two `ALTER TABLE "receipts" ADD COLUMN` statements. Read the generated file and confirm it contains **only** those two statements — if it contains anything else, the schema has drifted and that must be resolved before continuing.

- [ ] **Step 3: Apply the migration**

```bash
npm run db:migrate
```

⚠️ Drizzle gates on `created_at < folderMillis` and **never verifies hashes** — a migration that was hand-edited after being applied will silently pass. Do not edit `0003_*.sql` after this step.

- [ ] **Step 4: Verify the columns exist and rebuild the db package**

```bash
npx tsc --build
```

Expected: exit 0. The `@fabric-tca/db` dist must be rebuilt after a schema edit or drizzle omits the new columns from downstream consumers.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle
git commit -m "feat(db): add market_mid_before / market_mid_after columns"
```

---

### Task 2: Extract `readMidFromPool` (pure refactor)

**Files:**
- Modify: `packages/core/src/pricing.ts:179-224`
- Test: `packages/core/src/pricing.test.ts`

**Interfaces:**
- Consumes: `PoolMidReaders`, `PairMidResult` (both already exported from `pricing.ts`).
- Produces:
  ```typescript
  async function readMidFromPool(
    readers: PoolMidReaders,
    pool: { address: string; kind: string },
    dec0: number,
    dec1: number,
    inverted: boolean,
    blockNumber: bigint,
  ): Promise<number | null>
  ```
  Returns the orientation-corrected price, or `null` when the pool state is unreadable / empty / boundary-pinned.

This task changes **no behavior**. It exists so Task 3 can read three blocks from one pool without duplicating the v2/v3 branch logic.

- [ ] **Step 1: Run the existing pricing tests to establish the baseline**

```bash
npx vitest run packages/core/src/pricing.test.ts
```

Expected: PASS. Record the test count — it must be identical at the end of this task.

- [ ] **Step 2: Extract the helper**

In `packages/core/src/pricing.ts`, add above `defaultGetPairMid`:

```typescript
/**
 * Read one pool's mid at one block. Split out of defaultGetPairMid so the
 * three-block sampler can reuse an ALREADY-RESOLVED pool rather than
 * re-discovering per block — re-discovery could rank a different pool at a
 * different block, which would make the receipt's "deviation between blocks"
 * measure space instead of time.
 *
 * `inverted` is the caller's tokenIn > tokenOut ordering, not a pool property.
 */
async function readMidFromPool(
  readers: PoolMidReaders,
  pool: { address: string; kind: string },
  dec0: number,
  dec1: number,
  inverted: boolean,
  blockNumber: bigint,
): Promise<number | null> {
  let rawPrice: number; // token1 per token0

  if (mechanismForKind(pool.kind as PoolKind) === 'v2-reserves') {
    const reserves = await readers.readV2Reserves(pool.address, blockNumber);
    if (reserves === null || reserves[0] === 0n || reserves[1] === 0n) return null;
    rawPrice = v2MidFromReserves(reserves[0], reserves[1], dec0, dec1);
  } else {
    const sqrtPriceX96 = await readers.readSlot0(pool.address, blockNumber);
    if (sqrtPriceX96 === null) return null;
    if (sqrtPriceX96 <= MIN_SQRT_RATIO + 1n || sqrtPriceX96 >= MAX_SQRT_RATIO - 1n) return null;
    const liquidity = await readers.readLiquidity(pool.address, blockNumber);
    if (liquidity === null || liquidity < ESTIMATED_MID_MIN_LIQUIDITY) return null;
    rawPrice = sqrtPriceX96ToPrice(sqrtPriceX96, dec0, dec1);
  }

  const price = inverted ? (rawPrice > 0 ? 1 / rawPrice : 0) : rawPrice;
  return price > 0 ? price : null;
}
```

- [ ] **Step 3: Rewrite `defaultGetPairMid` to call it**

Replace the body of `defaultGetPairMid` from `const [dec0, dec1] = ...` through the final `return` with:

```typescript
  const [dec0, dec1] = await Promise.all([readers.readDecimals(token0), readers.readDecimals(token1)]);
  const price = await readMidFromPool(readers, pool, dec0, dec1, inverted, blockNumber);
  if (price === null) return null;
  return { price, poolAddress: pool.address, poolKind: pool.kind };
```

Leave the lines above it (`inLc` / `outLc` / `inverted` / `token0` / `token1` / `getDeepestPool` / `if (!pool) return null;`) untouched.

- [ ] **Step 4: Verify identical behavior**

```bash
npx vitest run packages/core/src/pricing.test.ts
npx tsc --build
```

Expected: the **same test count** as Step 1, all passing, tsc exit 0. A changed count means this stopped being a pure refactor.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pricing.ts
git commit -m "refactor(core): extract readMidFromPool from defaultGetPairMid"
```

---

### Task 3: `getPairMidTriple` — one pool, three blocks

**Files:**
- Modify: `packages/core/src/pricing.ts`
- Test: `packages/core/src/pricing.test.ts`

**Interfaces:**
- Consumes: `readMidFromPool` (Task 2), `PoolMidReaders`.
- Produces:
  ```typescript
  export interface PairMidTriple {
    before: number | null;  // N-2
    at: number | null;      // N-1, the ruler
    after: number | null;   // N
    poolAddress: string;
    poolKind: string;
  }

  export async function getPairMidTriple(
    readers: PoolMidReaders,
    tokenIn: string,
    tokenOut: string,
    refBlock: bigint,       // N-1
  ): Promise<PairMidTriple | null>
  ```
  Returns `null` only when the pool itself cannot be resolved. Individual block failures surface as `null` fields.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/pricing.test.ts`:

```typescript
describe('getPairMidTriple', () => {
  const POOL = { address: '0xpool', kind: 'univ3' };
  // token0 < token1 so `inverted` is false and the raw price passes through.
  const TOKEN_IN = '0x1111111111111111111111111111111111111111';
  const TOKEN_OUT = '0x2222222222222222222222222222222222222222';

  function makeReaders(slot0ByBlock: Record<string, bigint | null>) {
    const calls = { getDeepestPool: 0, readSlot0: [] as bigint[] };
    return {
      calls,
      readers: {
        getDeepestPool: async () => { calls.getDeepestPool++; return POOL; },
        readDecimals: async () => 18,
        readSlot0: async (_addr: string, blk: bigint) => {
          calls.readSlot0.push(blk);
          return slot0ByBlock[String(blk)] ?? null;
        },
        readLiquidity: async () => 10n ** 18n,
        readV2Reserves: async () => null,
      } as never,
    };
  }

  // 2^96 = a price of exactly 1.0 at equal decimals.
  const Q96 = 2n ** 96n;

  it('resolves the pool ONCE and reads state at N-2, N-1 and N', async () => {
    const { readers, calls } = makeReaders({ '98': Q96, '99': Q96, '100': Q96 });
    const { getPairMidTriple } = await import('./pricing.js');
    const triple = await getPairMidTriple(readers, TOKEN_IN, TOKEN_OUT, 99n);

    // The invariant this whole feature rests on: one discovery, three reads.
    // Re-discovering per block could rank a different pool at a different
    // block, making the dispersion figure spatial rather than temporal.
    expect(calls.getDeepestPool).toBe(1);
    expect(calls.readSlot0).toEqual([98n, 99n, 100n]);
    expect(triple?.poolAddress).toBe('0xpool');
    expect(triple?.at).toBeCloseTo(1, 10);
  });

  it('returns null for an individual block that cannot be read, not for the whole triple', async () => {
    const { readers } = makeReaders({ '98': null, '99': Q96, '100': Q96 });
    const { getPairMidTriple } = await import('./pricing.js');
    const triple = await getPairMidTriple(readers, TOKEN_IN, TOKEN_OUT, 99n);

    expect(triple).not.toBeNull();
    expect(triple?.before).toBeNull();
    expect(triple?.at).toBeCloseTo(1, 10);
    expect(triple?.after).toBeCloseTo(1, 10);
  });

  it('returns null when the pool cannot be resolved at all', async () => {
    const { getPairMidTriple } = await import('./pricing.js');
    const readers = {
      getDeepestPool: async () => null,
      readDecimals: async () => 18,
      readSlot0: async () => null,
      readLiquidity: async () => null,
      readV2Reserves: async () => null,
    } as never;
    expect(await getPairMidTriple(readers, TOKEN_IN, TOKEN_OUT, 99n)).toBeNull();
  });

  it('never reads a negative block number', async () => {
    const { readers, calls } = makeReaders({ '0': Q96, '1': Q96 });
    const { getPairMidTriple } = await import('./pricing.js');
    await getPairMidTriple(readers, TOKEN_IN, TOKEN_OUT, 0n);
    expect(calls.readSlot0.every((b) => b >= 0n)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run packages/core/src/pricing.test.ts -t 'getPairMidTriple'
```

Expected: FAIL — `getPairMidTriple is not a function`.

- [ ] **Step 3: Implement**

In `packages/core/src/pricing.ts`, after `defaultGetPairMid`:

```typescript
export interface PairMidTriple {
  /** N-2 — the receipt's "Before Block" row. */
  before: number | null;
  /** N-1 — the ruler. Equals what defaultGetPairMid returns. */
  at: number | null;
  /** N — the receipt's "After Block" row. Contains the trade's own impact. */
  after: number | null;
  poolAddress: string;
  poolKind: string;
}

/**
 * Sample ONE pool's mid at three adjacent blocks around the ruler.
 *
 * The pool is resolved once, at the ruler block, and reused for all three
 * reads. Pool discovery is block-invariant (getPool is a deterministic CREATE2
 * address), so this is both correct and cheap: +2 calls over the single-block
 * path. Re-discovering per block would be ~2x wall AND could rank a different
 * pool at a different block, silently turning the receipt's "deviation between
 * blocks" into a comparison of two different pools.
 *
 * A failed read for one block yields `null` for that field only. The caller
 * must render an absent mid as unavailable, never as zero.
 */
export async function getPairMidTriple(
  readers: PoolMidReaders,
  tokenIn: string,
  tokenOut: string,
  refBlock: bigint,
): Promise<PairMidTriple | null> {
  const inLc = tokenIn.toLowerCase();
  const outLc = tokenOut.toLowerCase();
  const inverted = inLc > outLc;
  const token0 = inverted ? outLc : inLc;
  const token1 = inverted ? inLc : outLc;

  const pool = await readers.getDeepestPool(token0, token1, refBlock);
  if (!pool) return null;

  const [dec0, dec1] = await Promise.all([readers.readDecimals(token0), readers.readDecimals(token1)]);

  // Clamp at genesis rather than underflowing to a negative block tag.
  const beforeBlock = refBlock > 0n ? refBlock - 1n : refBlock;
  const afterBlock = refBlock + 1n;

  const [before, at, after] = await Promise.all([
    readMidFromPool(readers, pool, dec0, dec1, inverted, beforeBlock),
    readMidFromPool(readers, pool, dec0, dec1, inverted, refBlock),
    readMidFromPool(readers, pool, dec0, dec1, inverted, afterBlock),
  ]);

  return { before, at, after, poolAddress: pool.address, poolKind: pool.kind };
}
```

- [ ] **Step 4: Run to verify they pass**

```bash
npx vitest run packages/core/src/pricing.test.ts
npx tsc --build
```

Expected: PASS, tsc exit 0.

- [ ] **Step 5: Mutation-check the shared-pool assertion**

Temporarily change `readers.getDeepestPool` to be called inside each `readMidFromPool` call (i.e. move discovery into the `Promise.all`). Re-run:

```bash
npx vitest run packages/core/src/pricing.test.ts -t 'resolves the pool ONCE'
```

Expected: **FAIL** on `expect(calls.getDeepestPool).toBe(1)`. Then revert. If it passes, the assertion is vacuous and must be fixed before continuing.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/pricing.ts packages/core/src/pricing.test.ts
git commit -m "feat(core): add getPairMidTriple — one pool, three adjacent blocks"
```

---

### Task 4: Surface the triple on `PricingResult`

**Files:**
- Modify: `packages/core/src/pricing.ts:88-108` (`PricingResult`), and both return branches of `priceReceipt`
- Test: `packages/core/src/pricing.test.ts`

**Interfaces:**
- Consumes: `getPairMidTriple` (Task 3), `PairMidTriple`.
- Produces: two new fields on `PricingResult`:
  ```typescript
  marketMidBefore: number | null;  // output-per-input at N-2
  marketMidAfter: number | null;   // output-per-input at N
  ```
  Same orientation as the existing `marketMid` (output-per-input at this layer; `analyzeTransaction` applies `toDisplayPrice` to all three in Task 6).

- [ ] **Step 1: Write the failing test**

```typescript
it('returns the adjacent-block mids alongside marketMid', async () => {
  const { priceReceipt } = await import('./pricing.js');
  const result = await priceReceipt(
    {
      rpcUrl: 'http://unused',
      blockNumber: 100n,
      chainId: 8453,
      inputToken: '0x1111111111111111111111111111111111111111',
      outputToken: '0x2222222222222222222222222222222222222222',
      inputAmountRaw: 10n ** 18n,
      outputAmountRaw: 10n ** 18n,
    },
    {
      readSymbol: async () => 'TKN',
      readDecimals: async () => 18,
      getPairMidTriple: async () => ({
        before: 2.0, at: 2.1, after: 2.2, poolAddress: '0xpool', poolKind: 'univ3',
      }),
      getMarketPrice: async () => ({
        price: 2.1, tier: 'full' as const, methodology: 'Verified: test.', flags: [],
      }),
    } as never,
  );

  expect(result.marketMid).toBeCloseTo(2.1, 10);
  expect(result.marketMidBefore).toBeCloseTo(2.0, 10);
  expect(result.marketMidAfter).toBeCloseTo(2.2, 10);
});

it('leaves the adjacent mids null on the partial path', async () => {
  const { priceReceipt } = await import('./pricing.js');
  const result = await priceReceipt(
    {
      rpcUrl: 'not-a-url',
      blockNumber: 100n,
      chainId: 8453,
      inputToken: '0x1111111111111111111111111111111111111111',
      outputToken: '0x2222222222222222222222222222222222222222',
      inputAmountRaw: 0n,
      outputAmountRaw: 0n,
    },
    {} as never,
  );
  expect(result.status).toBe('partial');
  expect(result.marketMid).toBeNull();
  expect(result.marketMidBefore).toBeNull();
  expect(result.marketMidAfter).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run packages/core/src/pricing.test.ts -t 'adjacent'
```

Expected: FAIL — the properties do not exist.

- [ ] **Step 3: Extend the interface and the DI seam**

In `PricingResult` (after `marketMid`, line 91):

```typescript
  /** Output-per-input mid at N-2 and N, from the SAME pool as marketMid. */
  marketMidBefore: number | null;
  marketMidAfter: number | null;
```

In `PricingDeps`, after `getPairMid`:

```typescript
  /** Same pool as getPairMid, sampled at refBlock-1, refBlock, refBlock+1. */
  getPairMidTriple: (
    tokenIn: string,
    tokenOut: string,
    refBlock: bigint,
  ) => Promise<PairMidTriple | null>;
```

In `createDefaultPricingDeps`, alongside the existing `getPairMid` entry:

```typescript
    getPairMidTriple: (tokenIn, tokenOut, refBlock) =>
      getPairMidTriple(poolReaders, tokenIn, tokenOut, refBlock),
```

In the `partial()` factory inside `priceReceipt`, add to the returned object:

```typescript
    marketMidBefore: null,
    marketMidAfter: null,
```

- [ ] **Step 4: Populate on the success paths**

In `priceReceipt`, after the deps are constructed and before the branch returns, add:

```typescript
    // Sampled from the same pool as the ruler. Never throws: a failure here must
    // degrade the two extra rows, not the receipt.
    const triple = await deps
      .getPairMidTriple(inputToken, outputToken, refBlock)
      .catch(() => null);
```

Add `marketMidBefore: triple?.before ?? null,` and `marketMidAfter: triple?.after ?? null,` to **both** the USDC/WETH fast-path return object and the general-path return object.

- [ ] **Step 5: Run to verify it passes**

```bash
npx vitest run packages/core/src/pricing.test.ts
npx tsc --build
```

Expected: PASS, tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/pricing.ts packages/core/src/pricing.test.ts
git commit -m "feat(core): surface adjacent-block mids on PricingResult"
```

---

### Task 5: Persist the triple

**Files:**
- Modify: `packages/core/src/analyzeTransaction.ts:188` (the `marketMid` field on the result type) and `:457` (the persist expression)
- Test: `packages/core/src/analyzeTransaction.test.ts`

**Interfaces:**
- Consumes: `PricingResult.marketMidBefore` / `.marketMidAfter` (Task 4).
- Produces: `Receipt.marketMidBefore` / `.marketMidAfter`, display-oriented, nulled whenever `marketMid` is.

- [ ] **Step 1: Write the failing test**

```typescript
it('nulls the adjacent mids whenever it nulls marketMid', async () => {
  // An implausible deviation makes the reference mid garbage. marketMid is
  // already nulled here; the two adjacent mids MUST die in the same breath —
  // a triple with a null centre and non-null wings is not a valid state, and
  // would render a table straddling a mid the receipt refuses to show.
  const receipt = await analyzeWithImplausibleMid();
  expect(receipt.marketMid).toBeNull();
  expect(receipt.marketMidBefore).toBeNull();
  expect(receipt.marketMidAfter).toBeNull();
});

it('stores the adjacent mids in the same display orientation as marketMid', async () => {
  // baseIsOutput inverts marketMid on the way to storage. If the wings are not
  // inverted identically, the table renders one row upside down against its
  // neighbours and nothing flags it.
  const receipt = await analyzeWithBaseIsOutput();
  expect(receipt.marketMidBefore).toBeLessThan(1);
  expect(receipt.marketMidAfter).toBeLessThan(1);
  expect(receipt.marketMid).toBeLessThan(1);
});
```

Build `analyzeWithImplausibleMid` / `analyzeWithBaseIsOutput` from the existing fixtures in that file — follow whatever DI pattern the neighbouring tests already use rather than inventing a new one.

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run packages/core/src/analyzeTransaction.test.ts -t 'adjacent mids'
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Add to the result interface near line 188:

```typescript
	marketMidBefore: number | null;
	marketMidAfter: number | null;
```

Replace line 457 with:

```typescript
			marketMid: midReliable ? toDisplayPrice(marketMid, baseIsOutput) : null,
			// Same gate, same orientation, same expression shape as marketMid above.
			// These three are one value or none — see the design spec §3.
			marketMidBefore:
				midReliable && pricing.marketMidBefore != null
					? toDisplayPrice(pricing.marketMidBefore, baseIsOutput)
					: null,
			marketMidAfter:
				midReliable && pricing.marketMidAfter != null
					? toDisplayPrice(pricing.marketMidAfter, baseIsOutput)
					: null,
```

- [ ] **Step 4: Wire through the persistence layer**

Add both fields to:
- `scripts/repopulateReceipts.mjs` `toUpdate()` — `marketMidBefore: num(r.marketMidBefore), marketMidAfter: num(r.marketMidAfter),` next to the existing `marketMid` entry.
- `packages/dashboard/app/api/receipts/route.ts:130` area — mirror the existing `marketMid` handling.

- [ ] **Step 5: Run the full suite**

```bash
npm test && npx tsc --build
```

Expected: all green, tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/analyzeTransaction.ts packages/core/src/analyzeTransaction.test.ts scripts/repopulateReceipts.mjs packages/dashboard/app/api/receipts/route.ts
git commit -m "feat(core): persist adjacent-block mids under the midReliable gate"
```

---

### Task 6: Dispersion helper

**Files:**
- Create: `packages/dashboard/components/receipt/priceDispersion.ts`
- Test: `packages/dashboard/components/receipt/priceDispersion.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```typescript
  export function dispersionBps(
    before: unknown, at: unknown, after: unknown,
  ): number | null

  export function dispersionClause(
    before: unknown, at: unknown, after: unknown,
  ): string
  ```
  `dispersionBps` returns `null` unless **all three** are finite positive numbers. `dispersionClause` returns `''` when `dispersionBps` is null, else `` `Price deviates ${n.toFixed(2)}bps between blocks.` ``

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { dispersionBps, dispersionClause } from './priceDispersion';

describe('dispersionBps', () => {
  it('is population sigma relative to the At Block mid', () => {
    // mean 35.022467, population sigma 0.0039534 => 1.1288 bps of 35.0232
    expect(dispersionBps(35.0269, 35.0232, 35.0173)).toBeCloseTo(1.13, 2);
  });

  it('is exactly zero when the pool never moved', () => {
    // The COMMON case: the reference pool is usually not one the trade touched,
    // so all three blocks agree. This must render 0.00, not be suppressed.
    expect(dispersionBps(35.0232, 35.0232, 35.0232)).toBe(0);
  });

  it('returns null when any block is missing, rather than narrowing the sample', () => {
    // A sigma over 2 points renders identically to one over 3. The reader could
    // not tell them apart, so an incomplete triple yields nothing at all.
    expect(dispersionBps(null, 35.0232, 35.0173)).toBeNull();
    expect(dispersionBps(35.0269, null, 35.0173)).toBeNull();
    expect(dispersionBps(35.0269, 35.0232, null)).toBeNull();
  });

  it('returns null for non-finite or non-positive input', () => {
    expect(dispersionBps(35.0269, 0, 35.0173)).toBeNull();
    expect(dispersionBps(35.0269, Number.NaN, 35.0173)).toBeNull();
    expect(dispersionBps('abc', 35.0232, 35.0173)).toBeNull();
  });

  it('accepts numeric strings, since the DB returns numerics as strings', () => {
    expect(dispersionBps('35.0269', '35.0232', '35.0173')).toBeCloseTo(1.13, 2);
  });
});

describe('dispersionClause', () => {
  it('renders two decimals and a trailing period', () => {
    expect(dispersionClause(35.0269, 35.0232, 35.0173)).toBe(
      'Price deviates 1.13bps between blocks.',
    );
  });

  it('renders the zero case rather than omitting it', () => {
    expect(dispersionClause(35.0232, 35.0232, 35.0232)).toBe(
      'Price deviates 0.00bps between blocks.',
    );
  });

  it('is empty when the triple is incomplete', () => {
    expect(dispersionClause(null, 35.0232, 35.0173)).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run packages/dashboard/components/receipt/priceDispersion.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
/**
 * Dispersion of the reference pool's mid across the three adjacent blocks the
 * receipt shows (N-2 / N-1 / N).
 *
 * Deliberately returns null rather than a narrowed sample when a block is
 * missing: a sigma over two points renders identically to one over three, so
 * the reader cannot tell them apart. Absent is not a smaller measurement.
 *
 * Expect 0.00 often. The reference pool is the deepest pool for the pair, which
 * usually is not a pool the trade touched, so in a 20-receipt sample it was
 * unchanged across all three blocks 15 times. Three identical rows and a 0.00
 * clause are the intended output, not a bug.
 */
function toFinitePositive(v: unknown): number | null {
	if (v == null) return null;
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : null;
}

export function dispersionBps(before: unknown, at: unknown, after: unknown): number | null {
	const b = toFinitePositive(before);
	const a = toFinitePositive(at);
	const f = toFinitePositive(after);
	if (b === null || a === null || f === null) return null;

	const mean = (b + a + f) / 3;
	const variance = ((b - mean) ** 2 + (a - mean) ** 2 + (f - mean) ** 2) / 3;
	// Expressed against the At Block mid — the ruler — not the mean, so the
	// figure is relative to the number the rest of the receipt is measured from.
	return (Math.sqrt(variance) / a) * 10_000;
}

export function dispersionClause(before: unknown, at: unknown, after: unknown): string {
	const bps = dispersionBps(before, at, after);
	return bps === null ? '' : `Price deviates ${bps.toFixed(2)}bps between blocks.`;
}
```

- [ ] **Step 4: Run to verify they pass**

```bash
npx vitest run packages/dashboard/components/receipt/priceDispersion.test.ts
npx tsc --build
```

Expected: PASS, tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/components/receipt/priceDispersion.ts packages/dashboard/components/receipt/priceDispersion.test.ts
git commit -m "feat(dashboard): add intra-block price dispersion helper"
```

---

### Task 7: `MarketPriceTable` row component

**Files:**
- Modify: `packages/dashboard/components/receipt/receiptRows.tsx`
- Test: `packages/dashboard/components/receiptView.test.tsx`

**Interfaces:**
- Consumes: `DetailRow` conventions from the same file.
- Produces:
  ```typescript
  export function MarketPriceTable(props: {
    before: React.ReactNode;
    at: React.ReactNode;
    after: React.ReactNode;
  }): JSX.Element
  ```
  Renders the label `Market Price` on the left and a two-column grid on the right: block labels (`Before Block` / `At Block` / `After Block`) in `--color-secondary` except `At Block` in `--color-primary`, and the values right-aligned in matching colors.

Figma 647-3599: `gap-[20px]` between the label column and the value column, `gap-[10px]` between rows, label column `w-[87px]`, value column `w-[144px]`, `text-[12px] leading-[12px]`.

- [ ] **Step 1: Write the failing test**

```typescript
describe('Market Price intra-block table (Figma 647-3599)', () => {
  it('renders all three block rows with At Block emphasized', async () => {
    const { Receipt } = await import('./receiptView');
    const html = renderToStaticMarkup(<Receipt row={tripleMidRow as never} />);

    expect(html).toContain('>Before Block<');
    expect(html).toContain('>At Block<');
    expect(html).toContain('>After Block<');
    // At Block is the ruler and is the only one in primary.
    const atBlock = html.indexOf('>At Block<');
    const before = html.indexOf('>Before Block<');
    expect(html.slice(before, atBlock)).toContain('--color-secondary');
  });

  it('renders an unreadable block as a dash, never as zero', async () => {
    const { Receipt } = await import('./receiptView');
    const html = renderToStaticMarkup(
      <Receipt row={{ ...tripleMidRow, marketMidBefore: null } as never} />,
    );
    const before = html.indexOf('>Before Block<');
    const at = html.indexOf('>At Block<');
    expect(before).toBeGreaterThan(-1);
    // The value cell for Before Block must not read 0.
    expect(html.slice(before, at)).not.toContain('0.0000');
  });
});
```

Define `tripleMidRow` next to the existing row fixtures in that file, as the existing `fullUsdcWethRow` plus `marketMidBefore: '35.0269'`, `marketMid: '35.0232'`, `marketMidAfter: '35.0173'`.

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run packages/dashboard/components/receiptView.test.tsx -t 'intra-block'
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `receiptRows.tsx`:

```tsx
/**
 * Market Price rendered as three adjacent-block samples (Figma 647-3599).
 *
 * `At Block` is the ruler (N-1) and is the only row in primary — the two
 * neighbours are context. All three come from the SAME pool; see the design
 * spec for why re-discovering per block would be wrong.
 */
export function MarketPriceTable({
	before,
	at,
	after,
}: {
	before: React.ReactNode;
	at: React.ReactNode;
	after: React.ReactNode;
}) {
	const SEC = 'var(--color-secondary)';
	const PRI = 'var(--color-primary)';
	const rows: [string, React.ReactNode, string][] = [
		['Before Block', before, SEC],
		['At Block', at, PRI],
		['After Block', after, SEC],
	];
	return (
		<div className="flex items-start justify-between text-[12px] leading-[12px]">
			<p style={{ color: PRI, fontFeatureSettings: '"calt" 0' }} className="whitespace-nowrap">
				Market Price
			</p>
			<div className="flex items-center gap-[20px]">
				<div className="flex w-[87px] flex-col gap-[10px] items-start">
					{rows.map(([label, , color]) => (
						<p key={label} className="w-full" style={{ color, fontFeatureSettings: '"calt" 0' }}>
							{label}
						</p>
					))}
				</div>
				<div className="flex w-[144px] flex-col gap-[10px] items-start text-right">
					{rows.map(([label, value, color]) => (
						<p key={label} className="w-full" style={{ color, fontFeatureSettings: '"calt" 0' }}>
							{value}
						</p>
					))}
				</div>
			</div>
		</div>
	);
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npx vitest run packages/dashboard/components/receiptView.test.tsx
npx tsc --build
```

Expected: PASS, tsc exit 0. (Task 8 wires it in; if `Receipt` does not yet render it, do Task 8's Step 3 first and re-run.)

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/components/receipt/receiptRows.tsx packages/dashboard/components/receiptView.test.tsx
git commit -m "feat(dashboard): add MarketPriceTable three-block row"
```

---

### Task 8: Price Range section restructure

**Files:**
- Modify: `packages/dashboard/components/receiptView.tsx:203-262`
- Test: `packages/dashboard/components/receiptView.test.tsx`

**Interfaces:**
- Consumes: `MarketPriceTable` (Task 7), `dispersionClause` (Task 6).
- Produces: no new exports. Section order becomes: top block (… Execution Delta, Gas Cost) → divider → `<h2>Price Range</h2>` → Execution Price, Market Price + descriptor, Price Delta → divider → `<h2>Transaction Cost</h2>`.

- [ ] **Step 1: Write the failing tests**

```typescript
describe('Price Range section (Figma 647-3415)', () => {
  it('renders a Price Range heading between Gas Cost and Transaction Cost', async () => {
    const { Receipt } = await import('./receiptView');
    const html = renderToStaticMarkup(<Receipt row={tripleMidRow as never} />);
    const gas = html.indexOf('>Gas Cost<');
    const priceRange = html.indexOf('>Price Range<');
    const txCost = html.indexOf('>Transaction Cost<');
    expect(gas).toBeGreaterThan(-1);
    expect(priceRange).toBeGreaterThan(gas);
    expect(txCost).toBeGreaterThan(priceRange);
  });

  it('moves Gas Cost above Execution Price', async () => {
    const { Receipt } = await import('./receiptView');
    const html = renderToStaticMarkup(<Receipt row={tripleMidRow as never} />);
    // Gas is not a price and must not sit inside Price Range.
    expect(html.indexOf('>Gas Cost<')).toBeLessThan(html.indexOf('>Execution Price<'));
  });

  it('appends the dispersion clause to the methodology descriptor', async () => {
    const { Receipt } = await import('./receiptView');
    const html = renderToStaticMarkup(<Receipt row={tripleMidRow as never} />);
    expect(html).toContain('Price deviates 1.13bps between blocks.');
  });

  it('omits the dispersion clause when a block is missing', async () => {
    const { Receipt } = await import('./receiptView');
    const html = renderToStaticMarkup(
      <Receipt row={{ ...tripleMidRow, marketMidAfter: null } as never} />,
    );
    expect(html).not.toContain('between blocks');
  });

  it('renders no USD subvalue on any Price Range row', async () => {
    const { Receipt } = await import('./receiptView');
    const html = renderToStaticMarkup(<Receipt row={tripleMidRow as never} />);
    const priceRange = html.indexOf('>Price Range<');
    const txCost = html.indexOf('>Transaction Cost<');
    const section = html.slice(priceRange, txCost);
    // Price Range is deliberately notional-free across all tiers. The top
    // block keeps its USD; this section must not.
    expect(section).not.toMatch(/\$[0-9]/);
  });

  it('renders N/A for Market Price and Price Delta on the unpriced tier', async () => {
    const { Receipt } = await import('./receiptView');
    const html = renderToStaticMarkup(<Receipt row={unpricedRow as never} />);
    expect(html).toContain('>Price Range<');
    expect(html).toContain('Unavailable: No reliable market price could be calculated.');
    expect(html).not.toContain('>Before Block<');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run packages/dashboard/components/receiptView.test.tsx -t 'Price Range'
```

Expected: FAIL.

- [ ] **Step 3: Implement**

In `receiptView.tsx`:

1. Move the existing `<DetailRow label="Gas Cost" …>` block so it immediately follows the `Execution Delta` block (around line 209).
2. After it, close the top `<div>` and add:

```tsx
			<Divider />

			<h2
				className="font-['Sohne_Breit'] font-medium text-[20px] leading-[20px]"
				style={{ fontFeatureSettings: '"calt" 0' }}
			>
				Price Range
			</h2>

			<div className="flex flex-col gap-[20px] font-['Sohne_Mono'] text-[12px] leading-[12px]">
```

3. Move `Execution Price`, the `Market Price` wrapper, and `Price Delta` inside it.
4. Drop `subValue` from the `Execution Price` row (delete `subValue={execUsdPerBase != null ? … }`).
5. Replace the `Market Price` `DetailRow` with, when `hasMarketPrice`, `MarketPriceTable`:

```tsx
					{hasMarketPrice ? (
						<MarketPriceTable
							before={formatMidCell(row.marketMidBefore, base, quote)}
							at={formatMidCell(row.marketMid, base, quote)}
							after={formatMidCell(row.marketMidAfter, base, quote)}
						/>
					) : (
						<DetailRow label="Market Price" hug valueTooltip={NULL_PRICE_TOOLTIP}>
							N/A
						</DetailRow>
					)}
```

with, near the other helpers in the same file:

```tsx
// An unreadable block renders the same em dash the LP-fee rows use for an
// unresolved value. Never 0 — absent is not a measurement.
function formatMidCell(mid: unknown, base: string, quote: string): React.ReactNode {
	return mid == null ? '–' : formatExecutionPrice(mid, base, quote);
}
```

6. Append the dispersion clause to the descriptor:

```tsx
					<p className="text-[10px] leading-[16px] text-[var(--color-secondary)]">
						<MethodologyText text={methodologyText} />
						{dispersion ? ` ${dispersion}` : ''}
					</p>
```

with, alongside the other derived values near line 104:

```tsx
	// Empty string when the triple is incomplete — see priceDispersion.ts.
	const dispersion = hasMarketPrice
		? dispersionClause(row.marketMidBefore, row.marketMid, row.marketMidAfter)
		: '';
```

7. Delete the now-duplicated `Gas Cost` row from its old position and drop `subValue` from the `Market Price` fallback.

- [ ] **Step 4: Run to verify they pass**

```bash
npm test && npx tsc --build && npm run lint
```

Expected: all green.

- [ ] **Step 5: Mutation-check the ordering assertions**

The repo has had positional `indexOf` assertions go vacuous after a reorder. Temporarily move the `Gas Cost` row back below `Price Delta` and re-run:

```bash
npx vitest run packages/dashboard/components/receiptView.test.tsx -t 'moves Gas Cost'
```

Expected: **FAIL**. Revert.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/components/receiptView.tsx packages/dashboard/components/receiptView.test.tsx
git commit -m "feat(dashboard): add Price Range section, move Gas Cost, drop notionals"
```

---

### Task 9: Close the delta rounding gap

**Files:**
- Modify: `packages/dashboard/components/receipt/priceFormat.ts:118-137`, `packages/dashboard/components/receiptView.tsx:104`
- Test: `packages/dashboard/components/receipt/priceFormat.test.ts`, `packages/dashboard/components/receiptView.test.tsx`

**Interfaces:**
- Consumes: `receiptDollars` → `{ notionalIn, notionalOut, execResultUsd }` (`qualityNotionals.ts:37`), `reconciledResult` → `{ execResultUsd, qualityBps }` (`receiptPure.ts:64`).
- Produces: no new exports. `Total Execution Delta` and the token-denominated `Price Delta` both derive from the `dollars` object on anchored receipts.

⚠️ **This is a structural fix, not a bug fix.** No divergence has ever been observed and none is expected at displayed precision. Do **not** write a test asserting a discrepancy exists — assert the *source*, not a difference.

- [ ] **Step 1: Write the failing test**

```typescript
it('derives the token Price Delta through receiptDollars, not the stored columns', async () => {
  // The trap: stored market_mid is DISPLAY-oriented. (mid - realized)/mid is
  // not invariant under that inversion — with realized = mid(1+eps) the
  // un-inverted form gives -eps and the inverted form gives eps/(1+eps).
  // Opposite sign convention, divergent at O(eps^2). A derivation that reads
  // the stored columns directly is wrong on the inverted half of the corpus.
  const { Receipt } = await import('./receiptView');
  const html = renderToStaticMarkup(<Receipt row={baseIsOutputRow as never} />);
  // The sign word must match the direction receiptDollars computes.
  expect(html).toContain('below Market Price');
  expect(html).not.toContain('above Market Price');
});

it('sources Total Execution Delta from the same object as Execution Delta', async () => {
  const { Receipt } = await import('./receiptView');
  // allInCostBps deliberately disagrees with what market_mid implies. The
  // rendered bps must follow market_mid (via receiptDollars), proving the row
  // no longer reads the stored column.
  const html = renderToStaticMarkup(
    <Receipt row={{ ...anchoredRow, allInCostBps: '999.99' } as never} />,
  );
  expect(html).not.toContain('999.99');
});
```

`baseIsOutputRow` must be an anchored fixture where `baseIsOutputLeg(inputToken, outputToken)` is true. `anchoredRow` is any fixture where `receiptDollars` returns non-null.

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run packages/dashboard/components/receiptView.test.tsx -t 'receiptDollars'
```

Expected: FAIL on the second test — the stored `999.99` renders today.

- [ ] **Step 3: Implement**

In `receiptView.tsx`, replace line 104:

```tsx
	// One source for all three renderings of the execution delta on this screen.
	// Anchored rows derive bps from the same reconciledResult that produces
	// execResultUsd; unanchored rows have no dollars object and keep the stored
	// column. See the design spec §6 — including why deriving from the stored
	// market_mid directly would be wrong on inverted pairs.
	const costBps =
		dollars != null && dollars.notionalIn > 0
			? -(dollars.execResultUsd / dollars.notionalIn) * 10_000
			: row.allInCostBps != null
				? Number(row.allInCostBps)
				: null;
```

Note `dollars` is declared below line 104 today — move the `const dollars = receiptDollars(row);` declaration above this line.

In `priceFormat.ts`, extend `formatPriceDeltaUsd` to take a token magnitude, or add a sibling that formats the token amount from `deltaUsdPerBase` converted through the same `dollars` figures. The Price Delta row's subvalue becomes `At Block per 1 ${base}`.

- [ ] **Step 4: Run to verify they pass**

```bash
npm test && npx tsc --build && npm run lint
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/components/receipt/priceFormat.ts packages/dashboard/components/receiptView.tsx packages/dashboard/components/receiptView.test.tsx
git commit -m "fix(dashboard): single-source the receipt's execution delta renderings"
```

---

### Task 10: Corpus snapshot tooling

**Files:**
- Create: `scripts/snapshotReceipts.mjs`
- Modify: `scripts/repopulateReceipts.mjs`

**Interfaces:**
- Consumes: `createDb`, `schema` from `@fabric-tca/db`; `toUpdate()` inside the repopulator.
- Produces: `node scripts/snapshotReceipts.mjs <out.json>` and `node scripts/snapshotReceipts.mjs --diff <a.json> <b.json>`; `node scripts/repopulateReceipts.mjs --snapshot=<path>`.

- [ ] **Step 1: Write the snapshot script**

```javascript
/**
 * snapshotReceipts.mjs — dump every column of every receipt to JSON.
 *
 *   node scripts/snapshotReceipts.mjs /tmp/arm0-backup.json
 *   node scripts/snapshotReceipts.mjs --diff /tmp/arm1.json /tmp/arm2.json
 *
 * Read-only, no RPC. This is the corpus BACKUP and the restore path if a
 * repopulation --commit goes wrong.
 *
 * --diff compares two snapshots on EVERY column, not the repopulator's 10-column
 * WATCH list. It classifies each row as CHANGED / ONLY-IN-A / ONLY-IN-B, and
 * reports per-column change counts so an expected column (market_mid_before)
 * is distinguishable from an unexpected one (all_in_cost_bps).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createDb, schema } from '@fabric-tca/db';
import { asc } from 'drizzle-orm';

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
for (const line of env.split('\n')) {
	const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/);
	if (m) process.env[m[1]] = m[2];
}

const args = process.argv.slice(2);

if (args[0] === '--diff') {
	const [, aPath, bPath] = args;
	if (!aPath || !bPath) { console.error('usage: --diff <a.json> <b.json>'); process.exit(1); }
	const a = new Map(JSON.parse(readFileSync(aPath, 'utf8')).map((r) => [r.id, r]));
	const b = new Map(JSON.parse(readFileSync(bPath, 'utf8')).map((r) => [r.id, r]));

	const columnHits = new Map();
	let changed = 0;
	for (const [id, rowA] of a) {
		const rowB = b.get(id);
		// A row present in A but absent from B is a FINDING, not silence: the
		// repopulator skips rows whose re-analysis returns null, so a receipt
		// that stops resolving would otherwise vanish without a diff line.
		if (!rowB) { console.log(`id ${id}  ⚠ ONLY-IN-A (dropped or skipped)`); changed++; continue; }
		const cols = [...new Set([...Object.keys(rowA), ...Object.keys(rowB)])]
			.filter((k) => JSON.stringify(rowA[k]) !== JSON.stringify(rowB[k]));
		if (!cols.length) continue;
		changed++;
		for (const c of cols) columnHits.set(c, (columnHits.get(c) ?? 0) + 1);
		console.log(`id ${String(id).padStart(3)}  Δ ${cols.join(' ')}`);
	}
	for (const id of b.keys()) if (!a.has(id)) console.log(`id ${id}  ⚠ ONLY-IN-B (new row)`);

	console.log(`\nrows changed: ${changed} / ${a.size}`);
	console.log('per-column:');
	for (const [c, n] of [...columnHits].sort((x, y) => y[1] - x[1])) console.log(`  ${String(n).padStart(4)}  ${c}`);
	process.exit(0);
}

const out = args[0];
if (!out) { console.error('usage: snapshotReceipts.mjs <out.json> | --diff <a> <b>'); process.exit(1); }
const db = createDb(process.env.TCA_DATABASE_URL);
const rows = await db.select().from(schema.receipts).orderBy(asc(schema.receipts.id));
writeFileSync(out, JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 2));
console.log(`wrote ${rows.length} receipts to ${out}`);
process.exit(0);
```

- [ ] **Step 2: Add `--snapshot` to the repopulator**

In `scripts/repopulateReceipts.mjs`, after the `COMMIT` / `onlyIds` parsing:

```javascript
const snapArg = process.argv.find(a => a.startsWith('--snapshot='));
const snapPath = snapArg ? snapArg.slice('--snapshot='.length) : null;
const snapshot = [];
```

Inside the row loop, immediately after `const upd = toUpdate(r, feeSinks);`:

```javascript
	// Serialize what repopulation WOULD write. Keyed off toUpdate's return value
	// so new columns are picked up automatically — no second list to keep in sync.
	if (snapPath) snapshot.push({ id: row.id, txHash: row.txHash, ...upd });
```

Before the final `process.exit(0)`:

```javascript
if (snapPath) {
	const { writeFileSync } = await import('node:fs');
	writeFileSync(snapPath, JSON.stringify(snapshot, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 2));
	console.log(`snapshot: wrote ${snapshot.length} computed rows to ${snapPath}`);
}
```

- [ ] **Step 3: Verify the snapshot round-trips**

```bash
node scripts/snapshotReceipts.mjs /tmp/rt-a.json
node scripts/snapshotReceipts.mjs /tmp/rt-b.json
node scripts/snapshotReceipts.mjs --diff /tmp/rt-a.json /tmp/rt-b.json
```

Expected: `rows changed: 0 / <n>`. Two dumps of an unchanged DB must be identical — if not, the serializer is non-deterministic and must be fixed before the arms below mean anything.

- [ ] **Step 4: Commit**

```bash
git add scripts/snapshotReceipts.mjs scripts/repopulateReceipts.mjs
git commit -m "feat(scripts): full-column corpus snapshot and diff"
```

---

### Task 11: Three-arm verification run

**Files:** none modified. This task produces evidence, not code.

**Interfaces:**
- Consumes: everything above.
- Produces: `/tmp/arm0-backup.json`, `/tmp/arm1-control.json`, `/tmp/arm2-branch.json` and two diff reports.

⚠️ Each RPC arm is ~100–151 calls and 4.3–6.7 s per receipt across ~62 receipts — **5–7 minutes each, which exceeds the tool timeout. Run them detached in the background.**

- [ ] **Step 1: Arm 0 — the backup**

```bash
node scripts/snapshotReceipts.mjs /tmp/arm0-backup.json
```

Expected: `wrote <n> receipts`. Keep this file — it is the restore path.

- [ ] **Step 2: Arm 1 — the control, on `main`**

```bash
git stash && git checkout main && npx tsc --build
node scripts/repopulateReceipts.mjs --snapshot=/tmp/arm1-control.json > /tmp/arm1.log 2>&1
```

Run detached. This is a **dry run** — no `--commit`, nothing is written to the DB.

- [ ] **Step 3: Read the control diff**

```bash
node scripts/snapshotReceipts.mjs --diff /tmp/arm0-backup.json /tmp/arm1-control.json
grep -c "NULL receipt now" /tmp/arm1.log
```

Everything here is **pre-existing staleness plus RPC non-determinism** — unrelated to this branch. Record the per-column counts and the skip count; they are the noise floor. Do not attempt to fix anything found here in this branch.

- [ ] **Step 4: Arm 2 — the treatment, on the branch**

```bash
git checkout feat/three-price-receipt && git stash pop && npx tsc --build
node scripts/repopulateReceipts.mjs --snapshot=/tmp/arm2-branch.json > /tmp/arm2.log 2>&1
```

Run detached, also a dry run.

- [ ] **Step 5: Read the treatment diff — the actual gate**

```bash
node scripts/snapshotReceipts.mjs --diff /tmp/arm1-control.json /tmp/arm2-branch.json
grep -c "NULL receipt now" /tmp/arm2.log
```

**Pass criteria:** the per-column report lists **only** `marketMidBefore` and `marketMidAfter`, and the skip count matches Arm 1's exactly.

**Any other column is a finding and blocks the branch**, in particular `allInCostBps` (Task 9 changes rendering, not persistence), `marketMid` (the ruler did not move), and `tier` / `pricingStatus`.

- [ ] **Step 6: Commit the evidence**

```bash
mkdir -p docs/superpowers/evidence
cp /tmp/arm1.log /tmp/arm2.log docs/superpowers/evidence/
git add docs/superpowers/evidence
git commit -m "test: three-arm repopulation evidence for the three-price receipt"
```

---

## Self-Review

**Spec coverage.** §2 ruler decision → Tasks 3–5 (N−2/N−1/N mapping, ruler untouched). §3 data model → Tasks 1, 3, 5 (columns, shared-pool invariant, orientation, midReliable gate, degradation). §3 USDC/WETH fast path → Task 4 Step 4 (both return branches). §4 dispersion → Task 6. §5 layout → Tasks 7, 8 (section order, Gas Cost, notional removal, tiers). §6 rounding gap → Task 9, with the orientation trap as its first test. §7 verification → Tasks 10, 11 (snapshot, `--snapshot`, three arms, skip trap). §8 testing → mutation checks in Tasks 3, 8.

**Known gap:** Task 9 Step 3's `priceFormat.ts` change is specified by intent rather than by literal replacement code, because the exact token-formatting seam depends on how `formatPriceDeltaUsd`'s callers read after Task 8's restructure. The implementer must read `priceFormat.ts:74-137` before writing it. Every other step carries literal code.

**Type consistency.** `PairMidTriple` fields (`before` / `at` / `after` / `poolAddress` / `poolKind`) are used identically in Tasks 3, 4. `marketMidBefore` / `marketMidAfter` naming is consistent across schema (Task 1), `PricingResult` (Task 4), the persisted receipt (Task 5), and the dashboard (Tasks 6–8). `dispersionBps` / `dispersionClause` signatures match between Task 6's definition and Task 8's use.
