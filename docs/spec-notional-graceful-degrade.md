# Spec: Per-side token notionals (both-or-none, gated on anchor + validated mid)

**Status:** superseded · **Date:** 2026-07-13 · **Scope:** dashboard render + core mid-validation
(phased — see Phasing)
Superseded by `docs/superpowers/specs/2026-07-14-receipt-mvp-decomposition-design.md` — the receipt no longer makes fair-value claims.

## Problem

A receipt stores a single `notionalUsd` from **one** USD-anchored leg and prints it on
**both** the Token In and Token Out rows, so every swap looks value-neutral and the output
is never valued on its own terms. When neither side anchors, the price rows and Price Delta
additionally stamp `$` on quote-per-base **token units** (`formatDelta:35`, price-subvalue
fallbacks `:483`/`:497`) — fabricated dollars.

## Decision

Chosen policy: **both notionals or none — never a single notional.** Showing one side's
figure and dropping the other reads as more confusing than helpful.

> **Show both notionals iff `(≥1 side independently anchors) AND (the benchmark mid clears
> a validation bar)`. Otherwise show none.**

The key realization: a second notional on a **single-anchor** trade does **not** require an
independent price for the non-anchored token. It is fully determined by

```
second_notional = anchored_notional × (realizedPrice / marketMid)
```

`realizedPrice` is exact (from the tx) and `anchored_notional` is trustworthy (oracle/face),
so the **only** soft input is `marketMid`. Trustworthiness of the second notional therefore
reduces entirely to **trust in the mid** — which is what the validation bar measures. A
"no anchor" trade still degrades to none regardless of mid quality, because there is no
independent USD tie-point to place *either* side on the dollar axis.

## Per-side anchor price

```ts
// STABLE_SYMBOLS = {USDC, USDbC, DAI}; ETH_SYMBOLS = {WETH, ETH}
function usdPrice(symbol: string, row: ReceiptRow): number | null {
  if (STABLE_SYMBOLS.has(symbol)) return 1;                 // face; tier-independent
  if (ETH_SYMBOLS.has(symbol))
    return row.chainlinkPrice != null ? Number(row.chainlinkPrice) : null; // pool-independent oracle
  return null;                                              // (until Phase 3 adds more oracles)
}
const anchorIn  = usdPrice(row.inputSymbol,  row);
const anchorOut = usdPrice(row.outputSymbol, row);
const anchorCount = (anchorIn != null ? 1 : 0) + (anchorOut != null ? 1 : 0);
```

## Mid validation (the hardening — core)

`midValidated: boolean` (new core-computed field on the receipt). A mid is validated when it
is corroborated by a source **independent of the executed swap**, within tolerance, and not
manipulation-flagged. Sources, preferred order:

1. **Already oracle-validated** — `pricing_status = 'full'` (WETH/USDC benchmark +
   Chainlink). Always `midValidated = true`.
2. **On-chain prior-window TWAP** — Uniswap V3 `observe()` over ~30 min before the block on
   the deepest pool of the pair. Block-accurate, dependency-free, and defeats both self-impact
   and single-block manipulation (time-independence). `midValidated` if `|spotMid − twapMid| /
   twapMid ≤ TOL`.
3. **On-chain cross-pool reference** — the token's deepest pool *other than the executed one*
   (ideally vs a stable), read at the block. Reuses `getEstimatedMid` / `poolDiscovery.ts`.
   Agreement within `TOL` → validated.
4. **External cross-check** — DefiLlama historical `{timestamp}/{chain}:{token}` (block→ts,
   low-latency, broad coverage) — agreement within `TOL` → validated. Dune reserved for
   async/backfill validation only (warehouse latency + minute/hour granularity make it a poor
   on-demand source; its long-tail prices are the same pools echoed back).

`TOL` starting point ~**100 bps** (looser than the 50 bps WETH/USDC `manipulationFlag`, given
tail-token volatility); tunable. No independent corroborator available, or disagreement, or
`manipulationFlag` set → `midValidated = false`.

## Resulting behavior

| `anchorCount` | `midValidated` | Example | Display |
|---|---|---|---|
| 2 | (true by construction) | USDC→WETH `full` | **both, independent** — gap = realized result |
| 1 | **true** | ETH→WBTC / CLAWNCH→USDC w/ validated mid | **both**; marked side labeled "marked at validated mid" |
| 1 | false | thin single-pool mid | **none** (degrade) |
| 0 | — | LFI→GITLAWB | **none** + Price Delta in output tokens |

Any row with no notional → pass `subvalue={undefined}` so `DetailRow` renders the plain
amount (`ReceiptView.tsx:202`). For `anchorCount === 1`, the marked side's notional =
`anchored_notional × (realizedPrice / marketMid)` in the correct orientation.

## Price rows & Price Delta

- **`anchorCount ≥ 1`:** price rows keep their existing USD subvalues (resolve correctly via
  `usdPerBasePrices` for ETH legs, or stable-quoting). Price Delta stays `$`-denominated.
- **`anchorCount === 0`:** drop the mislabeled `$` price subvalues; render **Price Delta in
  output tokens**. Regime 3 always resolves `base = input`, so `marketMid` is output-per-input:
  ```ts
  const tokenDelta = Number(row.outputAmount) - Number(row.inputAmount) * Number(row.marketMid);
  // value:   `${formatTokenAmount(Math.abs(tokenDelta), null, sym)} ${sym}`  → "197178.79 GITLAWB" (no grouping)
  // subvalue: existing priceDeltaComparison(...) word (At/Above/Below Market)
  // tooltip:  "Execution returned {|tokenDelta|} {sym} {fewer|more} than Market Price"
  ```
  `LFI→GITLAWB`: `7,234,145.96 − 6,745,937.5 × 1.1016 = −197,178.79 GITLAWB` → **"197178.79 GITLAWB
  · Above Market."**

## Optional: explicit Execution Result line (recommended when both present)

`Execution Result = notionalOut − notionalIn` (green > 0). Directly answers the original
question ("+$4.57"). Tooltip distinguishes epistemic status:
- 2 anchors → *"Realized dollars out minus in, both sides independently valued (fees
  included); marked to oracle, not a round-trip exit value."*
- 1 anchor → *"Output marked at the validated benchmark mid — a fill-quality mark, not two
  independent measurements."*

## Phasing

- **Phase 1 — dashboard only. ✅ SHIPPED** (`a845ca3`). `perSideNotionals` both-or-none for
  double-anchored pairs; Regime-3 output-token Price Delta; single-/no-anchor degrade to none.
- **Phase 2a — single-anchor "both" for validated mids. ✅ SHIPPED** (`91ec907`).
  `singleAnchorNotionals` marks the non-anchored (base) side at the benchmark mid + Execution
  Result; full-tier accepted as validated. Lights up full-tier single-anchor (CLAWD, EURC).
- **Phase 2 — WBTC independent oracle anchor. ✅ SHIPPED.** `packages/core/src/tokenOracle.ts`
  (`TOKEN_USD_FEEDS`: WBTC→BTC/USD, Base feed `0x64c9…848F`, verified on-chain), read in
  `analyzeTransaction` → new `receipts.anchor_price_usd` column (migration `0014`). The
  dashboard values the non-anchored side at its OWN oracle when present (a *true* second
  valuation, any tier) — labeled "independent Chainlink oracle". Backfilled the one existing
  WBTC row (id 135). Notably the oracle showed the trade ~flat vs true BTC, vs the mid-mark's
  +$4.57 — the pool mid was ~28 bps above BTC. Pure `validateMid` corroboration core landed
  in `b5eeeb0` for future use.
- **Phase 3 — EARMARKED (later upgrade).** Generalize: more Chainlink token oracles
  (cbBTC, EURC→EUR/USD feed `0xc91D…3F0F` verified, majors); the general `mid_validated`
  column + on-chain TWAP / cross-pool / DefiLlama corroborators (via `validateMid`) for the
  estimated memecoin tail (CLAWNCH/FAIR/TOSHI/WARP), which otherwise correctly stay dark;
  address-based `anchorsToUsd` (spoof-resistant); optional forward-population of
  `anchor_price_usd` already wired in core for new WBTC trades.

## Detection / plumbing

- Phase 1 fields already on the payload: `inputSymbol`, `outputSymbol`, `inputAmount`,
  `outputAmount`, `chainlinkPrice` (`route.ts:61`), `marketMid`, `realizedPrice`. **Confirm
  `chainlinkPrice` is on the `ReceiptRow` type** `ReceiptView` consumes.
- Reuse `STABLE_SYMBOLS` / `ETH_SYMBOLS`; note address-based (`anchorsToUsd` from core) as the
  spoof-resistant follow-up for Phase 3.

## Edge cases

- `marketMid == null` (partial): Price Delta already `UNAVAILABLE`; token-delta not computed;
  a marked notional cannot be formed → none.
- `realizedPrice == null`: Execution Price already `UNAVAILABLE`.
- Gas Cost untouched in every regime (`formatGasUsd`, ETH-anchored).
- Sub-cent / dust notionals keep `formatSubvalueUsd` 6-sig-fig precision.

## Out of scope

- `TradesTable` list-view notional column (receipt detail view only).
- Non-DefiLlama external providers beyond the validation cross-check.

## Test plan

`ReceiptView.test.tsx` + core validator unit tests:

1. **2 anchors (USDC→WETH `full`):** `notionalOut = outputAmount × chainlinkPrice`, distinct
   from `notionalIn`; optional Execution Result sign/color.
2. **1 anchor, validated (ETH→WBTC, `midValidated=true`):** both shown; marked side =
   `anchored × realized/mid`; "marked at validated mid" label present.
3. **1 anchor, unvalidated:** none; price rows/Delta stay USD.
4. **0 anchors (LFI→GITLAWB):** none except gas; Price Delta value =
   `|outputAmount − inputAmount × marketMid|` + output symbol; comparison word preserved.
5. **`marketMid == null`:** Price Delta `UNAVAILABLE`, no crash.
6. **Core validators:** TWAP / cross-pool / DefiLlama each flip `midValidated` at the `TOL`
   boundary; `manipulationFlag` forces `false`.

Verify in-app: `0x4a63…` (2-anchor), `0x16e7…360f` & `0xa86c…a078` (1-anchor — none in P1,
both in P2), `0xe4b9…f4b7` (0-anchor, degraded).
