# Receipt MVP: Decomposition Over Judgment

**Date:** 2026-07-14
**Status:** Approved, ready for planning
**Figma:** https://www.figma.com/design/f9uYixaSgpkV1lEvN8Ie01/TCA?node-id=365-2911
**Reference txn:** `0x16e782f7a9dfefc3b84054ec81a366efbd603aea745ee5373ec005568adb360f` (KyberSwap, Base, ETH→WBTC, receipts id 135)

## Thesis

The receipt answers **"what happened in this trade"** — not **"was this a good trade."**

Those are two different questions, and answering both at once is what made the
receipt self-contradictory. We may answer the second later, but the first has to
be validated before that's worth attempting. Every cut in this spec follows from
that ordering.

Concretely: the receipt decomposes a transaction against the venue it traded on.
It makes no claim about fair value, and therefore carries no USD valuation of
either side of the swap.

## Motivating bug

For the reference txn, the receipt simultaneously showed:

- **Total Execution Quality: +25.53 bps** (a good fill)
- **Price Delta: "Above Market" → "Execution Price is worse than Market Price"**

Both describe the same fact — the executed rate versus the pool mid — so they
cannot legitimately disagree. `priceDeltaComparison` (`ReceiptView.tsx:38`)
hard-codes *higher execution price = better*:

```ts
if (exec > mid) return 'Below Market';   // tooltip: "better than Market Price"
return 'Above Market';                    // tooltip: "worse than Market Price"
```

That holds only when the user is **selling** the base token. The base is the
volatile leg chosen by `anchorRank` (stables > ETH > everything else). When the
base is the **output** — i.e. the user is buying it — a *lower* price is better
and the verdict inverts.

| Trade | Base | User is | `exec < mid` means |
|---|---|---|---|
| ETH→WBTC | WBTC (output) | buying WBTC | **better** |
| USDC→WETH | WETH (output) | buying WETH | **better** |
| WETH→USDC | WETH (input) | selling WETH | **worse** |
| PEPE→WETH | PEPE (input) | selling PEPE | **worse** |

The bug therefore affects **every buy-side receipt**, including the common
USDC→WETH case. `ReceiptView.test.tsx:470` encodes it: it asserts that buying
WETH at 3005 against a 3000 mid is "better," which is a $5/ETH overpay.

A second, independent flaw: the labels are positionally backwards regardless of
direction — the code returns `'Below Market'` when the execution price is
literally *above* the mid. "Above/Below Market" reads as a statement of position
but is implemented as a verdict. For the reference txn both errors land at once.

`Total Execution Quality` is **not** affected: it is computed in
output-per-input via `signedDeviationBps` and negated at render
(`ReceiptView.tsx:490`), which is direction-correct.

## Layout

Per Figma `365:2911`:

```
Aggregator       KyberSwap
Pair             ETH→WBTC
Chain            Base
Block            48,601,527
············································· (divider already exists, ReceiptView.tsx:576)
Size             $1,791.14
Token In         1 ETH
Token Out        0.028625 WBTC
············································· (new)
Execution Price  34.934 ETH = 1 WBTC
Market Price     35.0232 ETH = 1 WBTC     ← label dotted-underlined, tier tooltip
Price Delta      0.0892 ETH               ← value dotted-underlined, verdict tooltip
············································· (new)
Gas Cost         $0.0080
```

`Cost Breakdown` and everything below it is untouched.

Dividers use the existing `<Divider dashed />`.

## Changes

### 1. Price Delta value → quote-per-base token delta

Currently USD (`$159.76`), derived via `usdPerBasePrices`. Becomes the raw
stored delta:

```
|marketMid − realizedPrice|  in quote-per-base, suffixed with the quote symbol
35.0232 − 34.934 = 0.0892 ETH
```

Formatted like its sibling price rows: 6 significant figures, no grouping;
2 decimals for stablecoin quotes at or above 0.01. Extract the numeric
formatting from `formatExecutionPrice` (`TradesTable.tsx:353`) so both share one
definition rather than duplicating the rule.

This works identically for anchored, ETH-quoted, and no-anchor memecoin pairs,
because the stored values are already quote-per-base in every case. It removes
the last USD dependency from the price block.

**Zero:** exact tie (`exec === mid`) → value renders `None`, no tooltip, no
underline. The old `<$0.01` "At Market" band is removed entirely — sub-cent
deltas now render at 6 significant figures rather than collapsing.

**No mid:** `partial` tier → `Unavailable for this pair` (unchanged behavior).

### 2. Price Delta tooltip → direction-aware, on the value

Replace `priceDeltaComparison` with a verdict function:

```ts
priceDeltaVerdict(mid, exec, baseIsOutput): 'better' | 'worse' | null
  better = baseIsOutput ? exec < mid : exec > mid
  null when either input is unusable, or exec === mid exactly
```

Tooltip string:

```ts
`${base} was ${baseIsOutput ? 'bought' : 'sold'} at ${verdict} than Market Price`
```

Reference txn → **"WBTC was bought at better than Market Price."** This agrees
with the +25.53 bps Execution Quality instead of contradicting it.

The four strings are not a 2×2 of free choices: the token and the verb are
locked together by one flag. The base *is* the bought token on a buy and the
sold token on a sell — that is what `baseIsOutput` means. Naming the base is
also what makes the tooltip describe the number actually on screen, since
Execution Price and Market Price are both quoted per base token.

`pairBaseQuote` (`ReceiptView.tsx:98`) already derives `baseIsOutput`
internally; it needs to return it.

**The verdict reads the raw stored `marketMid`/`realizedPrice` in every case** —
no branching. Sign is preserved under the USD rescale that used to be applied
(`marketUsd − execUsd = execUsd·(mm−rp)/rp`, with `execUsd > 0` and `rp > 0`),
and `exec === mid` is exactly when the delta is zero, so `None` can never
disagree with the tooltip.

The `tokenOutSubCent` parameter is deleted — it existed only to work around the
"At Market" band, which is gone.

### 3. Add Size

New row above `Token In`, value = `notionalUsd`, formatted as USD.
`Unavailable for this pair` when null. No tier gating — renders on `full`,
`estimated`, and `partial` alike.

Size is deliberately **soft**: a trade-size-at-a-glance figure that makes no
claim. It is the one USD number in the block that isn't load-bearing.

**No core work required.** `notionalUsd` is already populated on every tier and
already handles unanchored pairs: `getTokenUsdcValue` (`tokenPricing.ts:340`)
tries token/USDC directly, then falls back to token/WETH → WETH/USDC. For the
reference txn it resolves to $1,791.14, matching Figma exactly.

**Use `notionalUsd` as-is — do not re-derive it as "the input side."**
`bestEffortNotional` (`pricing.ts:439`) deliberately prefers the *anchored* side
over the input side, because pricing an illiquid input directly is a known
failure: a WARP→ETH swap hit a zero-liquidity WARP/USDC pool with a stale mid
and inflated the notional ~7×. Where the input is anchored (ETH→WBTC) the two
agree. Where they differ (e.g. PEPE→WETH values the WETH side) the gap is the
trade's own cost — immaterial at this precision, and the anchored side is the
robust choice.

### 4. Hide Execution Result and the per-side notionals

Remove from the render path:

- the `Execution Result` row
- USD subvalues on `Token In`, `Token Out`, `Execution Price`, `Market Price`
- the `Above/Below/At Market` subvalue on `Price Delta`

These are all "was this a good trade" claims.

### 5. DetailRow: gain `valueTooltip`, lose `subvalue`

`DetailRow` (`ReceiptView.tsx:243`) currently tooltips the label or the
subvalue, but not the value. Price Delta needs a dotted-underlined **value**.

All five `subvalue=` call sites are removed by change 4, so `subvalue` and
`subvalueTooltip` become dead and are deleted. `DetailRow` reduces to
`label / children / underscored / tooltip / valueTooltip`.

### 6. Preserve the "good trade" work in quarantine

Hiding Execution Result orphans most of the prior session's work. It is not
deleted and not left to rot in place. Move to
`packages/dashboard/components/receipt/qualityNotionals.ts` with its tests in
`qualityNotionals.test.ts`, **unimported by `ReceiptView`**:

- `perSideNotionals`
- `singleAnchorNotionals`
- `formatExecutionResult`
- `isAnchorable`
- `usdPerBasePrices`
- `outputTokenDelta`
- the ~24 associated tests

All six are confined to `ReceiptView.tsx` and `ReceiptView.test.tsx` — verified,
no external consumers — so the move is mechanical. (`formatSubvalueUsd` and
`tokenUnitPriceUsd` stay in `TradesTable.tsx`, which uses them independently;
`ReceiptView` keeps `formatSubvalueUsd` for Size and drops `tokenUnitPriceUsd`.)

Tests keep running and passing, so the code stays *provably* alive rather than
rotting behind a comment or buried in a commit SHA. `ReceiptView` gets smaller
and single-purpose.

Core is untouched: `validateMid`, `tokenOracle`, the `anchor_price_usd` column
(migration 0014, already applied to Supabase) and its backfill all stay. Core
keeps forward-populating `anchor_price_usd` for future WBTC trades, so the
"was this a good trade" phase resumes as a re-wire rather than a re-derivation.

## Tier gating (unchanged)

| Tier | Market Price | Price Delta | Size / Token In / Token Out / Gas |
|---|---|---|---|
| `full` | renders, oracle-validated tooltip | renders | renders |
| `estimated` | renders, "best-effort … not oracle-validated" tooltip | renders | renders |
| `partial` | `Unavailable for this pair` | `Unavailable for this pair` | renders |

The estimated-vs-full distinction is retained: a user must be able to tell a
bridged/estimated mid from an oracle-validated one. The reference txn is
`estimated`.

## Testing

TDD — each test watched failing before implementation.

**Rewritten** (currently assert the inverted behavior):

- the `priceDeltaComparison` describe block (`ReceiptView.test.tsx:41`)
- the three render tests at `ReceiptView.test.tsx:468-493`

**Direction coverage** — the core of this change:

| Case | Base | Expected verdict |
|---|---|---|
| ETH→WBTC, `exec < mid` | WBTC (output) | `bought at better` |
| ETH→WBTC, `exec > mid` | WBTC (output) | `bought at worse` |
| USDC→WETH, `exec > mid` | WETH (output) | `bought at worse` (currently asserts "better") |
| WETH→USDC, `exec > mid` | WETH (input) | `sold at better` |
| WETH→USDC, `exec < mid` | WETH (input) | `sold at worse` |

The WETH→USDC sell cases are **new** — no test covers the sell direction today,
which is why the inversion survived. They are the only thing that would catch a
direction regression.

**Other new coverage:**

- Price Delta renders quote-per-base with the quote symbol (`0.0892 ETH`)
- exact tie → `None`, no tooltip, no dotted underline
- sub-cent delta renders at 6 sig figs (no `$0.00` collapse, no "At Market")
- no-anchor pair (memecoin→memecoin) renders a token delta via the same path
- `partial` tier → `Unavailable for this pair` for Market Price and Price Delta
- Size renders on all three tiers; `Unavailable for this pair` when
  `notionalUsd` is null
- Execution Result and all four subvalues absent from rendered output
- `qualityNotionals` tests pass in their new location

**End-to-end:** verify against the real backfilled `id=135` row — Size
`$1,791.14`, Execution Price `34.934 ETH = 1 WBTC`, Market Price
`35.0232 ETH = 1 WBTC`, Price Delta `0.0892 ETH`, tooltip *"WBTC was bought at
better than Market Price"*, Total Execution Quality `+25.53 bps`.

## Verification

- `packages/core`: 533 tests pass (core is untouched; this is a regression gate)
- `packages/dashboard`: tests pass, including live-DB tests
- Typecheck clean
- Rendered receipt for id 135 matches Figma `365:2911`

Note: lint is broken repo-wide (ESLint v9 config missing) — pre-existing, out of
scope.

## Explicitly out of scope

- **Venue basis / fair-value reconciliation.** The reference txn's pool mid sat
  ~28 bps above the BTC/USD oracle, which is why a good fill (+25.53 bps vs pool)
  still produced a slightly negative result vs fair value (−$0.47). That is a
  real and interesting finding, and it is the "was this a good trade" question.
  Deferred.
- **Re-referencing the cost decomposition against an oracle.** LP fee,
  aggregator fee, price impact and slippage are pool-relative concepts; "price
  impact vs an oracle" is not definable. The decomposition stays venue-relative.
- **General `mid_validated` corroborators** (TWAP / cross-pool / DefiLlama) for
  the memecoin tail, and additional token oracles (cbBTC, EURC→EUR/USD feed
  already verified on-chain).
- **Address-based anchoring.**
