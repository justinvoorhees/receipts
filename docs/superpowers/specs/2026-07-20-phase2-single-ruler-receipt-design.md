# Single-Ruler Receipt — Phase 2

**Date:** 2026-07-20
**Status:** Approved, ready for planning
**Depends on:** Phase 1 (`2026-07-20-single-ruler-market-price-design.md`, merged `e12308a`)
**Figma:** full/single anchor `429-2858` · no anchor `430-3251` · no market price `429-3050`
(https://www.figma.com/design/f9uYixaSgpkV1lEvN8Ie01/TCA)
**Reference txn:** `0x16e782f7a9dfefc3b84054ec81a366efbd603aea745ee5373ec005568adb360f` (ETH→WBTC)

## Thesis

Phase 1 built the single Market Price apparatus behind `priceReceipt` but changed
nothing the user sees. Phase 2 **surfaces it on the receipt and retires the second
ruler.** Concretely: reintroduce the anchored-state rows (per-side USD notionals +
Execution Result) that were quarantined during the receipt-MVP retreat, wired to the
*one* Market Price; map the apparatus's `tier × anchor` onto the three Figma frames;
surface the methodology string; and **delete `anchor_price_usd`** — the stored-but-
unrendered field whose only consumer was the quarantined two-ruler code.

## Current state (what's live today)

- The receipt shows `Size` + **token-denominated** `Market Price`/`Price Delta` for
  *every* trade — effectively the "no anchor" frame, always. There is **no**
  Execution Result and **no** per-side USD notional on the live receipt.
- `qualityNotionals.ts` (`singleAnchorNotionals`, `perSideNotionals`,
  `formatExecutionResult`, `outputTokenDelta`) is defined but **not imported** by
  `ReceiptView.tsx` — it is quarantined dead code.
- `anchor_price_usd` is computed in `analyzeTransaction.ts:305-307`
  (`readTokenUsd(in) ?? readTokenUsd(out)`), stored via `route.ts:70`, and rendered
  **nowhere**. It exists solely to feed the quarantined second-ruler path.
- Phase 1's `tier`/`methodology`/`marketPriceFlags` live on the `PricingResult` but
  were never threaded onto the `Receipt`, into `route.ts`, or into the schema, so
  History rows cannot display them.

## Architecture: dashboard derives dollars via the shared core `reconciledResult`

The dashboard imports `reconciledResult` from `@fabric-tca/core` and derives the
per-side USD notionals and Execution Result from **already-stored** fields
(`marketMid`, `notionalUsd`, `realizedPrice`) + symbol-based anchor detection. This:

- makes the dashboard the **production caller** of `reconciledResult` (resolving the
  Phase-1 final-review gap where it had none, so the core invariant test now guards a
  live formula);
- works **retroactively on existing History rows** with no backfill;
- keeps one ruler — the single shared formula lives in core.

No new dollar columns are stored. `notionalUsd` remains the best-effort anchored-side
notional produced by `bestEffortNotional`.

### `reconciledResult` usage

**Orientation (critical):** `reconciledResult` requires **output-per-input** prices,
but core stores `marketMid`/`realizedPrice` through `toDisplayPrice(·, baseIsOutput)`,
which **inverts** them (`1/price`) whenever `baseIsOutputLeg(inputToken, outputToken)`
is true (the anchor→volatile "buy the volatile leg" direction — ETH→WBTC, USDC→TOKEN,
…). Feeding those display values straight in flips the sign of `realized/mid − 1`. So
`receiptDollars` must reconstruct output-per-input first:
- `realizedOPi = outputAmount / inputAmount` — from the raw amounts, orientation-free.
- `midOPi = baseIsOutputLeg(inputToken, outputToken) ? 1/marketMid : marketMid` —
  un-invert the stored mid with the **same** predicate core used to store it (export
  `baseIsOutputLeg` from core; do not re-derive via a symbol mirror that can drift).
- Anchor detection uses core's **address-based** `anchorsToUsd(inputToken)` /
  `anchorsToUsd(outputToken)` (exported from core), so the side `receiptDollars` pins
  `notionalUsd` to is exactly the side `bestEffortNotional` valued.

`reconciledResult({ marketMid: midOPi, realizedPrice: realizedOPi, notionalUsd })`
returns `execResultUsd = notionalUsd × (realizedOPi/midOPi − 1)` — exact **only when
`notionalUsd` is the INPUT (paid) side's notional** (`notionalIn`). So feed it
`notionalIn`, derived from the single anchor first (all values now output-per-input):

- `bestEffortNotional` stores the *anchored* side's USD. When the input is
  anchorable it prices the input first → stored `notionalUsd` **is** `notionalIn`.
  When ONLY the output anchors (`preferOutput = anchorsToUsd(output) && !anchorsToUsd(input)`)
  it prices the output → stored `notionalUsd` is `notionalOut`.
- Therefore (all prices output-per-input, per the orientation note above):
  ```
  notionalIn  = preferOutput ? notionalUsd * midOPi / realizedOPi : notionalUsd
  { execResultUsd } = reconciledResult({ marketMid: midOPi, realizedPrice: realizedOPi, notionalUsd: notionalIn })
  notionalOut = notionalIn + execResultUsd
  ```
  Both notionals are derived from the ONE anchor + the ONE mid, so
  `execResultUsd = notionalOut − notionalIn` exactly and the single-ruler invariant
  holds against `notionalIn`. (Feeding `reconciledResult` the *output* notional for
  an output-anchored pair would use `(realized−mid)/mid` where the exact term is
  `(realized−mid)/realized` — wrong by a second-order factor; hence always
  `notionalIn`.)

`execResultUsd > 0` = surplus (received more than mid) = **Gained**; `< 0` = **Lost**.

## Core changes (`analyzeTransaction.ts`)

- Add `tier: MarketPriceTier`, `methodology: string`, `marketPriceFlags: string[]` to
  the `Receipt` type, populated from `pricing.tier` / `pricing.methodology` /
  `pricing.marketPriceFlags`.
- **Remove** the `anchorPriceUsd` field and its computation (the `readTokenUsd(input)
  ?? readTokenUsd(output)` block). `readTokenUsd` STAYS imported — the apparatus's
  oracle corroborator (`getOracleImpliedMid`) uses it; only the display field goes.

## Schema, route, queries

- **One migration:** add `tier` (text), `methodology` (text), `market_price_flags`
  (text, JSON-encoded string[] — match the existing `normalize_flags` convention),
  and **`DROP COLUMN anchor_price_usd`**.
- `route.ts` (`toNewReceipt`): write the three new fields; stop writing
  `anchorPriceUsd`.
- `ReceiptRow` (`lib/queries`): add the three; remove `anchorPriceUsd`.

## Dashboard rendering (`ReceiptView.tsx`)

**Rewrite `qualityNotionals.ts`** into one single-ruler helper, deleting every
`anchorPriceUsd` / two-ruler branch (`singleAnchorNotionals`, the both-anchored
`perSideNotionals`, `usdPerBasePrices`, `outputTokenDelta`):

```
receiptDollars(row) → { notionalIn: number; notionalOut: number; execResultUsd: number } | null
```

Returns null unless a mid exists and a side anchors (`isAnchorable` retained). Uses
`reconciledResult` as above.

`formatExecutionResult` is rewritten to render **unsigned**: the magnitude only
(`$4.57`), with a `Gained`/`Lost` subvalue and color as the sole direction signal —
**no `+`/`−` prefix.** `Gained` (execResultUsd > 0) is green (matching
`formatDialogBps`); `Lost` (< 0) uses the default color. Magnitude is
`|execResultUsd|`.

### State mapping (`tier × anchor` → Figma frame)

| State | Condition | Rows |
|---|---|---|
| **Anchored** | mid present (`full`/`estimated`) **and** a side `isAnchorable` | Token In/Out **USD** subvalues; **Execution Result** (unsigned magnitude + Gained/Lost); Market Price with **USD** subvalue + methodology; Price Delta in **USD** |
| **No anchor** | mid present, no side anchors | `~Size`; token amounts only; Market Price + Price Delta **token-denominated** (today's rendering) |
| **No market price** | `tier: 'none'` (mid null) | `~Size`; Market Price / Price Delta null (existing null treatment) |

`~Size` (unsigned, `~`-prefixed, best-effort `notionalUsd`) appears **only** in the
two non-anchored states; it is mutually exclusive with the Execution-Result block.
The **methodology string** renders as the subvalue under Market Price (filling the
mock's `Methodology string…` slot) from the stored `methodology`.

## Retirements

- `anchor_price_usd` column (migration drop) + the `Receipt.anchorPriceUsd` field +
  its computation + `route.ts` write + `ReceiptRow` field.
- The two-ruler functions in `qualityNotionals.ts` (`singleAnchorNotionals`,
  two-ruler `perSideNotionals`, `usdPerBasePrices`, `outputTokenDelta`) — replaced by
  `receiptDollars`.

## Guarantee

The dashboard now calls `reconciledResult`, so the core reconciliation invariant test
guards a live formula. Add a **dashboard test** asserting the rendered Execution
Result magnitude equals `|qualityBps / 10_000 × notional|` for the reference ETH→WBTC
row and that the Gained/Lost label matches the sign.

## Non-goals

- **Module collapse** (Phase 3): unchanged.
- **Per-leg Price Impact / Slippage / Total Execution Quality:** untouched.
- **No new oracle coverage** and no change to how `notionalUsd` / `tier` are computed
  in core (that is Phase 1's apparatus).
- **No backfill** — derivation works on existing rows; the migration only drops a
  column and adds three nullable ones.

## Open items for the plan

- Exact `market_price_flags` encoding — reuse the `normalize_flags` JSON-string
  convention (confirm its serializer/parser in `route.ts` / `queries`).
- Precise per-tier methodology copy (from core `methodologyFor`) vs. any dashboard
  re-wording; default to rendering the stored string verbatim.
- Whether `Price Delta`'s USD form reuses the existing `formatSubvalueUsd` /
  `formatPriceMagnitude` helpers (it should) so the anchored and token-denominated
  branches share formatting.
- Confirm the `DROP COLUMN` migration ordering against the current latest migration
  number in `packages/db`.
