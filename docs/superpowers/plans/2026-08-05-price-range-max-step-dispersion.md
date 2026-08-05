# Price Range Max-Step Dispersion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Price Range table's population-sigma "Price deviates Xbps between blocks" caption with a signed, labeled max-single-step figure, so the caption reports a real observable move instead of diluting one into a smaller, unlabeled, directionless number.

**Architecture:** `priceDispersion.ts` currently computes the population standard deviation of the three block mids (before/at/after) and reports it as an unsigned magnitude. Replace that with a comparison of the two adjacent steps (`before→at` and `at→after`, both normalized against `at`) and report whichever has the larger magnitude, signed, naming the two blocks it spans. The block-name strings ("Before Block" / "At Block" / "After Block") are shared with `MarketPriceTable` via one exported constant so the two can't drift apart.

**Tech Stack:** TypeScript, Vitest (`vitest run`), React (server-rendered via `renderToStaticMarkup` in tests). Pure function change — no DB schema, no RPC, no new dependency.

## Global Constraints

- `dispersionClause`'s exported name and signature (`(before, at, after) => string`) must not change — `receiptView.tsx:113` calls it as-is and needs no edit.
- The two block-pair labels the clause names must be character-identical to `MarketPriceTable`'s row labels (`receiptRows.tsx:479-481`: `'Before Block'`, `'At Block'`, `'After Block'`) — enforced by importing one shared constant, not by hand-matching two string literals.
- Sign/zero convention matches the existing `formatDialogBps` pattern in this codebase (`receiptDisplay.tsx:91-97`): a zero value renders with no sign; a nonzero value gets a leading `+` or `-`.
- `npm test` does not typecheck this repo (project-known gap) — run `npx tsc --build` separately before calling any task done.
- This is a UI-visible change — verify it in the running dev server (`npm run dev`), not just via the test suite, before considering the work complete.

---

### Task 1: Rewrite `maxStepDeviation` / `dispersionClause` in `priceDispersion.ts`

**Files:**
- Modify: `packages/dashboard/components/receipt/priceDispersion.ts`
- Test: `packages/dashboard/components/receipt/priceDispersion.test.ts`

**Interfaces:**
- Produces: `export const MARKET_PRICE_BLOCK_LABELS: readonly ['Before Block', 'At Block', 'After Block']` — consumed by Task 2.
- Produces: `export interface MaxStepDeviation { bps: number; fromLabel: string; toLabel: string }` and `export function maxStepDeviation(before: unknown, at: unknown, after: unknown): MaxStepDeviation | null`.
- Produces: `export function dispersionClause(before: unknown, at: unknown, after: unknown): string` — same signature as today; this is what `receiptView.tsx` consumes (no change needed there).
- Removes: `export function dispersionBps(...)` (the old population-sigma export). Confirmed via repo-wide grep that only this file's own test imports it — no other consumer exists.

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `packages/dashboard/components/receipt/priceDispersion.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import { maxStepDeviation, dispersionClause } from './priceDispersion';

describe('maxStepDeviation', () => {
	it('picks the larger of the two adjacent steps, normalized against At Block', () => {
		// before=35.0269, at=35.0232, after=35.0173
		// stepBeforeToAt = (35.0232-35.0269)/35.0232*10000 = -1.0565
		// stepAtToAfter  = (35.0173-35.0232)/35.0232*10000 = -1.6846  <- larger magnitude, wins
		const result = maxStepDeviation(35.0269, 35.0232, 35.0173);
		expect(result).not.toBeNull();
		expect(result!.bps).toBeCloseTo(-1.68, 2);
		expect(result!.fromLabel).toBe('At Block');
		expect(result!.toLabel).toBe('After Block');
	});

	it('picks Before->At when that step is larger, even though it is the earlier one', () => {
		// stepBeforeToAt = (35.00-35.10)/35.00*10000 = -28.57  <- larger magnitude, wins
		// stepAtToAfter  = 0
		const result = maxStepDeviation(35.10, 35.00, 35.00);
		expect(result).not.toBeNull();
		expect(result!.bps).toBeCloseTo(-28.57, 2);
		expect(result!.fromLabel).toBe('Before Block');
		expect(result!.toLabel).toBe('At Block');
	});

	it('reproduces the receipt-543 case: a static ruler with a real move after it', () => {
		// before === at (the ruler did not move — the common case), so the old
		// population-sigma formula diluted a real 3.96bps move down to a
		// reported 1.87bps. The max-step figure reports the real move.
		const before = 0.08946959294717734;
		const at = 0.08946959294717734;
		const after = 0.0895050535736239;
		const result = maxStepDeviation(before, at, after);
		expect(result).not.toBeNull();
		expect(result!.bps).toBeCloseTo(3.96, 2);
		expect(result!.fromLabel).toBe('At Block');
		expect(result!.toLabel).toBe('After Block');
	});

	it('is exactly zero, defaulted to At->After, when the pool never moved', () => {
		// The COMMON case: the reference pool is usually not one the trade
		// touched, so all three blocks agree. This must render 0.00, not be
		// suppressed.
		const result = maxStepDeviation(35.0232, 35.0232, 35.0232);
		expect(result).not.toBeNull();
		expect(result!.bps).toBe(0);
		expect(result!.fromLabel).toBe('At Block');
		expect(result!.toLabel).toBe('After Block');
	});

	it('returns null when any block is missing, rather than narrowing the sample', () => {
		expect(maxStepDeviation(null, 35.0232, 35.0173)).toBeNull();
		expect(maxStepDeviation(35.0269, null, 35.0173)).toBeNull();
		expect(maxStepDeviation(35.0269, 35.0232, null)).toBeNull();
	});

	it('returns null for non-finite or non-positive input', () => {
		expect(maxStepDeviation(35.0269, 0, 35.0173)).toBeNull();
		expect(maxStepDeviation(35.0269, Number.NaN, 35.0173)).toBeNull();
		expect(maxStepDeviation('abc', 35.0232, 35.0173)).toBeNull();
	});

	it('accepts numeric strings, since the DB returns numerics as strings', () => {
		const result = maxStepDeviation('35.0269', '35.0232', '35.0173');
		expect(result).not.toBeNull();
		expect(result!.bps).toBeCloseTo(-1.68, 2);
	});
});

describe('dispersionClause', () => {
	it('renders the winning step, signed, with two decimals and a trailing period', () => {
		expect(dispersionClause(35.0269, 35.0232, 35.0173)).toBe(
			'Price moved -1.68bps from At Block to After Block.',
		);
	});

	it('renders a positive step with a leading +', () => {
		expect(
			dispersionClause(0.08946959294717734, 0.08946959294717734, 0.0895050535736239),
		).toBe('Price moved +3.96bps from At Block to After Block.');
	});

	it('renders the zero case rather than omitting it, without a sign', () => {
		expect(dispersionClause(35.0232, 35.0232, 35.0232)).toBe(
			'Price moved 0.00bps from At Block to After Block.',
		);
	});

	it('is empty when the triple is incomplete', () => {
		expect(dispersionClause(null, 35.0232, 35.0173)).toBe('');
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/dashboard/components/receipt/priceDispersion.test.ts`
Expected: FAIL — `maxStepDeviation` is not exported (the old file only exports `dispersionBps` and `dispersionClause`, and `dispersionClause` still returns the old sigma-based string).

- [ ] **Step 3: Write the implementation**

Replace the full contents of `packages/dashboard/components/receipt/priceDispersion.ts` with:

```ts
/**
 * Largest single-block price move among the three adjacent blocks the
 * receipt shows (N-2 / N-1 / N), reported as a signed bps step between the
 * two blocks it spans.
 *
 * Deliberately the max of the two adjacent steps, not a population sigma
 * over all three: the reference pool is usually not one the trade touched,
 * so in the common case `before === at` (the ruler didn't move) and a sigma
 * dilutes a real single-block move — a 3.96bps step reported as 1.87bps is
 * not a mistake a reader can catch, because the three price cells above
 * this caption render at 3 significant figures and look identical either
 * way. The max step is one real observed delta, and unlike a sigma it can
 * carry a sign (which direction the market moved) and name which two
 * blocks moved.
 *
 * Deliberately returns null rather than a narrowed sample when a block is
 * missing: two points would render just like three could, so the reader
 * cannot tell them apart. Absent is not a smaller measurement.
 *
 * Expect 0.00 often. The reference pool is the deepest pool for the pair,
 * which usually is not a pool the trade touched, so in a 20-receipt sample
 * it was unchanged across all three blocks 15 times. Three identical rows
 * and a 0.00 clause are the intended output, not a bug.
 */

// Mirrors MarketPriceTable's row labels (receiptRows.tsx) so this clause can
// name the pair that moved without the two ever drifting apart. Owned here
// (the pure/logic module) and imported by receiptRows.tsx (the presentational
// consumer), not the other way around.
export const MARKET_PRICE_BLOCK_LABELS = ['Before Block', 'At Block', 'After Block'] as const;
const [BEFORE_LABEL, AT_LABEL, AFTER_LABEL] = MARKET_PRICE_BLOCK_LABELS;

function toFinitePositive(v: unknown): number | null {
	if (v == null) return null;
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : null;
}

export interface MaxStepDeviation {
	bps: number;
	fromLabel: string;
	toLabel: string;
}

export function maxStepDeviation(before: unknown, at: unknown, after: unknown): MaxStepDeviation | null {
	const b = toFinitePositive(before);
	const a = toFinitePositive(at);
	const f = toFinitePositive(after);
	if (b === null || a === null || f === null) return null;

	// Both steps normalized against `at` (the ruler) — the same denominator
	// the rest of the receipt's bps figures use, so this number stays
	// comparable to them.
	const stepBeforeToAt = ((a - b) / a) * 10_000;
	const stepAtToAfter = ((f - a) / a) * 10_000;

	// Ties (including the common all-three-equal case) default to the
	// At->After step: it's the step closer to trade execution.
	if (Math.abs(stepAtToAfter) >= Math.abs(stepBeforeToAt)) {
		return { bps: stepAtToAfter, fromLabel: AT_LABEL, toLabel: AFTER_LABEL };
	}
	return { bps: stepBeforeToAt, fromLabel: BEFORE_LABEL, toLabel: AT_LABEL };
}

export function dispersionClause(before: unknown, at: unknown, after: unknown): string {
	const step = maxStepDeviation(before, at, after);
	if (step === null) return '';
	const rounded = Number(step.bps.toFixed(2));
	const sign = rounded > 0 ? '+' : rounded < 0 ? '-' : '';
	return `Price moved ${sign}${Math.abs(rounded).toFixed(2)}bps from ${step.fromLabel} to ${step.toLabel}.`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/dashboard/components/receipt/priceDispersion.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/components/receipt/priceDispersion.ts packages/dashboard/components/receipt/priceDispersion.test.ts
git commit -m "fix(dashboard): report max single-block step instead of 3-block sigma in Price Range caption"
```

---

### Task 2: Source `MarketPriceTable`'s row labels from the shared constant

**Files:**
- Modify: `packages/dashboard/components/receipt/receiptRows.tsx:467-503` (the `MarketPriceTable` component)

**Interfaces:**
- Consumes: `MARKET_PRICE_BLOCK_LABELS` from Task 1 (`./priceDispersion`).
- No new exports; `MarketPriceTable`'s props and rendered output are unchanged (same three label strings, same order).

- [ ] **Step 1: Edit the import block**

In `packages/dashboard/components/receipt/receiptRows.tsx`, add to the existing imports (near the top, alongside the `./receiptDisplay` import):

```ts
import { MARKET_PRICE_BLOCK_LABELS } from './priceDispersion';
```

- [ ] **Step 2: Replace the literal labels in the `rows` array**

Find this block (currently at `receiptRows.tsx:478-482`):

```ts
	const rows: [string, React.ReactNode, string][] = [
		['Before Block', before, SEC],
		['At Block', at, PRI],
		['After Block', after, SEC],
	];
```

Replace with:

```ts
	const [beforeLabel, atLabel, afterLabel] = MARKET_PRICE_BLOCK_LABELS;
	const rows: [string, React.ReactNode, string][] = [
		[beforeLabel, before, SEC],
		[atLabel, at, PRI],
		[afterLabel, after, SEC],
	];
```

- [ ] **Step 3: Run the existing MarketPriceTable tests to confirm no regression**

Run: `npx vitest run packages/dashboard/components/receiptView.test.tsx -t "MarketPriceTable"`
Expected: PASS — this exercises the `describe('MarketPriceTable (Figma 647-3599)', ...)` block (`receiptView.test.tsx:1919+`), which asserts on the literal rendered label text (`'>Before Block<'`, `'>At Block<'`, `'>After Block<'`). Output must be byte-identical to before this task since the label values themselves did not change, only their source.

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/components/receipt/receiptRows.tsx
git commit -m "refactor(dashboard): source MarketPriceTable labels from the shared block-label constant"
```

---

### Task 3: Update `receiptView.test.tsx` for the new caption copy

**Files:**
- Modify: `packages/dashboard/components/receiptView.test.tsx:2036-2040` and `:2077-2083`

**Interfaces:**
- Consumes: the new `dispersionClause` output format from Task 1. The file's `tripleMidRow` fixture (`marketMidBefore: '35.0269', marketMid: '35.0232', marketMidAfter: '35.0173'`, defined around line 2001) is unchanged — it's the same fixture Task 1's first test case computes against, so the expected string is `'Price moved -1.68bps from At Block to After Block.'`.

- [ ] **Step 1: Update the "appends the dispersion clause" test**

Find (currently `receiptView.test.tsx:2036-2040`):

```ts
	it('appends the dispersion clause to the methodology descriptor', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={tripleMidRow as never} />);
		expect(html).toContain('Price deviates 1.13bps between blocks.');
	});
```

Replace with:

```ts
	it('appends the dispersion clause to the methodology descriptor', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(<Receipt row={tripleMidRow as never} />);
		expect(html).toContain('Price moved -1.68bps from At Block to After Block.');
	});
```

- [ ] **Step 2: Fix the vacuous-pass risk in the "omits the dispersion clause" test**

Find (currently `receiptView.test.tsx:2077-2083`):

```ts
	it('omits the dispersion clause when a block is missing', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<Receipt row={{ ...tripleMidRow, marketMidAfter: null } as never} />,
		);
		expect(html).not.toContain('between blocks');
	});
```

The new clause text no longer contains the substring `'between blocks'` at all — as written, this assertion would pass regardless of whether the clause renders, which is a vacuous pass (this codebase has hit this trap before with positional/substring assertions). Replace with:

```ts
	it('omits the dispersion clause when a block is missing', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<Receipt row={{ ...tripleMidRow, marketMidAfter: null } as never} />,
		);
		expect(html).not.toContain('Price moved');
	});
```

- [ ] **Step 3: Verify no other file contains the old copy or the new copy pre-existing (collision check)**

Run: `grep -rn "Price deviates\|between blocks" packages/dashboard --include="*.ts" --include="*.tsx"`
Expected: no matches (confirms the old copy is fully gone).

Run: `grep -rn "Price moved" packages/dashboard --include="*.ts" --include="*.tsx" | grep -v priceDispersion`
Expected: only the two lines just edited in `receiptView.test.tsx` — confirms `'Price moved'` isn't already used by some other methodology string that Step 2's assertion could false-positive against.

- [ ] **Step 4: Run the full receiptView test file**

Run: `npx vitest run packages/dashboard/components/receiptView.test.tsx`
Expected: PASS (all tests in the file, not just the two touched)

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/components/receiptView.test.tsx
git commit -m "test(dashboard): update Price Range caption assertions for the max-step wording"
```

---

### Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `npx tsc --build`
Expected: no errors. (`npm test` does not typecheck in this repo — this step is not optional.)

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all tests pass, no regressions outside the files touched in Tasks 1-3.

- [ ] **Step 3: Manual browser check**

Start the dev server (`npm run dev`) and open the receipt for tx `0x4e51ce6c292c3ab50809b9d95ee5dac72240a64343625e697513f9cb8ebd6e92` (chain 8453 / receipt id 543 — the case that motivated this change). Confirm:
- The Price Range caption now reads `Price moved +3.96bps from At Block to After Block.` instead of the old `Price deviates 1.87bps between blocks.`
- The three Market Price rows (`Before Block` / `At Block` / `After Block`) still render, still show `0.0895 ... = 1 WETH` for all three (the 3-sig-fig display precision is unchanged by this task — it's a known, separate limitation, not something this plan fixes).
- Open any other receipt with `manipulationFlag` set (or reuse the existing test fixture pattern) to confirm the badge still renders as a sibling of the table and the caption still sits below it, unaffected by this change.

- [ ] **Step 4: Report**

No further commit needed if Steps 1-3 are clean — Task 1-3's commits already cover the code. If the manual check surfaces anything, fix it as a new small commit before considering the branch done.
