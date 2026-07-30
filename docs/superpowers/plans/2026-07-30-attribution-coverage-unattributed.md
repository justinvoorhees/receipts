# Attribution Coverage + the Unattributed Row — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When we did not price every leg of a route, stop calling the leftover
"Slippage" and call it "Unattributed" — gated on a notional-weighted coverage
metric shared by the UI and the analysis scripts.

**Architecture:** Two pure functions land in `packages/core/src/receiptPure.ts`
(the dependency-free leaf already exposed as `@fabric-tca/core/pure`).
`getExecutionBreakdown` in the dashboard consumes them and gains three return
fields. The receipt swaps two rows for one; the trades table splits one column
into three. **No arithmetic changes** — the residual is already computed
correctly; only its label and gating change.

**Tech Stack:** TypeScript, React 19 (server-rendered via
`renderToStaticMarkup` in tests), Vitest, Tailwind, Drizzle/Postgres (read-only
here), Node ESM analysis scripts.

Spec: `docs/superpowers/specs/2026-07-30-attribution-coverage-unattributed-design.md`

## Global Constraints

- **Do not change any displayed number.** The residual `slippage_bps −
  Σ(measured priceImpactBps)` is already correct. This work relabels and gates
  it. Task 2 carries an explicit regression test proving the digits are identical.
- **Tooltip copy is verbatim, user-specified. Do not paraphrase:**
  - `n/a` cells: `No slippage calculation available, pricing coverage is n% complete`
    (with `n` substituted, e.g. `pricing coverage is 76% complete`)
  - Unattributed label: `Residual cost or benefit that could not be completely attributed to L.P. fees, aggregator fees, or price impact`
- **Indentation differs by package.** `packages/core/src/*.ts` uses **2 spaces**.
  `packages/dashboard/**` uses **tabs**. Match the file you are editing.
- **Client components must import core helpers from the `@fabric-tca/core/pure`
  leaf subpath**, never the barrel `@fabric-tca/core` — the barrel pulls
  `analyzeTransaction → tagging → node:fs` into the browser bundle. Vitest will
  NOT catch this; only a browser load will.
- **`formatDialogBps` strips the minus sign.** `-6.18` renders `6.18bps`, never
  `-6.18bps`. Positive values get a leading `+`. Exact `0` renders `0.00bps`.
- **Never run `npm run build` while a dev server is running** — it writes into
  the same `.next` and the app renders unstyled. Use `npx tsc --build`.
- **Test suite baseline to hold: 595/595** with `.env` exported
  (`set -a && source .env && set +a`); 592 passing + 3 skipped without it. Run
  both states before calling anything green.
- **No migration and no repopulation.** Everything derives from `route_legs` at
  read time.

## File Structure

| file | responsibility |
|---|---|
| `packages/core/src/receiptPure.ts` | **modify** — owns the definition of "costed leg" and "coverage". Pure arithmetic, no I/O. |
| `packages/core/src/receiptPure.test.ts` | **modify** — behavior tests for the above |
| `packages/dashboard/components/receipt/receiptDisplay.tsx` | **modify** — `getExecutionBreakdown` gains coverage + Unattributed; owns tooltip copy constants |
| `packages/dashboard/components/receipt/receiptDisplay.test.ts` | **modify** — breakdown unit tests |
| `packages/dashboard/components/receiptView.tsx` | **modify** — conditional Unattributed row, `valueTooltip` on the two `n/a` cells |
| `packages/dashboard/components/receiptView.test.tsx` | **modify** — render tests |
| `packages/dashboard/lib/queries.ts` | **modify** — two new sort column keys |
| `packages/dashboard/components/tradesTable.tsx` | **modify** — 1 column → 3, accessors |
| `packages/dashboard/components/tradesTable.test.tsx` | **modify** — column tests |
| `scripts/analysis/_env.mjs` | **modify** — local `costedLegs` re-exports core's |
| `scripts/analysis/attributionCoverage.mjs` | **modify** — import the shared coverage fn |
| `scripts/analysis/coverageEstimate.mjs` | **modify** — same (file already exists, committed in `c4ad239`) |
| `docs/attribution-worklist.md` | **modify** — §1 marked done; percentage reversal recorded |

## Real Data For Tests

Measured 2026-07-30 against the live corpus. Use these — they are real receipts,
not invented fixtures.

| id | legs | priced | coverage | floor | `slippage_bps` | `Σ legPI` | residual |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 210 | 6 | 5 | 76.5480% | **76** | 25.54 | 19.37 | **6.18** |
| 189 | 8 | 6 | 61.3952% | 61 | 159.48 | 149.34 | 10.13 |
| 236 | 5 | 4 | 69.6508% | 69 | −17.56 | 1.38 | −18.94 |
| 55 | 4 | 3 | 98.5075% | 98 | 271.39 | 316.53 | −45.13 |
| 59 | 4 | 3 | 65.6378% | 65 | −183.68 | 111.37 | −295.05 |
| 215 | 6 | 5 | 94.1393% | 94 | 1.85 | 23.55 | −21.70 |
| 402 | 2 | 1 | 50.0336% | 50 | 33.27 | 12.44 | 20.82 |
| 36 | 1 | 0 | 0% | 0 | −26.66 | 0.00 | −26.66 |

Corpus totals: 62 receipts, 42 fully priced (unchanged), 20 below 100%, of which
13 currently print a number and will change.

---

### Task 1: Coverage primitives in core/pure

**Files:**
- Modify: `packages/core/src/receiptPure.ts` (append after `reconciledResult`, line 71)
- Test: `packages/core/src/receiptPure.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `costedLegs<T extends { type: string }>(legs: readonly T[]): T[]`
  - `priceImpactCoverage(legs: readonly CoverageLeg[]): number | null` where
    `CoverageLeg = { type: string; notionalUsdc: number; priceImpactBps: number | null }`
  - `isFullyPriced(legs: readonly { type: string; priceImpactBps: number | null }[]): boolean`
  - `export interface CoverageLeg` (exported so the dashboard can type its call)

⚠️ This file uses **2-space** indentation.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/receiptPure.test.ts`, and add the three new names
to the existing `import { … } from './receiptPure.js';` line at the top:

```ts
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
    // The REAL persisted route_legs of receipt 210 (Velora, $13,094), copied
    // from the database. 7 legs: 1 wrap (excluded) + 6 costed, of which the
    // rfq leg is unpriced. Notional-weighted coverage is 76.5480%.
    const legs = [
      leg(0, null, 'wrap'),
      leg(4971.412665, null, 'rfq'),
      leg(262.18974219197634, 0.020898202205538393, 'aerodrome_cl'),
      leg(3665.7859929998917, 0.09839290965261527, 'univ3'),
      leg(1047.1355028719797, 0.03968021578582681, 'univ3'),
      leg(3142.2182415639018, 0.026166874292076724, 'pancakev3'),
      leg(8109.494037, 19.183571888765734, 'curve_stableng'),
    ];
    const cov = priceImpactCoverage(legs)!;
    expect(cov * 100).toBeCloseTo(76.5480, 3);
    expect(Math.floor(100 * cov)).toBe(76);
    expect(isFullyPriced(legs)).toBe(false);
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder
npx vitest run packages/core/src/receiptPure.test.ts
```

Expected: FAIL — `costedLegs is not a function` / no export named `costedLegs`.

- [ ] **Step 3: Implement**

Append to `packages/core/src/receiptPure.ts`:

```ts
// ── Attribution coverage ─────────────────────────────────────────────────────
// How much of a route did we actually price? Consumed by the dashboard (to
// decide whether a residual may be called "Slippage") and by scripts/analysis
// (to report corpus-wide coverage). ONE definition, so the number the receipt
// shows and the number the worklist quotes cannot drift.

/** The minimal per-leg shape coverage needs. Structural so no package owns it. */
export interface CoverageLeg {
  type: string;
  notionalUsdc: number;
  priceImpactBps: number | null;
}

/**
 * Cost-bearing legs only. wrap/unwrap are informational conversions: they carry
 * no notional and are never priced, so including them would drag every wrapped
 * route's coverage down for no reason.
 */
export function costedLegs<T extends { type: string }>(legs: readonly T[]): T[] {
  return legs.filter((l) => l.type !== 'wrap' && l.type !== 'unwrap');
}

/**
 * Notional-weighted share of the route whose price impact we measured.
 * null when there is nothing to weigh (no costed legs, or zero total notional) —
 * 0/0 is undefined, and callers that want to DISPLAY that case decide for
 * themselves what to show. See isFullyPriced for the gating question, which is
 * deliberately a different test.
 */
export function priceImpactCoverage(legs: readonly CoverageLeg[]): number | null {
  const costed = costedLegs(legs);
  const notional = (l: CoverageLeg) => Number(l.notionalUsdc) || 0;
  const total = costed.reduce((s, l) => s + notional(l), 0);
  if (!(total > 0)) return null;
  const priced = costed.filter((l) => l.priceImpactBps != null).reduce((s, l) => s + notional(l), 0);
  return priced / total;
}

/**
 * True only when EVERY costed leg carries a price impact.
 *
 * This is the GATE, and it is leg-count based on purpose: the defect it guards
 * is summing a partial set of legs and labelling the remainder "Slippage", which
 * is a lie regardless of how little notional the unpriced leg carried. The
 * notional-weighted priceImpactCoverage above is for DISPLAY only. The two can
 * disagree — a zero-notional unpriced leg is 100% coverage but not fully priced.
 *
 * False on an empty route: a route we never decomposed priced 0% of itself, and
 * vacuous truth here would let it keep printing a confident Slippage number.
 */
export function isFullyPriced(
  legs: readonly { type: string; priceImpactBps: number | null }[],
): boolean {
  const costed = costedLegs(legs);
  return costed.length > 0 && costed.every((l) => l.priceImpactBps != null);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run packages/core/src/receiptPure.test.ts
npx tsc --build
```

Expected: all PASS, `tsc` exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/receiptPure.ts packages/core/src/receiptPure.test.ts
git commit -m "feat(core): add attribution-coverage primitives to the pure leaf

costedLegs, priceImpactCoverage, and isFullyPriced. The gate (isFullyPriced)
is leg-count based; the displayed percentage (priceImpactCoverage) is
notional-weighted. They disagree on a zero-notional unpriced leg, which is
why they are two functions.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `getExecutionBreakdown` gains coverage and Unattributed

**Files:**
- Modify: `packages/dashboard/components/receipt/receiptDisplay.tsx:98-129`
- Test: `packages/dashboard/components/receipt/receiptDisplay.test.ts`

**Interfaces:**
- Consumes: `priceImpactCoverage`, `isFullyPriced` from `@fabric-tca/core/pure` (Task 1).
- Produces: `getExecutionBreakdown` returns four additional fields —
  `unattributedDisplay: { text: string; color: string | undefined }`,
  `coveragePercent: number`, `fullyPriced: boolean`, and
  `residualRawBps: number | null` (the **unnegated** residual, positive = cost;
  Task 4's sort accessors need the sign, which the display strings have had
  stripped). Also exports `UNATTRIBUTED_TOOLTIP: string` and
  `noSlippageTooltip(coveragePercent: number): string`.

⚠️ Dashboard files use **tabs**.

- [ ] **Step 1: Write the failing tests**

Append to `packages/dashboard/components/receipt/receiptDisplay.test.ts`:

```ts
describe('getExecutionBreakdown coverage gating', () => {
	// The REAL persisted row for receipt id 210 (Velora, $13,094), copied from
	// the database: 7 legs = 1 wrap (excluded from coverage) + 6 costed, of
	// which the rfq leg is unpriced. Coverage 76.5480%; Σ legPI 19.36871009…;
	// residual 25.544581… − 19.368710… = 6.175871… → renders "6.18bps".
	const SLIPPAGE_BPS = 25.544581236341276;
	const SUM_PI = 19.36871009070179;
	const id210 = {
		slippageBps: SLIPPAGE_BPS,
		routeLegs: [
			{ type: 'wrap', notionalUsdc: 0, priceImpactBps: null },
			{ type: 'rfq', notionalUsdc: 4971.412665, priceImpactBps: null },
			{ type: 'aerodrome_cl', notionalUsdc: 262.18974219197634, priceImpactBps: 0.020898202205538393 },
			{ type: 'univ3', notionalUsdc: 3665.7859929998917, priceImpactBps: 0.09839290965261527 },
			{ type: 'univ3', notionalUsdc: 1047.1355028719797, priceImpactBps: 0.03968021578582681 },
			{ type: 'pancakev3', notionalUsdc: 3142.2182415639018, priceImpactBps: 0.026166874292076724 },
			{ type: 'curve_stableng', notionalUsdc: 8109.494037, priceImpactBps: 19.183571888765734 },
		],
	};
	// Same trade, same residual, but collapsed to a single fully-priced leg —
	// so the two fixtures differ ONLY in coverage, and any display difference
	// between them is attributable to the gate and nothing else.
	const fullyPricedRow = {
		slippageBps: SLIPPAGE_BPS,
		routeLegs: [{ type: 'univ3', notionalUsdc: 13094.06, priceImpactBps: SUM_PI }],
	};

	it('a partially-priced route moves its residual to Unattributed', async () => {
		const { getExecutionBreakdown } = await import('./receiptDisplay');
		const r = getExecutionBreakdown(id210 as never);
		expect(r.fullyPriced).toBe(false);
		expect(r.slippageDisplay.text).toBe('n/a');
		expect(r.positiveSlippageDisplay.text).toBe('n/a');
		expect(r.unattributedDisplay.text).toBe('6.18bps');
		// Unnegated and signed — the display string above has lost both.
		expect(r.residualRawBps).toBeCloseTo(6.18, 6);
	});

	it('THE REGRESSION GUARD: Unattributed prints exactly what Slippage used to', async () => {
		// This change must not move a single digit. Before this work, id 210's
		// Slippage row rendered "6.18bps" — the SAME residual, under a name that
		// claimed we had accounted for price impact. Only the label changes.
		const { getExecutionBreakdown, formatDialogBps } = await import('./receiptDisplay');
		const r = getExecutionBreakdown(id210 as never);
		const sumPi = id210.routeLegs.reduce((s, l) => s + (l.priceImpactBps ?? 0), 0);
		const legacySlippage = formatDialogBps(-(id210.slippageBps - sumPi));
		expect(r.unattributedDisplay.text).toBe(legacySlippage.text);
	});

	it('a fully-priced route keeps Slippage and blanks Unattributed', async () => {
		const { getExecutionBreakdown } = await import('./receiptDisplay');
		const r = getExecutionBreakdown(fullyPricedRow as never);
		expect(r.fullyPriced).toBe(true);
		expect(r.unattributedDisplay.text).toBe('n/a');
		expect(r.slippageDisplay.text).toBe('6.18bps');
		expect(r.positiveSlippageDisplay.text).toBe('0.00bps');
		expect(r.coveragePercent).toBe(100);
	});

	it('coveragePercent floors, so it never overstates what we priced', async () => {
		const { getExecutionBreakdown } = await import('./receiptDisplay');
		// 76.5480% must read 76, not 77.
		expect(getExecutionBreakdown(id210 as never).coveragePercent).toBe(76);
	});

	it('coveragePercent caps at 99 when a zero-notional leg is unpriced', async () => {
		const { getExecutionBreakdown } = await import('./receiptDisplay');
		// Notional-weighted coverage is exactly 1, but the route is NOT fully
		// priced. "pricing coverage is 100% complete" beside an n/a is absurd.
		const r = getExecutionBreakdown({
			slippageBps: 10,
			routeLegs: [
				{ type: 'swap', notionalUsdc: 1000, priceImpactBps: 2 },
				{ type: 'swap', notionalUsdc: 0, priceImpactBps: null },
			],
		} as never);
		expect(r.fullyPriced).toBe(false);
		expect(r.coveragePercent).toBe(99);
	});

	it('an empty route is 0% covered, not vacuously complete', async () => {
		const { getExecutionBreakdown } = await import('./receiptDisplay');
		const r = getExecutionBreakdown({ slippageBps: 25.54, routeLegs: [] } as never);
		expect(r.fullyPriced).toBe(false);
		expect(r.coveragePercent).toBe(0);
		expect(r.unattributedDisplay.text).toBe('25.54bps');
		expect(r.slippageDisplay.text).toBe('n/a');
	});

	it('a null slippageBps yields n/a everywhere, not a fake zero', async () => {
		const { getExecutionBreakdown } = await import('./receiptDisplay');
		const r = getExecutionBreakdown({ slippageBps: null, routeLegs: [] } as never);
		expect(r.unattributedDisplay.text).toBe('–');
		expect(r.slippageDisplay.text).toBe('n/a');
	});

	it('the n/a tooltip names the coverage percentage', async () => {
		const { noSlippageTooltip } = await import('./receiptDisplay');
		expect(noSlippageTooltip(76)).toBe(
			'No slippage calculation available, pricing coverage is 76% complete',
		);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run packages/dashboard/components/receipt/receiptDisplay.test.ts
```

Expected: FAIL — `r.unattributedDisplay` is undefined; `noSlippageTooltip` is
not exported.

- [ ] **Step 3: Implement**

Replace `getExecutionBreakdown` at `receiptDisplay.tsx:98-129` with:

```tsx
/**
 * Copy for the Slippage / Positive Slippage cells when we could not price every
 * leg. The percentage is deliberately user-facing: a trader should be able to
 * see how much of their transaction we actually priced.
 */
export function noSlippageTooltip(coveragePercent: number): string {
	return `No slippage calculation available, pricing coverage is ${coveragePercent}% complete`;
}

/** Copy for the Unattributed row's label. */
export const UNATTRIBUTED_TOOLTIP =
	'Residual cost or benefit that could not be completely attributed to L.P. fees, aggregator fees, or price impact';

const NOT_AVAILABLE = { text: 'n/a', color: undefined };

export function getExecutionBreakdown(row: { slippageBps: string | number | null; routeLegs?: unknown }): {
	executionDisplay: { text: string; color: string | undefined };
	priceImpactDisplay: { text: string; color: string | undefined };
	marketForcesDisplay: { text: string; color: string | undefined };
	slippageDisplay: { text: string; color: string | undefined };
	positiveSlippageDisplay: { text: string; color: string | undefined };
	unattributedDisplay: { text: string; color: string | undefined };
	coveragePercent: number;
	fullyPriced: boolean;
	residualRawBps: number | null;
} {
	const executionRaw =
		row.slippageBps == null || !Number.isFinite(Number(row.slippageBps))
			? null
			: Number(row.slippageBps);
	const legs = normalizeRouteLegs(row.routeLegs);
	const hasPriceImpact = legs.some((leg) => leg.priceImpactBps != null);
	const priceImpactRaw = hasPriceImpact
		? legs.reduce((sum, leg) => sum + (leg.priceImpactBps ?? 0), 0)
		: null;
	const marketForcesRaw =
		executionRaw != null && priceImpactRaw != null ? executionRaw - priceImpactRaw : executionRaw;

	// marketForcesRaw > 0 is a cost to the user; < 0 is a benefit. Split so each
	// row only ever carries one side, with the other pinned to 0.00bps.
	const slippageCostRaw = marketForcesRaw == null ? null : Math.max(marketForcesRaw, 0);
	const slippageBenefitRaw = marketForcesRaw == null ? null : Math.min(marketForcesRaw, 0);

	// The residual above is CORRECT arithmetic either way — it is what is left
	// after every leg we could price. What changes below is only what we are
	// entitled to CALL it. "Slippage" claims we accounted for price impact; when
	// a leg went unpriced, the honest claim is "we could not attribute this".
	const fullyPriced = isFullyPriced(legs);
	const coverage = priceImpactCoverage(legs);
	// Floor, never round, so we cannot overstate coverage; and cap at 99 so a
	// route that is 100.0% by notional but still has an unpriced (zero-notional)
	// leg never reads "100% complete" next to an n/a. A null coverage means
	// nothing to weigh at all, which is 0% priced.
	const coveragePercent = fullyPriced ? 100 : Math.min(99, Math.floor(100 * (coverage ?? 0)));

	const residualDisplay = formatDialogBps(marketForcesRaw == null ? null : -marketForcesRaw);

	return {
		executionDisplay: formatDialogBps(executionRaw == null ? null : -executionRaw),
		priceImpactDisplay: formatDialogBps(priceImpactRaw == null ? null : -priceImpactRaw),
		marketForcesDisplay: residualDisplay,
		slippageDisplay: fullyPriced
			? formatDialogBps(slippageCostRaw == null ? null : -slippageCostRaw)
			: NOT_AVAILABLE,
		positiveSlippageDisplay: fullyPriced
			? formatDialogBps(slippageBenefitRaw == null ? null : -slippageBenefitRaw)
			: NOT_AVAILABLE,
		unattributedDisplay: fullyPriced ? NOT_AVAILABLE : residualDisplay,
		coveragePercent,
		fullyPriced,
		// Unnegated (positive = cost to the user). Exposed because the display
		// strings above have had their sign stripped by formatDialogBps and the
		// trades-table sort needs it back. Callers negate for display polarity.
		residualRawBps: marketForcesRaw,
	};
}
```

Add the import at the top of `receiptDisplay.tsx`. The file currently imports
nothing from core — its imports end at `./usdFormat` on line 17. Add after
line 13 (`import { useState } from 'react';`):

```tsx
import { isFullyPriced, priceImpactCoverage } from '@fabric-tca/core/pure';
```

⚠️⚠️ This file is marked `'use client'` (line 1). The subpath **must** be
`@fabric-tca/core/pure`, never the barrel `@fabric-tca/core` — the barrel
re-exports `analyzeTransaction → tagging → node:fs` and will break the browser
bundle. **Vitest runs in Node and will pass either way**, so the test suite
cannot catch this mistake. It is the first thing to check if the app 500s.

⚠️ Note the last test case: when `slippageBps` is null, `residualDisplay` is
`formatDialogBps(null)` = `{ text: '–' }`, so Unattributed shows `–` while the
Slippage rows show `n/a`. That asymmetry is intended — `–` means "no number
exists", `n/a` means "a number exists but we will not label it Slippage".

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run packages/dashboard/components/receipt/receiptDisplay.test.ts
npx tsc --build
```

Expected: all PASS, `tsc` exit 0.

- [ ] **Step 5: Run the full dashboard suite to find fallout**

```bash
npx vitest run packages/dashboard
```

Expected: `tradesTable.test.tsx:107` exercises `marketForcesDisplay`, which is
unchanged, so it should still pass. Any failure here is a real regression —
investigate rather than editing the assertion.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/components/receipt/receiptDisplay.tsx \
        packages/dashboard/components/receipt/receiptDisplay.test.ts
git commit -m "feat(dashboard): gate Slippage on full price-impact coverage

getExecutionBreakdown gains unattributedDisplay, coveragePercent, and
fullyPriced. Below 100% coverage the residual is reported as Unattributed
rather than Slippage. The arithmetic is untouched — a regression test pins
Unattributed to the exact string Slippage used to print.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The Unattributed row on the receipt

**Files:**
- Modify: `packages/dashboard/components/receiptView.tsx:384-397`
- Test: `packages/dashboard/components/receiptView.test.tsx`

**Interfaces:**
- Consumes: `getExecutionBreakdown` (Task 2) — `unattributedDisplay`,
  `coveragePercent`, `fullyPriced`; `noSlippageTooltip`, `UNATTRIBUTED_TOOLTIP`.
- Produces: nothing consumed by later tasks.

Figma reference: `f9uYixaSgpkV1lEvN8Ie01`, node `577-1232`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/dashboard/components/receiptView.test.tsx`. Note
`fullUsdcWethRow` (line 141) has `routeLegs: []`, which is now "0% covered" — so
it is the natural fixture for the below-100% case, and a fully-priced variant
must be built for the other:

```tsx
describe('Receipt Unattributed row', () => {
	const pricedLeg = {
		venue: '0x1111111111111111111111111111111111111111',
		type: 'swap',
		tokenIn: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
		tokenOut: '0x4200000000000000000000000000000000000006',
		feeTierBps: 5, notionalUsdc: 1000, lpFeeBps: 1, priceImpactBps: 2,
	};
	const unpricedLeg = { ...pricedLeg, notionalUsdc: 500, priceImpactBps: null };

	const fullyPricedRow = { ...fullUsdcWethRow, routeLegs: [pricedLeg] };
	const partialRow = { ...fullUsdcWethRow, routeLegs: [pricedLeg, unpricedLeg] };

	it('hides the Unattributed row entirely when every leg is priced', async () => {
		const { ReceiptView } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={fullyPricedRow as never} hash={fullyPricedRow.txHash} />,
		);
		// Anchor on the cell, not the bare word: 'Slippage' is a substring of
		// 'Positive Slippage', and a bare toContain would pass vacuously.
		expect(html).not.toContain('>Unattributed<');
		expect(html).toContain('>Slippage<');
		expect(html).toContain('>Positive Slippage<');
	});

	it('shows Unattributed and n/a Slippage when a leg went unpriced', async () => {
		const { ReceiptView } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={partialRow as never} hash={partialRow.txHash} />,
		);
		expect(html).toContain('>Unattributed<');
		expect(html).toContain('>Slippage<');
		expect(html).toContain('>Positive Slippage<');
	});

	it('names the coverage percentage in the n/a tooltip', async () => {
		const { ReceiptView } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={partialRow as never} hash={partialRow.txHash} />,
		);
		// 1000 of 1500 notional priced = 66.66% → floors to 66.
		expect(html).toContain('No slippage calculation available, pricing coverage is 66% complete');
	});

	it('explains Unattributed on its label', async () => {
		const { ReceiptView } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={partialRow as never} hash={partialRow.txHash} />,
		);
		expect(html).toContain(
			'Residual cost or benefit that could not be completely attributed to L.P. fees, aggregator fees, or price impact',
		);
	});

	it('counts exactly two n/a cells in the slippage group, not one and not three', async () => {
		const { ReceiptView } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<ReceiptView trade={partialRow as never} hash={partialRow.txHash} />,
		);
		// A counted differential: 'n/a' is NOT unique on this page (unpriced leg
		// rows carry it too), so assert against the same render without the
		// unpriced leg rather than against an absolute count.
		const baseline = renderToStaticMarkup(
			<ReceiptView trade={fullyPricedRow as never} hash={fullyPricedRow.txHash} />,
		);
		const count = (s: string) => s.split('n/a').length - 1;
		// partial adds: 1 unpriced leg row + Slippage + Positive Slippage = 3.
		expect(count(html) - count(baseline)).toBe(3);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run packages/dashboard/components/receiptView.test.tsx -t 'Unattributed'
```

Expected: FAIL — `>Unattributed<` not found.

⚠️ Vitest `-t` is a **substring** filter, not an exact match. Confirm the run
reports a non-zero number of tests; a typo silently runs zero and reports green.

- [ ] **Step 3: Implement**

At `receiptView.tsx:384-397`, replace the two `BkdHeading`s with:

```tsx
<BkdHeading
	label="Slippage"
	value={execution.slippageDisplay.text}
	color={execution.slippageDisplay.color}
	tooltip="Residual cost after L.P. fees, aggregator fees, and price impact"
	valueTooltip={
		execution.fullyPriced ? undefined : noSlippageTooltip(execution.coveragePercent)
	}
	standalone
/>
<BkdHeading
	label="Positive Slippage"
	value={execution.positiveSlippageDisplay.text}
	color={execution.positiveSlippageDisplay.color}
	tooltip="Residual benefit after L.P. fees, aggregator fees, and price impact"
	valueTooltip={
		execution.fullyPriced ? undefined : noSlippageTooltip(execution.coveragePercent)
	}
	standalone
/>
{/*
  Shown ONLY when a leg went unpriced. The residual is the same number the
  Slippage row would have printed; what it is not is *slippage*, because we
  never measured every leg's price impact. One signed row — it is not split
  into cost/benefit halves the way Slippage is (Figma 577-1232).
*/}
{!execution.fullyPriced && (
	<BkdHeading
		label="Unattributed"
		value={execution.unattributedDisplay.text}
		color={execution.unattributedDisplay.color}
		tooltip={UNATTRIBUTED_TOOLTIP}
		standalone
	/>
)}
```

Extend the existing import from `./receipt/receiptDisplay` at
`receiptView.tsx:13` to include `noSlippageTooltip` and `UNATTRIBUTED_TOOLTIP`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run packages/dashboard/components/receiptView.test.tsx
npx tsc --build
```

Expected: all PASS.

- [ ] **Step 5: Verify the positional assertions by mutation**

⚠️ Non-negotiable — positional assertions on this exact file were defective 5×
in one prior plan. `receiptView.test.tsx:582` does
`html.slice(html.indexOf('Price Impact'), html.indexOf('Slippage'))`; adding a
row after Slippage should not affect it, but prove it rather than assume it.

Temporarily change the new row's label from `Unattributed` to `Unattributedx`,
re-run `npx vitest run packages/dashboard/components/receiptView.test.tsx`, and
confirm the new tests **FAIL**. Then revert the mutation and confirm they pass
again. If any test stayed green through the mutation, it is vacuous — fix it.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/components/receiptView.tsx \
        packages/dashboard/components/receiptView.test.tsx
git commit -m "feat(dashboard): render the Unattributed row below 100% coverage

Slippage and Positive Slippage become n/a with a tooltip naming the coverage
percentage; a single signed Unattributed row carries the residual. Hidden
entirely when every leg was priced. Figma 577-1232.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Split the trades-table Slippage column into three

**Files:**
- Modify: `packages/dashboard/lib/queries.ts:115-118`
- Modify: `packages/dashboard/components/tradesTable.tsx:26-49` (accessors),
  `:177-179` (header), `:286` (cell)
- Test: `packages/dashboard/components/tradesTable.test.tsx`

**Interfaces:**
- Consumes: `getExecutionBreakdown` (Task 2) — `slippageDisplay`,
  `positiveSlippageDisplay`, `unattributedDisplay`, `fullyPriced`.
- Produces: `TradesSortColumn` gains `'posSlippage'` and `'unattributed'`.

The table is admin-facing. Layout is **static** — all three columns render on
every row; the ones that do not apply show `–`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/dashboard/components/tradesTable.test.tsx`:

```tsx
describe('TradesTable slippage columns', () => {
	const baseRow = {
		id: 1, txHash: '0xaaaa', chainId: 8453, blockNumber: 1,
		aggregator: 'kyberswap', direction: 'buy_weth',
		inputToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
		outputToken: '0x4200000000000000000000000000000000000006',
		inputSymbol: 'USDC', outputSymbol: 'WETH',
		inputAmount: '1000', outputAmount: '0.33', notionalUsd: '1000',
		realizedPrice: '3000', marketMid: '3000', allInCostBps: '-1',
		pricingStatus: 'full', lpFeeBps: '1', aggFeeBps: '0',
		slippageBps: '25.54', executionBps: '-1', gasCostUsd: '0.001',
		hopCount: 1, routeShape: 'single', decompConfidence: 'low',
		routePure: true, reconResidualBps: null, manipulationFlag: false,
	};
	const leg = (notionalUsdc: number, priceImpactBps: number | null) => ({
		venue: '0x1111111111111111111111111111111111111111', type: 'swap',
		tokenIn: baseRow.inputToken, tokenOut: baseRow.outputToken,
		feeTierBps: 5, notionalUsdc, lpFeeBps: 1, priceImpactBps,
	});

	it('renders all three slippage columns as headers', async () => {
		const { TradesTable } = await import('./tradesTable');
		const html = renderToStaticMarkup(
			<TradesTable
				rows={[{ ...baseRow, routeLegs: [leg(1000, 19.37)] }] as never}
				initialSort={{ column: 'block', direction: 'desc' }}
			/>,
		);
		// Anchor on the cell: 'Slippage' is a substring of 'Pos. Slippage'.
		expect(html).toContain('>SLIPPAGE');
		expect(html).toContain('>POS. SLIPPAGE');
		expect(html).toContain('>UNATTRIBUTED');
	});

	// A COUNTED DIFFERENTIAL, not an absolute count: '–' is not unique in this
	// table (an RFQ-only route dashes L.P. Fee, a null allInCostBps dashes
	// Ex. Quality), so an absolute assertion would be brittle and could pass for
	// the wrong reason. Both renders below differ ONLY in the unpriced leg.
	const renderBody = async (legs: unknown[]) => {
		const { TradesTable } = await import('./tradesTable');
		const html = renderToStaticMarkup(
			<TradesTable
				rows={[{ ...baseRow, routeLegs: legs }] as never}
				initialSort={{ column: 'block', direction: 'desc' }}
			/>,
		);
		return html.slice(html.indexOf('<tbody'));
	};
	const dashes = (s: string) => s.split('>–<').length - 1;

	it('the residual moves from Slippage to Unattributed when a leg is unpriced', async () => {
		const priced = await renderBody([leg(1000, 19.37)]);
		const partial = await renderBody([leg(1000, 19.37), leg(500, null)]);

		// Same residual either way — 25.54 − 19.37 = 6.18. Only the column moves.
		expect(priced).toContain('6.18bps');
		expect(partial).toContain('6.18bps');

		// Fully priced: Slippage + Pos. Slippage filled, Unattributed dashed.
		// Partial: the inverse — two dashed, one filled. Net +1 dash.
		expect(dashes(partial) - dashes(priced)).toBe(1);
	});

	it('the fully-priced row dashes Unattributed specifically', async () => {
		const priced = await renderBody([leg(1000, 19.37)]);
		// The last three <td>s before Ex. Quality are the slippage trio. Assert
		// on order: filled, 0.00bps (the benefit half), dashed.
		const cells = priced.match(/<td[^>]*>([^<]*)<\/td>/g) ?? [];
		const texts = cells.map((c) => c.replace(/<[^>]*>/g, ''));
		expect(texts.slice(-4, -1)).toEqual(['6.18bps', '0.00bps', '–']);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run packages/dashboard/components/tradesTable.test.tsx -t 'slippage columns'
```

Expected: FAIL — `>POS. SLIPPAGE` not found.

- [ ] **Step 3: Add the sort keys**

In `packages/dashboard/lib/queries.ts:115`, extend `TRADES_SORT_COLUMN_KEYS`.
`impact` and `slippage` already both map to `slippageBps`; the new pair follows
that precedent (the mapped value drives the server-side default ordering only —
the visible sort is the client-side `ACCESSORS`):

```ts
export const TRADES_SORT_COLUMN_KEYS = {
	block: 'blockNumber', aggregator: 'aggregator', side: 'direction',
	size: 'notionalUsd', accuracy: 'allInCostBps', lpFee: 'lpFeeBps',
	aggFee: 'aggFeeBps', impact: 'slippageBps', slippage: 'slippageBps',
	posSlippage: 'slippageBps', unattributed: 'slippageBps', gas: 'gasCostUsd',
} as const;
```

- [ ] **Step 4: Replace the accessor and render the columns**

⚠️ The sort must work off the **raw** residual, not the rendered string:
`formatDialogBps` strips the minus sign, so `slippageDisplay.text` cannot be
parsed back into a signed number. Task 2 exposes `residualRawBps` for exactly
this — **use it. Do not recompute the residual here**, and do not add a local
helper that duplicates `getExecutionBreakdown`'s logic.

Replace the single `slippage` accessor (`:40-47`) with these three. Each returns
`0` for rows whose cell renders `–`, so a sort groups the blanks together. Note
the negation: `residualRawBps` is positive-is-cost, and the table's other
accessors (`accuracy`, `lpFee`, `aggFee`) all sort on the negated display
polarity, so these match:

```tsx
	slippage: (r) => {
		const e = getExecutionBreakdown(r);
		return e.fullyPriced ? Math.min(-(e.residualRawBps ?? 0), 0) : 0;
	},
	posSlippage: (r) => {
		const e = getExecutionBreakdown(r);
		return e.fullyPriced ? Math.max(-(e.residualRawBps ?? 0), 0) : 0;
	},
	unattributed: (r) => {
		const e = getExecutionBreakdown(r);
		return e.fullyPriced ? 0 : -(e.residualRawBps ?? 0);
	},
```

Header — replace the single `<th>` at `:177-179` with three:

```tsx
			<th className={TH}>
				<SortHeader col="slippage" sort={sort} onSort={onSort} tooltip={{ id: 'tooltip-slippage', text: 'Residual cost after L.P. Fee, Agg. Fee, and P. Impact' }}>Slippage</SortHeader>
			</th>
			<th className={TH}>
				<SortHeader col="posSlippage" sort={sort} onSort={onSort} tooltip={{ id: 'tooltip-pos-slippage', text: 'Residual benefit after L.P. Fee, Agg. Fee, and P. Impact' }}>Pos. Slippage</SortHeader>
			</th>
			<th className={TH}>
				<SortHeader col="unattributed" sort={sort} onSort={onSort} tooltip={{ id: 'tooltip-unattributed', text: 'Residual cost or benefit that could not be completely attributed, because some legs of this route were not priced' }}>Unattributed</SortHeader>
			</th>
```

Cell — replace the single slippage `<td>` at `:286` with three. Note the
existing `const slip = execution.marketForcesDisplay;` at `:269` becomes unused;
delete it:

```tsx
			<td className={`${COL} text-right`} style={execution.slippageDisplay.color ? { color: execution.slippageDisplay.color } : undefined}>{execution.fullyPriced ? execution.slippageDisplay.text : '–'}</td>
			<td className={`${COL} text-right`} style={execution.positiveSlippageDisplay.color ? { color: execution.positiveSlippageDisplay.color } : undefined}>{execution.fullyPriced ? execution.positiveSlippageDisplay.text : '–'}</td>
			<td className={`${COL} text-right`} style={execution.unattributedDisplay.color ? { color: execution.unattributedDisplay.color } : undefined}>{execution.fullyPriced ? '–' : execution.unattributedDisplay.text}</td>
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run packages/dashboard/components/tradesTable.test.tsx
npx tsc --build
npx eslint packages/dashboard packages/core
```

Expected: all PASS, `tsc` exit 0, eslint exit 0.

- [ ] **Step 6: Check the table at a narrow viewport**

⚠️ The branch is named `ui/receipt-footnote-and-trades-width`; this task takes
the table from 8 columns to 10. Start the dev server (`npm run dev` from
`packages/dashboard`, port 3000) and load `/trades` at a ~1280px viewport.
Confirm the table does not overflow its wrapper and the Aggregator column has
not started wrapping.

⚠️ Do **not** run `npm run build` while the dev server is up.
⚠️ Browsing the dev server mutates `configs/contractNames.json` as a side
effect — leave that file out of the commit.

- [ ] **Step 7: Commit**

```bash
git add packages/dashboard/components/tradesTable.tsx \
        packages/dashboard/components/tradesTable.test.tsx \
        packages/dashboard/lib/queries.ts
git commit -m "feat(dashboard): split the trades Slippage column into three

Slippage, Pos. Slippage, and Unattributed, all sortable. Static layout: the
cells that do not apply to a row render '-'. The table is admin-facing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Share one coverage definition with the analysis scripts

**Files:**
- Modify: `scripts/analysis/_env.mjs:33-35`
- Modify: `scripts/analysis/attributionCoverage.mjs:36-53`
- Modify: `scripts/analysis/coverageEstimate.mjs:24-45`
- Modify: `scripts/analysis/README.md`
- Modify: `docs/attribution-worklist.md`

**Interfaces:**
- Consumes: `costedLegs`, `priceImpactCoverage`, `isFullyPriced` (Task 1) via
  `packages/core/dist/receiptPure.js`.
- Produces: nothing.

The point is that the number the receipt shows and the number the worklist
quotes come from the same code and cannot drift.

- [ ] **Step 1: Build core so the scripts can import from dist**

```bash
npx tsc --build packages/core
ls packages/core/dist/receiptPure.js
```

Expected: the file exists.

- [ ] **Step 2: Re-export core's `costedLegs` from `_env.mjs`**

Replace `scripts/analysis/_env.mjs:33-35` with:

```js
/**
 * Cost-bearing legs only — wrap/unwrap are informational and carry no notional.
 * Re-exported from core so the scripts and the receipt UI share ONE definition.
 * Takes a DB row; core's takes the leg array.
 */
const pure = await import(new URL('../../packages/core/dist/receiptPure.js', import.meta.url));
export const costedLegs = (row) => pure.costedLegs(row.route_legs ?? []);
export const { priceImpactCoverage, isFullyPriced } = pure;
```

⚠️ Top-level `await import` is fine here — every consumer is an ESM `.mjs`
script that already uses top-level await for `connect()`.

- [ ] **Step 3: Use the shared coverage in `attributionCoverage.mjs`**

At `scripts/analysis/attributionCoverage.mjs`, change the import on line 24 to
pull in the shared function, and replace the hand-rolled `piCov` with it:

```js
import { connect, costedLegs, priceImpactCoverage, num } from './_env.mjs';
```

Then inside the loop, replace `piCov: share(piOk),` with:

```js
		piCov: priceImpactCoverage(legs) ?? 0,
```

and delete the now-unused `const piOk = …` line. Leave `feeOk` / `feeCov`
alone — LP-fee coverage is a separate dimension with its own `feeTierBps > 0`
test and is not part of this change.

- [ ] **Step 4: Use the shared coverage in `coverageEstimate.mjs`**

At `scripts/analysis/coverageEstimate.mjs`, change line 12 to:

```js
import { connect, costedLegs, isFullyPriced, priceImpactCoverage, num } from './_env.mjs';
```

Replace the whole body of the `for (const r of rows)` loop after the `noLegs`
guard, so the script's bucketing uses the same gate the UI does:

```js
	const priced = legs.filter((l) => l.priceImpactBps != null);
	const rec = {
		id: r.id, tier: r.tier, agg: r.aggregator,
		notional: num(r.notional_usd) ?? 0,
		slip: num(r.slippage_bps),
		status: r.pricing_status,
		cov: priceImpactCoverage(legs) ?? 0,
		fullyPriced: isFullyPriced(legs),
		nlegs: legs.length,
		rfqOnly: legs.every((l) => l.type === 'rfq'),
		conf: r.decomp_confidence,
	};
	if (rec.fullyPriced) buckets.full.push(rec);
	else if (priced.length > 0) buckets.partial.push(rec);
	else buckets.none.push(rec);
```

- [ ] **Step 5: Verify the scripts still reproduce the baseline**

```bash
node scripts/analysis/attributionCoverage.mjs
node scripts/analysis/coverageEstimate.mjs
```

Expected, unchanged from the 2026-07-30 measurement:
- `attributionCoverage`: price impact **83.5%**; 13 no-leg-priced, 7 partial,
  42 all-priced.
- `coverageEstimate`: 42 unaffected / 7 partial / 13 zero; **20 receipts below
  100%**, of which **13** currently print a number.

If a number moved, the refactor changed behavior — stop and diagnose. Do not
update the baseline to match.

- [ ] **Step 6: Update the docs**

In `scripts/analysis/README.md`, add a line to the "Reading them honestly"
section:

```markdown
- **Coverage is defined in core, not here.** `priceImpactCoverage` and
  `isFullyPriced` live in `packages/core/src/receiptPure.ts` and are re-exported
  through `_env.mjs`, so these scripts and the receipt UI can never disagree.
  Run `npx tsc --build packages/core` after editing them.
```

In `docs/attribution-worklist.md`, replace the **Deliverable** line at the end
of §1 with:

```markdown
**Delivered 2026-07-30.** Coverage lives in `@fabric-tca/core/pure`
(`priceImpactCoverage`, `isFullyPriced`) and gates the receipt: below 100% the
Slippage and Positive Slippage rows render `n/a` and a single signed
**Unattributed** row carries the residual. The trades table splits its one
Slippage column into three. 20 of 62 receipts are below 100%; 13 of them
previously printed a number.

⚠️ **The "never ship it as a user-facing percentage" guidance above is
superseded** (decision 2026-07-30). The percentage appears in the `n/a` cells'
tooltip — "pricing coverage is n% complete" — because a trader benefits from
knowing how much of their transaction we actually priced. It stays out of the
receipt's numeric rows.

⚠️ The `.some()` defect was a **labelling** bug, not an arithmetic one. The
residual `slippage_bps − Σ(measured legPI)` was and is correct; it simply was
not entitled to the name "Slippage". No displayed digit changed.
```

- [ ] **Step 7: Run the full suite in both shell states**

```bash
npx vitest run
set -a && source .env && set +a && npx vitest run
npx tsc --build && npx eslint packages/dashboard packages/core
```

Expected: **595/595** with `.env` exported; 592 passing + 3 skipped without.
`tsc` exit 0, eslint exit 0.

- [ ] **Step 8: Commit**

```bash
git add scripts/analysis/_env.mjs scripts/analysis/attributionCoverage.mjs \
        scripts/analysis/coverageEstimate.mjs scripts/analysis/README.md \
        docs/attribution-worklist.md
git commit -m "refactor(analysis): share one coverage definition with the UI

The analysis scripts now import priceImpactCoverage and isFullyPriced from
core rather than recomputing them, so the number the receipt shows and the
number the worklist quotes cannot drift. Records worklist item 1 as done,
including the reversal on showing the percentage to users.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Out of scope

Named so an implementer does not wander into them:

- **The RFQ relabel.** 6 of the 13 changed receipts are RFQ-only routes, unpriced
  *by design* rather than by failure. The tooltip copy here is cause-neutral on
  purpose. Separate worklist item.
- **Worklist items 2–4** (V4 PoolManager reader, twin venues, PancakeSwap
  Infinity). This work makes them measurable; it does not fix them.
- **LP-fee coverage.** Tracked at 76.6% and reported by
  `attributionCoverage.mjs`, but it gates nothing here. Per-leg fee provenance
  already ships via `feeResolved`.
- **`decompConfidence`.** Still dead in the UI and still scores route *chaining*
  rather than *pricing*. Not replaced, not removed.
- **Repopulation.** Nothing persisted changes.
