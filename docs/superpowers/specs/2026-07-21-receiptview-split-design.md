# ReceiptView.tsx split — design

**Date:** 2026-07-21
**Scope:** `packages/dashboard/components/ReceiptView.tsx` (855L) → three files: two
new leaves in `components/receipt/` plus the trimmed component file. Pure code
motion. **No behavior change.**

## Why

`ReceiptView.tsx` is the largest dashboard component and mixes three cleanly
separable layers: pure formatting/orientation helpers (return strings/numbers, no
JSX), presentational row sub-components (no hooks, take props), and the `Receipt`
composition that wires them. The file already has sibling leaves under
`components/receipt/` (`receiptDisplay.tsx`, `symbols.ts`, `usdFormat.ts`,
`qualityNotionals.ts`), so the extraction follows an established layout.

Verified: the row sub-components call none of the pure helpers, and the pure helpers
contain no JSX — so the two extracted leaves are independent of each other, and each
depends only on already-established leaves. No cycle risk.

## The three files

### 1. `receipt/priceFormat.ts` (~160L) — pure formatting + orientation

- `formatPriceDelta`, `PriceDeltaRow` (interface), `priceDeltaSentence`,
  `formatPriceDeltaUsd`, `formatPriceDeltaToken`, `fallbackMethodology`,
  `priceDeltaDirection`
- `receiptPairTitle`, `NAMED_CHAINS`, `chainLabel`, `symbolAnchorRank`,
  `pairBaseQuote`, `UNAVAILABLE`
- No JSX. Imports: `formatPriceMagnitude`, `formatSubvalueUsd` from `receiptDisplay`;
  `STABLE_SYMBOLS`, `ETH_SYMBOLS` from `symbols`; the `ReceiptRow` type from
  `../../lib/queries`.
- Everything currently exported stays exported (the tests import 5 of these). Of the
  currently-private helpers, only those `Receipt` calls directly gain `export` —
  `receiptPairTitle`, `chainLabel`, `pairBaseQuote`, and the `UNAVAILABLE` const.
  Helpers used only *within* `priceFormat` (`priceDeltaSentence`, `symbolAnchorRank`,
  `NAMED_CHAINS`) stay private. tsc/lint confirm the exact export set: export what
  `Receipt` imports, nothing more.

### 2. `receipt/receiptRows.tsx` (~310L) — presentational row components

- `Divider`, `DetailRow`, `AggregatorValue`, `FillerRow`, `BkdHeading`, `BkdRow`,
  `LegRow` — the components `Receipt` renders directly (gain `export`).
- `TooltipBubble` stays **internal** to this module (it is used only by `DetailRow`,
  `BkdRow`, `BkdHeading` within it — `Receipt` does not render it directly), so it is
  moved but not exported.
- No hooks. Imports: `providerColor`, `formatProvider` from `../../lib/formatters`;
  `getVenueLabel`, `isMakerLeg`, `RFQ_LEG_TOOLTIP`, `legPairContext`, `getStepContext`
  from `receiptDisplay`; `ReceiptRow`, `RouteLeg` types from `../../lib/queries`.
- **Imports nothing from `priceFormat`** (verified — the rows take formatted strings
  as props).

### 3. `ReceiptView.tsx` (~380L) — the composition

- Keeps `ReceiptView` (the thin wrapper) and `Receipt` (the big component).
- Imports the pure helpers from `./receipt/priceFormat` and the row components from
  `./receipt/receiptRows`, plus its existing `receiptDisplay` / `qualityNotionals` /
  `symbols` / `ReceiptSearch` imports.
- **No re-export shim.** The helpers are imported for `Receipt`'s own use; the tests
  are repointed to name the true source (below). This matches the decomposeRoute and
  decompose-trade splits earlier the same day. (The `receiptDisplay` re-export in
  `TradesTable` is not the precedent here — that one broke a real import cycle; there
  is no cycle here, so a re-export would be pure indirection.)

## Dependency graph

```
app/page.tsx ─▶ ReceiptView ─▶ receipt/priceFormat ─▶ receipt/receiptDisplay
TradesTable ──▶ Receipt (in ReceiptView) ─▶ receipt/receiptRows ─▶ receipt/receiptDisplay
```

Both new leaves import only established leaves (`receiptDisplay`, `symbols`,
`lib/formatters`) and types. Neither imports the other or `ReceiptView`. One
direction.

## Test-import updates (chosen: update, not re-export)

`ReceiptView.test.tsx` imports the 5 pure helpers via **17 isolated
`const { X } = await import('./ReceiptView')` sites** — each destructures exactly one
helper, never mixed with `Receipt`/`ReceiptView` (verified). Repoint those 17 to
`await import('./receipt/priceFormat')`:

- `formatPriceDelta` — 6 sites
- `priceDeltaDirection` — 5 sites
- `formatPriceDeltaToken` — 3 sites
- `formatPriceDeltaUsd` — 2 sites
- `fallbackMethodology` — 1 site

The 49 `Receipt` (23) and `ReceiptView` (26) dynamic imports stay pointing at
`./ReceiptView`. No other consumer of these helpers exists.

## Consumers unaffected

`app/page.tsx` imports `ReceiptView`; `TradesTable.tsx` imports `Receipt`. Both stay
exported from `ReceiptView.tsx` — those import sites are untouched.

## Testing

Pure code motion, so the existing suite is the whole safety net — no new tests.
Baseline: **427 pass across 32 files.** Gate every step with `tsc --build` +
`npm run lint` + `vitest run`. Because two extracted files are `'use client'` React
modules, additionally verify the running dev server renders a receipt at `200` (the
component tree is what could break at the bundler level, which vitest cannot catch).

## Out of scope

- The lowercase-first **file-rename pass** for dashboard component files
  (`ReceiptView.tsx → receiptView.tsx`, `TradesTable.tsx → tradesTable.tsx`, etc.) —
  a separate follow-up, done all-at-once after this split so the tree is never
  half-renamed. This split leaves `ReceiptView.tsx` PascalCase.
- The `Direction` v1-vestige rename — a separate backlog item.
