# Attribution Worklist — next steps

Handoff written 2026-07-30. Four workstreams, ordered by value. All figures are
measured against the 62 persisted receipts that carry `route_legs`.

**Measurement scripts for everything below live in `scripts/analysis/`** — see
its README. Every figure in this document can be reproduced by running them, and
should be re-measured rather than quoted as the corpus grows.

**Read this first:** three of the four items below move **almost no basis points**.
That is the finding, not a shortfall. The unattributed residual on a receipt is
*reference-pool-vs-traded-pool divergence*, which is structural — it is not
recoverable measurement sitting in an unread fee. Measured blast radius of
everything on this list combined:

| item | direction | receipts | notional | effect on Slippage |
|---|---|---:|---:|---|
| V4 PoolManager reader + stray nulls | Slippage → Price Impact | 4 | $2,913 | ~1.7 bps each |
| Twin venues fee tier | Price Impact → LP Fee | 2 | $27,319 | **exactly zero** |
| PancakeSwap Infinity | Price Impact → LP Fee | 1 | $3 | ~zero |
| (RFQ relabel — not in this doc) | none | 10 | $74,969 | zero, label only |

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

⚠️ `configs/contractNames.json` was already modified before this work began (the
dev server mutates it). Not part of this change.

**Receipts 75 and 78 are already repopulated.** Every other row still predates
the flag. Pre-repopulation backup of those two rows is checked in beside this
file: `docs/receipts-75-78-prerepop-backup.json`.

---

## 1. Internal attribution-coverage metric  ← do this first

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

## 2. V4 PoolManager reader + stray nulls

**Value:** the only item that moves bps out of Slippage — ~1.7 bps each on 4
receipts, $2,913 combined. Small, but it is a genuinely broken reader.

### The bug

Every `PI_IMPLAUSIBLE` instance in the corpus is the **same venue** —
`0x498581ff718922c3f8e6a244956af099b2652b2b`, the Uniswap V4 PoolManager — with
impacts of **6881.8, 5335.9, 9999.0, and −13,149,914,232 bps**, alongside
`LEG_FEE_IMPLAUSIBLE: contributes 2000.00 bps` (a 20% fee tier).

That is a systematically wrong mid **and** fee read, not implausible markets.
The clamp (`PI_IMPLAUSIBLE_CAP_BPS`, `decomposeRoute.ts:635`) nulls it and the
loss disappears into the residual.

### ⚠️ Do NOT raise the cap to "see the impact"

The clamped values are wrong — that is *why* the clamp fired. Anyone who
unclamps first ships a −13-billion-bps row. Fix the reader, then repopulate.

### How

Same shape as the trap in the QuickSwap v4 work: a venue needs BOTH a working
fee reader and a working mid reader, or tagging it nulls its price impact.
Start by reading `getSlot0(poolId)` for the affected legs at `blockNumber - 1`
and comparing against the realized price to find which half is wrong.

**Affected:** 8 legs / 8 receipts / $3,087 notional. Only 4 have a non-null
`slippage_bps` to shift out of (402, 59, 215, 55); the other 6 (219, 329, 330,
396, 399, 403) have `slippage_bps` NULL — `tier=none`, two are $0 junk rows —
so there is nothing to move and you would be creating a number where the
receipt currently shows `n/a` on both rows.

### Also in scope: the stray nulls

- **id 399** — `univ4`, `priceImpactBps` null with **no flag explaining why**.
  Diagnose before assuming it is the same cause.
- **id 219** — `ROUTE_NOT_DECOMPOSED: shape=complex, reconstructed=false`,
  5 legs, $41. Reconstruction failure, different root cause.

---

## 3. Twin venues fee tier

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

## 4. PancakeSwap Infinity

**Value: $3 of notional corpus-wide (1 of 52 receipts).** Do it for
correctness, not for recovered bps. Lowest priority.

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
