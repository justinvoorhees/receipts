# Market Price descriptor strings + footnote placement

**Date:** 2026-07-23
**Figma:** frame `500-3013` (descriptor string table), frame `500-2858` (receipt with `*` footnote)

## Goal

Replace the coarse Market Price methodology descriptor with the 12 spec-exact
strings, fix the reducer so the two `ORACLE_DISAGREE + SINGLE_SOURCE` states are
representable, and move the descriptor from a muted sub-label under the Market
Price label to a `*`-connoted footnote below the price rows.

## 1. Reducer flag semantics — `packages/core/src/marketPrice.ts`

The final flag assignment currently suppresses `SINGLE_SOURCE` whenever any other
flag is already present:

```ts
if (!corroborated && flags.length === 0) flags.push('SINGLE_SOURCE');   // old
```

This is wrong for the single-pool-plus-disagreeing-oracle case: it pushes
`ORACLE_DISAGREE`, then the `flags.length === 0` guard blocks `SINGLE_SOURCE`, so
the "only one liquidity source AND the oracle disagreed" state collapses to just
`ORACLE_DISAGREE`. Replace with:

```ts
if (!corroborated && liqClasses.length === 1) flags.push('SINGLE_SOURCE');
```

**Semantics:** `SINGLE_SOURCE` = exactly one liquidity class present and not
corroborated.

- It now co-occurs with `ORACLE_DISAGREE` → `['ORACLE_DISAGREE','SINGLE_SOURCE']`.
- It can never co-occur with `LIQUIDITY_DISAGREE` (that requires ≥2 classes).
- Tier is unchanged by this line: `SINGLE_SOURCE` is only added when
  `!corroborated`, i.e. the result is already `estimated`. The single-pool +
  agreeing-oracle case stays `full` (oracle in `corroboratedBy`), and gets no
  `SINGLE_SOURCE`.

No consumer outside core branches on these flags — the dashboard renders the
stored `methodology` string, not the flags (`marketPriceFlags` is persisted for
the record only). So this change is inert everywhere except core's own
descriptor selection.

### 1a. Corroboration definition — two disagreeing pools are never "full"

**(Added 2026-07-23, user-approved — overrides the original "no tier change"
constraint for this one case.)** The Figma state table enumerates every valid
state, and BOTH its `LIQUIDITY_DISAGREE` rows are `estimated`; there is no
"full + pools disagree" state. But the existing reducer promotes to `full`
whenever `oracleCorroborated`, even when the two liquidity pools disagree and the
oracle merely lands near their median — yielding `corroboratedBy === ['oracle']`
and the ungrammatical, un-spec'd `Verified: The oracle reference agree.`

With two liquidity values, each sits equidistant from their median, so if they
disagree (`LIQUIDITY_DISAGREE`) BOTH fall outside tolerance and neither is in
`corroboratedBy`. Fix the promotion so an oracle can only confer `full` when
there is a single liquidity source (the intended single-pool + oracle → full
case, spec states 2/3/4):

```ts
// full requires liquidity agreement, OR a single pool the oracle corroborates.
// Two disagreeing pools are never rescued to "full" by an oracle near their median.
const corroborated = liquidityCorroborated || (liqClasses.length === 1 && oracleCorroborated);
```

Result: two disagreeing pools + oracle-near-median → `estimated` with
`LIQUIDITY_DISAGREE` (spec state "disagree. Showing their median."). This makes
`methodologyFor`'s full-tier branch structurally guaranteed to see ≥2
corroborators, so the empty/1-part join is unreachable by construction.

## 2. Descriptor strings — `packages/core/src/pricing.ts`

Rewrite `methodologyFor(mp)` and the USDC/WETH fast-path methodology string
(currently `'Corroborated WETH/USD benchmark (median pools + oracle) at block
N-1.'`) to the spec-exact strings. `direct`/`bridged` naming: `direct` →
"direct-pool price", `bridged` → "WETH-derived price".

| State (tier / flags / corroboratedBy) | Descriptor |
|---|---|
| fast-path (USDC/WETH), oracle corroborates | `Verified: The median of three WETH/USDC pool prices agrees with the oracle reference.` |
| fast-path (USDC/WETH), `ORACLE_DISAGREE` | `Estimated: The median of three WETH/USDC pool prices disagree with the oracle reference. Showing the median of the three liquidity-based prices.` |
| full · `direct,bridged,oracle` | `Verified: The direct-pool price, WETH-derived price, and oracle reference agree.` |
| full · `direct,oracle` | `Verified: The direct-pool price and oracle reference agree.` |
| full · `bridged,oracle` | `Verified: The WETH-derived price and oracle reference agree.` |
| full · `direct,bridged` | `Verified: The direct-pool price and WETH-derived price agree.` |
| estimated · `SINGLE_SOURCE` · direct | `Estimated: Only the direct-pool price was available.` |
| estimated · `SINGLE_SOURCE` · bridged | `Estimated: Only the WETH-derived price was available.` |
| estimated · `LIQUIDITY_DISAGREE` (no oracle disagree) | `Estimated: The direct-pool price and WETH-derived price disagree. Showing their median.` |
| estimated · `ORACLE_DISAGREE`+`SINGLE_SOURCE` · direct | `Estimated: The direct-pool price and oracle reference disagree. Showing the direct-pool price.` |
| estimated · `ORACLE_DISAGREE`+`SINGLE_SOURCE` · bridged | `Estimated: The WETH-derived price and oracle reference disagree. Showing the WETH-derived price.` |
| estimated · `LIQUIDITY_DISAGREE`+`ORACLE_DISAGREE` | `Estimated: The direct-pool price and WETH-derived price disagree, and the oracle reference does not confirm their median. Showing the median of the two liquidity-based prices.` |
| none | `Unavailable: No reliable market price could be calculated.` |

**Selection logic** (given `mp: MarketPriceResult`):

- `tier === 'none'` → the Unavailable string.
- `tier === 'full'` → pick by the `corroboratedBy` set (the four `full` combos).
  Built as `Verified: The <a>[, <b>][, and <c>] agree.` from the phrases in
  canonical order `direct` → "direct-pool price", `bridged` → "WETH-derived
  price", `oracle` → "oracle reference"; first phrase capitalized "The …".
- `tier === 'estimated'`:
  - both `LIQUIDITY_DISAGREE` and `ORACLE_DISAGREE` → the combined string.
  - `LIQUIDITY_DISAGREE` only → the "disagree. Showing their median." string.
  - `ORACLE_DISAGREE` (single source) → direct/bridged variant, chosen by which
    liquidity class is in `corroboratedBy`.
  - otherwise (`SINGLE_SOURCE`) → "Only the … was available." direct/bridged
    variant, chosen by `corroboratedBy`.

The single liquidity class is always in `corroboratedBy` (a lone class is
within-tol of itself, which is the mid), so `corroboratedBy` reliably names
direct vs bridged for the single-source rows.

### 2a. USDC/WETH fast-path oracle downgrade

**(Added 2026-07-23, user-approved.)** The fast-path (`isUsdcWethPair` branch,
pricing.ts ~419-448) currently ALWAYS returns `status: 'full'`, `tier: 'full'`
with the confirmed string — even when the benchmark's oracle did not corroborate
the pool median. The benchmark already emits `ORACLE_DISAGREE` in its `flags`
when the pool median and the usable oracle(s) diverge beyond tolerance.

Fix: when `bench.flags` includes `'ORACLE_DISAGREE'`, the fast-path returns
`status: 'estimated'`, `tier: 'estimated'`, and the estimated fast-path string;
otherwise `full` + the confirmed string. The shown `marketMid` is unchanged (it
is still the pool median) in both cases — only the tier and descriptor change.

- Confirmed (no `ORACLE_DISAGREE`): `Verified: The median of three WETH/USDC pool prices agrees with the oracle reference.`
- Estimated (`ORACLE_DISAGREE`): `Estimated: The median of three WETH/USDC pool prices disagree with the oracle reference. Showing the median of the three liquidity-based prices.`

**Trigger scope:** `ORACLE_DISAGREE` ONLY (user decision). Oracle-unavailable and
oracle-stale benchmark states (`ORACLE_UNAVAILABLE`, `CHAINLINK_STALE`,
`OFFCHAIN_STALE`) keep `tier: 'full'` for now; a distinct row/string for them is
deferred. The "three" wording is verbatim per the design; the benchmark's
`LOW_POOL_COVERAGE` case (fewer than three pools) is not separately worded here.

## 3. Dashboard

### `packages/dashboard/components/receipt/priceFormat.ts`
`fallbackMethodology(pricingStatus)` (for rows with a NULL `methodology` column)
aligns to the new prefixes:
- `full` → `Verified: market price corroborated across sources.`
- `estimated` → `Estimated: market price is uncorroborated.`
- else → `Unavailable: No reliable market price could be calculated.`

### `packages/dashboard/components/receiptView.tsx`
- Market Price row: remove `subLabel={methodologyText}`. Label renders
  `Market Price*` only when `hasMarketPrice`; otherwise plain `Market Price`.
- Add a full-width, wrapping footnote `*{methodologyText}` between the Price
  Delta row and the Gas Cost divider, rendered only when `hasMarketPrice`.

### `packages/dashboard/components/receipt/receiptRows.tsx`
The existing `subLabel` slot on `DetailRow` used `whitespace-nowrap`. The new
footnote must wrap across lines, so it is a standalone element in `receiptView`
(secondary color, `text-[12px]`), not the `subLabel` slot. The Market Price row
was the only `subLabel` caller, so after removing it the prop is dead: delete the
`subLabel` prop from `DetailRow` and its full-width markup block.

## 4. Tests

- `marketPrice.test.ts`: the existing "oracle disagrees" case now also asserts
  `flags` contains `SINGLE_SOURCE`; add an explicit single-pool + oracle-disagree
  case asserting both flags; confirm the ≥2-class + oracle-disagree case does NOT
  get `SINGLE_SOURCE`.
- `pricing.test.ts`: `estMid` fixture uses `SINGLE_SOURCE`; update the two
  methodology assertions to the new exact strings; add coverage for the
  `ORACLE_DISAGREE + SINGLE_SOURCE` and `LIQUIDITY_DISAGREE + ORACLE_DISAGREE`
  strings.
- `receiptView.test.tsx`: update `fallbackMethodology` asserts; assert the `*`
  footnote renders with the stored methodology and is absent on the null-mid
  state; assert `Market Price*` on a priced row.

## 5. Repopulation

Re-run receipt analysis on the persisted rows (`scripts/repopulateReceipts.mjs`,
needs `TCA_RPC_URL`) so `methodology` and `market_price_flags` reflect the new
strings/flags. Mids are unchanged by this work, so it is a descriptor/flag
refresh only. Controller (not a subagent) runs the full suite WITH RPC after.

## Non-goals

- No change to how mids are computed, tiers assigned, or notionals derived.
- No new flags beyond making `SINGLE_SOURCE` co-emit with `ORACLE_DISAGREE`.
