# Token & Price Value Display — Design

**Date:** 2026-07-13
**Status:** Approved (pending spec review)

## Problem

Memecoin trades produce token amounts and per-unit prices with long,
unrestricted digit strings. Rendered verbatim in the receipt, they visually
overwhelm headline tokens (WETH, USDC) and — worse — sub-cent per-unit USD
prices round to `$0.00` under the current 2-decimal `formatSubvalueUsd`, hiding
real value on the Execution Price / Market Price / Price Delta rows.

## Scope

Receipt display only (`packages/dashboard/components/{ReceiptView,TradesTable}.tsx`).
No changes to stored data, cost model, or notional computation.

## Terminology

- **Per-unit USD price** of a token side = `notionalUsd ÷ amount` for that side
  (input or output). The trade's `notionalUsd` is the shared USD value of the
  swap; each side's amount is known, so its per-unit price is derivable.
- **Trade notional** = `row.notionalUsd`, the shared USD value shown as the
  Token In / Token Out subvalue. Unchanged by this work except for dust trades
  (see change 1).

## Changes

### 1. Sub-cent USD precision (`formatSubvalueUsd`) — core change

Current: `$${value.toLocaleString('en-US', { min/maxFractionDigits: 2 })}`, so
`0 < |value| < 0.005` → `$0.00`.

New:
- `value === 0` or non-finite → `–` (unchanged).
- `0 < |value| < 0.01` → **6 significant figures**, trailing zeros trimmed:
  `$${value.toLocaleString('en-US', { maximumSignificantDigits: 6 })}` →
  e.g. `$0.000000667735`.
- `|value| >= 0.01` → unchanged 2-decimal grouped form (`$1,829.76`, `$2.25`).

This single formatter feeds Execution Price and Market Price subvalues **and**
the Token In / Token Out notionals, so scoping falls out naturally:

- Memecoin exec/market price (sub-cent USD-per-token) → real precision. ✅
- PEPE-example Token In/Out notional stays `$2.25` (>$0.01 → normal path). ✅
- A **genuine dust trade** (whole notional <$0.01) automatically gains
  precision — the "truly a dust trade" case. ✅

### 2. Price Delta USD magnitude (`formatDelta`)

The absolute USD delta (`$0.16`-style) gets the same sub-cent treatment so tiny
deltas show precision instead of `$0.00`. This value feeds both the Price Delta
row value and the tooltip number in change 4. Extract a shared
`formatUsdMagnitude(value)` helper used by both `formatSubvalueUsd` and
`formatDelta` to keep the sub-cent rule in one place.

### 3. Token amount clamp (`formatTokenIn` / `formatTokenOut`)

Discriminator: the side's per-unit USD price (`notionalUsd ÷ amount`).

- **> $0.01/unit** (headline): whole part unlimited length (**no thousands
  separators**), **decimals capped at 6 places** (trailing zeros trimmed).
  Symbol never clamped.
  - e.g. `1000000000.123456 USDC`, `2.25005 USDC`, `0.00123 WETH`.
- **< $0.01/unit** (memecoin): high decimal ceiling of **18 places** (wei-level;
  matches `formatExecutionPrice`'s existing `trimNumber(n, 18)`), applied to both
  sides — this replaces today's asymmetric 6 (in) / 15 (out) caps. No separators.
- **Unknown** per-unit price (missing/zero notional or amount): default to the
  **clamped** (headline, 6-decimal) path — layout-protective.

Boundary: per-unit price `>= 0.01` uses the clamped path.

Implementation note: `Number(amount).toLocaleString('en-US', {
useGrouping: false, maximumFractionDigits: cap })` handles rounding and
trailing-zero trimming in one call, with grouping disabled (`cap` = 6 for
headline/unknown, 18 for sub-cent).

### 4. Price Delta comparison label → tooltip

The comparison word (`priceDeltaComparison` output) rendered with the existing
dotted-underline + hover-tooltip treatment (same pattern as the Market Price
label). Copy verbatim from Figma (node 344-761); `$X` = the precise delta from
change 2:

- **Below Market** → `Execution Price is better than Market Price by $X`
- **Above Market** → `Execution Price is worse than Market Price by $X`
- **At Market** → `Execution Price is the same as Market Price within $0.01`
  (static; no `$X`)

Requires threading a subvalue tooltip through `DetailRow` (today it supports a
tooltip only on the label). Add an optional subvalue-tooltip affordance rather
than overloading the existing label `tooltip` prop.

### 5. Sub-cent tokenOut never "At Market" (`priceDeltaComparison`)

Add a `tokenOutSubCent: boolean` argument (tokenOut per-unit USD price <$0.01).
When set, the `<$0.01` "At Market" band is dropped — it's meaningless when the
entire price is sub-cent:

- `exec > mid` → `Below Market`
- `exec < mid` → `Above Market`
- `exec === mid` (exact tie) → **`Below Market`** (tie-break; favorable default)

Non-sub-cent behavior is unchanged (`|exec - mid| < 0.01` → `At Market`).

## Banding (open question — resolved)

**No banding.** The $0.01 cutoff is the principled boundary: it's exactly where
2-decimal USD formatting starts rounding toward `$0.00`. Because the sub-cent
branch uses significant figures (not fixed decimals), displayed values stay
monotonic across the boundary (`$0.012 → $0.01`, `$0.008 → $0.008`) — a
precision increase where needed, no value jump. A hard band would add
complexity to smooth an already-smooth transition. The ~$0.02 edge case is
ignored intentionally.

## Testing

- `formatSubvalueUsd`: sub-cent → 6 sig figs (`$0.000000667735`); `>= $0.01`
  unchanged; `0`/non-finite → `–`; dust notional gains precision.
- `formatDelta` / `formatUsdMagnitude`: sub-cent delta precision; `>= $0.01`
  unchanged.
- `formatTokenIn`/`formatTokenOut`: headline caps at 6 decimals (no separators);
  memecoin keeps full precision (18 places); unknown price → clamped; symbol
  never dropped; large whole numbers never truncated.
- `priceDeltaComparison`: sub-cent tokenOut never `At Market`; exact tie →
  `Below Market`; non-sub-cent unchanged.
- Price Delta row: renders the three tooltip strings with the correct `$X`
  delta and dotted-underline treatment.

## Out of scope

- Per-side independent notionals (Token In/Out keep the shared trade notional).
- Any change to stored `notionalUsd`, `realizedPrice`, `marketMid`, or the cost
  model.
- Sig-fig formatting for headline (`>= $0.01`) USD values — those stay 2-decimal.
- The Execution Price / Market Price **main rate string** (`formatExecutionPrice`,
  `"X quote = 1 base"`) — unchanged; only its subvalue (change 1) is affected.
