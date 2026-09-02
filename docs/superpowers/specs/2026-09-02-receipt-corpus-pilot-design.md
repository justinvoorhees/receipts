# Spec: receipt corpus pilot — phased threshold

**Status:** drafted, needs review · **Date:** 2026-09-02 · **Repo at:** `177f682`

The first dataset regime for turning single-trade receipts into a measured corpus. Scope is a **pilot**: ~1,900 decodes, one week of collector uptime, and a counterfactual layer. Its job is to *replace assumptions with measurements*, not to produce a publishable ranking.

Companion reading: `docs/mainnet-expansion-feasibility.md` (chain coupling), `docs/decision-large-trade-scarcity.md` (the June frame this supersedes in scope).

---

## What this pilot must answer

Five questions, each currently an assumption something downstream rests on.

| # | Question | Today |
|---|---|---|
| 1 | What is the **all-pairs** ≥$X rate on Base? | Unmeasured. The quoted 1.57% is USDC↔WETH-scoped. |
| 2 | **Where does the cost signal die** as notional falls? | One June sentence: "below $100 the bps are garbage (±9,000)". Predates the depth floor and notional gating. |
| 3 | What is **σ of the paired counterfactual delta**? | Unmeasured. Swings required corpus size by ~16×. |
| 4 | What is the **decode failure taxonomy** on an unfiltered population? | Only known for the 62 curated cases. |
| 5 | Does the Stage 1 screen **agree with the real notional**? | The screen does not exist yet. |

### Explicit non-goals

- Not a provider ranking. n is sized to *detect whether ranking is feasible*, not to publish one.
- Not mainnet. Base only; nothing here should assume one chain, but nothing here ports it either.
- Not a persistent corpus. Output is hashes plus a decoded snapshot in its own file, per the `cases.json` discipline.

---

## Part 0 — prerequisites

### ⚠️ Decode serially. This is load-bearing.

`transient-rpc-silently-degrades-receipts` is open and in `main`: concurrent decodes of the same transaction produce different receipts with no flag (`allInCostBps` 101 → 5012; leg type `aerodrome_cl` → `univ3`). It is stable when serial.

At ~1,900 decodes × 3.4s that is **~108 minutes**. Run it serially and the determinism bug cannot touch this pilot. **Do not parallelise to save an hour.**

⭐ This means the pilot does **not** block on the determinism fix. That fix becomes mandatory at 10k+, not here.

### Determinism baseline (run first, ~20 min)

Before anything else, establish the corruption rate on known ground:

```
node scripts/analysis/decodeGolden.mjs capture /tmp/a.json --concurrency=4
node scripts/analysis/decodeGolden.mjs capture /tmp/b.json --concurrency=4
node scripts/analysis/decodeGolden.mjs diff /tmp/a.json /tmp/b.json
```

Record the diff count. It is the number that justifies the serial rule above, and the baseline any future fix is measured against.

---

## Part A — frame builder

Enumerate candidate transactions per aggregator over a block range.

### ⚠️ Identity resolution must mirror `resolveAggregator`, not a router address list

June's discovery reported **0x at zero router calls, "inactive at registered Base address."** That is an artifact of the method. `resolveAggregator` resolves 0x through the **0x Deployer registry — 57 settler addresses** in `configs/settlers.json` — not through a single router entry. A frame keyed on one address finds zero no matter how active 0x is.

The frame builder must therefore enumerate, per aggregator:

- every active entry in `configs/routers.json` with `detection: 'to_address'`, **and**
- for 0x, all 57 addresses in `configs/settlers.json`

⚠️ Routers flagged `detection: 'solver_eoa'` are not `to`-matchable and are out of frame. Record them as a known exclusion rather than silently omitting them.

**"0x is dead on Base" is untested and must be re-measured here.**

### Output

One row per candidate: `{ hash, blockNumber, aggregator, matchedAddress, tier }`. Hashes only — no decoded columns, per the `cases.json` rule.

---

## Part B — Stage 1 screen

The component that makes everything else affordable, and the reason the pilot is an afternoon rather than a fortnight.

### Design

Per candidate, **one `eth_getTransactionReceipt`** — no trace, no pricing:

1. Decode Transfer logs from the receipt.
2. Compute the sender's approximate signed net flow per token.
3. If either side is a known anchor (USDC, USDbC, DAI, WETH, native ETH), size the trade against a per-block ETH/USD price **cached once per block**.
4. Emit `{ hash, aggregator, sizeUsd, sizeBucket, anchorSide }` — or `sizeUsd: null` with `reason: 'no_anchor'`.

**~1–2 RPC calls per candidate** versus ~130 for a full decode.

### Three buckets, not two

| Bucket | Meaning |
|---|---|
| `sized` | An anchor was present; `sizeUsd` is populated |
| `no_anchor` | Neither side is an anchor — **unmeasured, NOT small** |
| `unreadable` | Receipt fetch or log decode failed — transport, not evidence |

⚠️⚠️ **`no_anchor` must never be filed with the dust.** A memecoin↔memecoin trade has no anchor on either side, and filing it as "small" silently excludes the entire long-tail-token population. Under June's USDC↔WETH scoping this bucket did not exist; under all-pairs it may be large. Its size is finding #1b.

### Screen conservatively

Emit at **≥$5**, well below any threshold under consideration. A trade the screen wrongly drops is invisible bias; one it wrongly keeps costs a single decode.

---

## Part C — collection windows

One week of collector uptime, with per-tier sampling rules. Tiering is required because **equal n is not achievable at equal window**: at 4×6h, four of eight aggregators cannot supply 100 trades at any threshold ≥$100.

| Tier | Aggregators | Window | Rationale |
|---|---|---|---|
| A | Velora, KyberSwap, Relay | 4 × 6h slices | ~52k candidates; ample at any threshold |
| B | 1inch, Fabric, Odos, 0x | full week, continuous | ~26k candidates; needs the whole week |
| C | Nordstern | full week, take everything | ~1,034 calls/week — **expect < 100 and report the real n** |

⚠️ **Record `sampling_fraction` per stratum as a column.** Unequal-probability sampling is valid; forgetting the probabilities is not — that is precisely how June's extrapolation went wrong (an equal-allocation pilot multiplied by a pooled rate).

⚠️ **Do not lower the threshold per-router to make the numbers work.** That compares different trade populations and invalidates every cross-router claim. Widen the window instead.

⭐ Nordstern coming in under 100 is a **finding, not a failure**. "Insufficient population to rank" is a legitimate result and matches June's conclusion.

### The 6h slices must be drawn as several short windows

Not one 24h block. A day shares a volatility regime, a gas regime, a live-pool set, possibly one whale — cluster sampling with a design effect plausibly 2–5×. Four randomly-placed 6h windows over the week carry substantially more independent information at identical volume, and spread time-of-day rather than confounding it.

Draw the slice offsets from a **recorded seed** so the selection is reproducible.

---

## Part D — the phased threshold

The core of this spec. The threshold is a **finding, not an input**.

### ⛔ Why not just pick ≥$1k

Two forces pull opposite ways and do not cancel:

- **Population.** At ≥$1k the tiering above is mandatory and Odos/Fabric/1inch are marginal. At ≥$100 seven of eight clear 100 in the plain slice design.
- **Precision.** At a fixed decode budget you draw the *same 100* either way — so a lower threshold buys a noisier population, not more samples. Required n scales with σ², and June observed ±9,000 bps below $100 (mostly notional normalization: per-leg `lpFeeBps` and `priceImpactBps` divide by whole-trade notional).

Lowering therefore **helps exactly the routers that are population-capped and hurts the ones that are not**. Where the crossover sits depends on σ per band, which nobody has measured — and the ±9,000 observation predates both the depth floor and notional gating.

⭐ The paired counterfactual may absorb much of that variance, since pair, size and block are held constant. σ_d could grow far more slowly than σ. That would make low thresholds substantially more viable. Unknown; Phase 2 measures it.

### Phase 1 — retrospective calibration (~400 decodes, run now)

Runs against a **past** week. No counterfactual (see Part E for why).

- Screen **4 × 6h slices in a past week** per Part B — same slice design as Part C, different seed, so Phase 1's histogram is directly comparable to Phase 2's population (~53k candidates).
- Draw **100 decodes per size band**, aggregator pooled (aggregator recorded, not stratified):

  | Band | |
  |---|---|
  | `< $10` | 100 |
  | `$10 – $100` | 100 |
  | `$100 – $1k` | 100 |
  | `≥ $1k` | 100 |

**Produces:** σ of `allInCostBps` per band · the all-pairs size histogram (question 1) · the `no_anchor` fraction · the decode failure taxonomy (question 4) · screen-vs-notional agreement (question 5) · a **provisional** threshold.

⚠️ Oversample deliberately in **$50–$200** for the agreement study — misclassification only matters near whichever line gets drawn.

### Phase 2 — prospective collection (~1,500 quotes, one week elapsed)

Collect **wide, select narrow.** Quoting is cheap; committing to a threshold before the data is not.

Two quotas run simultaneously against the live collector:

| Quota | Rule | n |
|---|---|---|
| **Calibration** | 300 per size band, aggregator-agnostic, reservoir-sampled | ~1,200 |
| **Comparison** | 100 per aggregator at the Phase 1 provisional threshold, per-tier windows | ~800 |

Quotas overlap where bands align; expect **~1,500 distinct** transactions.

**Produces:** σ_d per band (question 3) — the number that sets corpus size for every future provider comparison.

### Phase 3 — selection and analysis

Choose the final threshold **T** on the σ_d curve, then select 100/aggregator at T from what Phase 2 already collected. No further collection.

⚠️ If **T lands *above* the provisional threshold**, the Comparison quota may hold fewer than 100/aggregator at T — the thin routers first. Report the shortfall as an n, do not backfill by relaxing T for those routers (Part C's rule). If T lands *below* it, every aggregator gains rows and nothing is needed.

⭐ Prior, stated so it can be falsified: **T lands at ≥$100** — enough population to make the design simple, not so noisy that n=100 stops working. If the σ_d curve disagrees, the curve wins.

---

## Part E — counterfactual layer

### ⚠️⚠️ It cannot be built retrospectively

spanDEX queries 0x, LiFi, Fabric, KyberSwap, Relay, Nordstern and Velora over their **live HTTP APIs**. Per its docs: *"no block number or historical parameters exist for archival queries."* The `eth_simulateV1` validation step could be block-pinned, but the provider's **route choice** at a past moment is unrecoverable.

**Decodes are retrospective. Counterfactuals are not.** Pairing a past trade with a present quote measures elapsed market drift. Hence the Phase 1 / Phase 2 split — Phase 1 is retrospective and quote-free by necessity, not by preference.

### Benchmark rule: leave-one-out

Provider P's counterfactual is **best-of-{all providers except P}**. No provider is benchmarked against itself, Fabric receives no special treatment in either direction, and the rule states in one line.

The conflict-of-interest answer is not the tool's authorship — it is that **spanDEX is open source and this corpus is hash-addressed**. Publish the hashes, the pinned spanDEX version and the config, and anyone can re-derive the numbers.

⚠️ Disclose two asymmetries rather than fixing them: spanDEX covers six of the eight framed aggregators — **1inch and Odos are absent**, LiFi is added — so those two can be *rated* from on-chain data but cannot contribute to a benchmark. And leave-one-out is best-of-5 for spanDEX-covered providers versus best-of-6 for the rest; record the benchmark composition per comparison.

### ⚠️ Five biases that will otherwise manufacture a finding

A naive counterfactual concludes "every real execution underperformed." That is an artifact — each of these pushes the same direction:

1. **Gas.** A 4-hop route can win on output and lose on total cost. Compare **net of gas**, estimated for the counterfactual route via `quote.simulation.gasUsed`, not just observed for the real one. Below ~$100 the inter-route gas difference is comparable to the routing difference being measured.
2. **Lookahead.** The counterfactual picks a route knowing the block's state; the trader did not. Simulate against **N−1**.
3. **Own footprint.** Simulate the counterfactual *executing*, with its impact applied — not quoting a mid. Otherwise it dodges a cost the real trade paid, and the bias scales with size.
4. **RFQ and private flow.** An AMM simulation routinely beats a firm RFQ quote on paper while being unexecutable at that size. Will systematically defame RFQ-heavy routers unless handled deliberately.
5. **Simulator venue coverage.** Misses the best route exactly when an unindexed venue was best.

### ⚠️ Failed quotes return `null`, they do not throw

Coverage failures will be **silent** unless counted explicitly — the same "absent ≠ measured" class of defect that has bitten this codebase repeatedly (`zero-fee-vs-unresolved-fee`, `v4-poolkey-reader-swallows-errors`). Every `null` gets a row and a reason.

### Quote latency

Quote within **~10–30s** of the trade landing (5–15 Base blocks). Record `quote_lag_blocks` per observation — drift is a measurable bias term, not a negligible one.

---

## Part F — what gets recorded

### Storage discipline

Follow `docs/qa/cases.json`: **the selection is hashes only.** Decoded output goes to its own generated file, never mixed in as columns — that is exactly what `corpus.json` did before it was deleted.

The selection must be a **deterministic recipe**: block range + filter + seed. Then 10k→100k is "same recipe, wider window," and a repopulation after a pricing change re-decodes the *identical* set rather than a new one you cannot compare against.

### Per-observation columns

| Column | Why |
|---|---|
| `hash`, `chainId`, `blockNumber` | Immutable |
| `aggregator`, `matchedAddress`, `resolutionTier` | Identity, and *how* it was resolved |
| `window_id`, `slice_offset`, `seed` | Reproducibility |
| `stratum`, `sampling_fraction` | **Reweighting to population.** Omitting this is the June error. |
| `sizeBucket`, `screen_sizeUsd`, `anchor_side` | Screen output |
| `decode_status`, `failure_reason` | See below |
| `spandex_version`, `quote_lag_blocks`, `benchmark_composition` | Counterfactual provenance |
| `quote_status`, `quote_null_reason` | Silent-failure guard |

### ⚠️⚠️ Record every failure, not just every success

Bucket by `FailureReason`. The decoder's admission rule — `extractEndpoints` demands a clean 1-in/1-out net flow — rejects exactly the interesting shapes: batch settlements, cross-chain legs, complex routes. A corpus of successes with no record of failures makes Base look far more decodable than it is, and the bias runs one direction.

**The denominator is the finding.** `unpricedCauses.mjs` and `coverageEstimate.mjs` already do this at corpus scale; follow their shape.

---

## Part G — validation gates

Three, each with a defined failure action.

| Gate | Method | On failure |
|---|---|---|
| **Determinism** | Part 0 golden diff | Serial-only rule stands; record the rate |
| **Screen agreement** | Phase 1's ~300 paired screen-vs-decode observations, oversampled near the line | Widen the conservative margin below $5 |
| **Counterfactual reproduction** | Ask the simulator to reproduce **the route the trade actually took**; compare to observed output | Exclude the observation and **count it** |

⭐ The third gate is the A/A control before the A/B — the pattern `rpcProviderAB.mjs --control` already establishes in this repo. If the simulator cannot reproduce a path where the answer is known, its counterfactual on a different path is not evidence.

---

## Cost

| Stage | Volume | RPC / API | Wall-clock |
|---|---|---|---|
| Determinism baseline | 62 × 2 | ~16k | ~20 min |
| Frame builder | ~132k candidates | block scan | hours |
| Stage 1 screen (both phases) | ~132k | ~200k | hours |
| Phase 1 decodes | 400 | ~52k | ~23 min serial |
| Phase 2 decodes | ~1,500 | ~195k | ~85 min serial |
| Counterfactual quotes | ~1,500 | ~9k API (~6/min) | spread over the week |

**Total ≈ 460k RPC calls, ~2 hours of serial compute, gated on one week of elapsed collection.**

⚠️ Wall-clock, not compute, is the binding constraint. **Do not sit idle** — run Phase 1 retrospectively while the Phase 2 collector accrues in parallel.

---

## Open decisions

1. **Which week for Phase 1's retrospective screen?** Recent enough to be representative, old enough to be fully settled. Deep archive costs more.
2. **Does the collector need block-scanning infrastructure, or does polling recent blocks suffice?** June's discovery ran through Blockscout (Etherscan v2 dropped Base free tier); a live collector may not need it at all.
3. **Provider API plans.** ~6 quotes/min is inside most basic tiers, but each of the six needs credentials (0x API key, KyberSwap client ID, Fabric app ID, etc.).
4. **Dashboard scope** — deliberately TBD. One requirement regardless: it must surface the **denominator and coverage**, not only the successful rows.

## What this pilot does not answer

- Whether Base can support a *published* provider ranking. It measures feasibility; June's answer was "not at ≥$10k" and this may confirm it at lower thresholds.
- Anything about mainnet. See `docs/mainnet-expansion-feasibility.md`.
- Whether `slippageBps` becomes a real measurement rather than a plug. The counterfactual is the mechanism, but this pilot only sizes it.
