# Cost Model v2 — Spec

> **STATUS — v2.0 SHIPPED (2026-06-18).** The pool-centric, single-hop, trader-ID
> approach below (§0.5, §1) was **superseded** during implementation: the data
> showed the 0.05% pool is mostly a routing *hop*, not a venue, so per-leg
> attribution never described the user's real trade. We pivoted to a **trade-centric,
> router-centric** model — see **§A: As-Built (v2.0)** immediately below. The cost
> *decomposition* (§2–§6: venue / slippage / agg-fee split, gas-in-USD, matrix axes)
> remains the **v2.1 target**; v2.0 ships only the top-line all-in cost that those
> components must sum to. Keep §2–§6 as the decomposition reference.

---

## A. As-Built (v2.0) — trade-centric, router-centric

**Goal shipped:** one trustworthy, spot-checkable number per trade —
`all_in_cost_bps = signedDeviation(direction, market_mid@N-1, realized_price)` —
using the trade's *true* endpoints (trader's net token deltas), not the pool leg.

**Pipeline (all reproducible):**
1. **Discovery** `discover-router-trades.ts` — every tx that called each aggregator
   router over a window, via **Blockscout** (free Etherscan-compatible API for Base;
   Etherscan v2 free tier does *not* cover Base, Routescan doesn't index it). 2-week
   window = 790,921 router calls across 10 routers.
2. **Extraction** `tradeEndpoints.ts` (`extractTradeEndpointsFromReceipt`) —
   **receipt-based** (all ERC-20 Transfers are in receipt logs; no `debug_trace`,
   far cheaper). Computes per-address net deltas, finds the **trader anchor** (the
   non-denylisted address whose only significant deltas are USDC + WETH, two-sided),
   prices vs the deepest USDC/WETH pool mid at N-1 (`referencePrice.ts`).
   Denylist = routers + CoW `GPv2Settlement` + 4337 EntryPoint + the four USDC/WETH
   pools + token contracts. (The denylist + trader-anchor heuristic is refined by
   the selection gate in **§C**, which supersedes it for v2.1.)
3. **Genuine-trade filter** — keep iff the trader's true endpoints are USDC↔WETH,
   **or** USDC↔native-ETH (the aggregator (un)wraps WETH; the ETH leg is valued from
   the net `Withdrawal−Deposit` `wad`, logs-only). Drop routing-hops (third token),
   ambiguous (multi-anchor batch/split/MM), dust.
4. **Harvest** `extract-router-trades.ts` — per-aggregator random sample (seeded),
   `$1k` notional floor (applied pre-pricing to save CU), `±100 bps` sanity gate
   (rejects ETH wrap-net artifacts; empirically no exact-WETH trade exceeds it).

**Decisions (engineer, 2026-06-18):** stay on **Base**; **≥$1k** notional floor
($10k is empirically dead on Base — see §A findings); **include USDC↔ETH**;
**sample per aggregator** (not full-process the 790k needle-haystack).

**Key finding — large trades barely exist on Base.** Of router calls: ~32% are
genuine USDC↔WETH/ETH but overwhelmingly dust (median sizes $0–$256). Only ~0.11%
are ≥$10k (~900 in 2 weeks); ~1.6% are ≥$1k (~12k). Hence the $1k floor and the
"market structure, not a bug" conclusion (`docs/decision-large-trade-scarcity.md`).

**v2.0 dataset (4,000/agg sample, 2 weeks):** 371 clean trades ≥$1k
(314 WETH exact + 57 ETH proxy; 8 ETH artifacts auto-rejected). Loaded to the
`router_trades` table. Per-aggregator all-in cost (median / stdev bps):
Velora −0.27 / 4.83 · 1inch −1.81 / 5.61 · KyberSwap +0.63 / 4.64 ·
Relay −7.70 / 10.69 · Odos +1.34 / 11.02. Nordstern/Fabric dust-only (n<5).
Inter-aggregator spread is fine-grained (−7.7 to +1.3 bps) — matrix labels are
**relative to the cohort**, not absolute verdicts.

**v2.1 backlog (deferred):** (a) trace-based native-ETH attribution to replace the
wrap-net proxy and recover the 8 rejects; (b) the §2–§6 decomposition (venue /
slippage / agg-fee, gas-in-USD) so the all-in number splits into line items;
(c) wire the dashboard matrix (median X / stdev Y) to `router_trades`;
(d) expand sample for tighter stats on thin aggregators.

**Reference scripts:** `orient-transfers.ts`, `prove-aggfee.ts`,
`spotcheck-outlier.ts`, `diagnose-drops.ts` (drop-class + ETH diagnostic).

---

## B. v2.1 Decomposition — Validation Spike (as-proven)

> **STATUS — SPIKE COMPLETE (2026-06-19).** The method below was implemented in
> `decompose-trade.ts` + `validate-decomposition.ts` and hand-validated against 7
> curated transactions spanning 5 aggregators (1inch, Odos, Velora, Fabric,
> KyberSwap, Relay). It refines §2–§6 in several places; those sections remain
> the conceptual reference but the spike is the proven implementation.

**Goal:** split the v2.0 top-line `all_in_cost_bps` into independently correct
line items — LP fee, aggregator fee, slippage (or execution) — plus gas tracked
separately. Prove the method on a small, venue-diverse handful before scaling
into the pipeline or touching the dashboard.

### Data source

`debug_traceTransaction` (callTracer, `withLog: true`). The receipt alone is
insufficient because agg-fee detection requires native-ETH `value` flows and call
structure. The spike reuses `tradeEndpoints.ts` decoders (`decodeTransferLogs`,
`collectNativeEthDeltas`, the `DENYLIST`, `USDC`, `WETH` constants) to build
per-address, per-token net deltas across ALL tokens, plus V3/V4 Swap events. WETH
wrap/unwrap events (`Withdrawal` / `Deposit` on the WETH contract) are tracked to
adjust per-address WETH balances so that intermediaries that unwrap WETH do not
appear to "retain" it.

### Invariants

- **PURE routes** (no third token through the hub):
  `all_in_cost_bps = lp_fee_bps + agg_fee_bps + slippage_bps`.
- **IMPURE routes** (third token transits the hub):
  `all_in_cost_bps = agg_fee_bps + execution_bps`.
- **Gas** tracked separately in both cases: `gas_cost_usd` (from receipt),
  `gas_bps = gas_cost_usd / notional_usdc × 10,000`.

### Pipeline (as implemented)

1. **Value-flow graph.** Collect every ERC-20 Transfer (USDC, WETH), every
   V3/V4 `Swap` event, V2/Aerodrome `Swap`/`Sync` events, WETH wrap/unwrap
   events, and per-address native-ETH deltas from the trace. Build a
   `Map<address, { usdc, weth, nativeEth }>` of net deltas.

2. **Classify addresses.**
   - **Trader** = the clean USDC↔WETH anchor from `extractTradeEndpointsFromReceipt`.
   - **Venues** = anything that emits a V3 `Swap`, V2/Aerodrome `Swap`/`Sync`,
     the Uniswap V4 PoolManager singleton (`0x498581ff…`), or responds to `fee()`
     (V3) / `getReserves()` (V2) view calls. The V4 PoolManager nets a balance
     that is pool liquidity, NOT a fee — must be classified as a venue.
   - **Fee sinks** = see step 3.
   - **Unclassified retained-balance addresses** with > 10% of notional are
     classified as counterparties (RFQ venues / solvers), not fee sinks.

3. **Aggregator fee (≥ 0) — all-token rule.**
   A fee sink is a non-trader, non-venue address whose ENTIRE net position is
   USDC/WETH-only (no nonzero third-token delta) — plus a curated per-aggregator
   fee-vault map:
   - Velora: `0x00700052c0608f670705380a4900e0a8080010cc`
   - Relay: `0xf70da97812cb96acdf810712aa562db8dfa3dbef`

   **Critical fix (refines §2–§3):** an address that receives USDC but pays out a
   third token (e.g. Odos `0xe093…`: +317.89 USDC / −318.25 USDT) is a
   **stableswap venue** netting ≈ 0, NOT a fee — the all-token gate excludes it.
   Before this fix it was mis-counted as 125 bps. The third-token gate is the key
   insight that separates fee sinks from venues without requiring per-aggregator
   whitelists for every venue address.

   `agg_fee_bps = Σ retained_value_at_fee_sinks / notional_usdc × 10,000`.

4. **Route-purity gate (hub-based) — refines §2 single-hop restriction.**
   Identify the trade hub = the `DENYLIST` aggregator router with gross USDC/WETH
   flow in the tx. A third token makes the route **IMPURE** only if it passes
   through the hub (the hub transiently holds it — e.g. Fabric router
   `0x7c137a37…` holds CLAWD on a WETH→CLAWD→USDC route). Third tokens that stay
   internal to venues which deliver WETH back to the hub (Odos USDT/cbBTC, Velora
   cbBTC, KyberSwap EURC) keep the route **PURE**. A third token only seen among
   peripheral RFQ-filler addresses (1inch ROBA) is a co-settled batch leg, NOT
   impure.

   This replaces the v2.0 "single-hop only" filter (§1 edge cases) with a more
   nuanced gate that keeps multi-venue routes that are functionally USDC↔WETH.

5. **LP fee (PURE routes only) — refines §2.**
   Notional-weighted per-venue fee tiers:
   - **V3:** `fee()` view call at the trade block (dynamic-fee pools like
     KyberSwap/Algebra return the fee at execution time, not a static tier).
     Known static pools use a hardcoded map to save RPC calls.
   - **V4:** pool fee from a known-map (`usdc_weth_v4_default` = 5 bps).
   - **V2/Aerodrome:** factory defaults (not yet exercised in the handful).
   - **RFQ gap:** if total pool-hop notional < trade notional, the difference
     is an RFQ fill with 0 LP fee, diluting the weighted average correctly.
   - Denominator = `max(total_hop_notional, trade_notional)` to handle sequential
     hops (where the same notional flows through multiple pools) without
     double-counting.
   - **IMPURE routes ⇒ LP fee = n/a** (the fee is inseparable from execution).

6. **Slippage (PURE routes only) — refines §3.**
   `slippage_bps = all_in_cost_bps − lp_fee_bps − agg_fee_bps`. Signed residual:
   **negative is valid** — venues beating the reference mid (RFQ tighter than
   pool `slot0`, or a stale single-pool reference). Never clamp or abs().
   IMPURE routes ⇒ slippage = n/a.

7. **Execution (IMPURE routes only).**
   `execution_bps = all_in_cost_bps − agg_fee_bps`. Honest combined LP + price
   impact bucket when the route structure prevents separating them.

8. **Gas.** `gas_cost_usd` from receipt; `gas_bps = gas_cost_usd / notional_usdc ×
   10,000`. Not part of the bps invariant (consistent with §4).

### Corrected handful results (7 curated txns)

| # | Agg | Route | LP (bps) | Agg (bps) | Slippage (bps) | Exec (bps) | Gas (bps) | all-in (bps) |
|---|-----|-------|----------|-----------|----------------|------------|-----------|--------------|
| 1 | 1inch | PURE | 0.00 | 0.00 | −18.52 | — | 0.03 | −18.52 |
| 2 | Odos | PURE | 0.05 | 0.00 | 46.75 | — | 0.02 | 46.81 |
| 3 | Velora | PURE | 12.75 | 13.71 | 3.94 | — | 1.19 | 30.41 |
| 4 | Fabric | IMPURE | n/a | 0.00 | n/a | 0.02 | 0.05 | 0.02 |
| 5 | KyberSwap | PURE | 5.15 | 0.00 | −18.75 | — | 0.01 | −13.59 |
| 6 | Relay | PURE | 0.40 | 41.00 | 1.07 | — | 0.06 | 42.47 |
| 7 | 1inch | PURE | 0.11 | 0.00 | 0.13 | — | 0.06 | 0.25 |

All 7 reconcile: `LP + Agg + Slippage = all_in` (PURE) or `Agg + Exec = all_in`
(IMPURE), each within 0.01 bps rounding tolerance. Gas tracked alongside.

### Open items / caveats (honest assessment)

(a) **KyberSwap #5 trader mis-identification.** The trader is sometimes
    mis-identified as the pool itself — a selection/extraction issue in the
    upstream `extractTradeEndpointsFromReceipt`, not a decomposition bug. The
    decomposition itself is correct given the right trader anchor.

(b) **Velora agg fee dust — FIXED.** A dust floor = max($1.00, 1 bps of notional)
    is now applied to structural retained-balance detection; the `0x6652` $0.77
    routing dust is excluded from agg fee and surfaced as a NEEDS REVIEW flag.
    Corrected Velora agg fee: 13.71 bps (was 14.31); slippage absorbs the
    difference: 3.94 bps (was 3.34). LP, gas, and all-in unchanged.

(c) **Sequential-vs-parallel hop LP precision.** The notional-weighted LP fee is
    an approximation. Sequential hops (same notional through multiple pools) use
    `max(total_hop_notional, trade_notional)` as denominator, which is correct for
    the common case but may slightly over- or under-weight in complex topologies.

(d) **Fee-vault map is curated/incremental.** Only Velora and Relay fee vaults are
    confirmed so far. New aggregators or vault rotations require manual addition.
    The `NEEDS REVIEW` flag catches unclassified retained balances for triage.

(e) **Hand-validation against Basescan is the gate.** The handful must be
    confirmed against on-chain data (see `docs/decomposition-handful-validation.md`)
    BEFORE scaling into the pipeline or `router_trades`.

### Implementation files

- `packages/ingest/src/decompose-trade.ts` — pure decomposition library.
  `decomposeTrade({ trace, trade }) → { lpFeeBps, aggFeeBps, slippageBps,
  executionBps, gasBps, hops[], feeSinks[], flags[] }`. Only I/O: V3/V4 `fee()`
  view calls for unknown pool tiers. No DB writes.
- `packages/ingest/src/validate-decomposition.ts` — runs the 7 hashes, pulls
  each trade's row from `router_trades` for the anchors, fetches the trace, calls
  `decomposeTrade`, prints per-txn results + reconciliation. Read-only.
- Reuses `tradeEndpoints.ts` (decoders, denylist, constants).

---

## C. Selection Gate — Genuine User Trades (v2.1 refinement)

> **STATUS — INVESTIGATION COMPLETE (2026-06-22).** A trader-type audit of the
> 459 loaded `router_trades` rows revealed that ~82% have an INTERMEDIARY as the
> recorded "trader," not an end user. This section documents the selection gate
> that refines and supersedes the §A denylist + trader-anchor heuristic. The §B
> decomposition method is INDEPENDENT of this gate and unaffected — it computes
> LP/agg/slippage correctly on whatever passes selection; this gate only decides
> which transactions are admitted as trades.

### The problem

A trader-type audit of the 459 loaded `router_trades` rows, broken down by
distinct trader address:

| Category | Rows | % | Description |
|---|---|---|---|
| EOA traders | 83 | 18% | Plausible end users |
| AMM pools / settlement contracts | ~89 | ~19% | Pure artifacts — the recorded "trade" is actually a pool hop (realized price = the pool's swap rate, not a user's cost) |
| Opaque MM / filler / solver contracts | ~287 | ~63% | Clean USDC↔WETH swaps executed by professional intermediaries, not users |

One address `0x770004fe4411e42ea51a7fcaca32b267d791f3d4` is the "trader" in 196
rows (43% of the dataset), across KyberSwap, Odos, Relay AND Velora, never the
tx sender — a shared filler/solver. The 1inch RFQ resolver
`0x03c01acae3d0173a93d819efdc832c7c4f153b06` accounts for 24 more.

### Root cause

The §A extractor anchors on "non-denylisted address whose net deltas are exactly
{USDC, WETH}." In an aggregator fill, BOTH user and filler/pool have clean
two-sided {USDC, WETH} net positions (mirror images). When the user's output
settles in native ETH or the user is a cross-chain/bridge recipient (common for
Relay), the only clean ERC-20 {USDC, WETH} anchor left is the filler/pool, so
it is mislabeled as the trader. Pools and fillers are unbounded and unlabeled —
a hardcoded denylist can't keep up. This recurs the v1 "anchor latches onto an
intermediary" failure.

### The selection gate (the rule)

IN-SCOPE trade = exactly one account — the "swapper" — that SENDS the input
token and RECEIVES the output token, where the pair is USDC↔WETH or USDC↔ETH.
In transfer logs: `[swapper] → [route address]` for the input, possibly many
hops, then `[route address] → [swapper]` for the output. The recorded trader
MUST be that swapper.

The swapper may be an EOA OR a smart-contract wallet (e.g. a Basenamed Coinbase
Smart Wallet / Safe) — "has bytecode" is NOT disqualifying.

**REJECT when:**
- **(a)** the swapper's pair includes a third token or isn't USDC↔WETH/ETH
  (e.g. an EURC→WETH trade routed through a USDC/WETH pool);
- **(b)** no user-side swapper exists and only a pool/filler/MM performs the
  USDC↔WETH round-trip;
- **(c)** the trade is SPLIT-RECIPIENT — input paid by one address, output
  delivered to a different address (per the §3 Velora case in the validation
  table below).

**Two refinements the Velora case forced:**
1. The swapper's input leg must be a VISIBLE transfer from the swapper, not
   inferred via the wrap-net proxy.
2. Native-ETH-funded trades carry the input leg in INTERNAL txns (native-ETH
   `value` flows), so the gate must read those, not just ERC-20 logs.

### Implementation direction (extractor fix, for the scaling phase — NOT yet built)

1. **Exclude pools structurally, no hardcoded list:** drop any trader candidate
   that emits a Swap event (Uniswap V3/V4, V2, Aerodrome topics), exposes
   `token0()/token1()`, or has a pool/LP-token `symbol()` (e.g. `wethusdc`,
   `crvWusdc`, `cETHUSDC`, `CLOB-ORDER`).
2. **Identify the swapper** as the round-trip account funded from OUTSIDE the
   route — typically the tx sender or its AA wallet — that VISIBLY sends the
   input and receives the output; require its net pair be exactly USDC↔WETH/ETH
   with no third-token leg. Read native-ETH `value` flows for ETH-settled legs.
3. **Treat filler/MM/RFQ-resolver counterparties as the counterparty**, not the
   trader; drop rows where no user swapper is identifiable; re-anchor where a
   real user sits behind a fill (see validation txn #7 below).
4. **Do NOT exclude on "has bytecode" alone** — smart-wallet users must pass.
   Reject split-recipient trades for the MVP (require same account on both legs;
   revisit with address-linking later).

### Validation evidence (7-txn handful under the gate)

| # | Aggregator | Swapper round-trip | Verdict |
|---|---|---|---|
| 2 | Odos | `0x65da09…` (tx.from EOA): −25,400 USDC → +15.03 ETH | VALID (user buy) |
| 6 | Relay | `kurt42183.base.eth` (`0x1dbe67c11c`, tx.from, smart wallet): −1,320 USDC → +0.79 ETH | VALID (user buy) |
| 7 | 1inch | `0xa3a9be…` (tx.from EOA): −1,565 USDC → +0.90 WETH — DB had recorded the 1inch RFQ resolver as trader | VALID (re-anchored to real user) |
| 1 | 1inch | Only the RFQ resolver MM `0x03c01a…` round-trips (receives USDC / sends WETH = maker side); tx.from deals in ROBA | REJECT (no user swapper) |
| 4 | Fabric | Only the UniswapX filler `0x72ab38…` round-trips (maker side); tx.from deals in CLAWD | REJECT (filler, no user) |
| 5 | KyberSwap | Recorded trader is a USDC/WETH pool `0x3fe04a…`; real user `chanth.base.eth` is an EURC→WETH swap | REJECT (wrong pair) |
| 3 | Velora | SPLIT-LEG: tx.from `0xd0d08887` pays 7.996 native ETH to the Velora router `0x6a000f20…`, which delivers 12,830 USDC to a DIFFERENT address `0xd5283cab…` (the recorded "trader"). The recorded trader only RECEIVES USDC and sends nothing — its sell leg was never on-chain there; it was anchored via the wrap-net proxy. No single-account round-trip. | REJECT (split-recipient) |

Under the gate: **VALID = #2, #6, #7** (3); **REJECT = #1, #4, #5, #3** (4).

### Scope impact

Under the strict gate the current 459-row dataset shrinks substantially — most
of the ~82% intermediary rows fall out, minus those re-anchorable to a real user
behind the fill (like #7). A RE-EXTRACTION pass is required before scaling the
decomposition into the pipeline.

Critically: the §B decomposition method is INDEPENDENT of this gate and
unaffected — it computes LP/agg/slippage correctly on whatever passes selection;
this gate only decides which transactions are admitted as trades.

---

## Original handoff (pre-pivot — §0–§1 superseded by §A; §2–§6 = v2.1 target)

Scope: restructure per-trade cost line items, make aggregator fee a *measured*
number (not a residual), move gas out of the accuracy score, and audit/redesign
the trust matrix axes.

Dataset at handoff: 52 aggregator-attributed swaps, USDC/WETH 0.05% pool, $10k+,
Jun 4–18 2026. Pool: `0xd0b53D9277642d899DF5C87A3966A349A798F224`.

---

## 0. Headline finding from the data (read first — it reframes everything)

A re-decode of two "1inch" trades (see `packages/ingest/src/prove-aggfee.ts`,
runnable) showed our attribution is contaminated:

- The $131k "1inch sell" is actually a **CoW Protocol batch settlement**
  (`GPv2Settlement = 0x9008D19f58AAbD9eD0D60971565AA8510560ab41` is the hub of
  every transfer). `tx.from` is the **solver**, not the trader. The pool leg we
  ingested ($131k) is one of ~12 legs in a ~$5M multi-user batch. The 27 bps
  "aggregator fee" we recorded is a meaningless artifact of comparing a
  single-pool reference price against a batch we don't fully see.
- The $29k "1inch buy" routes through a 1inch router proxy; `tx.from`'s net
  WETH delta is 0 because the WETH lands in a different address. Again `tx.from`
  is **not cleanly the trader**.

**Implication:** the residual "agg fee" (current model) silently absorbs
attribution errors, multi-pool partials, and batch artifacts. We cannot trust
any per-trade decomposition until we (a) identify the real trader wallet and
(b) decide how to handle batch/multi-pool trades. This is item #1 below.

---

## 0.5 FIRST-STEP GATE — validate trader identification before building anything

**Do not implement §1–§7 until this gate passes.** Everything downstream sits on
top of correctly identifying the trader EOA and their net wallet delta, and that
logic has so far only been eyeballed against two transactions — both of which were
the *messy* cases (a CoW batch and a proxy-routed trade where `tx.from` ≠ trader).
Build the identification + net-delta logic first, in isolation, and prove it.

**Gate procedure:**
1. Implement only the trader-EOA identification (denylist + clean two-sided
   net-delta matching) and the batch / single-hop classifiers from §1.
2. Run it over **10–15 trades** sampled across aggregators (include at least one
   known CoW batch and a couple of multi-hop routes so the exclusions are
   exercised, not just the happy path). Extend `prove-aggfee.ts` or write a sibling.
3. For each trade, print: detected trader, `is_batch_settlement`, `is_single_hop`,
   trader USDC/WETH net delta, `P_pool`, `P_user`, and `aggFeeBps`.
4. **Pass criteria (manual review):**
   - Every CoW/batch tx is flagged `is_batch_settlement` (and would be excluded).
   - For every *kept* (single-hop, non-batch) trade, the detected trader is the
     real EOA — net delta is a clean two-sided swap (sent one token, received the
     other), not zero and not a router/settlement address.
   - `P_user` is within a few % of `P_pool` (sanity: the router spread is a fee,
     not a different order of magnitude). Flag and inspect any outlier.
5. Only after a human signs off on the sample do §2–§7 proceed.

If the gate reveals the heuristic mis-IDs traders on common patterns (smart-contract
wallets, 4337 bundlers, internal-router hops), fix the heuristic here — do not
paper over it downstream with another residual.

---

## 1. Aggregator fee — make it a measured number

### Definition
The aggregator fee is the **spread the router keeps between what the AMM(s) paid
out and what the trader's wallet actually received**, valued at spot. It bundles
explicit commission + retained positive slippage. It is concrete and on-chain.

### Prices (all USDC per WETH; positive bps = cost to the user)
| Symbol | Meaning | Source |
|---|---|---|
| `P_spot` | mid price, block N-1 | `slot0` (already have via `referencePrice`) |
| `P_quote` | simulated execution at N-1 state | QuoterV2 (already have via `simulatedPrice`) |
| `P_pool` | actual pool execution, block N | Swap event amounts (already have via `executedPrice`) |
| `P_user` | trader's effective price | **NEW: trader net wallet delta** |

### The decomposition telescopes spot → user
```
Total cost (accuracy) = (P_spot → P_user)
  = Venue fee   (P_spot  → P_quote)   = LP fee + price impact
  + Slippage    (P_quote → P_pool)    = pool drift / MEV / ordering (± surplus)
  + Aggregator  (P_pool  → P_user)    = router's retained spread   ← NEW, measured
```
Gas is **not** in this sum (see §4).

### Algorithm for `P_user` / aggregator fee
1. **Identify the trader EOA.** It is *not* reliably `tx.from`. Find the address
   with a clean two-sided net delta (sent token A, received token B) that is
   **not** a known router/settlement/solver/pool address. Maintain a denylist
   (CoW settlement, 1inch routers, Velora/Paraswap, KyberSwap, Odos, Relay,
   4337 EntryPoint `0x0000000071727De22E5E9d8BAf0edAc6f37da032`). The decoder
   already extracts all USDC/WETH transfers with `from`/`to`; sum per-address.
2. **Compute trader net delta** across USDC and WETH.
3. `P_user = |USDC delta| / |WETH delta|`.
4. `aggFeeBps = signedDeviation(direction, P_pool, P_user)` — and it should be
   ≥ 0 except where the router shares surplus back (then negative).
5. Persist `aggFeeUsd = aggFeeBps/10000 * notionalUsd` for the line-item display.

### Edge cases — decide explicitly
- **CoW / batch settlements** (`tx.from` is a solver, multiple traders bundled):
  the single-pool leg is partial and `P_pool` is not the trader's fill. **For v2,
  flag and EXCLUDE these** (add `is_batch_settlement boolean`); revisit later by
  parsing the GPv2 `Trade` event to recover the actual order. Do **not** let them
  into the matrix or summaries.
- **Multi-pool split routes:** the trader's net delta spans pools we didn't
  ingest, so `P_pool` (single leg) ≠ the trader's blended fill. Two options:
  (a) restrict the v2 dataset to **single-hop, single-pool** trades (detect:
  exactly one DEX Swap event in the trace), or (b) compute the agg fee against
  the **aggregate of all DEX outputs in the trace** rather than one leg.
  **Recommend (a) for v2** — simpler, defensible; document the filter.
- Validate: after implementing, re-run `prove-aggfee.ts`-style checks on ≥10
  trades and confirm `P_user` is sane (within a few % of `P_pool`).

---

## 2. Venue fees (price impact + LP fee)

Combine into one displayed line item "Venue fees", with the two sub-parts
available underneath:
- `lpFeeBps` = pool fee tier (500 → 5 bps). Already correct.
- `priceImpactBps` = `(P_spot → P_quote) − lpFeeBps`. This is the depth cost at
  trade size. We currently zero this out — **restore it** from the QuoterV2
  simulation (the v1 code computed `rawRefToSimBps - lpFeeBps`; bring that back).
- `venueFeeBps = lpFeeBps + priceImpactBps`.

---

## 3. Slippage (hidden cost / surplus)

`slippageBps = signedDeviation(direction, P_quote, P_pool)`. Positive = pool
moved against the trader between quote and execution; negative = **surplus**
(better fill than quoted). Keep the sign — surplus is real and is the "profit if
given back" case. This is `P_quote → P_pool`, distinct from v1 which compared
simulated → executed at the same node; the change is that executed is now
strictly the **pool** price, and `P_user` carries the router spread separately.

---

## 4. Gas

- Compute `gasCostUsd = gasUsed * effectiveGasPrice(base+priority) / 1e18 * ethUsd`.
  We already have this (`gasCostUsd`). `effectiveGasPrice` already includes
  base+priority on Base.
- **Display gas in USD, not bps.** Update the Trades table + any summary to show
  e.g. `$1.42`, formatted via the spot ETH/USDC used for the trade.
- **Remove gas from the accuracy score.** Accuracy = venue + slippage + agg fee
  only. Audit `tcaCalculator.ts`, `processSwap.ts`, and every dashboard query
  (`getAggregatorSummary`, `getCostByAggregator`, `TRADES_SORT_COLUMNS.accuracy`)
  to ensure `total_cost_bps` no longer includes gas. Keep `gasCostBps` in the DB
  if cheap, but it must not feed accuracy or the matrix.

### Resulting invariant (must hold, add a test)
```
total_cost_bps == venue_fee_bps + slippage_bps + agg_fee_bps   (± rounding)
gas shown separately in USD, excluded from the above
```

---

## 5. Accuracy framing

The dashboard's core statement is **"what the user got (execution) vs what they
could have gotten (spot)."** So:
- Accuracy / total cost = `P_spot → P_user` (the full chain, ex-gas).
- Positive = cost to user; negative = surplus over spot.
- This is the number the matrix consumes (§6) and the Trades "Accuracy" column.

---

## 6. Trust matrix — audit + redesign

### Current state (broken for the intended quadrants)
`packages/dashboard/lib/trustMatrix.ts` uses **X = stddev(cost)**,
**Y = P95(cost)**. These are **strongly correlated** (both driven by the same
tail), so an aggregator with large outliers scores high on *both* axes and lands
top-right. There is no way for a "volatile but otherwise fine" aggregator to land
top-left. The axes are not orthogonal → the four quadrants collapse to a diagonal.

### Intended quadrant semantics (from Justin)
The two axes are the two failure modes; the corners are their combinations.
X (center) high = **Overpriced** (consistent markup). Y (spread) high =
**Volatile** (large outliers). Both = **Untrustworthy**; neither = **Trustworthy**.

| | Low spread (not volatile) | High spread (volatile) |
|---|---|---|
| **Low center (fair price)** | bottom-left = **Trustworthy** | top-left = **Volatile** |
| **High center (overpriced)** | bottom-right = **Overpriced** | top-right = **Untrustworthy** |

### Required axis design — decorrelate center vs spread
- **X axis = central tendency** ("noise"): `median(totalCostBps)` (or trimmed
  mean). Captures a consistent small markup. High X = bottom/right shift.
- **Y axis = dispersion independent of center** ("volatility"): **use
  `stddev(totalCostBps)` for v2.** Rationale: at our sample sizes (per-aggregator
  n drops below ~20 once single-hop-filtered, with Kyber/Relay/Odos in single
  digits), `stddev` is the stable, sample-size-unbiased, glitch-robust choice.
  **Planned migration:** switch the Y stat to `P95(totalCostBps) − median` once
  every displayed aggregator has ≥30 single-hop trades — that's the purer
  "tail above typical" measure but a noisy estimator until then. `max − median`
  was rejected for the axis (one bad print dominates; biased by sample count) —
  may surface separately as a per-aggregator "worst case" stat.
- Both axes computed on the ex-gas total cost (§5), with batch settlements
  excluded (§1) and only single-hop trades included (§1).

Lower-left origin = best. Confirm the component's Y axis is oriented so "up =
worse" matches "high dispersion."

### Audit step (do this, don't just trust it)
Add a unit test with **four synthetic aggregators**, one engineered per quadrant:
1. Trustworthy: tight around 6 bps → bottom-left.
2. Overpriced: tight around 15 bps → bottom-right.
3. Volatile: mostly 6 bps with a few 40 bps spikes → top-left.
4. Untrustworthy: wide spread around 15 bps → top-right.
Assert each lands in its quadrant relative to the median split of the axes. This
is the concrete "verify the matrix works" the spec calls for.

---

## 7. File-level checklist

- `packages/ingest/src/decoder.ts` — add trader-EOA identification + net-delta
  helper; expose `traderAddress`, `traderUsdcDelta`, `traderWethDelta`. Add the
  router/settlement denylist. Detect single-hop (count DEX Swap events).
- `packages/ingest/src/tcaCalculator.ts` — agg fee = measured `P_pool → P_user`;
  restore price impact; total cost excludes gas; keep gas USD.
- `packages/ingest/src/processSwap.ts` — wire `P_user`; set `priceImpactBps`,
  `venueFeeBps`, `aggFeeBps`, `aggFeeUsd`, `is_batch_settlement`,
  `is_single_hop`. Stop zeroing price impact / execution quality.
- `packages/db` schema — add `agg_fee_usd`, `venue_fee_bps`, `is_batch_settlement`,
  `is_single_hop`, `trader_address`. Migration.
- `packages/dashboard/lib/queries.ts` — exclude batch settlements; accuracy
  excludes gas; surface gas USD + venue/slippage/agg line items.
- `packages/dashboard/lib/trustMatrix.ts` — new median / (P95−median) strategy.
- `packages/dashboard/components/TradesTable.tsx` — line items: Aggregator fee,
  Venue fees, Slippage, Gas ($), and Accuracy sum. Gas in USD.
- Tests: the cost-sum invariant (§4) + the four-quadrant matrix audit (§6).

## 8. Decisions (resolved 2026-06-18)
1. **Batch settlements (CoW): EXCLUDE for v2.** Flag `is_batch_settlement`;
   revisit GPv2 `Trade`-event parsing later.
2. **Restrict v2 to single-hop only.** Exactly one DEX Swap event in the trace.
3. **Y-axis dispersion: `stddev` for v2**, migrate to `P95 − median` once every
   displayed aggregator has ≥30 single-hop trades. `max − median` rejected for
   the axis.
4. **Bottom-right label: "Overpriced."** Quadrant labels: Trustworthy (BL),
   Volatile (TL), Overpriced (BR), Untrustworthy (TR). X high = overpriced,
   Y high = volatile, both = untrustworthy, neither = trustworthy.
