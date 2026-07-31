# Attribution Worklist — next steps

Handoff written 2026-07-30. Four workstreams, ordered by value. All figures are
measured against the 62 persisted receipts that carry `route_legs`.

**Measurement scripts for everything below live in `scripts/analysis/`** — see
its README. Every figure in this document can be reproduced by running them, and
should be re-measured rather than quoted as the corpus grows.

**Read this first:** the items below move **almost no basis points**. That is
the finding, not a shortfall. The unattributed residual on a receipt is
*reference-pool-vs-traded-pool divergence*, which is structural — it is not
recoverable measurement sitting in an unread fee.

⚠️ **§1 is DONE (2026-07-30) and it changed how to value the rest.** The
residual is now labelled **Unattributed** whenever we did not price every leg,
so the old framing — "§2 is the only item that moves bps *out of Slippage*" —
is stale. Those bps already stopped being mislabelled. What remains is making
the numbers *more accurate*, not making the receipt *more honest*.

Measured blast radius, re-measured 2026-07-30:

| item | receipts | notional | what it is |
|---|---:|---:|---|
| **§2 V4 multi-pool fee averaging** | 5 (3 unflagged) | $4,497 | a real bug; 3 receipts silently wrong today |
| ~~§3 Twin venues fee tier~~ 🛑 CLOSED | 2 | $53,884 | won't fix — both receipts are Odos, which is winding down |
| §4 PancakeSwap Infinity | 1 | $3 | generalizable root cause, negligible value |
| ~~RFQ relabel~~ ✅ DONE 2026-07-30 | 10 | $74,969 | zero bps, label only — see below |

**RFQ relabel — ✅ DONE 2026-07-30** (`8accd10`). Not a numbered item, but it
was the largest remaining honesty gap: 10 of 62 receipts ($74,969) have an
unpriced leg *only* because a market maker filled it off-chain, and the Slippage
cells were telling the trader "pricing coverage is n% complete" — reporting a
property of RFQ as a failure of ours. `getExecutionBreakdown` now returns
`slippageUnavailableTooltip`, which reads **"No calculation available due to
market maker inventory."** only when the route is **entirely** maker-filled, and
the coverage string otherwise. **7 receipts / $55,054.**

⚠️ **"every UNPRICED leg is a maker" is the wrong test**, and shipped briefly
before being narrowed. On a mixed route like id 210 — one maker leg among six,
77% of the notional priced through pools — it is *true* yet claims the whole
trade was maker-filled. The 3 mixed receipts (210, 189, 236; $19,915) get the
coverage figure, which is both more informative and more honest.

**Recommended order: §2, then §4.** ~~then §3~~ — §3 is closed (Odos wind-down). §2 is the only one that corrects a
displayed number, and its fix reuses machinery that already exists and passes
tests. §4 is cheap and its root cause generalizes to any future singleton DEX.
§3 carries by far the most notional but provably cannot move a basis point, and
since the fee-provenance and price-impact-caveat work its legs already render
honestly (`–` on LP Fee, a caveat on Price Impact) — so it is the least urgent
despite looking like the biggest.

Do these for **correctness**. Do not expect them to shrink the residual.

---

## 0. Where the code stands

Committed on `ui/receipt-footnote-and-trades-width` (unpushed) as `adf0f00`,
`5128489`, `ae1acba`. This is the completed unresolved-fee fix, all three halves.
⚠️ The branch name no longer matches its contents — these three commits are core
fee-provenance work sitting on top of three unrelated UI commits. They touch
nothing the UI commits touch, so cherry-picking them onto their own branch is
clean if that branch is headed for a PR as a UI change.

- `routeReaders.ts` — two silent fee sites now return `defaulted: true` and warn
  via a shared `unresolvedFee()` helper
- `legFees.ts` / `decomposeRoute.ts` — `LegFeeInput.feeResolved?: boolean`
- `analyzeTransaction.ts` — new exported pure `toPersistedLeg()` owning the
  `receipts.route_legs` contract
- `queries.ts` / `receiptDisplay.tsx` / `receiptRows.tsx` / `receiptView.tsx` —
  `feeResolved: false` renders `n/a` + "No fee available for this leg"

Verified: repo **595/595** with `.env` exported, `tsc --build` exit 0, eslint exit 0.

**Since then (2026-07-30), §1 shipped** on the same branch —
`35d0f82..aa6d4a7`, still unpushed. Coverage primitives in
`@fabric-tca/core/pure`, the Unattributed row on the receipt, the trades table's
three-way Slippage split, and the analysis scripts folded onto the shared
definition. Plus one follow-up not in the original plan: a leg whose fee tier
failed to resolve now caveats its **Price Impact** cell too
(`IMPACT_ABSORBS_FEE_TOOLTIP`), because the unread fee is sitting inside that
number. Repo **624/624** with `.env` exported, 621 + 3 skipped without.
Spec and plan: `docs/superpowers/specs/` and `docs/superpowers/plans/`,
both dated 2026-07-30.

⚠️ `configs/contractNames.json` was already modified before this work began (the
dev server mutates it). Not part of this change.

**Receipts 75 and 78 are already repopulated.** Every other row still predates
the flag. Pre-repopulation backup of those two rows is checked in beside this
file: `docs/receipts-75-78-prerepop-backup.json`.

---

## 1. Internal attribution-coverage metric  ✅ DONE 2026-07-30

> Kept in full because the reasoning below still governs the shipped code — the
> two-dimension split, the `feeTierBps > 0` trap, and why `decompConfidence`
> does not substitute for coverage. See the "Delivered" note at the end of this
> section for what changed, including the one reversal.

**Why first:** it makes everything else measurable instead of faith-based, it
needs no RPC, and it is the only item that finds problems rather than fixing one
known case.

### Do NOT ship it as a user-facing percentage

A trader cannot act on "83% of this route was priced" — it is meta-commentary on
our own tooling. Its job is a **gate** and an internal DB lever. The per-leg
`n/a` tooltips already exist and are good (`receiptDisplay.tsx:232`,
`RFQ_LEG_TOOLTIP` / `LEG_NULL_PRICE_TOOLTIP` / `NULL_PRICE_TOOLTIP`).

### Measure both dimensions, notional-weighted, excluding wrap/unwrap

```
coverage = Σ notionalUsdc (legs where the measurement exists)
           ────────────────────────────────────────────────────
           Σ notionalUsdc (all legs, excluding wrap/unwrap)
```

Current corpus values:

| dimension | test | coverage | missing |
|---|---|---:|---|
| LP fee | `feeTierBps > 0` | **76.6%** | 16 legs — `rfq` 11 ($66,828), `unknown` 5 ($53,887) |
| price impact | `priceImpactBps != null` | **83.5%** | 26 legs — `rfq` 11, V4 PoolManager 8, not-decomposed 5, other 2 |

⚠️ **Test `feeTierBps > 0`, NOT `!= null`.** A `feeTierBps: 0` leg passes a null
check and reads as "measured". That artifact produced a false "100% on 62/62,
the metric is saturated" reading before it was caught. With the `feeResolved`
flag now persisted you can test provenance directly instead of inferring from
the value — prefer `feeResolved === false` where present.

### It beats `decompConfidence`, which is dead and measures the wrong thing

```
conf=high    n=21   coverage <100%: 9    worst: 0%
conf=medium  n=14   coverage <100%: 1    worst: 61%
conf=low     n=27   coverage <100%: 10   worst: 0%
```

Worked example: **id 36** — KyberSwap, $35,055, `tier=full`, `conf=high`,
price-impact coverage **0%**. `decompConfidence` scores whether the route
*chained*; coverage scores whether it was *priced*.

### Separate causes, don't report one number

Lumped together, RFQ dominates and the metric just says "we do RFQ".

| cause | example ids | verdict |
|---|---|---|
| `RFQ_LEG_UNPRICED` | 36, 53, 118, 197, 208, 324 | **honest** — no on-chain mid exists; label unattributable, don't count as failure |
| `ROUTE_NOT_DECOMPOSED` | 219 (5 legs, `shape=complex`) | reconstruction failed |
| `PI_IMPLAUSIBLE` clamp | 329, 330, 402, 403 | **a bug in hiding** — see §2 |
| unexplained null | 399 (`univ4`, no flag) | needs a look |

### The real bug the metric exposes — fix this with it

`receiptDisplay.tsx:110` gates on `legs.some(pi != null)`, not `every`. A
partially-priced route subtracts only the priced legs' impact and silently
treats unpriced legs as **exactly zero** impact:

```
no leg priced    13 receipts   nothing subtracted — merely mislabelled
SOME legs priced  7 receipts   SILENTLY WRONG
all priced       42 receipts   correct
```

The 7 wrong ones:

```
id 210  coverage 77%  $13,094  slip= 25.5   conf=high
id 236  coverage 70%  $ 1,457  slip=-17.6   conf=high
id 189  coverage 61%  $ 5,364  slip=159.5   conf=medium
id  59  coverage 66%  $   637  slip=-183.7  conf=low
id 402  coverage 50%  $   268  slip= 33.3   conf=low
id 215  coverage 94%  $   562  slip=  1.8   conf=low
id  55  coverage 99%  $ 1,446  slip=271.4   conf=low
```

On id 210 we subtracted 77% of the route's impact and called the remaining 23%
zero. The displayed Slippage is wrong by an unknown amount, reads as precise,
and `decompConfidence` says **high**.

**Delivered 2026-07-30.** Coverage lives in `@fabric-tca/core/pure`
(`priceImpactCoverage`, `isFullyPriced`) and gates the receipt: below 100% the
Slippage and Positive Slippage rows render `n/a` and a single signed
**Unattributed** row carries the residual. The trades table splits its one
Slippage column into three. 20 of 62 receipts are below 100%; 13 of them
previously printed a number.

⚠️ **The "never ship it as a user-facing percentage" guidance above is
superseded** (decision 2026-07-30). The percentage appears in the `n/a` cells'
tooltip — "pricing coverage is n% complete" — because a trader benefits from
knowing how much of their transaction we actually priced. It stays out of the
receipt's numeric rows.

⚠️ The `.some()` defect was a **labelling** bug, not an arithmetic one. The
residual `slippage_bps − Σ(measured legPI)` was and is correct; it simply was
not entitled to the name "Slippage".

⚠️ **"No displayed digit changed" is true of the RECEIPT only** — don't carry it
across to the trades table. On the receipt, every value is byte-identical: the
`Unattributed` row prints the exact string the `Slippage` row used to, colour
included. But the table replaced one cell that rendered the **signed** residual
with a cost/benefit split, so a **fully-priced** row whose residual is a benefit
now shows `0.00bps` under Slippage with the number relocated to `Pos. Slippage`.
That is **28 of 62 receipts** (16 above $100 notional) — e.g. id 307 ($147,653,
residual −0.36), id 253 ($37,984, −639.50), id 248 ($13,125, −26.09). The change
is intended and makes the table agree with the receipt; it is the unqualified
claim that was wrong. Anyone regression-checking the table needs to expect it.

---

## 2. V4 multi-pool fee averaging  ✅ DONE 2026-07-30

> ⚠️ **Rewritten 2026-07-30 after re-measurement. The previous diagnosis on this
> item was WRONG** and would have sent its reader down a dead end. It claimed
> "a systematically wrong mid **and** fee read" and prescribed reading
> `getSlot0(poolId)` to find which half was broken. Neither half is broken. Of
> 23 Uniswap V4 legs in the corpus, most read fine — tiers of 0.07, 0.1, 5, 100
> with sensible price impact. Do not go reader-hunting.

### The actual bug

Uniswap V4 is a **singleton**: one address (`0x498581ff…`) emits `Swap` for
every pool. When a route touches several V4 pools, `decomposeTrade.ts:336-362`
collapses that flow into ONE synthetic leg and **averages the fee tiers**:

```
id  55  multiple V4 Swap fees detected (500, 10000)              → average=52.50 bps
id  59  multiple V4 Swap fees detected (3000, 500, 10003)        → average=45.01 bps
id 249  multiple V4 Swap fees detected (21222, 10000, 29500)     → average=202.41 bps
id 211  multiple V4 Swap fees (1002,1006,1000,1004,500,1003)     → average=9.19 bps
id 207  multiple V4 Swap fees detected (49, 500)                 → average=2.75 bps
```

The averaged tier is wrong for every pool it covers. Because core derives
`priceImpact = (legTotalCost − feeTier) × share` (`:374`, `:632`) from that same
tier, the impact goes with it — id 55 lands at **−92,096 bps**.

### The fix already exists in-repo, behind a gate that is too narrow

`decomposeRoute.ts:450` has a **V4 multi-pool RESCUE** that synthesizes one leg
per `poolId` from the Swap events. It works: receipts **56, 251, 408** carry
clean `v4:<poolId>` legs with correct per-pool tiers and sane impacts.

It is gated on **`!graph.reconstructed`** — it only fires when the first pass
*fails* (`orphan_token` / `fee_on_transfer`). The five receipts above
reconstruct *successfully but wrongly*, on a leg whose fee is a garbage average,
so the rescue never runs. **The gate cannot distinguish "reconstructed well"
from "reconstructed wrong."**

⇒ Widen it: also attempt the rescue when `decomposeTrade` averaged more than one
distinct V4 fee.

⚠️ **"Adopt only if the V4-augmented graph reconstructs" is NOT a safety net** —
an earlier draft of this section claimed a failed rescue changes nothing, and
that is false. `reconstructDag` checks only that INTERMEDIATE tokens conserve
and that the output token receives something; it never compares endpoint totals
against the trade, so it accepts both under-accounting (a `v4PoolKeyReader`
returning null silently drops that pool, and 2-of-3 resolved still trips the
`>1 poolId` gate) and over-accounting — the latter is exactly how ids 55 and 207
were corrupted in production mid-branch. A real completeness guard now compares
the adopted graph's input-token outflow against the pre-rescue graph's and
rejects a shortfall beyond the same 0.1% dust tolerance `conserved()` uses,
flagging `V4_RESCUE_REJECTED`. Do not remove it and go back to trusting
reconstruction.

### The clamp is hiding only the worst of it — 3 receipts are silently wrong

Of the 8 receipts that averaged, 3 were rescued (56, 251, 408) and **5 were
not**. Only two of those five tripped `PI_IMPLAUSIBLE`:

| id | notional | averaged tier | outcome |
|---|---:|---|---|
| 55 | $1,446 | 52.50 bps | clamped, PI nulled → shows Unattributed |
| 59 | $637 | 45.01 bps | clamped, PI nulled → shows Unattributed |
| **249** | **$2,220** | **202.41 bps** | **NOT clamped — wrong LP fee + wrong PI, unflagged** |
| **211** | **$193** | **9.19 bps** | **NOT clamped — same** |
| **207** | **$1** | **2.75 bps** | **NOT clamped — same** |

The three unclamped rows are the real find: they display confident LP Fee and
Price Impact numbers built on an averaged tier, with nothing warning anyone.
The clamp only catches the extremes.

### ⚠️ Do NOT raise the cap to "see the impact"

The clamped values are wrong — that is *why* the clamp fired. Anyone who
unclamps first ships a −13-billion-bps row. Fix the averaging, then repopulate.

### Two things previously filed here that do NOT belong

- **id 215 is not a V4 problem.** Its `PI_IMPLAUSIBLE` names leg
  `0x53ab4c60…` — **Hydrex**, not the V4 PoolManager. The old text asserted
  "every `PI_IMPLAUSIBLE` instance is the same venue"; that is false. Separate
  investigation.
- **ids 329, 330, 402, 403 are a different failure mode.** They carry
  `PI_IMPLAUSIBLE` on `0x498581ff…` but **no averaging flag** — a *single* V4
  pool whose impact is still implausible (6881.8, 5335.9, 9999.0,
  −13,149,914,232 bps), with `LEG_FEE_IMPLAUSIBLE: contributes 2000.00 bps` on
  329/330. A 20% tier is plausible for a hooked memecoin pool, so this may not
  be a bug at all. All four are `tier=none` with `slippage_bps` NULL, and two
  are $0 rows — nothing to move. Diagnose separately, and only after the
  averaging fix, which may change what is left.

### Also in scope: the stray nulls

- **id 399** — `univ4`, `priceImpactBps` null with **no flag explaining why**.
  Diagnose before assuming it is the same cause.
- **id 219** — `ROUTE_NOT_DECOMPOSED: shape=complex, reconstructed=false`,
  5 legs, $41. Reconstruction failure, different root cause.

**Delivered 2026-07-30.** Two halves. `shouldAttemptV4Rescue` (`v4Legs.ts`)
widens the rescue gate to routes that RECONSTRUCT over more than one distinct V4
poolId — previously the rescue only ran when the graph *failed*, so a route that
chained perfectly well on a collapsed leg never qualified. And `routeGraph.ts`
now lets the per-pool legs REPLACE that collapsed leg, discriminating it by the
**address that emitted the V4 Swap logs** (`v4Emitter`), not by token pair.

⚠️ The emitter-address rule is load-bearing and was learned the hard way. A
pair-scoped version shipped first and corrupted two receipts in production: ids
55 and 207 are multi-HOP through V4 — id 55 collapsed `USDC→CLAWD` against
synthesized `USDC→WETH` + `WETH→CLAWD`, id 207 collapsed `USDC→WETH` against
`USDC→USDbC` + `USDbC→WETH` — so the collapsed leg's pair is the route's
ENDPOINTS, which no individual pool covers — it survived alongside its own
replacements and the same flow was counted twice (`lp_fee_bps` 100.971→104.058
on id 55). Match on the emitter address: it identifies the collapsed leg
regardless of pair, while an unrelated V4-topic contract at a different address
still survives. Do not "simplify" this back to a pair or a type check.

Receipts 55, 59, 207, 211 and 249 repopulated. Every per-pool `feeTierBps` now
reproduces its raw Swap-event fee exactly — id 211's six pools read
10.02/10.06/10.00/10.04/5.00/10.03 against raw 1002/1006/1000/1004/500/1003.
The averaged tier was materially wrong: id 211's LP fee drops 10.019→5.747 and
id 59's slippage corrects −183.68→−37.21. Backup at
`docs/receipts-v4-multipool-prerepop-backup.json` (true pre-repop state).

⚠️ Still open, and deliberately not touched here: `decomposeTrade.ts:342-358`
still averages V4 fees for the route-level rollup, and ids 329/330/402/403
(single V4 pool, implausible PI, no averaging flag) and id 215 (Hydrex) remain
undiagnosed.

---

## 3. Twin venues fee tier  🛑 CLOSED 2026-07-31 — WON'T FIX

> **Both twin receipts are Odos, and Odos announced it is winding down
> operations within the month.** Odos is exactly 2 of 62 receipts — ids 75 and
> 78, the twin receipts and nothing else. Identifying these pools would serve a
> venue that is about to stop producing volume, for zero basis points of
> movement. Closed on value, not on difficulty.

### What the investigation found before it was closed (2026-07-31)

Measured on-chain. **Two of this section's structural claims are wrong** — do
not build on them if this is ever reopened.

- ⚡ **"Twin" = ONE contract deployed twice.** Both are 19,335 bytes but NOT
  byte-identical: they differ in 33 short runs, every one an inlined
  `immutable`. Not two instances of the same pool.
- ⚡ **The pairs are readable without verification**, straight from those
  immutables and confirmed by a state-dump getter: `0x0fcbb3f9…` is
  **USDC/cbBTC**, `0xef05e733…` is **cbBTC/WETH**. They form a two-hop CHAIN
  (USDC → cbBTC → WETH), not a round trip.
- ⚡⚡ **"sqrtPriceX96 ⇒ concentrated-liquidity family" is DISPROVEN.** Tested
  against the realized price in the same log: word[6]/2⁹⁶ squared gives
  57,752.92 where the actual raw price is 775.57 (USDC/cbBTC), and 24,057.72
  where it is 3.63e11 (cbBTC/WETH). Neither matches. Word[5] is a constant −1
  on both legs — a sentinel, not an amount.
- ⚠️ **The contract exposes no standard AMM interface at all** — 14
  non-standard dispatch selectors, no `token0()` / `fee()` / `slot0()` /
  `getReserves()`. `unknown` is genuinely correct today; this was never a
  reader bug.
- ⭐ Only lead worth resuming from: **`0xbcdb4dad` returns a 14-word state
  dump** (both tokens plus `5000000`, `10000`, `−30`, `29`, `1e10`, `1e12`, and
  two contracts). ⚠️ `10000` cannot be a 1% fee — leg A's measured price impact
  is 4.33 bps. The chain runs cold at a `factory()` pointing to an address with
  **zero code on Base**.

Full detail: memory `twin-venues-investigation.md`.

### The user-visible defect this leaves behind

⭐ **id 78 renders `L.P. Fee = 0.0bps` on `/trades`** for a $1,919 trade routed
100% through these pools. The per-leg rows are honest (`N/A` + "No fee available
for this leg"); the ROLLUP is not, because a missing fee sums to zero. That is
fixable **without identifying anything** — make the route-level rollup render
`–` when every contributing leg has `feeResolved: false`, applying the same
"missing ≠ zero" rule already used per-leg. Cheaper than this section ever was,
and it survives Odos shutting down.

---

### Original notes (superseded above, kept for the algebra)

**Value: exactly zero bps out of Slippage.** This is correctness only.
⚠️ Previously recorded as the "best target" at $53.9k — that was wrong, see below.

### They are already priced

```
id 75  $25,400  0x0fcbb3f9ae  pi= 13.25  feeTier=0
id 75  $25,400  0xef05e73397  pi=-10.82  feeTier=0
id 78  $ 1,919  0x0fcbb3f9ae  pi=  4.33  feeTier=0
id 78  $ 1,919  0xef05e73397  pi=-16.30  feeTier=0
```

They have price impact. What they lack is a **fee tier**, so their LP fee is
currently absorbed *into* Price Impact.

### Why fixing them cannot move Slippage

The cancellation is algebraic, not approximate. `lpFeeBps = feeTier × share`
(`decomposeRoute.ts:565`) and `weightedPI = (legTotalCost − feeTier) × share`
(`:374`) use the **same** `share`. Raising the tier by F adds X to LP Fee and
subtracts the same X from ΣPI. Core's `slippage = allIn − lpFee − aggFee` drops
by exactly the X that PI drops by, and the UI's
`marketForces = slippage − ΣPI` (`receiptDisplay.tsx:115`) is invariant.

### Identification (the actual work)

Both are unverified and **exactly 19,335 bytes** — the same contract deployed
twice, so one investigation identifies both.

- addresses: `0x0fcbb3f9aecc556de81ee756f01191d94a3d085e`,
  `0xef05e733970c37b6a2f863de0db9378ea49447cc`
- shared swap topic:
  `0xcd8b75a7fb6cb82ab3acded68ac53af5c43d19b51a91b9d5640bb73622dbdf57`
- 7 non-indexed words: `(address, address, bool, int amount0, int amount1, uint, uint)`
- last word ÷ 2⁹⁶ = 117.54 / 1.398 ⇒ **sqrtPriceX96, concentrated-liquidity family**

Then: topic→venue-type tag + **fee reader** (the actual defect) + mid reader —
both halves — and repopulate.

**Until then**, thanks to the §0 work, these four legs now render `n/a` +
"No fee available for this leg" instead of a false `0.00bps`. ids 75 and 78 are
already repopulated; the fix is visible now.

---

## 4. PancakeSwap Infinity  ⚡ HALF DONE 2026-07-30

> ⚠️ **The receipt id below is STALE.** This section says id 326, which no
> longer exists. The live case is **id 408**
> (`0x32b6fdfb3351304de58a8c3eedd0a7e0c1820d4505ea5bdb5d8cdbe764aede68`).

**✅ Shipped (`46aeed2`): the fee-sink misbooking.**
`SINGLETON_DEX_CUSTODIANS` (`tradeDecoders.ts`) replaces the hardcoded
`venueAddresses.add(UNISWAP_V4_POOL_MANAGER)`; the Vault is now infrastructure
and never probed. id 408: aggFee 3.997 → 1.188, slippage −3.209 → −0.400, allIn
unchanged, identity still closes. Backup: `docs/receipt-408-prerepop-backup.json`.

⚡ **The mechanism is flash accounting, not a failed probe.** The root-cause
text below is half right — the probe genuinely cannot see a custodian, but that
is incidental. A singleton settles by taking tokens in and paying them back out,
so it should net to ~nothing; the two sides are not measured identically and the
residual reads as a retained fee. Measured: the Vault's ERC-20-only delta is
**+2.991 USDC on a $12.07 trade**, because its payout side is native ETH.

⚠️ The registry holds the **CUSTODIAN**, not the Swap emitter. Uniswap V4 does
both at one address; Pancake splits them. Listing an emitter would leave the
custodian probed and misbooked.

**⭐ STILL OPEN: the 0.47 bps leg fee.** Everything below about decoding it from
the Swap event is verified correct on-chain. It is unread because adding a new
`VenueType` without also adding a `getLegMidAtBlock` branch would **null the
leg's 2.88 bps price impact** — the leg currently reaches a mid only via the
`unknown` → discovery fallback. Worth 0.17 bps of route LP fee on a $12 trade.

**Original value note: $3 of notional corpus-wide (1 of 52 receipts).** Do it for
correctness, not for recovered bps.

### The bug

`0x238a358808379702088667322f80aC48bAd5e6c4` appears on receipt **id 326** as
both a route-leg venue (`type: 'unknown'`, `lpFeeBps: 0`) and a 2.81 bps
**aggregator fee sink**. It is the PancakeSwap Infinity **`Vault`** — the
singleton token custodian. Not a pool, not a fee vault.

Real pool: `CLPoolManager 0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b`,
poolId `0xf6e81e5d…`, swap topic
`0x04206ad2b7c0f463bff3dd4f33c5735b0f2957a351e4f79763a4fa9e775dd237`.

### The fee is in the event — no RPC needed

```
event Swap(PoolId indexed id, address indexed sender, int128 amount0,
           int128 amount1, uint160 sqrtPriceX96, uint128 liquidity,
           int24 tick, uint24 fee, uint16 protocolFee)
```

Emitted with `state.swapFee` (the total) and `state.protocolFee`. On id 326:
`swapFee=70, protocolFee=23`. Pancake's `calculateSwapFee` =
`protocolFee + lpFee − protocolFee×lpFee/1e6`, which inverts to **lpFee=47**.
So 0.47 bps LPs + 0.23 bps protocol = 0.70 bps total.

### Root cause — generalize, don't special-case

Two spots in `decomposeTrade.ts`: line ~151 hardcodes exactly one singleton
(`venueAddresses.add(UNISWAP_V4_POOL_MANAGER)`), and lines ~163-169 decide
pool-vs-fee-sink by probing with `fee()` / `getReserves()`. A singleton vault
answers **neither** (fees live in the pool manager's per-pool `slot0`), so it
falls through and is classified as a fee sink.

⚠️ This generalizes: **any** singleton-architecture DEX we don't explicitly know
will have its LP fee silently reclassified as an aggregator fee. Uniswap V4 was
carved out by hand; nothing else was. Replace the hardcoded carve-out with a
registry.

### ⚠️ What the fix does and does not do

The 2.81 bps booked as Agg Fee is **not** mostly fee — the whole pool fee is
0.17 bps of the trade. The rest is the pool-mid-vs-market-mid ruler gap. So the
fix moves **+0.17 bps to LP Fee and +2.64 bps to slippage**. It does *not*
"fold the Agg Fee into LP Fees", and all-in cost is unchanged.

---

## Cross-cutting notes

**Repopulation.** `node scripts/repopulateReceipts.mjs --ids=… [--commit]`.
Dry-run by default; preserves id / created_at / user_id.
⚠️ `WATCH` (line 61) does **not** include `routeLegs`, so a legs-only change
prints `no change` and `changed=0` — but `if (COMMIT) await db.update(...)` runs
unconditionally, so the write still happens. Consider adding `routeLegs` to
`WATCH`. A full 39+ row run exceeds the 5-minute tool timeout — run it in the
background.

**Never `npm run build` over a live dev server** — it writes into the same
`.next` that `next dev` owns and the app renders unstyled. Use `npx tsc --build`.

**Suite colour is shell-dependent.** RPC e2e tests skip unless `TCA_RPC_URL` is
exported, and `source .env` does not export by itself — use
`set -a && source .env && set +a`. Run both states before calling it green.
Current baseline: **595/595** exported, 592 + 3 skipped clean.

**Test traps that have bitten repeatedly.**
- `formatDialogBps` (`receiptDisplay.tsx:93`) **strips the minus sign** — a −2 bps
  value renders `2.00bps`, not `-2.00bps`.
- `0.00bps` is not unique on the page (Aggregator Fee, Slippage) — anchor on the
  cell (`>0.00bps<`) and assert a counted differential, not mere presence.
- A label that prefixes another breaks `not.toContain` — anchor on `>Label<`.
- Reordering sections voids `html.slice(indexOf, indexOf)` helpers, giving
  vacuous passes. Verify assertions by mutation.

**Reader error handling.** All 53 non-test `catch` sites in `packages/core/src`
were swept 2026-07-29; only the two in `routeReaders.ts` were silent and both are
now fixed. Don't re-audit. The pattern to copy is `resolveAggregator.ts:50` /
`settlementDecoders.ts:50` — degrade, `console.warn`, and *name the consequence*.
⚠️ `makeDecimalsCache` (`tokenPricing.ts`) deliberately does **not** catch —
adding a try/catch there would misprice every non-18-decimal token by 10¹².
