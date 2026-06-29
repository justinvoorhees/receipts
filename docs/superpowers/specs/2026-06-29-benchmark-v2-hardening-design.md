# Benchmark v2 Hardening

**Date:** 2026-06-29
**Branch:** `feat/cost-model-v2`
**Status:** Approved design — ready for implementation plan
**Predecessor:** `2026-06-26-robust-benchmark-oracle-validation-design.md` (+ its follow-ups doc)

## Problem

Three issues in the WETH/USDC benchmark + valuation path, all flowing through
`packages/ingest/src/benchmarkPrice.ts`:

1. **Pool-divergence flag is over-sensitive.** `poolDivergenceBps` is
   `(max − min)/median × 1e4` across **all** valid pools. The thin Uni V3 30bps
   WETH/USDC pool legitimately drifts up to ~its fee tier during low-activity
   windows (arbitrage only fires when profit exceeds fee cost), inflating the
   spread and tripping `> 15 bps → POOL_DIVERGENCE → low-confidence` **even though
   the median benchmark value already discards that outlier**. On the smoke set
   this downgraded exactly one trade (`0x12adf9d1`, 15.5 bps) whose benchmark was
   fine.

2. **Single-oracle manipulation check is fragile to Chainlink staleness.** We read
   `latestRoundData()` at N−1 and compare to the DEX median. But the Base ETH/USD
   feed can be up to its heartbeat interval stale. If ETH moves while the feed
   hasn't updated, `MANIPULATION_SUSPECT` fires on a clean trade — we'd be using a
   potentially ~60-min-old CEX price to validate a 12-second DEX price. There is
   also only one oracle, so a single bad oracle read has no backstop.

3. **WETH→USD valuation reference is not internally consistent.** Within a single
   trade, `allInCostBps` (numerator) is denominated against the benchmark
   `marketMid` (median-of-3), but `gasCostUsd` is computed as
   `gasCostEth × realizedPrice` — the trade's **own execution price**. So a
   cost-decomposition expressed in basis points mixes two different WETH/USD
   references. The gap is widest exactly during high-volatility events, where
   `realizedPrice` diverges most from the true mid and where execution-quality
   measurement matters most.

   Note (scope-shaping discovery): the previously-suspected culprit
   `getTokenUsdcValue` / single-pool `getPairMidAtBlock(WETH, USDC)` in
   `tokenPricing.ts` has **zero production callers** — it is latent, not live. The
   live asymmetry is the `realizedPrice` gas valuation above. Per-leg
   `getLegMidAtBlock` correctly reads each leg's **own** pool for price-impact
   attribution and is intentionally not part of this problem.

## Goal

1. Make the pool-divergence flag robust to the outlier the median already rejects,
   without changing the benchmark **value**.
2. Add Chainlink staleness handling and a second, block-precise off-chain oracle
   (Dune), and combine the two oracles into a consensus manipulation check that
   resists single-oracle false positives.
3. Make every WETH→USD **valuation** within a trade flow through the single
   validated benchmark mid, and close the latent asymmetry in `tokenPricing.ts`.

## Design

### Section A — Median-relative pool divergence (Item 1)

In `computeBenchmark` (`benchmarkPrice.ts`), change:

```
poolDivergenceBps = (max(prices) − min(prices)) / median × 1e4      // OLD
poolDivergenceBps = max(|price − median| for price in prices) / median × 1e4   // NEW
```

- Benchmark **value is unchanged** — still `median(validPrices)`.
- A pool the median already discards (thin 30bps pool) can no longer inflate the
  flag; the smoke outlier `0x12adf9d1` drops below tolerance and stops tripping
  `POOL_DIVERGENCE`.
- **Semantic shift:** the metric now measures the *max single-pool deviation from
  the median*, inherently ~half the old full-spread number. `DIVERGENCE_TOL_BPS`
  stays at **15** but now gates this looser quantity; its doc comment is updated to
  say so.
- The `LOW_POOL_COVERAGE` / 1-valid / 0-valid (`throw`) branches are unchanged.

**Edge case — exactly 2 valid pools:** the median is the mean of the two, so
`|price − median|` equals half the spread for *both* pools; the new metric =
`(spread/2)/median × 1e4`. This is correct and intended; it gets an explicit unit
test (closes follow-up #3).

### Section B — Two-oracle cross-check + staleness (Item 2)

#### B1 — Chainlink staleness guard

`getBenchmarkMid` already reads N−1. Additionally read the **N−1 block timestamp**
(`getBlock`) and the Chainlink `updatedAt` (already returned by
`latestRoundData()`), then:

```
chainlinkStalenessSecs = blockTimestamp − Number(updatedAt)
if (chainlinkStalenessSecs > MAX_CHAINLINK_STALENESS_SECS) {
  flags.push('CHAINLINK_STALE'); lowConfidence = true;
  // Chainlink no longer contributes to the manipulation decision.
}
```

`MAX_CHAINLINK_STALENESS_SECS` default **1200** (20 min). A stale Chainlink read is
demoted from "manipulation evidence" to "context"; it never asserts
`MANIPULATION_SUSPECT` on its own.

#### B2 — Off-chain oracle adapter (Dune)

Add a provider-agnostic injected function so the pure core stays testable and the
network lives at the edge:

```ts
type OffChainPrice = { price: number; asOfSecs: number } | null;
type OffChainOracle = (unixSecs: number) => Promise<OffChainPrice>;
```

First (and only, for now) adapter: **Dune**, querying minute-granular ETH/USD from
Dune's `prices` data (e.g. `prices.minute`). Chosen over CoinGecko because the
trades are historical backfill at a specific block: Dune is minute-granular
(≤ ~30s error vs a 12s block), while CoinGecko's free history is hourly/daily.
The adapter:

- Resolves the price at/just-before the N−1 block timestamp and returns its
  `asOfSecs`, so the combiner can apply the same staleness reasoning as Chainlink.
- Reads `DUNE_API_KEY` from env. On missing key / network error / no row → returns
  `null` (treated as "oracle unavailable", never throws).
- Is **not** called in unit tests — tests inject a stub `OffChainOracle`.

The off-chain price gets its own staleness check against
`MAX_OFFCHAIN_STALENESS_SECS` (default **1200**, same rationale); a stale off-chain
read is demoted the same way Chainlink is.

#### B3 — Consensus manipulation combiner

`computeBenchmark` gains an `offChain: { price, devBps } | null` input (already
staleness-filtered by the caller) alongside the existing Chainlink input. The
manipulation decision becomes consensus-based:

| Oracles usable (non-null, non-stale) | Behavior |
|---|---|
| **Both, and they agree** (mutual dev ≤ `MANIPULATION_TOL_BPS`) | `MANIPULATION_SUSPECT` iff DEX median diverges from their consensus (mean) > `MANIPULATION_TOL_BPS`. Single-stale/odd-oracle false positives are eliminated. |
| **Both, but they disagree** (> `MANIPULATION_TOL_BPS` apart) | `ORACLE_DISAGREE`, `lowConfidence = true`; **do not** assert manipulation (can't tell which oracle is right). |
| **Exactly one** | Current single-oracle behavior against that oracle. |
| **Zero** | `ORACLE_UNAVAILABLE`; skip manipulation check; confidence untouched by this step. |

`manipulationSuspect` remains the single persisted boolean downgrade signal on
`router_trades_gated`; the string flags merge into the existing `flags` array as
today.

#### New persisted fields (additive, nullable)

On the smoke/gated benchmark output and `router_trades_gated` (nullable so existing
rows stay clean — no backfill):

| Column | Type | Meaning |
|---|---|---|
| `offchain_price` | `numeric` | Dune ETH/USD at ~N−1. Null if unavailable. |
| `offchain_dev_bps` | `numeric` | `|median − offchain| / offchain × 1e4`. Null if unavailable. |
| `chainlink_staleness_secs` | `numeric` | `blockTs − chainlink.updatedAt`. Null if Chainlink unavailable. |

Existing `chainlink_price`, `chainlink_dev_bps`, `pool_divergence_bps`,
`manipulation_flag` are retained.

#### New constants

| Constant | Default | Rationale |
|---|---|---|
| `MAX_CHAINLINK_STALENESS_SECS` | 1200 | 20 min: long enough to tolerate normal heartbeat gaps, short enough that intra-window ETH moves don't validate against a stale price. |
| `MAX_OFFCHAIN_STALENESS_SECS` | 1200 | Same reasoning for the Dune read. |

`DIVERGENCE_TOL_BPS` (15), `MANIPULATION_TOL_BPS` (50), `MIN_VALID_POOLS` (2) are
unchanged.

### Section C — Single WETH→USD valuation reference (Item 3)

#### C1 — Gas valuation through the benchmark

Replace the trade's-own-price gas valuation with the benchmark mid so every
WETH→USD valuation in a trade shares one reference:

- `normalizeSmokeTrade.ts:123` — `gasCostUsd = gasCostEth × realizedPrice`
  → `× marketMid`.
- `decompose-gated.ts:92` — same change.
- `tcaCalculator.ts:45` and `enrich-router-trades.ts:92` already multiply by an
  injected `ethPriceUsd`; their callers pass `marketMid` (the benchmark) for that
  argument. No signature change beyond ensuring the benchmark mid is what's
  threaded in.

Result: `allInCostBps` (numerator) and `gasBps` (`gasCostUsd / notionalUsdc`) are
denominated against the same validated mid; the bps decomposition is internally
consistent.

**No backfill.** Existing stored `gasCostUsd` values (computed at `realizedPrice`)
stay as-is until the next re-extract, consistent with the deferred-165 decision.

#### C2 — Close the latent asymmetry in `tokenPricing.ts`

Add an optional `precomputedWethUsd?: number`:

- `getTokenUsdcValue(...)` — when the token is WETH and `precomputedWethUsd` is
  provided, use it directly instead of the single-pool factory read.
- `getPairMidAtBlock(...)` WETH/USDC path — same optional override.

No live caller today, but this guarantees the asymmetry can't silently reappear
when that path is revived. `getLegMidAtBlock` is **untouched** — per-leg
price-impact attribution must read each leg's own pool.

## Architecture / boundaries

- `computeBenchmark` stays a **pure function**: pool prices + Chainlink input +
  off-chain input → `BenchmarkResult`. All RPC, oracle, and Dune I/O stays in
  `getBenchmarkMid`.
- The off-chain oracle is a single injected `OffChainOracle` function; the Dune
  adapter is one implementation behind that boundary and is the only networked
  piece. Swapping providers later means writing a new adapter, not touching the
  combiner.

## Testing

- **Median-relative divergence:** 3-valid (outlier no longer trips), exactly-2
  valid (half-spread metric), 1-valid (`LOW_POOL_COVERAGE`), 0-valid (`throw`).
- **Chainlink staleness:** under and over `MAX_CHAINLINK_STALENESS_SECS`; stale →
  `CHAINLINK_STALE`, no `MANIPULATION_SUSPECT` from Chainlink.
- **Two-oracle combiner:** both-agree (consensus manipulation true/false across the
  boundary), both-disagree (`ORACLE_DISAGREE`, no manipulation), exactly-one, zero
  (`ORACLE_UNAVAILABLE`).
- **Off-chain adapter** mocked via injected stub; no network in unit tests.
- **C1:** assert `gasCostUsd` uses `marketMid` (a fixture where `marketMid ≠
  realizedPrice` shows the value change).
- **C2:** `getTokenUsdcValue` with `precomputedWethUsd` returns
  `humanAmount × precomputedWethUsd` and performs no pool read.

## Out of scope

- The benchmark **value** semantics (stays `slot0` median-of-3, instantaneous mid).
- V4 per-leg mid logic; per-leg `getLegMidAtBlock`.
- The ±100 bps plausibility gate (`MAX_PLAUSIBLE_BPS`).
- The deferred 165-row `router_trades_gated` backfill, and any backfill of existing
  `gasCostUsd`.
- The separate v2.0 `processSwap` / `swaps` pipeline.
- CoinGecko adapter (interface stays provider-agnostic; not built now).
- The earmarked Uni V3 `observe()` TWAP detector (still a future follow-up).
```
