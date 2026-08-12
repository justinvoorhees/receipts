# Spec: Reference-pool depth floor

**Status:** approved, not implemented · **Date:** 2026-08-11 · **Scope:** core pricing (`tokenPricing`, `pricing`, `marketPrice`, `analyzeTransaction`)

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
| floor value | **$1,000** |
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
- Introduce `MIN_REFERENCE_DEPTH_USD = 1_000` as a genuinely separate concept, compared only against a USD-valued depth.

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
- New `Receipt` field carrying the winning reference pool's depth in USD, populated **whether or not the floor passed**, so a *passing but thin* ruler is also visible. No migration — receipts are ephemeral since `database-removal`.
- `methodologyFor` (`pricing.ts:375`) gains a branch naming the reason when `INSUFFICIENT_DEPTH` is present.

### Interaction with pinned selection

`pinnedPool.ts` pins pool *selection* once per decode while still reading the mid at each of the three sampled blocks. The floor is therefore evaluated against the same pool at `refBlock-1 / refBlock / refBlock+1`. A receipt cannot pass the floor at one wing and fail at another, which would otherwise render an incoherent Before/At/After triple. **The floor must be evaluated at selection time, not per sampled block** — putting it in the per-block read path would reintroduce exactly the space-vs-time confusion `pinnedPool` was built to eliminate.

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

Amounts, direction, gas, route legs, per-leg LP fees and per-leg price impact all still render. The receipt loses only the claim it could not support.

---

## Known consequences

**Receipt 253 (`KEYCAT→AERO`) degrades to `tier: 'none'`.** Its best available pool was measured at **$183**, below the floor. This is intended and is the cost of the chosen floor value: $183 is not a market price for a $37,984 trade. Accepted knowingly.

**Some long-tail memecoin receipts will stop showing a market price.** That is the point. The alternative is continuing to show numbers like 9755 bps.

**Corpus repopulation is required.** Pricing changes do not propagate to stored rows, and `receipt-repopulation-2026-07-21` warns stored receipts go stale silently. Note `three-price-receipt`'s three-arm protocol (backup → control on `main` in an isolated worktree → branch) — without the control arm, months of pre-existing staleness reads as if this branch caused it.

---

## Testing

**Pure unit tests (no RPC)** — `depthUsd` across stable / WETH / native / volatile refTokens; the floor predicate at, just below, and just above $1,000; the v2-reserves branch specifically, per the breadcrumb; `computeMarketPrice` reaching `tier: 'none'` when every class is floored out; `methodologyFor` producing the `INSUFFICIENT_DEPTH` string.

**RPC e2e** — pin `0x537a3c55…` and assert `tier === 'none'`, `marketMid === null`, `allInCostBps === null`, and `INSUFFICIENT_DEPTH` present. Add it to `docs/qa/cases.json` as a hash with a `why`, per `qa-cases-file` — **never** append a decoded row to `corpus.json`.

**Regression guard** — a receipt whose reference pool is comfortably deep (e.g. `WETH→wstETH`, corpus 254, $19,334 notional) must be byte-identical before and after. Verify with `scripts/analysis/decodeGolden.mjs`, **captured serially** — concurrency produces false differences (`transient-rpc-silently-degrades-receipts`).

**Suite hygiene** — run from **repo root**; running from `packages/dashboard` reports roughly half the suite (`multichain-receipt-urls`). Run **both** env states: the RPC e2e skips silently without `TCA_RPC_URL` exported, and `source .env` does not export by itself — use `set -a && source .env && set +a`. `npm test` does **not** typecheck; run `tsc --build` and lint separately, since lint is what fails the Railway deploy.

---

## Out of scope

- **Uniswap V4 reference-pool discovery** — spec #2. Both V4 pools on the motivating tx are hookless (`hooks = 0x0`) with standard params (fee 5000/spacing 100 and fee 10000/spacing 200), so their poolIds are computable locally via `keccak256(PoolKey)` with zero RPC for enumeration. But V4 holds all liquidity in the singleton PoolManager, so `balanceOf(pool)` is meaningless as a depth yardstick and ranking V4 against univ3 needs a common unit (virtual reserves from `liquidity` + `sqrtP`). Real design work, not a `POOL_FAMILIES` one-liner.
- **`singleton-mid-decimals-orientation`** — the parked univ4/Infinity decimals-vs-currency-order bug. It must be fixed **before** V4 mids are trusted in the pricing path, and is a prerequisite of spec #2, not of this spec.
- Any notional-scaled or relative depth check.
- Rendering reference depth in the receipt UI.
