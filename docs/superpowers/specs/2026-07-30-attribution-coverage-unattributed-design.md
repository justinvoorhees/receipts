# Attribution Coverage + the Unattributed Row — design

Date: 2026-07-30. Implements **item 1** of `docs/attribution-worklist.md`
(internal attribution-coverage metric + the `.some()`/`.every()` Slippage gate).

## The problem

`receiptDisplay.tsx:110` computes the route's price impact as

```ts
const hasPriceImpact = legs.some((leg) => leg.priceImpactBps != null);
const priceImpactRaw = hasPriceImpact ? legs.reduce((s, l) => s + (l.priceImpactBps ?? 0), 0) : null;
const marketForcesRaw = executionRaw - priceImpactRaw;
```

and then labels `marketForcesRaw` **Slippage** — "residual cost after L.P. fees,
aggregator fees, and price impact".

That label is a lie whenever any leg went unpriced. On receipt **id 210**
(Velora, $13,094, `decompConfidence = high`) we priced 77% of the route by
notional, subtracted only those legs' impact, and printed the remainder as a
precise Slippage figure. The unpriced 23% of the route contributed an unknown
amount of price impact that is sitting inside that number, uncaveated.

### The arithmetic is not wrong — the claim is

This is the point that is easy to get backwards, so it is stated first.

`executionDelta − Σ(measured price impact)` is a correct, well-defined quantity.
Every leg we *could* price is attributed and shown in the Price Impact section;
what remains genuinely is unattributed. Nothing about that sum needs
recomputing, and **on the receipt** this design does not change a single
displayed digit of it — the `Unattributed` row prints the exact string, colour
included, that the `Slippage` row used to.

⚠️ That guarantee covers the receipt, **not the trades table.** §5 replaces one
table cell that rendered the *signed* residual with a cost/benefit split, so a
**fully-priced** row whose residual is a benefit moves its number from
`Slippage` (which now reads `0.00bps`) to the new `Pos. Slippage` column. That
is 28 of the 62 persisted receipts. Intended — it makes the table agree with the
receipt — but it is a real change to what the table displays, so don't quote the
"no digit moved" line at it.

What is wrong is the **name**. "Slippage" asserts *"we accounted for price
impact, and this is what was left over."* When coverage is below 100% the honest
statement is *"this is what we could not account for."* The fix is therefore a
relabel plus a gate, not a new calculation.

Corollary: the sort accessors at `tradesTable.tsx:35` (`impact`) and `:40`
(`slippage`) mirror the same `.some()` logic and are consequently **already
consistent** with the cells they sort. They need splitting to match the new
columns, but they are not carrying a defect.

## Measured blast radius

`scripts/analysis/coverageEstimate.mjs`, run 2026-07-30 against all 62 persisted
receipts (all of which carry `route_legs`):

| price-impact coverage | receipts | notional |
|---|---:|---:|
| 100% — visually unchanged | **42** | $295,508 |
| partial — number is uncaveated | 7 | $22,829 |
| 0% — whole delta printed as "Slippage" | 13 | $55,831 |

**20 of 62 (32%) fall below 100%.** Seven of those already render `n/a` for
unrelated reasons (`slippage_bps` null, or `pricingStatus = 'partial'`), so
**13 receipts / $77,870 actually change**: 6 RFQ-only routes ($55,042, the
largest being id 36 at $35,055) and 7 mixed pool routes ($22,829).

Re-measure rather than quote — the corpus grows.

## Design

### 1. Coverage lives in core, not the dashboard

Two new pure functions in `packages/core/src/receiptPure.ts`, exposed via the
existing `@fabric-tca/core/pure` leaf subpath:

```ts
/** Cost-bearing legs only. wrap/unwrap are informational and carry no notional. */
export function costedLegs<T extends { type: string }>(legs: readonly T[]): T[];

/**
 * Notional-weighted share of the route whose price impact we measured.
 * null when the route has no costed legs, or zero total notional.
 */
export function priceImpactCoverage(
  legs: readonly { type: string; notionalUsdc: number; priceImpactBps: number | null }[],
): number | null;

/** True only when EVERY costed leg carries a price impact. False on an empty route. */
export function isFullyPriced(
  legs: readonly { type: string; priceImpactBps: number | null }[],
): boolean;
```

Structural parameter types, not the dashboard's `RouteLeg` — `receiptPure.ts` is
deliberately dependency-free (no viem, no fs) so `'use client'` components can
import it without dragging the barrel into the browser bundle.

Core is the home rather than `receiptDisplay.tsx` because
`scripts/analysis/_env.mjs` already exposes a `core()` helper for importing
`packages/core/dist/*`. Putting it there gives the UI and the measurement
scripts **one** definition. `attributionCoverage.mjs` and
`coverageEstimate.mjs` are updated to import it instead of recomputing inline,
so the number the receipt shows and the number the worklist quotes cannot drift.

### 2. The gate and the percentage are different tests — on purpose

- **The gate** is `isFullyPriced` — leg-count based, `every()`. The labelling
  defect is about summing a partial set, and that is true regardless of how
  little notional the unpriced leg carried.
- **The displayed percentage** is `priceImpactCoverage` — notional-weighted,
  matching the metric definition in the worklist. Id 210 is 76.5480%, so it
  reads **76%**, where a leg count would say 83%.

These can disagree: a route with an unpriced zero-notional leg is *not* fully
priced but computes to 100.0% coverage. Displaying "pricing coverage is 100%
complete" next to an `n/a` would be absurd, so the formatter **floors to an
integer and caps at 99% whenever `isFullyPriced` is false.** Flooring rather
than rounding is deliberate: it can never overstate how much we priced.

**An empty route (`routeLegs: []`) is not fully priced.** `priceImpactCoverage`
returns `null` there (0/0 is undefined), `isFullyPriced` returns `false`, and the
display floor turns the null into **0%**. This is a real behavior change: today
a receipt with no decomposed legs prints "No Route Found" under Price Impact and
*still* prints a confident Slippage number. That is the same overclaim this work
exists to remove, so it gets the same treatment. No receipt in the current
corpus has empty `route_legs`, so the change is invisible today.

### 3. `getExecutionBreakdown` gains three fields

```ts
export function getExecutionBreakdown(row: {
  slippageBps: string | number | null;
  routeLegs?: unknown;
}): {
  executionDisplay:         { text: string; color?: string };
  priceImpactDisplay:       { text: string; color?: string };
  marketForcesDisplay:      { text: string; color?: string };
  slippageDisplay:          { text: string; color?: string };
  positiveSlippageDisplay:  { text: string; color?: string };
  unattributedDisplay:      { text: string; color?: string };  // NEW
  coveragePercent:          number | null;                     // NEW — integer, capped
  fullyPriced:              boolean;                           // NEW
};
```

`marketForcesRaw` is computed exactly as it is today. Then:

| | `fullyPriced` | `!fullyPriced` |
|---|---|---|
| `slippageDisplay` | cost half of `marketForcesRaw` | `{ text: 'n/a' }` |
| `positiveSlippageDisplay` | benefit half | `{ text: 'n/a' }` |
| `unattributedDisplay` | `{ text: 'n/a' }` | `formatDialogBps(-marketForcesRaw)` |

`unattributedDisplay` is **one signed row**, not split into cost/benefit halves —
matching the Figma. `executionDisplay`, `priceImpactDisplay` and
`marketForcesDisplay` are untouched, so the trades table's `P. Impact` and
`Ex. Quality` columns and every existing test of them keep working.

`priceImpactDisplay` deliberately keeps showing the partial sum when coverage is
incomplete: it is the sum of what we measured, which is a true statement. The
adjacent Unattributed value is what signals incompleteness.

### 4. Receipt (`receiptView.tsx`)

Figma: `f9uYixaSgpkV1lEvN8Ie01`, node `577-1232`.

| coverage | Slippage | Positive Slippage | Unattributed |
|---|---|---|---|
| 100% | value | value | **row not rendered** |
| < 100% | `n/a` ⓘ | `n/a` ⓘ | `[n]bps` ⓘ |

The Unattributed row is a `BkdHeading … standalone`, structurally a clone of
Slippage, placed between `Positive Slippage` and `Total Execution Delta`,
keeping the existing 40px rhythm.

Copy (verbatim, user-specified):

- Slippage / Positive Slippage `valueTooltip`, both cells:
  **"No slippage calculation available, pricing coverage is n% complete"**
  where `n` is `coveragePercent`.
- Unattributed label `tooltip`:
  **"Residual cost or benefit that could not be completely attributed to L.P.
  fees, aggregator fees, or price impact"**

The percentage reaching the receipt face is **intended**, confirmed 2026-07-30.
The worklist's "never on the receipt face" guidance is superseded: showing a
trader how much of their transaction we actually priced is useful to them, and
it is scoped to a tooltip on a row that is already admitting it has no number.
`docs/attribution-worklist.md` §1 is updated to record the reversal.

Interaction with the existing early return at `receiptView.tsx:342`
(`isPartial || (legs.length > 0 && !hasCostedLeg)`) is unchanged — that branch
already renders `n/a` for both Price Impact and Slippage and never reaches this
code. It accounts for the 7 receipts in the scan that change nothing.

### 5. Trades table (`tradesTable.tsx`) — admin-facing

The single `Slippage` column becomes three: **`Slippage`**, **`Pos. Slippage`**,
**`Unattributed`**. Layout is static — all three columns always present on every
row, taking the table from 8 columns to 10.

Per row, mutually exclusive, mirroring the receipt:

- `fullyPriced` → Slippage and Pos. Slippage carry values, Unattributed shows `–`
- `!fullyPriced` → Slippage and Pos. Slippage show `–`, Unattributed carries the value

All three sortable, consistent with today's Slippage column. This needs:

- two new keys in `TRADES_SORT_COLUMN_KEYS` (`queries.ts:115`) —
  `posSlippage` and `unattributed`, both mapping to `slippageBps`. Precedent
  exists: `impact` and `slippage` already both map to `slippageBps`.
- three `ACCESSORS` entries replacing today's one `slippage`, each returning `0`
  for rows where its column renders `–`, so a sort groups the blanks together.

⚠️ This branch is named `ui/receipt-footnote-and-trades-width`. Adding two
columns to a table whose width was recently tuned needs a browser check at a
narrow viewport before it is called done.

## Files touched

| file | change |
|---|---|
| `packages/core/src/receiptPure.ts` | + `costedLegs`, `priceImpactCoverage`, `isFullyPriced` |
| `packages/core/src/receiptPure.test.ts` | unit tests for the three |
| `packages/dashboard/components/receipt/receiptDisplay.tsx` | `getExecutionBreakdown` gains 3 fields; 2 new tooltip constants |
| `packages/dashboard/components/receiptView.tsx` | conditional Unattributed row; `valueTooltip` on the two `n/a` cells |
| `packages/dashboard/components/tradesTable.tsx` | 1 column → 3; accessors |
| `packages/dashboard/lib/queries.ts` | 2 new sort column keys |
| `scripts/analysis/_env.mjs` | its local `costedLegs` (line 34) re-exports core's |
| `scripts/analysis/attributionCoverage.mjs` | import the shared coverage fn |
| `scripts/analysis/coverageEstimate.mjs` | (new, already written) same |
| `docs/attribution-worklist.md` | §1 updated: item done, percentage reversal recorded |

**No migration, no repopulation.** Coverage is derived from `route_legs` at read
time. Every persisted row already carries what this needs.

## Testing

TDD throughout, per repo practice. Baseline to hold: **595/595** with `.env`
exported (`set -a && source .env && set +a`), 592 + 3 skipped without.
`npx tsc --build` exit 0, eslint exit 0.

Core unit tests:
- `priceImpactCoverage` excludes wrap/unwrap; returns `null` on zero notional;
  weights by notional, not leg count.
- `isFullyPriced` is `false` on an empty route and on one unpriced leg;
  disagrees with `priceImpactCoverage === 1` for a zero-notional unpriced leg.

Dashboard tests:
- `getExecutionBreakdown` on a fully-priced route: Slippage/Positive Slippage
  unchanged from today's values, Unattributed `n/a`.
- On a partially-priced route: the two flip to `n/a` and Unattributed carries
  **the same magnitude today's Slippage row prints** — the explicit regression
  guard that this change moves no digits.
- `coveragePercent` caps at 99 when `isFullyPriced` is false but the weighted
  share rounds to 100.
- Receipt render: Unattributed row **absent** at 100%, **present** below it.
- Trades table: 10 `<th>`s; a `!fullyPriced` row has `–` in Slippage and
  Pos. Slippage and a number in Unattributed.

### Test traps that have bitten this file repeatedly

- `formatDialogBps` (`receiptDisplay.tsx:90`) **strips the minus sign** — a −2 bps
  value renders `2.00bps`, never `-2.00bps`.
- `0.00bps` and `n/a` are **not unique on the page**. Anchor on the cell
  (`>n/a<`) and assert a **counted differential**, not mere presence.
- A label that prefixes another breaks `not.toContain` — "Slippage" is a
  substring of "Positive Slippage", and this design adds a *third* row whose
  presence is the thing under test. Anchor on `>Label<`.
- Adding a row voids `html.slice(indexOf, indexOf)` helpers, giving **vacuous
  passes**. Verify every positional assertion **by mutation** — positional
  assertions were defective 5× in one prior plan on this exact file.

## Out of scope

- **The RFQ relabel.** 6 of the 13 changed receipts are RFQ-only routes whose
  legs are unpriced *by design*, not by failure. Tooltip copy here is
  cause-neutral on purpose; distinguishing "no on-chain mid exists" from "our
  reader broke" is its own worklist item.
- **Items 2–4** of the worklist (V4 PoolManager reader, twin venues, PancakeSwap
  Infinity). This item makes them measurable; it does not fix them.
- **LP-fee coverage.** The worklist tracks both dimensions (76.6% LP fee / 83.5%
  price impact). Only the price-impact dimension gates a row here. LP fee
  provenance already renders per-leg via `feeResolved` (shipped 2026-07-29).
- **`decompConfidence`.** Still dead in the UI, still scores route *chaining*
  rather than *pricing*. Coverage does not replace or remove it.
