# Dashboard lowercase-first filenames — design

**Date:** 2026-07-21
**Scope:** Rename the PascalCase component files under
`packages/dashboard/components/` to camelCase-first-lowercase, matching the
convention already used throughout `core/src`. **File names only** — no behavior
change. One atomic commit.

## Why

`core/src` is uniformly lowercase-first (`decomposeRoute.ts`, `tradeEndpoints.ts`,
`decomposeTrade.ts` after today's rename). The dashboard components are the last
PascalCase-file holdouts. This aligns the two packages on one filename convention.

**File names only.** Exported identifiers stay as they are — React components MUST
be PascalCase (in JSX a lowercase-first tag is parsed as an HTML element), and TS
types/interfaces stay PascalCase by convention. Only the filenames and the import
specifiers that reference them change.

## What changes

### Renamed (7 live components + 3 tests)

| From | To |
| --- | --- |
| `FailureNotice.tsx` | `failureNotice.tsx` |
| `Footer.tsx` | `footer.tsx` |
| `Header.tsx` | `header.tsx` |
| `NavTabs.tsx` | `navTabs.tsx` |
| `ReceiptSearch.tsx` | `receiptSearch.tsx` |
| `ReceiptView.tsx` | `receiptView.tsx` |
| `TradesTable.tsx` | `tradesTable.tsx` |
| `FailureNotice.test.tsx` | `failureNotice.test.tsx` |
| `ReceiptView.test.tsx` | `receiptView.test.tsx` |
| `TradesTable.test.tsx` | `tradesTable.test.tsx` |

### Deleted, not renamed

- `ChevronDown.tsx` — dead code (verified: zero references anywhere in the
  dashboard, static or dynamic). Renaming a file nothing imports is pointless;
  deleting it matches the earlier dead-code prune (`FilterRow`/`RouteLegs`/`Tooltip`).

### Not renamed (already lowercase / framework convention)

- `app/` route files (`page.tsx`, `layout.tsx`, `route.ts`) — Next.js convention,
  already lowercase. Only their import *specifiers* change.
- `components/receipt/` leaf (`priceFormat.ts`, `receiptRows.tsx`, `receiptDisplay.tsx`,
  `symbols.ts`, `usdFormat.ts`, `qualityNotionals.ts`) and `lib/` — already
  lowercase-first.

## The rename mechanic (critical)

The working filesystem is **case-insensitive** (macOS default). A one-step
`git mv ReceiptView.tsx receiptView.tsx` can error or silently no-op because git
sees the two paths as the same file. Every rename goes **two-step via a temp name**:

```bash
git mv ReceiptView.tsx ReceiptView.tsx.tmp
git mv ReceiptView.tsx.tmp receiptView.tsx
```

This is the single most important implementation detail. After all renames, verify
each target exists lowercase and no PascalCase original remains
(`ls packages/dashboard/components/[A-Z]*.tsx` should return nothing but any file
not in scope — and after this pass, nothing at all).

## Import specifier updates

- **8 static from-clause specifiers** (across 7 files — `layout.tsx` has two) — each
  references a renamed file; lowercase the filename segment of the path:
  - `app/layout.tsx`: `../components/Header` → `../components/header`,
    `../components/Footer` → `../components/footer`
  - `app/page.tsx`: `../components/ReceiptView` → `../components/receiptView`
  - `app/trades/page.tsx`: `../../components/TradesTable` → `../../components/tradesTable`
  - `components/header.tsx` (renamed): `./NavTabs` → `./navTabs`
  - `components/receiptSearch.tsx` (renamed): `./FailureNotice` → `./failureNotice`
  - `components/receiptView.tsx` (renamed): `./ReceiptSearch` → `./receiptSearch`
  - `components/tradesTable.tsx` (renamed): `./ReceiptView` → `./receiptView`
- **~106 test dynamic-import specifiers** — lowercase the filename in each:
  - `receiptView.test.tsx`: `await import('./ReceiptView')` ×49 → `./receiptView`
  - `tradesTable.test.tsx`: `await import('./TradesTable')` ×54 → `./tradesTable`
  - `failureNotice.test.tsx`: `await import('./FailureNotice')` ×3 → `./failureNotice`
  - Untouched: the already-lowercase `./receipt/priceFormat` (×17) and other
    `./receipt/*` specifiers in the tests.

## Testing

No behavior change — the existing suite is the whole safety net. Baseline: **427 pass
across 32 files.** Gate with `tsc --build` + `npm run lint` + `vitest run`, plus a
dev-render check (the component tree could break at the bundler/module-resolution
level, which is exactly what a mis-cased import would cause and vitest might not
surface): confirm `/?tx=…` returns `200`.

## Execution shape

**One atomic commit.** This is not decomposable into independently-reviewable units —
a partial rename leaves broken imports, and every commit must be green. It is one
logical change. Inline execution with the full gate before committing.

## Out of scope

- Any change to exported identifiers (components/types stay PascalCase).
- The `Direction` v1-vestige rename — a separate backlog item.
- Renaming `core/src` files (already lowercase-first) or `app/` route files (Next
  convention).
