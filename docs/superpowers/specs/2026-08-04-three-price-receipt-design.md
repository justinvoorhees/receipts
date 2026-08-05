# Three-Price Receipt — Price Range section, intra-block market price, and the delta rounding gap

**Date:** 2026-08-04
**Branch:** `feat/three-price-receipt`
**Figma:** [647-3415](https://www.figma.com/design/f9uYixaSgpkV1lEvN8Ie01/TCA?node-id=647-3415) (full tier) ·
[647-3599](https://www.figma.com/design/f9uYixaSgpkV1lEvN8Ie01/TCA?node-id=647-3599) (intra-block table) ·
[647-3470](https://www.figma.com/design/f9uYixaSgpkV1lEvN8Ie01/TCA?node-id=647-3470) (descriptor sentence) ·
[647-3471](https://www.figma.com/design/f9uYixaSgpkV1lEvN8Ie01/TCA?node-id=647-3471) (Price Delta) ·
[650-3993](https://www.figma.com/design/f9uYixaSgpkV1lEvN8Ie01/TCA?node-id=650-3993) (unpriced tier)

## 1. Summary

Reorganize the receipt so every price-related value lives in its own **Price Range**
section, and give Market Price an intra-block table showing the pool mid at three
adjacent blocks plus the dispersion between them.

**The pricing ruler does not change.** This is a display and provenance change. The
one substantive engineering change beyond rendering is closing the Execution Delta
two-path rounding gap, which the redesign would otherwise widen from two paths to
three.

## 2. The ruler decision (settled)

The Figma emphasizes the `At Block` row (`--primary` against `--secondary` for its
neighbours), which reads as a proposal to move the reference mid to block N.
**Rejected.** The ruler stays at N−1 (`pricing.ts:407`,
`refBlock = blockNumber > 0n ? blockNumber - 1n : blockNumber`).

### Why not same-block

`readSlot0` / `readV2Reserves` pass `blockNumber` to viem's `readContract`, i.e. an
`eth_call` block tag. **`eth_call` at block N returns state at the END of block N** —
after every transaction in it, including the trade being analyzed. A "market price at
block N" is therefore partly a price the trade itself created.

Consequences, in order of severity:

1. **Self-reference.** Where the reference pool is one of the route's pools, Execution
   Delta measures the fill against a mid the fill moved. The measured cost shrinks
   toward zero for exactly the trades with the most impact. This is a partial case of
   the route-relative ruler falsified on 2026-07-29 (see
   `docs/attribution-worklist.md` and the `market-ruler-error-quantified` findings),
   inheriting its tautology, manipulation-surface, and cross-receipt-comparability
   objections.
2. **It fails selectively and silently.** The reference pool is in the route only
   ~20% of the time, so most receipts would not visibly move — but that 20% is the
   single-pool, single-hop trades that are the easiest to interpret. A ruler that is
   wrong only on the clearest receipts is the worst available failure mode.
3. **Nothing to gain.** 75 V3-style legs rolled back to their exact pre-tx
   `sqrtPriceX96` and compared against the N−1 mid: **median 0.00 bps, max 6.9 bps,
   2/75 legs above 1 bps.** N−1 already *is* the pre-trade price.
4. **Cost.** Moving the ruler invalidates every persisted `market_mid` and every
   derived bps column, for no accuracy gain.

### Row → block mapping

The three rows sample **N−2 / N−1 / N**, not N−1 / N / N+1:

| Row | Block | Meaning |
|---|---|---|
| Before Block | N−2 | prior-block context |
| **At Block** | **N−1** | **the state the trade executed against — the ruler, unchanged** |
| After Block | N | post-trade: where the block left the pool |

`At Block = N−1` is semantically correct rather than a fudge: an AMM swap consumes
end-of-N−1 state, so N−1 is the price the trade actually faced. The emphasized row
in the Figma stays emphasized and stays the ruler; only the block it names shifts by
one.

**Known caveat (accepted):** the `After Block` row contains the trade's own price
impact, so the dispersion figure (§4) is not purely market movement. Accepted
deliberately — the alternative (computing over N−2/N−1 only) would describe two of
the three rows on screen.

## 3. Data model

Two new nullable numeric columns on `receipts`, named for their UI role:

| Column | Block | Row |
|---|---|---|
| `market_mid_before` | N−2 | Before Block |
| `market_mid` *(exists, unchanged)* | N−1 | At Block |
| `market_mid_after` | N | After Block |

Both are stored in the **same display orientation** as `market_mid` — i.e. through
`toDisplayPrice(mid, baseIsOutput)` (`analyzeTransaction.ts:457`). Storing them in a
different orientation than their sibling would guarantee an inversion bug later.

Both inherit the `midReliable` gate: when the reference mid is implausible,
`analyzeTransaction.ts:457` nulls `marketMid`, and the two new columns must be nulled
in the same expression. A partially-populated triple is not a valid state.

**The dispersion figure is NOT stored.** It is derived at read time from the three
mids. Storing it would create a second source of truth for a quantity fully
determined by columns we already persist — the same defect §6 exists to close.

### The shared-pool invariant

**All three reads must come from the same pool.** Pool discovery is block-invariant
(`getPool` is a deterministic CREATE2 address, and `poolFamilies.ts` already drops
the block parameter from `scanGetPool`), so the implementation resolves the ranked
pool **once** and re-reads `slot0` / `getReserves` at three block tags.

If the pool were re-discovered per block, a different pool could rank first at a
different block and the "deviation between blocks" would be measuring **space, not
time** — a wrong number with no symptom. Reusing the pool is also the cheap path:
**+2 calls, ~0 ms** (measured 765 ms/11 calls → 681 ms/13). Naive re-discovery per
block is ~2× wall (1485 ms/31) and must not be used.

### The USDC/WETH fast path is a separate branch

`priceReceipt`'s USDC/WETH branch does not use a single pool — `deps.benchmark()`
takes a median across `BENCHMARK_POOLS` and validates it against the oracle
reference. Sampling that at three blocks means 9 pool reads rather than 3. Still
cheap in parallel, but it is a **second implementation path**, not a free reuse of
the single-pool one. Both paths must produce the same triple shape.

### Degradation

If a block's read fails, or the pool did not exist at N−2:

- that row renders `–` (never `0`, never a silently narrowed sample), and
- the dispersion sentence is **omitted entirely** rather than computed over two
  points.

Rationale: this repo has shipped the "failed read is byte-identical to a real
measurement" defect twice (the unresolved-fee-vs-zero-fee case, and
`makeV4PoolKeyReader`'s `catch → null`). A σ computed over 2 points renders
identically to one over 3, so the reader cannot tell a narrowed sample from a full
one. Omit rather than narrow.

## 4. The dispersion figure

The descriptor sentence gains a final clause:

> Verified: The direct-pool price and oracle reference agree. **Price deviates
> 0.00bps between blocks.**

**Definition:** population standard deviation σ across the three mids, expressed in
bps relative to the **At Block** mid:

```
σ_bps = (σ({mid_before, mid_at, mid_after}) / mid_at) × 10_000
```

⚠️ **The `0.1bps` in Figma 647-3470 is a placeholder.** Against that frame's own
three numbers (35.0269 / 35.0232 / 35.0173) the candidate statistics are: range
2.74 bps, population σ 1.13 bps, sample σ 1.38 bps. None is 0.1. Do not treat the
mock's figure as a target during implementation or testing.

**Expect zeros.** In a 20-receipt sample the reference pool was **unchanged across
all three adjacent blocks in 15 of 20 cases** — it never moved, because it usually is
not a pool the trade touched. The three rows will therefore show three identical
values roughly three-quarters of the time and the sentence will read
`deviates 0.00bps`. This is intended: the rows render regardless and the sentence
stands. No special-casing, no conditional collapse. (That 15/20 is a subsample —
re-measure before quoting it anywhere user-facing.)

## 5. Layout

### 5.1 Section structure

Current receipt order → new order:

```
BEFORE                              AFTER
──────                              ─────
Aggregator                          Aggregator
Pair                                Pair
Chain                               Chain
Block                               Block
[Size | Token In/Out]               [Size | Token In/Out]
Execution Delta                     Execution Delta
Execution Price                     Gas Cost              ← moved up
Market Price + descriptor           ───────────────
Price Delta                         ## Price Range        ← new section
Gas Cost                            Execution Price
───────────────                     Market Price (3 rows) + descriptor
## Transaction Cost                 Price Delta
                                    ───────────────
                                    ## Transaction Cost   ← unchanged
```

Gas Cost moves up because it is not a price — it is paid separately in ETH and does
not belong in Price Range. Transaction Cost is untouched by this work.

### 5.2 Notional removal

"Notional free" applies **only inside Price Range**. Specifically:

- `Execution Price` loses its `subValue={formatSubvalueUsd(execUsdPerBase)}`
- `Market Price` loses its `subValue={formatSubvalueUsd(marketUsdPerBase)}`
- `Price Delta` renders a token amount, with `At Block per 1 <BASE>` as its subvalue

The top block is **unchanged**: Token In / Token Out keep their USD sublines, Size
keeps `~$151.04`, Execution Delta keeps `$4.57`, Gas Cost keeps `$0.0080`.

The Size-vs-per-token-USD difference between the two Figma frames is **existing
behavior, not a new rule** — `receiptView.tsx:183` already branches: anchored
(single-ruler) rows get per-side USD and an Execution Delta row and no Size; every
other row gets the soft `~Size` line instead. Both frames are consistent with that
branch. No change required.

### 5.3 Price Delta

```
Price Delta        WBTC bought at 0.0892 ETH below Market Price
                                          At Block per 1 WBTC
```

Verified against the mock's own numbers: Execution 34.934 vs At Block 35.0232 gives
0.0892 ETH per WBTC; re-expressed per-ETH in USD that is $4.56, matching the `$4.57`
in the Execution Delta row. Price Delta and Execution Delta are **one quantity in two
denominations** — which is precisely why §6 matters.

### 5.4 Tiers

| Tier | Execution Price | Market Price | Descriptor | Price Delta |
|---|---|---|---|---|
| `full` | value | 3 rows | Verified… + deviation | token + At Block qualifier |
| `estimated` | value | 3 rows | Estimated… + deviation | token + At Block qualifier |
| `none` / unpriced | value | `N/A` | `Unavailable: No reliable market price could be calculated.` | `N/A` |

The unpriced tier keeps Execution Price (it needs no mid) and renders the whole
Price Range section with `N/A` in two rows. It does not render the table or the
deviation clause.

⚠️ Figma 650-3993 still labels the third section **"Cost Breakdown"**. That frame
predates the 2026-08-04 rename (`2836e37`); the correct heading is **Transaction
Cost**. Do not regress it.

## 6. Closing the Execution Delta rounding gap (in scope)

### Why here

The receipt states one quantity three ways: `Execution Delta` (USD),
`Price Delta` (per 1 base), `Total Execution Delta` (bps). Today two of the three
share a source — `priceFormat.ts:71` documents that anchored Price Delta is "derived
from the SAME `execResultUsd` that drives the Execution Delta row, so the two can
never disagree" — while `receiptView.tsx:104` reads stored `all_in_cost_bps` for the
bps row.

**This redesign changes anchored Price Delta from USD to token-denominated.**
Implemented the obvious way — recomputing `marketMid − realizedPrice` from the stored
columns — it becomes a *third* independent derivation and silently retires the
documented guarantee. The branch must decide this either way, so it is in scope.

### The fix

`qualityNotionals.ts:57` already funnels everything through one
`reconciledResult({ marketMid, realizedPrice, notionalUsd })`. The work is to point
the remaining rows at that object rather than re-deriving:

1. **Token-denominated Price Delta** derives from the same `dollars` object, keeping
   the "can never disagree" invariant through the redesign.
2. **`Total Execution Delta`** derives from that object for anchored receipts,
   retiring the receipt's read of stored `all_in_cost_bps`.

### The orientation trap

⚠️ Stored `market_mid` is **display-oriented** (`toDisplayPrice(mid, baseIsOutput)`).
`(mid − realized) / mid` is **not invariant under that inversion**: with
`realized = mid(1+ε)` the un-inverted form gives `−ε` and the inverted form gives
`ε/(1+ε)` — opposite sign convention, and divergent at O(ε²). A naive read-time
derivation off the stored columns is therefore **wrong on the inverted half of the
corpus**, not merely differently rounded.

`receiptDollars` already handles this (`qualityNotionals.ts:53`,
`midOPi = baseIsOutput ? 1 / midStored : midStored`, with `realizedOPi = outAmt/inAmt`
computed orientation-free from raw amounts). Every new derivation must go through it.

### Why this is safe

`analyzeTransaction.ts:317` nulls `allInCostBps` when the mid is implausible — and
line 457 nulls `marketMid` in the same breath. Both die together, so a read-time
derivation **cannot resurrect a value core deliberately suppressed**. The CLAWNCH
plausibility guard survives the change.

### Explicitly out of scope

- **Core, and the `all_in_cost_bps` column itself.** `/trades` reads it for display
  *and for sorting* (`tradesTable.tsx:35,276`, `queries.ts:140`), and `alerts.ts:130`
  reads it for Slack. Changing the receipt's source is safe; changing the column is a
  separate, larger change.
- **Unanchored receipts.** `receiptDollars` returns `null` when neither token anchors
  to USD, so those rows keep the stored column.

**Honest limitation:** this makes the *receipt* internally single-sourced. It does not
make the repo single-sourced. Two sources still exist — they just never share a
screen, which is the property that motivated the backlog item.

⚠️ This is a **structural** fix, not a bug fix. No divergence has ever been observed
and none is expected at displayed precision. Do not go looking for a phantom
discrepancy to justify it, and do not write a test asserting one exists.

## 7. Verification: corpus backup and three-arm diff

### 7.1 The backup

`repopulateReceipts.mjs` has a dry-run, but it diffs only a **10-column `WATCH`
list** — it would not surface a change in `routeLegs`, `feeSinks`, `methodology`, or
`manipulationFlag`, and it only prints. "Any diffs beyond the intended Price Range
updates" is a full-column question.

**New: `scripts/snapshotReceipts.mjs`** — dumps every column of every row to a
timestamped JSON. Read-only, no RPC, seconds to run. This is the backup, and it
doubles as the restore path if a `--commit` goes wrong.

**New flag: `repopulateReceipts.mjs --snapshot=<path>`** — a dry-run additionally
serializes what it *would* write. It must serialize **`toUpdate()`'s return value**,
because that is by definition the column set repopulation touches; the new
`market_mid_before` / `market_mid_after` columns are then picked up automatically
with no second list to maintain.

### 7.2 Three arms

A snapshot → repopulate → diff conflates three sources of change: (1) this branch,
(2) pre-existing staleness from already-shipped fixes never repopulated (the
Aerodrome fee-reader stub, the v3 fee-tier relabel, the third-party fee relabel, the
QuickNode migration), and (3) RPC non-determinism. Only (1) is ours.

| Arm | Where | Cost | A diff here means |
|---|---|---|---|
| **0 — backup** | live DB, as-is | seconds, no RPC | the restore point |
| **1 — control** | `main`, dry-run + `--snapshot` | ~5–7 min | (2) + (3) — the noise floor, unrelated to this branch |
| **2 — treatment** | this branch, dry-run + `--snapshot` | ~5–7 min | vs Arm 1 → attributable to this branch |

**Arm 1 is not optional.** Without it every stale row from July reads as if this
branch caused it. This is the same control-first discipline `rpcProviderAB.mjs`
already encodes (`--control` A/As one provider against itself, so anything it flags
is non-determinism rather than signal).

Both RPC arms exceed the 5-minute tool timeout (~100–151 calls and 4.3–6.7 s per
receipt across ~62 receipts) and **must run detached in the background**.

### 7.3 Expected diff in Arm 2

Only `market_mid_before` and `market_mid_after` should change, from `null` to a
value, on rows where a mid exists. **Anything else is a finding**, including:

- any movement in `all_in_cost_bps` (§6 does not touch what core persists),
- any movement in `market_mid` (the ruler did not change),
- any tier or `pricingStatus` transition.

### 7.4 The skip trap

⚠️ `repopulateReceipts.mjs:74` **skips** rows whose re-analysis now returns null —
`"⚠ NULL receipt now — SKIPPED, not overwriting"`. Correct as a write guard, but it
means a receipt that silently stops resolving produces **no diff line at all**. The
comparison must **count skips as findings, not silence.** This is exactly how the V4
pool-key regression hid: one receipt vanished and eleven went wrong under a green
suite.

## 8. Testing

**Unit**

- σ-in-bps: normal case; three-identical-mids → `0.00`; two-of-three present → clause
  omitted (not σ over 2).
- The shared-pool invariant: three reads resolve the pool once. A test asserting
  "null and no RPC" does not pin branch existence — deletion produces exactly that,
  so assert the call count and the reused address.
- **Orientation:** a fixture with `baseIsOutput: true` where a naive
  `(mid − realized)/mid` on stored columns yields the wrong sign, proving the
  derivation routes through `receiptDollars`.
- Degradation: a failed block read renders `–`, never `0`.

**Render**

- All three tiers against the Figma frames.
- Gas Cost's new position (above the Price Range divider).
- Notional absent from all three Price Range rows; still present in the top block.

**Discipline**

- Every string assertion **mutation-checked** — change the source string, confirm the
  test fails, revert. Positional `indexOf`/`slice` assertions have gone vacuous
  repeatedly in this repo after reorderings, and this change reorders sections.
- `npm test` does **not** typecheck — also run `npx tsc --build`.
- `next build` runs ESLint and a lint error fails the Railway build. With a dev server
  live, real-build in a detached worktree rather than over the shared `.next`.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Re-discovery per block silently makes the deviation spatial | Resolve pool once; assert reuse in tests (§3) |
| Naive read-time bps derivation wrong on inverted pairs | Route through `receiptDollars`; explicit `baseIsOutput` fixture (§6) |
| Repopulation diff misread as branch-caused | Three-arm protocol with a control arm (§7.2) |
| A receipt silently stops resolving | Count skips as findings (§7.4) |
| Figma's `0.1bps` treated as a target | Documented as a placeholder (§4) |
| Three-identical-rows read as a bug | Expected ~75% of the time; documented (§4) |

## 10. Out of scope

- Moving the pricing ruler (§2).
- Changing core or the `all_in_cost_bps` column (§6).
- The `/trades` table and its `Ex. Delta` column.
- Transaction Cost section contents.
- Rendering the fee-on-transfer flag, and the `tooltip-agg-fee` / `tooltip-accuracy`
  id rename — both separately earmarked.
