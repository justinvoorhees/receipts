# Receipts Page — Design Spec
Date: 2026-06-30

## Overview

Replace the Dashboard tab with a new **Receipts** tab, rename **Trades** to **History**, and build a full-page receipt view. A user pastes a transaction hash scoped to the History dataset; the receipt renders inline on the same page. Invalid hashes surface a red error state. A default hash is pre-loaded on first visit.

---

## Navigation

- `NavTabs.tsx` TABS array gains a `hidden` boolean field.
- The Dashboard entry (`href: '/'`) gets `hidden: true`. It is not rendered in the nav but the route continues to work if visited directly.
- `{ label: 'Trades', href: '/trades', … }` → label changed to `'History'`.
- New entry inserted before History: `{ label: 'Receipts', href: '/receipts', matches: (p) => p === '/receipts' }`.
- Tab order in nav: **Receipts**, **History**.

---

## Routing

### `app/receipts/page.tsx` (server component)
- Reads `searchParams.tx` (string or undefined).
- If absent, uses default: `0x9703bfa335528a8e01c6b63dd3046ccd6e13a66ba2e6954956aa2df39da269c1`.
- Calls `getTradeByHash(hash)`. Passes `{ trade: TradeRow | null, hash: string }` to `<ReceiptView>`.
- Sets `export const revalidate = 30`.

### `lib/queries.ts` — `getTradeByHash(hash: string): Promise<TradeRow | null>`
- Calls `getCuratedTrades()` and finds the row where `r.txHash.toLowerCase() === hash.toLowerCase()`.
- Returns the matching `TradeRow` or `null`.

---

## Components

### `components/ReceiptSearch.tsx` (client)
Props: `hash: string`, `error?: string`

- Renders a labeled text input (`Transaction Hash` label above, Sohne Breit 12px secondary color).
- Input: full-width, 40px height, 1px border, 2px border-radius. Initialized with `hash`; controlled by local state so the user can edit before submitting.
- Right side of input: dark-filled icon button (same bg as `--color-primary`) with a search/submit icon. Clicking or pressing Enter navigates to `/receipts?tx=<value>` via `router.push`.
- **Default state**: `--color-primary` border and label color.
- **Error state** (when `error` prop is set): `--color-danger` (#fa0b54) border, label color, and input text color. A supporting-text line appears below the input in `--color-danger`, showing the `error` string.

### `components/ReceiptView.tsx` (client)
Props: `trade: TradeRow | null`, `hash: string`

Top of page:
- `<ReceiptSearch hash={hash} error={trade === null ? 'Transaction not found in History.' : undefined} />`

When `trade` is not null, renders below the search:
1. Horizontal rule divider (`--color-primary`, full-width).
2. Section heading: pair title derived as `${lastTokenSymbol}→${firstTokenSymbol}` (last token in route → first token in route). Uses `routePath` from existing helpers: split the path on `->`, reverse first+last. Sohne Breit Kräftig 20px.
3. Detail table (flex-col, 20px gap, Sohne Mono 12px):
   - Txn Hash → linked to Basescan, `shortTxHash` formatted, dotted underline
   - Chain → `Base`
   - Block → `row.blockNumber.toLocaleString()`
   - Aggregator → colored via `providerColor`
   - Route → `routePath(legs)`
   - Dashed divider
   - Token In → `formatTokenIn(row)` + USD subvalue
   - Token Out → `formatTokenOut(row)` + USD subvalue
   - Realized Execution Price → `formatExecutionPrice(row.realizedPrice)` + USD subvalue
   - Market Price (dotted underline on label) → `formatExecutionPrice(row.marketMid)` + USD subvalue + optional ⚠ manipulation flag
   - **Delta** → `$${Math.abs(Number(row.marketMid) - Number(row.realizedPrice)).toFixed(2)}` — no color, informational
   - Gas Cost → `formatGasUsd(row.gasCostUsd)`
4. Horizontal rule divider.
5. Section heading: `Cost Breakdown`. Sohne Breit Kräftig 20px.
6. Cost breakdown table: identical structure to the existing `TransactionDetailsDialog` cost section — LP Fee per leg, Aggregator Fee, Price Impact per leg, Slippage, solid divider, Total Execution Quality (label changed from "Total Accuracy" to "Total Execution Quality" to match Figma).

**Detail row layout** — two-column flex justify-between:
- Left: label (secondary color, 12px Sohne Mono); some labels have dotted underline (Market Price).
- Right: value (primary color, right-aligned); rows with subvalues stack value + subvalue (secondary color) in a flex-col.

---

## Delta Calculation

```
delta = Math.abs(Number(row.marketMid) - Number(row.realizedPrice))
```

Displayed as `$${delta.toFixed(2)}`. No sign, no color applied. Positioned immediately after the Market Price row.

Verification: marketMid 1830.44284125 − realizedPrice 1829.763683289442 = 0.679… → displays as `$0.68`.

---

## Error State

When `getTradeByHash` returns `null` for the submitted hash:
- `ReceiptView` passes `error="Transaction not found in History."` to `ReceiptSearch`.
- Input field: `--color-danger` (#fa0b54) border, label, text, supporting text.
- No receipt content renders below the search input.
- The errored hash value stays in the input so the user can edit it.

No error is shown on the default hash load (it is guaranteed to exist in the dataset).

---

## Reuse

All formatting functions (`formatExecutionPrice`, `formatGasUsd`, `formatTokenIn`, `formatTokenOut`, `formatProvider`, `providerColor`, `shortTxHash`, `formatDialogBps`, `getPriceImpactRows`, `getExecutionBreakdown`, `getVenueLabel`, `getAggregatorFeeAttribution`) are imported from existing modules without modification.

---

## Out of Scope

- Dashboard tab content: preserved as-is at `/`, just hidden from nav.
- Account button shown in Figma nav: not included (not requested).
- "Total Accuracy" label in the existing `TransactionDetailsDialog`: unchanged (that component is not modified by this work).
- Trades table rename: the `<h1>` in `app/trades/page.tsx` says "Trades" — update to "History" to match the new tab label.
