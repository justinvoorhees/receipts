# Spec: Reference-pool depth floor

**Status:** approved, not implemented · **Date:** 2026-08-11, revised 2026-08-12 · **Scope:** core pricing (`tokenPricing`, `pricing`, `marketPrice`, `analyzeTransaction`) + receipt UI

**2026-08-12 revision.** Two more confirming transactions were verified, the floor was **calibrated against the corpus and lowered from $1,000 to $100**, the sole "known consequence" (receipt 253) was found to be **stale and wrong**, a live witness for the direct/v2 gate was found (receipt 485), a second ungated path onto the same dust pools was identified (`getTokenUsdcValue`), and the *Data flow* section's claim about what still renders was corrected against the UI and the approved design (Figma `733:209`).

**Relationship to other work:** the successor to `2026-07-31-depth-ranked-reference-pool-discovery-design.md`. That spec's depth *ranking* has since shipped — `createDefaultPricingDeps` now resolves reference pools through `getDeepestPoolForPair` / `getDeepestPoolWithDepth`, so pools are ranked by `balanceOf(refToken)` rather than taken first-match. This spec covers the case ranking cannot reach: **the ranked winner is itself dust.**

Spec #2 (Uniswap V4 reference-pool discovery) is a separate document and a separate plan. This one is deliberately independent of it: the floor protects the receipt even where V4 is not the answer (hooked pools, other venues, genuinely dead pairs).

---

## Problem

Transaction `0x537a3c559e1947123fe9271b9456f9a2e4d3c4ffa2ba8116e4087a11345e8495` (Base, block 49849551) is a **$1.98 BEAN→USDC** trade. Its receipt reports:

| field | value |
|---|---:|
| `realizedPrice` | 1.3261 USDC/BEAN |
| `marketMid` | **54.2416** USDC/BEAN |
| `allInCostBps` | **9755.5** |
| `slippageBps` | 9559.8 |
| `tier` | `estimated` |
| `marketPriceFlags` | `["SINGLE_SOURCE"]` |

The receipt asserts the trader lost **97.5%** of their notional. They did not. The route's own legs price cleanly: the BEAN→WETH leg reports `priceImpactBps` **0.33** and the BEAN→MILF leg **116.7**. Execution was normal; the *benchmark* is fiction.

### Root cause (traced and reproduced)

The Market Price apparatus reaches BEAN through the bridged class:

```
getMarketPrice → getEstimatedMidAtBlock → usdRef(BEAN) → midViaDeepest(BEAN, WETH)
                                        → getDeepestPoolWithDepth → POOL_FAMILIES scan
```

`POOL_FAMILIES` (`poolFamilies.ts:101`) covers `univ3`, `pancakev3`, `aerodrome_cl`, `aerodrome_basic`. For BEAN/WETH the scan returns exactly one initialized candidate:

- **`0x6945a4Bf3E7A68D86c4BFd863c6d664575D81545`** (univ3), depth `115202102709082` wei of WETH = **0.0001152 WETH ≈ $0.22**

Ranking runs and picks it, because it is the only candidate. `ESTIMATED_MID_MIN_LIQUIDITY = 1n` (`tokenPricing.ts:39`) admits it — one wei clears the floor. That pool's frozen mid becomes the sole ruler for the whole receipt.

Reproduced exactly: `midViaDeepest(BEAN, WETH)` at block 49849550 returns `0.02884488171999806` WETH/BEAN; `midViaDeepest(WETH, USDC)` returns `1880.4578357181485`; their product is `54.24158385073354` — the receipt's `marketMid` to the last digit.

The real BEAN liquidity is in **Uniswap V4**, which reference-pool discovery cannot see. That is spec #2's problem. **This spec's problem is that a $0.22 pool was allowed to become the market price at all.**

### Why this is silent

Nothing on the receipt records how deep the reference pool was. A $0.22 ruler and a $2M ruler are indistinguishable in the output. `SINGLE_SOURCE` does **not** mean "thin" — it means one liquidity *class* — and it fires on **24 of 62 corpus receipts (39%)**, the overwhelming majority of which are fine. There is no signal to filter on, which is why this required a live decode plus manual pool inspection to find.

### Why ranking already shipped and did not help

`2026-07-31`'s conclusion was explicit: *"rank by depth; don't reject. No minimum-depth floor is needed."* That conclusion was correct **for the cases it was derived from** — receipts 59 and 253, where a genuinely deep pool existed and merely lost to scan order. Ranking fixes those.

This transaction is the case that reasoning did not cover: ranking ran, and selected the best member of a set whose only member is dust. Ranking cannot rescue a candidate set that contains nothing good.

### Why the route's own pools cannot be the ruler

`market-ruler-error-quantified` establishes this at length: a route-relative ruler is a **tautology** (AMM output is a deterministic function of reserves and amountIn, so realized-vs-own-pool-mid ≡ LP fee + curve impact by construction), it cannot see bad routing, and it hands benchmark control to whoever picks the route. The fix must widen or gate *independent* discovery. It must not borrow the trade's own pools.

---

## Design

### Decision summary

| decision | choice |
|---|---|
| floor shape | **absolute USD**, not scaled to trade notional |
| floor value | **$100** (revised 2026-08-12 from $1,000 — see *Calibration*) |
| scope | **both** liquidity classes (direct and bridged) |
| application point | the **ranked winner**, never the candidate set |
| on failure | degrade `tier` to `none`; do **not** fall through to another pool |
| observability | distinct `INSUFFICIENT_DEPTH` flag + reference depth USD on `Receipt` |

An absolute floor keeps the ruler **trade-independent**, which preserves cross-receipt comparability — two receipts on the same pair in the same block get the same market price and the same tier. A notional-scaled floor would break that, undoing `single-ruler-market-price`.

The floor gates the *winner*, not the candidates. This is what distinguishes it from the gate `2026-07-31` rejected: that gate would have excluded pools during selection and fallen through to a worse estimate while a good pool sat unexamined. Here, ranking completes first; if the best pool in existence is dust, the answer is "no market price", not "a different pool".

### ⚠️ `ESTIMATED_MID_MIN_LIQUIDITY` must be SPLIT, not raised

The single constant `ESTIMATED_MID_MIN_LIQUIDITY = 1n` is currently compared against two quantities in **incompatible units**:

| site | compared against | unit |
|---|---|---|
| `pricing.ts:207` | `readLiquidity(pool)` | V3 virtual-liquidity **L** |
| `tokenPricing.ts:253` (`usdRef`) | `midViaDeepest(...).depth` | **`balanceOf(refToken)`** token amount |
| `tokenPricing.ts:272` (anchor) | `anchor.depth` | `balanceOf(refToken)` token amount |

Raising this one constant to any meaningful value would silently apply a token-amount threshold to an L value, and vice versa. **Do not raise it.**

Instead:
- Keep the L check as its own named constant with its current semantics (`L > 0` sanity, "this pool is not empty"). Rename to something that says so, e.g. `MIN_POOL_LIQUIDITY_L`.
- Introduce `MIN_REFERENCE_DEPTH_USD = 100` as a genuinely separate concept, compared only against a USD-valued depth.

### ⚠️ The v2-reserves branch is in scope

`pricing.ts:194-196` carries a breadcrumb written for exactly this moment:

> *"Deliberate asymmetry vs the v3 branch below: this rejects only a literal zero reserve, with no depth floor beyond that. That's harmless only because `ESTIMATED_MID_MIN_LIQUIDITY` is currently `1n` — if that floor is ever raised, revisit whether basic-AMM direct mids need an equivalent depth guard, since a near-empty v2 pool would otherwise pass through."*

Because the floor here is applied at the winner (post-ranking, in USD) rather than inside `readMidFromPool`, basic-AMM pools are covered by construction — the same `depthUsd` gate sees them. The breadcrumb should be **updated to say so** rather than left implying an open hole.

### Components

**1. `depthUsd(refToken, rawDepth, wethUsd, decimals) → number | null`** — new pure function in `tokenPricing.ts`.

Converts a `balanceOf(refToken)` raw depth into USD. Returns `null` when `refToken` is not free-priceable (see the gap below).

- `refToken` is a stable → `rawDepth / 10^dec`
- `refToken` is WETH or native → `rawDepth / 1e18 × wethUsd`
- otherwise → `null`

`pickReferenceToken` (`poolFamilies.ts:31`) picks the stronger anchor (stable > WETH > volatile), so in the **bridged** path — where `midViaDeepest` is only ever called as `(token, WETH)` or `(WETH, USDC)` — the yardstick is *always* WETH or USDC and this never returns null.

**2. Bridged path gate** — `getEstimatedMidAtBlock` / `usdRef` in `tokenPricing.ts`.

`wethUsd` is already in scope (computed from the anchor before either side is priced) and `midViaDeepest` already returns `{price, depth}`. Pure addition; no interface change. Both the anchor and each side are gated.

**3. Direct path gate** — `defaultGetPairMid` in `pricing.ts`.

`PoolMidReaders.getDeepestPool` currently returns `{address, kind}` and **discards depth**. Widen it to `{address, kind, depth}` — `getDeepestPoolWithDepth` already computes it, and `getDeepestPoolForPair` exists only to throw it away. Ripples:

- `createDefaultPricingDeps` — `resolveDeepest` switches to the with-depth resolver (`resolveDeepestWithDepth` already exists and is already pinned; the two can likely collapse into one).
- `pinnedPoolResolver` — generic over `T`, so no change.
- `pricing.test.ts` fake readers — must return the widened shape.

The direct path needs a `wethUsd` to value a WETH-denominated depth. `getMarketPriceForPair` already runs the bridged estimator concurrently; the anchor read is memoised by the decode session (`rpcSession.ts`), so obtaining it costs no additional RPC round trip.

**4. Flag and field.**

- New flag `INSUFFICIENT_DEPTH`, distinct from `NO_LIQUIDITY`. "A pool exists but is dust" and "no pool exists" are different facts and must stay distinguishable — collapsing them would destroy the evidence needed to tell whether $1,000 is set sensibly.

  ⚠️ **The flag cannot originate in `computeMarketPrice`.** That function is a pure reducer over an `Estimator[]`, and an estimator rejected by the floor is simply *absent* from the array — byte-identical to one that never existed. The rejection reason is known only in `getMarketPriceForPair`, where the deps are called. So:

  - `MarketPriceDeps`' three getters change from returning `number | null` to returning a small result carrying the reason (`{ price } | { rejected: 'depth', depthUsd } | null`), **or** `getMarketPriceForPair` collects rejections in a side-channel it merges into `MarketPriceResult.flags` after `computeMarketPrice` returns.
  - Prefer the second: it keeps `computeMarketPrice` — the most heavily unit-tested function in the module — untouched and still pure over its existing signature.
  - When the floor is what emptied every class, the result carries **both** `NO_LIQUIDITY` (from the reducer, which correctly observed zero classes) and `INSUFFICIENT_DEPTH` (from the merge, explaining why). That co-occurrence is intended, and `methodologyFor` must branch on `INSUFFICIENT_DEPTH` **before** the generic `tier === 'none'` string so the specific reason wins.
- Two new `Receipt` fields for the winning reference pool, both populated **whether or not the floor passed**, so a *passing but thin* ruler is also visible. No migration — receipts are ephemeral since `database-removal`.
  - `referenceDepthUsd` — the depth in USD.
  - `referencePoolAddress` — **the pool itself.** Depth alone cannot be re-audited; an address can, and it is what proved `0x7e21b6dc` and `0x537a3c55` share one dust pool (`0x6945a4Bf`, byte-identical depth). Nearly free to capture at selection time, impossible to recover afterwards on an ephemeral receipt.
- `methodologyFor` (`pricing.ts:375`) gains a branch naming the reason when `INSUFFICIENT_DEPTH` is present. **Approved copy** (Figma `733:504`):

  > Unavailable: The <u>deepest reference pool</u> for this token pair held $0.22 of liquidity. No reliable market price could be calculated.

  Note what this string does **not** say: it never states the threshold. The receipt reports the measured depth and lets it speak; publishing "below the $1,000 minimum" would harden a tuning constant into user-facing copy and invite argument about the number rather than the pool. Keep it out.

  "deepest reference pool" is a **link to `referencePoolAddress`** on the block explorer, standard dotted-underline treatment (Figma `733:494`) — the same affordance the Filler address and per-leg venues already use. This is what makes the field observable without a dedicated depth row, and it is why the address must be persisted rather than just the number.

### Interaction with pinned selection

`pinnedPool.ts` pins pool *selection* once per decode while still reading the mid at each of the three sampled blocks. The floor is therefore evaluated against the same pool at `refBlock-1 / refBlock / refBlock+1`. A receipt cannot pass the floor at one wing and fail at another, which would otherwise render an incoherent Before/At/After triple. **The floor must be evaluated at selection time, not per sampled block** — putting it in the per-block read path would reintroduce exactly the space-vs-time confusion `pinnedPool` was built to eliminate.

### ⚠️ `getTokenUsdcValue` is a second, ungated door onto the same dust pool

`notionalUsd` does **not** come from the gated path. `bestEffortNotional` (`pricing.ts:628`) calls `deps.getUsdValue` → `getTokenUsdcValue` (`tokenPricing.ts:292`), which resolves mids through `getPairMidAtBlock` — **not** the ranked, floored discovery this spec gates. Its fallback chain is: token/USDC direct, then token/WETH × WETH/USDC. Both can land on exactly the kind of pool this spec exists to reject.

For an **anchored** pair this is harmless, and it is why both 2026-08-12 cases survive with a correct `~Size`: `bestEffortNotional` prefers the anchored side, so `0x7e21b6dc` takes $81.68 off the ETH leg and `0x1955c578` takes $6.91 off the USDC leg, neither touching the dust pool.

For a pair with **neither** side anchored there is no such protection. `receiptDollars` already returns `null` there (no anchor ⇒ no per-side USD), so the `~Size` row is the *only* dollar figure on the page — and it would be computed from an ungated mid. The precedent is recorded in `bestEffortNotional`'s own docstring: a WARP→ETH swap whose WARP/USDC pool had zero in-range liquidity and a stale mid, *"inflating notional ~7×."* Post-floor, such a receipt reads `tier: none`, `INSUFFICIENT_DEPTH`, no market price — beside a confident `~$4,061`.

**Decision: out of scope for this spec, in scope for the follow-up, and recorded here so it is not mistaken for covered.** Gating `getTokenUsdcValue` means either routing it through the ranked resolver (a wider change than this spec wants, and it feeds `notionalUsdc` on every leg) or accepting that notional and market price are gated by different rules. Do not quietly do half of it.

### The volatile/volatile gap — accepted, flagged, not paid for

For a **direct** pair where neither side is a stable or WETH (e.g. BEAN/MILF), `pickReferenceToken` yields a volatile refToken and `depthUsd` returns `null`. Valuing it would need another bridge hop, which can itself land on a dust pool and recurse.

**Decision: do not pay for the hop.** When depth cannot be valued, emit `DEPTH_UNVERIFIED` and allow the mid through. This keeps the receipt honest — the check is recorded as *not performed*, not silently passed — consistent with the `feeResolved:false` and `routeReconstructed` precedents.

Blast radius is small: `pricing-dead-reference-pool` measured only **3 of 62** corpus receipts with neither side USD-anchored (59, 253, 256), ~5%.

### Data flow on the motivating transaction

```
usdRef(BEAN)
  → midViaDeepest(BEAN, WETH) → { price: 0.0288…, depth: 115202102709082n }
  → depthUsd(WETH, 115202102709082n, 1880.46) = $0.2166
  → 0.2166 < 1000 → null
⇒ bridged class absent; direct class already absent
⇒ computeMarketPrice([]) → { tier: 'none', marketMid: null, flags: ['NO_LIQUIDITY'] }
⇒ getMarketPriceForPair merges the rejection → flags: ['NO_LIQUIDITY', 'INSUFFICIENT_DEPTH']
⇒ allInCostBps null · slippageBps null · methodology names the reason
⇒ referenceDepthUsd: 0.2166 (recorded even though it failed the floor)
```

### ⚠️ What the receipt actually does — the original claim here was wrong

This section previously read *"Amounts, direction, gas, route legs, per-leg LP fees and per-leg price impact all still render. The receipt loses only the claim it could not support."* Traced against the UI on 2026-08-12, that is wrong in two places and incomplete in a third. Approved design: Figma `733:209` (`no-liquidity`).

**1. The per-side USD figures stop rendering, and the `~Size` row takes over.** `receiptDollars` (`qualityNotionals.ts:37`) returns `null` the moment `marketMid` is null, so the Token In / Token Out USD subvalues disappear — and one of them was *correct*, being the anchored side straight from `bestEffortNotional`. It is rescued only because `anchored` is defined as `dollars != null` (`receiptView.tsx:186`), which un-suppresses the soft `~Size` line. Net effect on `0x7e21b6dc`: `$4,061.25 → $81.68 → −$3,979.57` is replaced by a single `Size ~$81.68`, which is right.

⚠️ **That rescue is currently accidental.** `anchored` was written as a fallback for *unanchored pairs*, not for an anchored pair whose mid got floored; it does the right thing here by coincidence and nothing pins it. **Add a UI test** asserting `Size` renders and the per-side subvalues do not, on a receipt with a null mid and an anchored side.

**2. Per-leg Price Impact does NOT render — and this is a defect the floor makes common.** `tier: 'none'` routes through `partial()` (`pricing.ts:461`), which sets `pricingStatus: 'partial'`; `receiptView.tsx:444` then gates the *entire* Price Impact section on `isPartial` and collapses it to one `N/A`. But per-leg `priceImpactBps` is measured against **each leg's own pool mid at N−1** (`decomposeRoute.ts:855-908`) and is completely independent of the market ruler — 61.14bps on `0x7e21b6dc`, 0.34 + 20.05bps on `0x1955c578`, all still computed and stored.

The gate's own comment justifies itself with *"there is a route but no reference mid to measure it against"* — true of the whole-trade delta, **false of per-leg impact**. The two must be separated: the whole-trade rows (Slippage, Positive Slippage, Total Execution Delta) legitimately die with the ruler; the per-leg rows do not.

Per Figma `733:290` / `733:513`, the Price Impact section **keeps its leg rows** — `Uniswap v4 · BEAN/WETH` — rather than collapsing to a bare heading, so the receipt's shape is unchanged and the reader can still see which venues the trade touched.

**RESOLVED 2026-08-12 (user decision): render each leg's REAL price impact whenever it is available.** The design's per-leg `N/A` was an overstep and is superseded — `61.14bps` renders on `0x7e21b6dc`, `0.34bps` and `20.05bps` on `0x1955c578`. A floored market price says nothing about what a leg cost against its own pool, and withholding a number we measured understates the receipt.

**The change is a gate deletion, not new rendering.** `getPriceImpactRows` (`receiptDisplay.tsx:358`) is already entirely ruler-independent — it reads `leg.priceImpactBps`, formats per leg, and *already* handles every degenerate case on its own: `N/A` plus a per-leg explanation via `getNullPriceImpactTooltip` when the impact is null (rfq legs, `MID_NULL`, zero amountIn), and `–` for wrap/unwrap step legs. So "when available" needs no new logic; it is what that function already does.

In `receiptView.tsx:444`, drop `isPartial` from the gate:

```
- {!routeReconstructed || isPartial ? (
+ {!routeReconstructed ? (
```

Two consequences to carry through:
- Inside that branch, `valueTooltip={routeReconstructed ? NULL_PRICE_TOOLTIP : NO_ROUTE_TOOLTIP}` collapses — `routeReconstructed` is now always `false` there, so it simplifies to `NO_ROUTE_TOOLTIP`. Simplify it rather than leaving a ternary that reads as if both arms are reachable.
- ⚠️ **Do NOT make the same change to the Slippage rows.** `isPartial` stays on Slippage / Positive Slippage / Total Execution Delta (`receiptView.tsx:488`) — those are whole-trade quantities measured against the ruler and they legitimately die with it. The whole point of this change is that per-leg and whole-trade are different questions; deleting the gate in both places would recreate the conflation in the opposite direction.

**Test:** a receipt with `pricingStatus: 'partial'` and legs carrying non-null `priceImpactBps` must render the per-leg numbers; the same receipt's Slippage and Total Execution Delta must still render `N/A`. That pair of assertions is what pins the distinction.

**3. Price Delta is removed entirely.** With `marketMid` null the row could only ever print `N/A` directly beneath a Market Price row already printing `N/A` — redundant. Per Figma `733:494`, the Price Range section on a floored receipt is exactly: `Execution Price`, `Market Price: N/A`, then the methodology sentence. Drop the row rather than render a second `N/A`.

Amounts, direction, gas, route legs, per-leg LP fees, and the route's venue list all still render. The receipt loses the whole-trade delta it could not support.

---

## Calibration (measured 2026-08-12)

`scripts/analysis/referenceDepthDistribution.mjs` re-runs the *selection* half of the estimator over the frozen 62-row corpus at each receipt's own refBlock and values the winner's depth in USD. Serial, read-only, ~1 minute.

**44 of 62 receipts are depth-gated at all.** The other 18 are ETH↔USDC pairs that price through the `benchmark` fast path, where this floor never applies — so every percentage below is out of 44, not 62.

Receipts that would lose their market price entirely (i.e. **every** class floored out):

| floor | receipts losing market price | which |
|---|---:|---|
| $1 – $100 | **1 / 44 (2%)** | 173 |
| $200 – $500 | 2 / 44 (5%) | +371 |
| $700 – $1,000 | 4 / 44 (9%) | +189, +485 |
| $2,000 | 5 / 44 (11%) | +55 |
| $10,000 | 9 / 44 (20%) | +52, +56, +252, +536 |

The distribution has a **4,400× gap** at the bottom — $0.04, then nothing until $177.63:

| id | pair | binding depth | `allInCostBps` |
|---|---|---:|---:|
| 173 | ETH→SIRE | **$0.04** | **−2,249.0** |
| 543 | USDC→FLOWER | $177.63 | 38.7 |
| 371 | ETH→KellyClaude | $180.73 | −22.3 |
| 485 | POD→USDC | $595.15 | 165.4 |
| 189 | ETH→jesse | $628.72 | 279.2 |
| 55 | USDC→CLAWD | $1,670.87 | 372.4 |

Every **confirmed** instance of the pathology sits at or below $0.22 — `0x537a3c55` ($0.216 → +9,755), `0x7e21b6dc` ($0.216 → +9,799), `0x1955c578` ($0.0113 → −16,961), and id 173 ($0.04 → −2,249). Every receipt in the $177–$629 band reports a cost that looks entirely ordinary. **$100 catches 100% of known pathology at a cost of one receipt; $1,000 costs four receipts to catch the same one.**

### ⚠️ Two corrections to the original spec

**Receipt 253 is not $183 — it measures $2,925.32.** Its binding side is KEYCAT/WETH (`0xB211a9DD`, aerodrome_cl); the AERO side holds $1.38M. It does **not** degrade at $1,000, let alone $100. The $183 figure predates depth *ranking* shipping, which is exactly the change that would raise it. The old "Known consequences" section rested entirely on this number and has been deleted — **there is no longer any known receipt that the floor degrades and that we would rather keep.**

**Receipt 543 is rescued by its direct class**, and that vindicates the per-class design: its bridged out-side pool holds $177.63, but the direct USDC/FLOWER pool holds $131,721, so it keeps a `full` direct mid and merely loses bridged corroboration. A floor applied to some notional "overall depth" rather than per class would have wrongly killed it.

### Residual uncertainty

n=44, one frozen corpus, and the $177–$629 band was cleared only on the weaker test that its *headline* bps look plausible — not by verifying those rulers are right. `referenceDepthUsd` + `referencePoolAddress` are the instrument for revisiting this: ship them, accumulate receipts, re-run this script. The constant does not have to be right forever, it has to be defensible now.

**Corpus repopulation is required.** Pricing changes do not propagate to stored rows, and `receipt-repopulation-2026-07-21` warns stored receipts go stale silently. Note `three-price-receipt`'s three-arm protocol (backup → control on `main` in an isolated worktree → branch) — without the control arm, months of pre-existing staleness reads as if this branch caused it.

---

## Testing

**Pure unit tests (no RPC)** — `depthUsd` across stable / WETH / native / volatile refTokens; the floor predicate at, just below, and just above $1,000; the v2-reserves branch specifically, per the breadcrumb; `computeMarketPrice` reaching `tier: 'none'` when every class is floored out; `methodologyFor` producing the `INSUFFICIENT_DEPTH` string.

**RPC e2e — bridged gate.** Pin `0x537a3c55…` and assert `tier === 'none'`, `marketMid === null`, `allInCostBps === null`, and `INSUFFICIENT_DEPTH` present. Two more confirming cases are already in `docs/qa/cases.json` and should be pinned alongside it, because they cover shapes `0x537a3c55` does not:

- **`0x7e21b6dc…`** — same dust pool, byte-identical depth, but a **$81.68** notional (41× the motivating tx) and a **positive** delta of +9,798.9bps.
- **`0x1955c578…`** — the **negative**-sign case, −16,960.7bps. ⚠️ A test that only asserts an absurdly *large* delta would pass on both of the others and miss this one; assert on `|allInCostBps|` or on the flag, never on sign.

**RPC e2e — direct gate (the v2-reserves branch).** ⚠️ Originally there was no live witness for this path; **there is one: corpus receipt 485** (`0x79854af2…`, POD→USDC, block 49,504,751). Its direct pool `0x6e2752252794dd3Ad7bF2889FBc2FB3e15635e6E` (`aerodrome_basic`) holds reserves `[3385, 8778689381562459]` — **3385 raw USDC = $0.0034** — and `defaultGetPairMid` returns a **non-null 0.38559286618676636** today. This is precisely the case `pricing.ts:194-196`'s breadcrumb predicted (*"a near-empty v2 pool would otherwise pass through"*), so the direct gate and the v2 branch get their regression from one real transaction rather than from fakes alone.

Add any new hash to `docs/qa/cases.json` with a `why`, per `qa-cases-file` — **never** append a decoded row to `corpus.json`.

**Calibration regression** — `scripts/analysis/referenceDepthDistribution.mjs` is checked in. Re-run it after any change to discovery or ranking: if the corpus's binding-depth distribution shifts, the constant's justification has moved and the *Calibration* section above is stale.

**Regression guard** — a receipt whose reference pool is comfortably deep (e.g. `WETH→wstETH`, corpus 254, $19,334 notional) must be byte-identical before and after. Verify with `scripts/analysis/decodeGolden.mjs`, **captured serially** — concurrency produces false differences (`transient-rpc-silently-degrades-receipts`).

**Suite hygiene** — run from **repo root**; running from `packages/dashboard` reports roughly half the suite (`multichain-receipt-urls`). Run **both** env states: the RPC e2e skips silently without `TCA_RPC_URL` exported, and `source .env` does not export by itself — use `set -a && source .env && set +a`. `npm test` does **not** typecheck; run `tsc --build` and lint separately, since lint is what fails the Railway deploy.

---

## Out of scope

- **Uniswap V4 reference-pool discovery** — spec #2. Both V4 pools on the motivating tx are hookless (`hooks = 0x0`) with standard params (fee 5000/spacing 100 and fee 10000/spacing 200), so their poolIds are computable locally via `keccak256(PoolKey)` with zero RPC for enumeration. But V4 holds all liquidity in the singleton PoolManager, so `balanceOf(pool)` is meaningless as a depth yardstick and ranking V4 against univ3 needs a common unit (virtual reserves from `liquidity` + `sqrtP`). Real design work, not a `POOL_FAMILIES` one-liner.
- **`singleton-mid-decimals-orientation`** — the parked univ4/Infinity decimals-vs-currency-order bug. It must be fixed **before** V4 mids are trusted in the pricing path, and is a prerequisite of spec #2, not of this spec.
- Any notional-scaled or relative depth check.
- Rendering reference depth in the receipt UI.
