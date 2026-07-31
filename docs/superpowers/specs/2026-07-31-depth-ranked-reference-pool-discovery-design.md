# Spec: Depth-ranked reference-pool discovery

**Status:** approved, not implemented · **Date:** 2026-07-31 · **Scope:** core pricing (`poolDiscovery`, `poolFamilies`, `tokenPricing`, `venueClassification`)

**Relationship to other work:** new. Files as **§5 of `docs/attribution-worklist.md`**, not as part of any existing item. Builds directly on `dc3a891` (third Aerodrome CLFactory), which fixed venue *tagging* but left reference-pool *discovery* blind to the same factory.

---

## Problem

The trade notional and the market mid are both sampled from a "reference pool" chosen by
`discoverPool`. That function returns the **first initialized pool** it finds — not the best
one — and its only gate is `sqrtPriceX96 > 0`, which is true forever once a pool is created.
It says nothing about liquidity, balances, or recency.

A drained pool therefore does not error and does not return zero. It returns the price
**frozen at whenever it last traded**, which is a plausible-looking number. The failure is
silent.

Two receipts are provably mispriced today:

| receipt | pair | stored notional | correct | error |
|---|---|---:|---:|---|
| 59 | `LFI→GITLAWB` | $637.35 | ≈$1,474.92 | **2.31× under** |
| 253 | `KEYCAT→AERO` | $37,984.03 | ≈$7,388 | **5.14× over** |

Receipt 59's chosen pool had `liquidity()==0`, **$0.71** of USDC, and had not traded in
**618,824 blocks (~14.3 days)**. Its tick sat 8,408 ticks from the live market —
`1.0001^8408 ≈ 2.32×`, exactly the observed error. Reproduced exactly:
`getPairMidAtBlock(LFI, USDC, 46386347) × inputAmount = 637.3487` = the stored value to the
last digit.

### Why this matters more than it looks

`notionalUsd` is the **denominator of every bps cost on the receipt**. When it is wrong,
`lpFeeBps`, `slippageBps`, `reconResidualBps` and gas bps all rescale together, while
`all_in_cost_bps` — which is token-denominated (realized vs mid) — stays correct. The
receipt becomes internally inconsistent rather than obviously broken.

On receipt 59: `lpFeeBps` 302.94 (true ≈131), and `slippageBps` = 265.72 − 302.94 =
**−37.21**, which corrects to ≈**+135**. ⇒ **A negative slippage figure can be a denominator
artifact, not a measurement.**

### Why the existing mitigation does not cover it

`bestEffortNotional` (`pricing.ts:528`) already documents this exact hazard — *"a volatile,
illiquid token priced directly against USDC can resolve to a dead/stale reference pool and
mis-value the trade by multiples… inflating notional ~7×"* — and mitigates by preferring the
USD-anchored side. That mitigation lives at the **caller**. The hazard lives in
`discoverPool`, so it cannot fire when neither side anchors. Only **3** corpus receipts have
neither side anchored (59, 253, 256) and **2 of the 3 are wrong**.

Do not read the existing comment as coverage.

---

## Root cause: three defects, all in reference-pool discovery

### 1. First-match instead of depth-ranked

`discoverPool` (`poolDiscovery.ts:102`) loops factories × tiers and returns on the first
initialized hit. Its own docstring claims it "discovers the best reference pool"; it does no
ranking.

**The repo already contains the correct implementation.** `getDeepestPoolWithDepth` /
`getDeepestPoolForPair` (`poolDiscovery.ts:314`, `:348`) gather candidates across every
family in `POOL_FAMILIES` and rank them by a uniform `balanceOf(referenceToken)` yardstick
via `rankCandidatesByDepth`. It never throws, gates initialization per mechanism, and treats
an unreadable depth as `0` so a pool is never dropped for a transient RPC failure. It was
built for the basic-AMM mid work (`06164e2`) and `getPairMidAtBlock` simply never adopted it.

### 2. PancakeSwap's 2500 tier is invisible

`V3_FEE_TIERS = [100, 500, 3000, 10000]` is applied to the PancakeSwap factory, whose real
set is `[100, 500, **2500**, 10000]`. The constant is **duplicated** in two files that must
agree: `poolDiscovery.ts:85` and `poolFamilies.ts:64`. Every PancakeSwap 0.25% pool on Base
is invisible to both discovery paths.

### 3. `POOL_FAMILIES` knows one Aerodrome CL factory

`venueClassification.ts` now lists **three** (after `dc3a891`); `poolFamilies.ts` lists one
(`AERO_CL_FACTORY`). Pools from the other two cannot be discovered as reference pools. This
is the same gap class as the bug `dc3a891` fixed, in a second registry.

### The candidate evidence

Every pool a depth-ranked discovery would consider, measured at each victim's block:

**Receipt 59 — LFI/USDC @ 46386347**

| candidate | liquidity | USDC depth | in scan today |
|---|---:|---:|:-:|
| **AeroCL#3 ts=200 `0x8343C682…`** | 4.99e19 | **$35,922.82** | **no** (defect 3) |
| Pancake 2500 `0x41932EA9…` | 3.25e17 | $728.65 | **no** (defect 2) |
| UniV3 10000 `0xE8Bf20c8…` ← **chosen today** | 0 | $0.71 | yes |
| UniV3 3000 `0x337219D0…` | — | $0.00 | yes |

**Receipt 253 — KEYCAT/USDC @ 48879840**

| candidate | liquidity | USDC depth | in scan today |
|---|---:|---:|:-:|
| **UniV3 10000 `0x860c135a…`** | 1.13e15 | **$183.21** | **yes** |
| UniV3 100 `0x84dcB367…` ← **chosen today** | 0 | $0.00 | yes |
| UniV3 500, Pancake 500, Pancake 2500 | 0 | $0.00 | mixed |

⚠️ **This corrects an earlier working hypothesis.** The fix is *not* a `liquidity() > 0`
rejection gate that falls through to the two-hop WETH path. A genuinely deep pool exists in
both cases — $35,922 and $183 — and a fall-through would settle for a two-hop estimate while
ignoring it. **Depth ranking finds the right pool; rejection merely avoids the worst one.**

Note also that receipt 253 is fixed by ranking **alone** — its best pool is already in the
scan and simply loses to scan order.

---

## Design

**Invariant:** *a reference pool is the deepest live pool for the pair across every known
venue family.*

### Component 1 — `poolFamilies.ts` becomes the single registry

- Per-family tier/tick-spacing lists, so PancakeSwap gets `[100, 500, 2500, 10000]` and
  Uniswap keeps `[100, 500, 3000, 10000]`.
- The Aerodrome CL factory address list becomes **one exported constant**, imported by both
  `poolFamilies.ts` and `venueClassification.ts`. A future factory is added once.
- `poolDiscovery.ts` imports these rather than redeclaring them.

Rationale for unifying rather than patching both copies: defect 3 arose *because* two
registries drifted. Patching in place leaves the drift mechanism intact.

### Component 2 — `getPairMidAtBlock` adopts the depth path

Replace the `discoverPool` call at `tokenPricing.ts:162` with `getDeepestPoolForPair`.
No new ranking, gating, or error handling is written — all of it already exists and is
tested.

### Component 3 — retire `discoverPool`

It has exactly **one** production caller (`tokenPricing.ts:162`); after Component 2 it is
dead. Delete it, leaving an **anti-re-add breadcrumb** comment at the deletion site in
`poolDiscovery.ts` — a short note saying first-match discovery was removed because it
selected drained pools, so it is not reintroduced as an "optimisation". `discoverPool` is
the defect itself, and leaving it exported invites reuse.

⚠️ Confirm the caller count at implementation time rather than trusting this line. Dormant is
not the same as dead, and a reference count taken today can be stale by the time the change
lands.

### Data flow after

```
getTokenUsdcValue → getPairMidAtBlock → getDeepestPoolForPair
    → all families × correct per-family tiers × all known factories
    → per-mechanism initialization gate
    → rank by balanceOf(referenceToken)
    → deepest live pool → mid → notionalUsd
```

The same path feeds `getMarketPrice → market_mid → all_in_cost_bps`.

### Error handling

Inherited from the depth path and unchanged: never throws; unreadable depth ⇒ `0`;
initialization gated per mechanism (`v3-slot0` via `readSlot0`, `v2-reserves` via
`readV2Reserves`).

**One case deliberately not changed:** when every candidate has depth 0,
`rankCandidatesByDepth` still returns an initialized pool rather than `null`. A pair whose
only pool is dead therefore still yields a stale mid. This is identical to today's behaviour,
so it is not a regression — recorded, not fixed. Returning `null` would strand thin pairs
that currently price acceptably.

---

## Testing

**Unit, no RPC** (pure over injected readers — the existing `rankCandidatesByDepth` shape):
1. PancakeSwap discovery scans 2500; Uniswap discovery does not.
2. The Aerodrome family covers all three factory addresses.
3. `rankCandidatesByDepth` returns the deepest candidate, not the first.
4. A candidate whose depth read reverts is ranked at 0, not dropped.

**Integration, injected readers:**
5. `getPairMidAtBlock` returns the deep pool when a dead pool sorts earlier in the scan.

**Regression, RPC e2e** (skips without `TCA_RPC_URL` — run the suite with `.env` exported):
6. LFI/USDC @ 46386347 resolves to `0x8343C682…`, not `0xE8Bf20c8…`.
7. KEYCAT/USDC @ 48879840 resolves to `0x860c135a…`, not `0x84dcB367…`.

TDD throughout: each test must be watched failing for the right reason before the
corresponding change.

---

## Rollout

Chosen approach: **fix forward, repopulate, inspect after.**

0. ⚠️ **Take a fresh corpus backup first.** The existing
   `docs/receipts-full-corpus-backup-2026-07-31.json` is **stale**: 62 rows (ids 36–408),
   written 10:15 today, *before* the `dc3a891` repopulation. The DB now holds 63 rows
   (ids 36–442). Restoring it would drop id 442 and silently revert the Slipstream relabel.
1. `node scripts/marketMidSnapshot.mjs /tmp/base.json` on `main`.
2. Implement, `npx tsc --build`, full suite green in **both** env states.
3. `node scripts/marketMidSnapshot.mjs /tmp/after.json`, then `--diff` — not as a gate, as
   the artifact showing which pairs moved and by how much.
4. `node scripts/repopulateReceipts.mjs --commit` (background — a full-corpus run exceeds the
   5-minute tool timeout).
5. Verify receipts 59 and 253 against the values in this spec.

---

## Expected impact

- Receipt 59: notional $637.35 → sampled from a $35.9k pool.
- Receipt 253: notional $37,984.03 → sampled from the live $183 pool.
- An unmeasured number of other receipts' `market_mid`, and therefore `all_in_cost_bps`.
  Step 3 quantifies this; it is not known in advance.

⚠️ **This contradicts the headline thesis of `docs/attribution-worklist.md`**, which holds
that remaining work "moves almost no basis points" because the residual is structural
reference-vs-traded-pool divergence. That remains true *for the attribution gap*. This defect
is a different error class: a wrong **denominator**, not an unattributed cost. Both can be
true at once, and this one moves real bps.

---

## Out of scope

- The "zero in-range liquidity but out-of-range liquidity exists" nuance in CL pools.
- Any new receipt-facing flag for "no usable reference pool".
- A minimum-depth floor (the evidence above shows none is needed).
- Everything on the attribution worklist, including §4's open PancakeSwap Infinity leg fee.

## Negative results — do not re-investigate

- The near-zero-notional receipts (255, 327, 400, 401, 404, 405) are **genuine sub-dollar
  dust trades**, not mispricing. Their leg notionals agree with the trade notional.
- Receipt 256 (`QR→AERO`) has the dead pool on the **two-hop** path and a live direct pool,
  so direct-first is right there by luck. It is why the fix must not be "prefer the two-hop
  route".
- No receipt with a USD-anchored side shows this defect; the `bestEffortNotional` mitigation
  holds for those.
- Detector for regressions: `max(measured leg notional) / notional_usd > 1.5` flagged exactly
  receipt 59 corpus-wide.
