# Single-Ruler Market Price

**Date:** 2026-07-20
**Status:** Approved, ready for planning
**Figma:** full/single anchor `429-2858` · no anchor `430-3251` · no market price `429-3050`
(https://www.figma.com/design/f9uYixaSgpkV1lEvN8Ie01/TCA)
**Reference txn:** `0x16e782f7a9dfefc3b84054ec81a366efbd603aea745ee5373ec005568adb360f`
(KyberSwap, Base, ETH→WBTC — the row that exposed the two-ruler bug)

## Thesis

There is **one price** on the receipt: **Market Price**, a single scalar per pair
at block N-1 (output-per-input). Everything USD-denominated — per-side notionals,
Execution Result, Price Delta — derives from that one number. Because they share a
ruler, **Execution Result is the dollarized form of Total Execution Quality by
construction**; they can never disagree in sign or magnitude. That identity is not
redundancy to design around — it is the *proof* that a single ruler is doing all
the work.

This reverses the earlier "notional pricing" attempt, which used **two rulers**:
the input side was marked at the deepest pool's mid, the output side at an
independent oracle (e.g. WBTC via BTC/USD). Two rulers produced two numbers that
openly contradicted each other — the reference ETH→WBTC row read **+$4.57 by the
pool ruler and ≈flat by the oracle ruler** — because the WBTC pool sat ~28 bps
above the BTC/USD oracle. A signed dollar gain that disagrees with the bps figure
reads as a bug. We are collapsing to one ruler and hardening it.

## What "Market Price" is (and is not)

Market Price is **one output-per-input scalar** for the traded pair at N-1. Multiple
sources may be consulted, but **only as independent estimators of that same one
number** — never as prices for the two sides separately.

- **IS**: the corroborated mid of the pair the trade actually moved.
- **IS NOT**: `usd(tokenIn)` from one source and `usd(tokenOut)` from another. That
  is the two-ruler pattern and is explicitly retired (see *Retirements*).

Oracles participate in exactly two single-ruler-safe roles:
1. **Backbone / anchor** — WETH/USD and stable≈$1 provide the USD pivot used to
   *dollarize* the one ratio. One anchor + the ratio yields both side notionals.
2. **Corroborator** — when *both* sides have USD feeds, the oracle-implied ratio
   `usd(in)/usd(out)` is another estimate of the *same* pair scalar, used to
   raise/lower confidence in it. It never becomes a side's display price.

## Semantics: pool-relative, not cross-venue

Market Price is the **pair's own corroborated mid** (pool-relative). We deliberately
do **not** re-express the volatile side at its independent oracle to surface
"venue basis." Doing so is the second ruler. Consequence, made explicit: for the
reference ETH→WBTC row the headline reads **Execution Result +$4.57 Gained**,
matching **Total Execution Quality +25.53 bps** — the same fact stated twice, which
is correct and expected under one ruler.

The per-leg Price Impact / Slippage / Total Execution Quality section already owns
the pool-relative execution story in bps. Execution Result is its receipt-level
dollarization. The two agreeing is the invariant we ship.

## The two gates → four render states

Two orthogonal gates decide what a receipt shows. This maps the three Figma frames
onto the apparatus's outputs.

### Gate 1 — ratio confidence (what earns a "Market Price")

Estimators of the one output-per-input scalar fall into **two roles**, and the
distinction is load-bearing: **liquidity** estimators *set* the Market Price;
**reference** estimators only *corroborate* it. The mid is always pool-relative —
an oracle never moves it. (This mirrors `benchmarkPrice`'s own proven pattern: the
oracle sets the manipulation flag, never the median-of-pools mid.)

Liquidity (mid-setting):
- **Direct** — median across the top-N deepest `in/out` pools at N-1 (generalizes
  the WETH/USDC benchmark's median-of-3 to any pair; today the non-WETH path reads
  a single deepest pool).
- **Bridged** — `(in/WETH) × (WETH/out)` via each side's deepest WETH pool. This is
  an *independent* path to the same ratio **only when neither endpoint is literal
  WETH**. When a side is literal WETH the direct estimator already reads that same
  WETH pool, so the bridge algebraically collapses to it (the WETH/USD anchor
  cancels) — it is suppressed (returns null) to avoid a hollow corroboration.
  **Native ETH (`'native'`) is the exception and is NOT suppressed**: `defaultGetPairMid`
  returns null for the synthetic `'native'` pseudo-address (there is no `native/x`
  pool), so for native-ETH pairs the bridge is the *only* liquidity estimator — it
  is essential, not redundant. (Real corroboration for native pairs then comes from
  the oracle-implied ratio, e.g. `ETH/USD ÷ BTC/USD` for native→WBTC.)

Reference (corroborate-only, never in the mid):
- **Oracle-implied** — `usd(in)/usd(out)` built from *independent* USD references:
  stablecoins = $1, WETH/native = the robust WETH/USD backbone, mapped-feed tokens
  (e.g. WBTC via BTC/USD) = their feed. Fires only when *both* sides resolve
  independently. For ETH↔WBTC this is `ETH/USD ÷ BTC/USD` — a genuine cross-venue
  check against the pool mid. It is a single ratio (one number), never a per-side
  display price.

Tiers:

- **`full`** — a liquidity mid exists **and** is corroborated within tolerance by an
  independent source: either a second independent liquidity class (direct **and**
  independent bridged agree) **or** the oracle-implied ratio. Market Price = the
  **liquidity mid** (median of the liquidity classes). The oracle's agreement earns
  the tier but does not enter the mid.
- **`estimated`** — a liquidity mid exists but has no agreeing independent
  corroborator (single guarded pool, or the corroborator disagrees beyond
  tolerance). Guards are the existing ones in `pricing.ts` / `analyzeTransaction.ts`:
  in-range liquidity floor, tick-boundary rejection (`MIN/MAX_SQRT_RATIO`), and the
  downstream plausibility cap. Market Price = the liquidity mid; dollar figures are
  shown but flagged `estimated`. A disagreeing oracle raises an `ORACLE_DISAGREE`
  flag (possible manipulation / thin pool / large venue basis).
- **`none`** — no liquidity mid survives the guards → Market Price and Price Delta
  null. An oracle ratio alone never produces a Market Price (the mid is
  pool-relative by definition).

Reuse the benchmark's tolerance as the default (tunable): `CORROBORATE_TOL_BPS = 50`
(matches `MANIPULATION_TOL_BPS`). A corroborator beyond tolerance drops the tier and
raises a flag; the mid is **never** the average of a pool and a disagreeing oracle.

### Gate 2 — USD anchor present (what earns dollars)

A side anchors to USD if it is a stablecoin, ETH/WETH, or a mapped-feed token. If
≥1 side anchors, dollarize: value the anchored side via the backbone (WETH/USD, or
stable=$1), value the other side by applying the **one** Market Price ratio. If
neither side anchors, the ratio can still be shown token-denominated, but no dollar
gain/loss claim is made.

### The states

| Gate 1 (ratio) | Gate 2 (anchor) | Render state (Figma frame) |
|---|---|---|
| `full` / `estimated` | yes | **Full / single anchor** — Token In/Out USD, **Execution Result**, USD Market Price + Price Delta. `estimated` tier annotates the methodology string. |
| `full` / `estimated` | no  | **No anchor** — *token-denominated* Market Price + Price Delta (e.g. `0.0892 ETH below Market Price`), `~Size` for orientation, **no** Execution Result / per-side USD. |
| `none` | either | **No market price** — Market Price / Price Delta / Price Impact / Slippage null, `~Size` only. |

**Full anchor vs single anchor is not a separate layout.** Both are the top row of
the table above. The difference is only in *available estimators*: a fully-anchored
pair (both sides have USD feeds) also has the oracle-implied corroborator, so it
reaches `full` more readily; a single-anchored pair leans on direct + bridge. The
same tier machinery serves both, which is why the Figma frame is labeled
"full / single anchor."

### `~Size` (orientation notional)

`~Size` is a best-effort, whole-trade USD magnitude for orientation only. It is
**always** prefixed `~`, **unsigned**, and never split per side or turned into a
gain/loss. It is a looser estimate than an anchor-grade notional — it may bridge
both sides through WETH even when neither side is a first-class anchor — so it can
appear in the "no anchor" and "no market price" states where Execution Result
cannot. It reuses the existing `bestEffortNotional` path.

## Architecture: one apparatus, thin source readers

Collapse the four pricing modules **by role, not into one file**. A single-file
monolith would kill the dependency-injection seam that makes pricing unit-testable
with pure fakes, and would force the per-leg impact reader to either move or
duplicate its math.

```
priceMath            pure sqrt/v2 → price. One copy.
                     (absorbs referencePrice.sqrtPriceX96ToUsdcPerWeth, which is
                      just sqrtPriceX96ToPrice(x, 18, 6) with 10^12 hardcoded)

source readers       thin, independently testable "rulers":
  - poolMid            deepest / top-N pool mids for a pair
  - wethUsdBackbone    generalized from benchmarkPrice (median-of-pools +
                       Chainlink + Dune, manipulation/staleness flags). Also
                       feeds bestEffortEthUsd (gas-in-USD), replacing its
                       separate getBenchmarkMid call.
  - tokenUsdFeeds      from tokenOracle — CORROBORATOR / ANCHOR inputs only
  - offChain           Dune ETH/USD

getMarketPrice       THE apparatus. Assembles estimators → one Market Price +
  (the apparatus)      confidence tier → dollarizes via one anchor. Replaces the
                       anchoring/branching logic in pricing.ts. Single entry point.

impact (UNTOUCHED)   getLegMidAtBlock stays with decomposeRoute — the intrinsic,
                     per-leg pool-relative layer. It does not move and is not
                     rewritten. Move it OUT of tokenPricing so that shared file
                     stops straddling two layers.
```

`priceReceipt` remains the boundary `analyzeTransaction` calls; `getMarketPrice`
implements it internally. The DI `PricingDeps` seam is preserved.

## Retirements (the second ruler comes out)

These exist today specifically to support two-ruler, independent side-pricing and
are removed or repurposed:

- **`anchorPriceUsd`** (field in `analyzeTransaction.ts`, column `anchor_price_usd`,
  migration 0014): today it carries the non-anchored side's *independent* oracle
  price so the dashboard can value that side off its own feed. Under one ruler it
  is no longer a display price. It survives only as a **corroborator input** to the
  ratio, or is dropped. The column may remain nullable and unused pending a later
  cleanup migration — no backfill.
- **`singleAnchorNotionals`** (quarantined `qualityNotionals.ts`): its
  independent-oracle branch (`row.anchorPriceUsd` → `basePrice`) is the second
  ruler. Per-side notionals are instead derived from the one Market Price + one
  anchor.
- **`isUsdcWethPair` fast-path** (`pricing.ts`): folds into the general path as
  simply the fully-corroborated case (WETH/USD backbone corroborated by
  Chainlink/Dune). No dedicated branch.

Reused as-is (not retired): the empty-pool / tick-boundary / plausibility guards,
`bestEffortNotional`, and the `formatExecutionResult` / Price-Delta rendering
helpers.

## Non-goals

- **No cross-venue "venue basis" line.** That requires the second ruler; excluded.
- **No change to per-leg Price Impact, Slippage, or Total Execution Quality.** The
  intrinsic pool-relative layer is untouched.
- **No fair-value/"good trade" claim beyond the pool-relative Execution Result.**
- **No new oracle coverage work** in this spec (ETH, stables, WBTC as they stand);
  the apparatus is structured so adding feeds later only adds corroborators.

## Reconciliation invariant (the test that guards one ruler)

For any receipt in the **Full / single anchor** state:

```
ExecutionResult_usd  ==  ExecutionQuality_bps / 10_000  ×  notional_usd
```

to within rounding. A test asserting this on the reference ETH→WBTC row (and at
least one `estimated`-tier row) is the guardrail that fails loudly if a second
ruler ever creeps back in.

## Sequencing

1. Build the `getMarketPrice` apparatus + estimators + tiers behind the existing
   `priceReceipt` interface; assert the reconciliation invariant. No UI change yet.
2. Rewire receipt rows (Execution Result, USD Market Price + Delta, methodology
   string, `~Size`) onto the tiers; retire `anchorPriceUsd` as a display price.
3. Fold the module collapse (priceMath / source readers / apparatus); move
   `getLegMidAtBlock` out of `tokenPricing`.

Per-leg impact never moves across any step.

## Open items for the plan

- Exact `top-N` for the direct-pool median (benchmark uses 3 fixed WETH/USDC pools;
  general pairs need dynamic discovery of the deepest N).
- Precise methodology-string copy per tier (`full` / `estimated`) and per state.
- Whether `anchor_price_usd` is dropped now (cleanup migration) or left dormant.
- Confirm `~Size` sourcing when neither side anchors (bridge-both-through-WETH) is
  acceptable as orientation-grade.
