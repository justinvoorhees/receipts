# Receipt UI Polish — design

**Date:** 2026-07-21
**Scope:** presentation only, in `packages/dashboard`. No core pricing logic changes.

Five Figma-backed changes to the receipt detail table, plus one data finding that
blocks change 3 from being visible.

Figma frames (file `f9uYixaSgpkV1lEvN8Ie01`):

| Frame | Node | Covers |
| --- | --- | --- |
| Token value + subvalue | `453:4171` | subvalue type size |
| Gas Cost row | `453:4203` | gas descriptor; Spread reference |
| Market Price label | `453:4191` | methodology as sub-label |
| Price Delta value | `453:4199` | two-line delta sentence |

---

## Finding: methodology is NULL on every persisted row

The Market Price sub-label is already wired (`ReceiptView.tsx:633`), the column
exists (`packages/db/src/schema.ts:57`), and the API route maps it on insert
(`app/api/receipts/route.ts:44`). It renders blank because the data is absent:

```
select count(*), count(tier), count(methodology) from receipts;
-> {"total":39,"has_tier":0,"has_meth":0}
```

Phase 2a added the columns and the population path, but no existing row has been
re-analyzed since, so all 39 rows carry NULL.

**Decision:** derive a fallback descriptor from `pricingStatus` (present on every
row) so old receipts show a correct-tier string immediately. Re-populating the 39
rows to get core's richer strings is a **separate follow-up**, deliberately out of
scope — it is a DB write, not a UI change.

Fallback mapping (mirrors core `methodologyFor`, `pricing.ts:301-310`):

| `pricingStatus` | Fallback string |
| --- | --- |
| `full` | `Corroborated market price at block N-1.` |
| `estimated` | `Estimated: uncorroborated pool mid at block N-1.` |
| `partial` | `No reliable market price available.` |

`row.methodology` always wins when non-null.

---

## 1. Subvalue type size — `DetailRow` only

`DetailRow`'s sub-label (`:210-212`) and sub-value (`:230-237`) render at
`text-[10px]`. Figma specifies the same 12px `body-mono` as the rest of the list.

- `text-[10px] leading-[12px]` -> `text-[12px] leading-[12px]` on both.
- Column gaps `gap-[3px]` -> `gap-[10px]` (both label and value columns), matching
  the frames. `FillerRow` already uses `gap-[10px]`, so the table stays uniform.

**Explicitly untouched:** `BkdRow`, `BkdHeading`, `LegRow` — the per-leg Cost
Breakdown list keeps its current treatment.

## 2. Execution Result -> Spread

- Label renamed to `Spread`.
- Color moves from the sub-value to the **value**. `DetailRow` gains a `valueColor`
  prop (only `subValueColor` exists today).
- `formatExecutionResult` returns `color: 'var(--color-green)'` on a gain and
  `undefined` on a loss or zero. **No red** — losses render in primary, matching the
  existing `formatDialogBps` convention (green for good, uncolored otherwise).
- The `Gained` / `Lost` sub-line stays, in secondary gray.

## 3. Market Price descriptors for all three tiers

- Delete `marketTooltip` and its `tooltip` binding — the string is on-screen now.
- Sub-label renders for **every** tier, including null/`partial`, via
  `row.methodology ?? fallbackFor(row.pricingStatus)`.
- The `NULL_PRICE_TOOLTIP` value-tooltip on the null case is retained; it explains
  *why* there is no price, which the descriptor does not.

## 4. Price Delta two-line format

Value line, then `per 1 {base}` as the sub-value. Both the USD-anchored and the
token-denominated paths take the same shape:

```
WBTC bought at $159.76 below Market Price        anchored
per 1 WBTC

TOSHI bought at 0.0021 ETH below Market Price    non-anchored
per 1 TOSHI
```

- Base symbol leads; verb lowercase (`bought` / `sold`) from `baseIsOutput`.
- `formatPriceDeltaUsd` loses its trailing `per 1 {base}` (now the sub-value) and
  gains the leading base symbol.
- The non-anchored path gets a matching formatter using `formatPriceMagnitude` +
  quote symbol, with direction from `priceDeltaDirection`.
- Direction is now in the text, so `priceDeltaTooltip` / the `valueTooltip` binding
  on the non-anchored path is removed.
- An exact tie stays `None`, with no sub-value.

## 5. Gas Cost descriptor

Static sub-value `Paid separately in ETH` on the Gas Cost row. Always shown,
including when the value is `–`; it describes the row, not the number.

---

## Testing

TDD: update assertions first, then implement.

- ~10 assertions in `ReceiptView.test.tsx` reference `Execution Result` -> `Spread`.
- New: Spread value carries green on a gain and no color on a loss.
- New: Market Price sub-label renders for all three tiers, including a row with
  NULL methodology (fallback path).
- New: Price Delta renders the two-line shape on both anchored and non-anchored
  rows, and `None` with no sub-value on a tie.
- New: Gas Cost sub-value present.
- `qualityNotionals.test.ts` covers the `formatExecutionResult` color change.

## Out of scope

- Re-populating the 39 receipts to fill `tier` / `methodology` / `market_price_flags`.
- Any change to core pricing, the Cost Breakdown section, or per-leg rows.
