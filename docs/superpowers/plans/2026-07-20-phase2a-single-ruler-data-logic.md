# Single-Ruler Receipt — Phase 2a (Data Path + Logic) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the apparatus's `tier`/`methodology`/`marketPriceFlags`, provide the dashboard a tested single-ruler `receiptDollars` helper (per-side USD + Execution Result via the shared core `reconciledResult`), and retire `anchor_price_usd` end to end — without yet changing what the receipt renders.

**Architecture:** Additive DB + core/route threading, then a coordinated retirement of the second-ruler field. The dashboard-side dollar derivation lives in a rewritten `qualityNotionals.ts` and imports `reconciledResult` from `@fabric-tca/core`. The receipt's visual wiring is a separate follow-on plan (Phase 2b).

**Tech Stack:** TypeScript (ESM, NodeNext), Drizzle ORM + Postgres, viem, vitest, Next.js. Core builds with `tsc --build`; tests `npx vitest run`; migrations via `npm run db:generate` / `npm run db:migrate`.

**Scope:** This is **Phase 2a** of `docs/superpowers/specs/2026-07-20-phase2-single-ruler-receipt-design.md`. **Phase 2b** (ReceiptView rendering of the four states, with a browser verification loop) is a separate plan authored after this lands.

## Global Constraints

- **One ruler.** `receiptDollars` derives BOTH per-side notionals from the ONE stored `notionalUsd` (anchored side) + the ONE `marketMid`. It must feed `reconciledResult` the **input/paid-side** notional (`notionalIn`), never the output notional — see the derivation below. No second independent price source.
- **`reconciledResult` derivation (exact):**
  - `preferOutput = isAnchorable(outputSymbol) && !isAnchorable(inputSymbol)` (mirrors core `bestEffortNotional`).
  - `notionalIn = preferOutput ? notionalUsd * marketMid / realizedPrice : notionalUsd`
  - `execResultUsd = reconciledResult({ marketMid, realizedPrice, notionalUsd: notionalIn }).execResultUsd`
  - `notionalOut = notionalIn + execResultUsd`
- **Execution Result renders unsigned.** Magnitude only (`$4.57`); direction is conveyed by a `Gained`/`Lost` subvalue + color, never a `+`/`−` prefix. `Gained` (execResultUsd > 0) green; `Lost` (< 0) default color.
- **`anchor_price_usd` is dropped, not left dormant** — removed from schema, core `Receipt`, `route.ts`, and the quarantined two-ruler helpers.
- **Do not touch** the per-leg impact layer, `computeMarketPrice`/`getMarketPriceForPair`/`priceReceipt` internals, or the apparatus's use of `readTokenUsd` (only the *display* field `anchorPriceUsd` goes).
- Each task ends with `npx tsc --build` and the relevant tests green. `market_price_flags` uses `jsonb` (matching `normalize_flags`).
- Test commands from repo root: `npx vitest run <path>`; migrations `npm run db:generate` then `npm run db:migrate` (needs a DB connection in env).

---

### Task 1: Schema — add `tier` / `methodology` / `market_price_flags`

**Files:**
- Modify: `packages/db/src/schema.ts` (receipts table, near `pricingStatus` / `normalizeFlags`)
- Create: `packages/db/drizzle/0017_*.sql` (generated)

**Interfaces:**
- Produces: `receipts.tier` (text, nullable), `receipts.methodology` (text, nullable), `receipts.marketPriceFlags` (jsonb, nullable). `ReceiptRow`/`NewReceipt` gain these automatically (`$inferSelect`/`$inferInsert`).

- [ ] **Step 1: Add the columns to the schema**

In `packages/db/src/schema.ts`, immediately after the `pricingStatus` line (`pricingStatus: text('pricing_status').notNull(),`), add:

```ts
		// single Market Price apparatus (Phase 2): tier = full|estimated|none,
		// methodology = human string for the receipt, marketPriceFlags = jsonb string[].
		tier: text('tier'),
		methodology: text('methodology'),
		marketPriceFlags: jsonb('market_price_flags'),
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`
Expected: a new `packages/db/drizzle/0017_*.sql` containing three `ALTER TABLE "receipts" ADD COLUMN` statements (`tier` text, `methodology` text, `market_price_flags` jsonb). Open it and confirm it adds ONLY those three columns and drops nothing.

- [ ] **Step 3: Apply the migration**

Run: `npm run db:migrate`
Expected: applies cleanly. Confirm the columns exist (psql or a Drizzle check): `tier`, `methodology`, `market_price_flags` present, nullable.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --build`
Expected: exit 0 (additive; existing code unaffected).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle/0017_*.sql
git commit -m "feat(db): add tier/methodology/market_price_flags to receipts"
```

---

### Task 2: Core + route — populate the three fields

**Files:**
- Modify: `packages/core/src/analyzeTransaction.ts` (`Receipt` type + the final receipt object)
- Modify: `packages/dashboard/app/api/receipts/route.ts` (`toNewReceipt`)
- Modify: `packages/core/src/analyzeTransaction.test.ts` if it constructs/asserts a full `Receipt` (add the new fields)

**Interfaces:**
- Consumes: the existing `pricing` result (`priceReceipt`) which already carries `tier`, `methodology`, `marketPriceFlags` (Phase 1).
- Produces: `Receipt.tier: MarketPriceTier | null`, `Receipt.methodology: string | null`, `Receipt.marketPriceFlags: string[] | null`.

- [ ] **Step 1: Add the fields to the `Receipt` type**

In `packages/core/src/analyzeTransaction.ts`, in the `Receipt` interface near `pricingStatus`, add:

```ts
	tier: string | null;
	methodology: string | null;
	marketPriceFlags: string[] | null;
```

- [ ] **Step 2: Populate them on the returned receipt**

In the final receipt object literal (where `pricingStatus: midReliable ? pricing.status : 'partial'` is set), add alongside it:

```ts
			tier: midReliable ? pricing.tier : 'none',
			methodology: pricing.methodology,
			marketPriceFlags: pricing.marketPriceFlags,
```

(When the mid is implausible/absent we surface `tier: 'none'` to match the nulled `marketMid`; `methodology`/flags pass through as computed.)

- [ ] **Step 3: Thread them through `toNewReceipt`**

In `packages/dashboard/app/api/receipts/route.ts`, in the object returned by `toNewReceipt`, add after `pricingStatus: r.pricingStatus,`:

```ts
		tier: r.tier,
		methodology: r.methodology,
		marketPriceFlags: r.marketPriceFlags,
```

- [ ] **Step 4: Fix any full-`Receipt` test fixtures**

Run: `npx vitest run packages/core/src/analyzeTransaction.test.ts`
If it fails to compile because a fixture builds a full `Receipt`, add `tier: 'full', methodology: 'x', marketPriceFlags: []` (or values matching that fixture's intent) to the fixture. If it uses live RPC and is skipped without `TCA_RPC_URL`, note that and rely on tsc.

- [ ] **Step 5: Typecheck the workspace**

Run: `npx tsc --build`
Expected: exit 0. The new fields now flow core → route → DB.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/analyzeTransaction.ts packages/dashboard/app/api/receipts/route.ts packages/core/src/analyzeTransaction.test.ts
git commit -m "feat(core): populate tier/methodology/marketPriceFlags on the receipt + persist"
```

---

### Task 3: Dashboard logic — `receiptDollars` + unsigned Execution Result

**Files:**
- Modify: `packages/core/src/index.ts` (barrel-export `reconciledResult` + the market-price types)
- Modify: `packages/dashboard/components/receipt/qualityNotionals.ts` (ADD `receiptDollars`, rewrite `formatExecutionResult` unsigned; keep the old fns for now so nothing else breaks — they are removed in Task 4)
- Modify: `packages/dashboard/components/receipt/qualityNotionals.test.ts` (add tests for the two new behaviors)

**Interfaces:**
- Consumes: `reconciledResult` from `@fabric-tca/core`; `STABLE_SYMBOLS`/`ETH_SYMBOLS` from `./symbols`; `ReceiptRow` (type-only) from `../../lib/queries`.
- Produces:
  - `receiptDollars(row): { notionalIn: number; notionalOut: number; execResultUsd: number } | null`
  - `formatExecutionResult(execResultUsd: number): { text: string; sub: string | null; color: string | undefined }` (unsigned magnitude; `sub` = 'Gained'|'Lost'|null).

- [ ] **Step 1: Barrel-export `reconciledResult` from core**

In `packages/core/src/index.ts`, add:

```ts
export { reconciledResult, computeMarketPrice, getMarketPriceForPair } from './marketPrice.js';
export type { MarketPriceTier, MarketPriceResult, Estimator } from './marketPrice.js';
```

(If some of these are already exported, keep the export list unique — do not duplicate.)

- [ ] **Step 2: Write the failing tests**

Append to `packages/dashboard/components/receipt/qualityNotionals.test.ts`:

```ts
import { receiptDollars, formatExecutionResult } from './qualityNotionals';

describe('receiptDollars (single ruler)', () => {
  // Reference ETH->WBTC: 1 ETH -> 0.028625 WBTC, marketMid 1/35.0232 (WBTC per ETH),
  // input (ETH) anchored, notionalUsd = 1791.14 = notionalIn.
  const base = {
    inputSymbol: 'ETH', outputSymbol: 'WBTC',
    inputAmount: '1', outputAmount: '0.028625',
    marketMid: String(1 / 35.0232), realizedPrice: String(0.028625 / 1),
    notionalUsd: '1791.14',
  };

  it('input-anchored: notionalIn = notionalUsd, execResult = notionalOut - notionalIn (~+$4.5)', () => {
    const d = receiptDollars(base)!;
    expect(d.notionalIn).toBeCloseTo(1791.14, 2);
    expect(d.execResultUsd).toBeCloseTo(d.notionalOut - d.notionalIn, 6);
    expect(d.execResultUsd).toBeGreaterThan(4);
    expect(d.execResultUsd).toBeLessThan(5);
  });

  it('output-anchored: feeds reconciledResult the derived notionalIn, not notionalUsd', () => {
    // TOKEN -> USDC, USDC (output) anchored. notionalUsd = notionalOut = 1000.
    // marketMid = 2 (USDC per TOKEN), realized = 2.01 (got slightly more USDC).
    const d = receiptDollars({
      inputSymbol: 'TKN', outputSymbol: 'USDC',
      inputAmount: '500', outputAmount: '1005',
      marketMid: '2', realizedPrice: '2.01', notionalUsd: '1000',
    })!;
    expect(d.notionalOut).toBeCloseTo(1000, 6);
    // notionalIn = notionalUsd * mid/realized = 1000 * 2/2.01
    expect(d.notionalIn).toBeCloseTo(1000 * 2 / 2.01, 6);
    expect(d.execResultUsd).toBeCloseTo(d.notionalOut - d.notionalIn, 6);
  });

  it('returns null when no side anchors or a field is missing', () => {
    expect(receiptDollars({ ...base, inputSymbol: 'TKA', outputSymbol: 'TKB' })).toBeNull();
    expect(receiptDollars({ ...base, marketMid: null })).toBeNull();
    expect(receiptDollars({ ...base, notionalUsd: null })).toBeNull();
  });
});

describe('formatExecutionResult (unsigned)', () => {
  it('positive => magnitude only + Gained + green (no + sign)', () => {
    const r = formatExecutionResult(4.57);
    expect(r.text).toBe('$4.57');
    expect(r.text).not.toContain('+');
    expect(r.sub).toBe('Gained');
    expect(r.color).toBe('#117d45');
  });
  it('negative => magnitude only + Lost + default color (no - sign)', () => {
    const r = formatExecutionResult(-3.2);
    expect(r.text).toBe('$3.20');
    expect(r.text).not.toContain('-');
    expect(r.sub).toBe('Lost');
    expect(r.color).toBeUndefined();
  });
  it('zero => no direction', () => {
    expect(formatExecutionResult(0).sub).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify fail**

Run: `npx vitest run packages/dashboard/components/receipt/qualityNotionals.test.ts -t "receiptDollars|formatExecutionResult"`
Expected: FAIL — `receiptDollars` not exported; `formatExecutionResult` shape differs.

- [ ] **Step 4: Implement**

In `packages/dashboard/components/receipt/qualityNotionals.ts`, add imports at the top (keep existing imports):

```ts
import { reconciledResult } from '@fabric-tca/core';
```

Add `receiptDollars` (near `isAnchorable`, which is already defined in this file):

```ts
/**
 * Single-ruler per-side USD notionals + Execution Result, from the ONE stored
 * anchor notional (`notionalUsd`) + the ONE `marketMid`. Feeds `reconciledResult`
 * the INPUT (paid) side notional so the identity execResult = notionalOut -
 * notionalIn holds exactly (see spec). Null unless a side anchors and a mid exists.
 */
export function receiptDollars(
  row: Pick<ReceiptRow, 'inputSymbol' | 'outputSymbol' | 'inputAmount' | 'outputAmount' | 'marketMid' | 'notionalUsd' | 'realizedPrice'>,
): { notionalIn: number; notionalOut: number; execResultUsd: number } | null {
  const mid = row.marketMid == null ? null : Number(row.marketMid);
  const realized = row.realizedPrice == null ? null : Number(row.realizedPrice);
  const notional = row.notionalUsd == null ? null : Number(row.notionalUsd);
  if (mid == null || realized == null || notional == null) return null;
  if (![mid, realized, notional].every(Number.isFinite) || mid <= 0 || realized <= 0) return null;
  const inAnchor = isAnchorable(row.inputSymbol);
  const outAnchor = isAnchorable(row.outputSymbol);
  if (!inAnchor && !outAnchor) return null;
  const preferOutput = outAnchor && !inAnchor; // stored notionalUsd is the OUTPUT side
  const notionalIn = preferOutput ? (notional * mid) / realized : notional;
  const { execResultUsd } = reconciledResult({ marketMid: mid, realizedPrice: realized, notionalUsd: notionalIn });
  const notionalOut = notionalIn + execResultUsd;
  if (![notionalIn, notionalOut, execResultUsd].every(Number.isFinite)) return null;
  return { notionalIn, notionalOut, execResultUsd };
}
```

Rewrite `formatExecutionResult` (replace the existing signed version) to be unsigned:

```ts
// Unsigned execution result: magnitude only. Direction is the `sub` label
// (Gained/Lost) + color — never a +/- prefix. Positive = surplus (green).
export function formatExecutionResult(execResultUsd: number): { text: string; sub: string | null; color: string | undefined } {
  const mag = formatUsdMagnitude(Math.abs(execResultUsd)) ?? '0.00';
  const text = `$${mag}`;
  if (execResultUsd > 0) return { text, sub: 'Gained', color: '#117d45' };
  if (execResultUsd < 0) return { text, sub: 'Lost', color: undefined };
  return { text, sub: null, color: undefined };
}
```

(`formatUsdMagnitude` is already imported in this file.)

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run packages/dashboard/components/receipt/qualityNotionals.test.ts`
Expected: PASS (new tests + any retained old ones). Then `npx tsc --build` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/index.ts packages/dashboard/components/receipt/qualityNotionals.ts packages/dashboard/components/receipt/qualityNotionals.test.ts
git commit -m "feat(dashboard): receiptDollars single-ruler helper + unsigned Execution Result"
```

---

### Task 4: Retire `anchor_price_usd` end to end

**Files:**
- Modify: `packages/core/src/analyzeTransaction.ts` (remove `Receipt.anchorPriceUsd` field + its computation)
- Modify: `packages/dashboard/app/api/receipts/route.ts` (remove the `anchorPriceUsd` write)
- Modify: `packages/dashboard/components/receipt/qualityNotionals.ts` (delete the two-ruler fns that read `anchorPriceUsd`)
- Modify: `packages/db/src/schema.ts` (remove the `anchorPriceUsd` column)
- Create: `packages/db/drizzle/0018_*.sql` (generated — the DROP)
- Modify: any test referencing the deleted fns/field

**Interfaces:**
- Removes: `Receipt.anchorPriceUsd`, `receipts.anchor_price_usd`, and `qualityNotionals` fns `singleAnchorNotionals`, `perSideNotionals`, `usdPerBasePrices`, `outputTokenDelta`.

- [ ] **Step 1: Remove the core field + computation**

In `packages/core/src/analyzeTransaction.ts`: delete the `anchorPriceUsd: number | null;` line from the `Receipt` interface, the `anchorPriceUsd` computation block (`const anchorPriceUsd = (await readTokenUsd(...)) ?? (await readTokenUsd(...));`), and the `anchorPriceUsd,` line in the returned object. Leave the `readTokenUsd` import (still used by the apparatus). If a comment references the removed field, delete it too.

- [ ] **Step 2: Remove the route write**

In `packages/dashboard/app/api/receipts/route.ts`, delete the `anchorPriceUsd: num(r.anchorPriceUsd),` line from `toNewReceipt`.

- [ ] **Step 3: Delete the two-ruler helpers**

In `packages/dashboard/components/receipt/qualityNotionals.ts`, delete `singleAnchorNotionals`, `perSideNotionals`, `usdPerBasePrices`, and `outputTokenDelta` entirely (they read `anchorPriceUsd` / mark sides at the mid — the retired second ruler). Keep `isAnchorable`, `receiptDollars`, and `formatExecutionResult`. Remove any now-unused imports.

- [ ] **Step 4: Remove tests for the deleted fns**

In `packages/dashboard/components/receipt/qualityNotionals.test.ts`, delete the describe blocks for the removed functions. Keep the `receiptDollars` / `formatExecutionResult` blocks.

Run: `npx vitest run packages/dashboard/components/receipt/qualityNotionals.test.ts`
Expected: PASS (only the retained blocks).

- [ ] **Step 5: Drop the schema column + migration**

In `packages/db/src/schema.ts`, delete the `anchorPriceUsd: numeric('anchor_price_usd'),` line and its comment.

Run: `npm run db:generate`
Expected: `packages/db/drizzle/0018_*.sql` containing exactly `ALTER TABLE "receipts" DROP COLUMN "anchor_price_usd";`. Open and confirm it drops ONLY that column.

Run: `npm run db:migrate`
Expected: applies cleanly.

- [ ] **Step 6: Typecheck the whole workspace**

Run: `npx tsc --build`
Expected: exit 0 — no dangling reference to `anchorPriceUsd` anywhere. If tsc reports one, fix that reference (it will name the file:line).

Run: `grep -rn "anchorPriceUsd\|anchor_price_usd" packages --include=*.ts --include=*.tsx | grep -v node_modules | grep -v drizzle`
Expected: no matches (drizzle migration history retains the old SQL — that's fine).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: retire anchor_price_usd (the second ruler) end to end"
```

---

## Self-Review

**Spec coverage (Phase 2a scope):**
- Persist tier/methodology/marketPriceFlags → Tasks 1 (schema) + 2 (core/route). ✓
- Dashboard derives dollars via shared `reconciledResult`, single-ruler, input-notional derivation → Task 3 (`receiptDollars`), with the output-anchored correctness case tested. ✓
- Unsigned Execution Result (Gained/Lost + color) → Task 3 (`formatExecutionResult`). ✓
- Retire `anchor_price_usd` (schema/core/route/helpers) → Task 4. ✓
- **Deferred to Phase 2b:** the ReceiptView rendering of the four states (Token In/Out USD, Execution Result row, USD Market Price + methodology subvalue, USD Price Delta, `~Size` gating) — needs a browser verification loop against the Figma frames.

**Placeholder scan:** none — every code step is complete. The one generated artifact (migration SQL) has its exact expected contents stated for verification.

**Type consistency:** `receiptDollars` return shape identical across Task 3 definition, its tests, and the Phase-2b consumer contract; `formatExecutionResult` new shape (`{ text, sub, color }`) is defined and tested in Task 3 (its Phase-2b consumer must read `sub`, not the old signed `text`). `tier`/`methodology`/`marketPriceFlags` column names (`market_price_flags` jsonb) match across schema, core field names (camelCase `marketPriceFlags`), and `toNewReceipt`.

**Ordering for green increments:** Task 1 additive (schema), Task 2 additive (populate), Task 3 additive (new helper alongside old), Task 4 coordinated removal. `anchor_price_usd` stays present until Task 4, so tsc is green after every task.

---

## Execution Handoff

Phase 2a is a standalone deliverable: the apparatus's tier/methodology persist, the single-ruler dollar helper is tested and exported, and the second ruler is gone — with the full suite and `tsc` green. The receipt renders unchanged until **Phase 2b** (ReceiptView: the four render states), which gets its own plan and a browser verification loop to match the Figma frames.
