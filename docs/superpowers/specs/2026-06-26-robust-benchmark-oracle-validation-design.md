# Robust Multi-Pool Benchmark with Oracle Validation

**Date:** 2026-06-26
**Branch:** `feat/cost-model-v2`
**Status:** Approved design — ready for implementation plan

## Problem

The benchmark "Market Price" shown in the Transaction Details dialog (`market_mid`)
is derived from a **single hardcoded pool**: the Uniswap V3 5bps WETH/USDC pool on
Base (`0xd0b53D9277642d899DF5C87A3966A349A798F224`), read via
`getReferencePrice(POOL_5BPS, blockNumber)` and sampled at `slot0` of block N−1.

This value is the pool's **marginal/instantaneous** price — by construction the most
manipulable and noisiest single number a pool exposes — and the pipeline trusts one
pool's reading at one block with no cross-check. The address is also copy-pasted
across three ingest scripts.

A partial backstop already exists: `MAX_PLAUSIBLE_BPS = ±100`
(`extract-router-trades.ts`) silently drops any trade whose all-in cost vs the mid
exceeds ±100 bps. This catches *gross* bad/manipulated mids but (a) does so as a
silent drop rather than a flag, and (b) lets *subtle* bad reads (≈10–80 bps off)
survive and quietly corrupt the cost.

### Scope of this work

Benchmark **robustness only**. The pipeline stays WETH/USDC-only. We are not
generalizing to arbitrary token pairs, and we are not changing the `slot0`
instantaneous-mid semantics — TCA specifically wants the price the trader could have
gotten just before execution, so time-smoothing (TWAP) would itself distort the
benchmark and is explicitly out of scope for the benchmark value.

## Goal

1. Replace the single-pool read with a **median of the three deepest WETH/USDC pools
   at block N−1**, preserving instantaneous-mid semantics while removing the
   single-point-of-failure.
2. Add a **Chainlink ETH/USD cross-check** at N−1 to detect pre-block manipulation.
3. Emit two independent divergence signals (intra-pool, and DEX-vs-oracle) into the
   existing flag/confidence plumbing, and persist the validation metrics for audit.

## Design

### 1. New module: `packages/ingest/src/benchmarkPrice.ts`

A single focused unit that replaces direct `getReferencePrice(POOL_5BPS, …)` calls.
Takes a viem `PublicClient` + block number, returns a structured result.

```ts
getBenchmarkMid(client: PublicClient, blockNumber: bigint): Promise<BenchmarkResult>

interface BenchmarkResult {
  marketMid: number;            // median of available pool prices (USDC per WETH)
  perPool: { label: string; price: number | null }[];
  poolDivergenceBps: number;    // (max - min) / median × 1e4 across valid pools
  chainlinkPrice: number | null;
  chainlinkDevBps: number | null; // |median - chainlink| / chainlink × 1e4
  manipulationSuspect: boolean;   // chainlinkDevBps > MANIPULATION_TOL_BPS
  flags: string[];
  lowConfidence: boolean;
}
```

#### Pool registry (3 entries)

All three are V3-style pools read via `slot0().sqrtPriceX96` and converted with the
existing `sqrtPriceX96ToUsdcPerWeth` (`referencePrice.ts`). For all three pools
token0 = WETH (18) and token1 = USDC (6) — WETH `0x4200…` sorts below USDC
`0x8335…` — so the existing `× 10^12` decimal adjustment holds without inversion.

| Label          | Address                                      | Source |
|----------------|----------------------------------------------|--------|
| Uni V3 5bps    | `0xd0b53D9277642d899DF5C87A3966A349A798F224`  | Already pinned (`poolDiscovery.ts` getPool(WETH,USDC,500)) |
| Uni V3 30bps   | _confirm on-chain_                            | `getPool(WETH, USDC, 3000)` on Uni V3 factory |
| Aerodrome CL   | _confirm on-chain_                            | Deepest Aerodrome CL WETH/USDC pool |

Addresses are confirmed on-chain and commented with their provenance, matching the
convention in `poolDiscovery.ts`.

#### Algorithm

1. Read `slot0` at block N−1 from all 3 pools **concurrently**. Skip any pool that
   reverts or returns null (e.g. the pool did not exist at that block).
2. Compute `median` of the valid prices → `marketMid`.
   - **≥2 valid** → normal path.
   - **exactly 1 valid** → use it, push flag `LOW_POOL_COVERAGE`, set
     `lowConfidence = true`. Intra-pool divergence is not computable (set 0).
   - **0 valid** → throw (matches the current hard-fail behavior of
     `getReferencePrice`).
3. `poolDivergenceBps = (max − min) / median × 1e4` across valid pools. If
   `> DIVERGENCE_TOL_BPS` → push flag `POOL_DIVERGENCE`, set `lowConfidence = true`.
4. Read Chainlink ETH/USD `latestRoundData()` at block N−1 (8 decimals).
   `chainlinkDevBps = |median − chainlink| / chainlink × 1e4`. If
   `> MANIPULATION_TOL_BPS` → `manipulationSuspect = true`, push flag
   `MANIPULATION_SUSPECT`, set `lowConfidence = true`.
5. If the Chainlink read fails → push flag `CHAINLINK_UNAVAILABLE`, skip the
   manipulation check (cannot assert manipulation without the oracle), leave
   `lowConfidence` unchanged by this step.

#### Constants (defaults — tunable)

| Constant                | Value   | Rationale |
|-------------------------|---------|-----------|
| `DIVERGENCE_TOL_BPS`    | 15      | Deepest WETH/USDC pools should agree within ~15 bps; beyond → thin/stale/manipulated liquidity. |
| `MANIPULATION_TOL_BPS`  | 50      | 0.5% per requirement. Comfortably above normal USDC depeg (<10 bps), so the USDC≠USD gap does not false-trigger. |
| `MIN_VALID_POOLS`       | 2       | Need at least two independent reads to median/cross-check. |

#### USDC ≠ USD caveat

Chainlink reports ETH/**USD**; our mid is USDC/WETH. Normal USDC depeg is <10 bps and
sits well inside the 50 bps tolerance, so it does not false-trigger. This is
documented in a code comment at the deviation computation.

### 2. Data model — migration on `router_trades_gated`

Four **nullable** columns (nullable so the existing 165 gated rows backfill cleanly):

| Column                 | Type      | Meaning |
|------------------------|-----------|---------|
| `chainlink_price`      | `numeric` | Chainlink ETH/USD at N−1 (USD per ETH). Null if oracle unavailable. |
| `chainlink_dev_bps`    | `numeric` | `|median − chainlink| / chainlink × 1e4`. Null if oracle unavailable. |
| `pool_divergence_bps`  | `numeric` | Intra-pool spread across valid pools. |
| `manipulation_flag`    | `boolean` | True when `chainlink_dev_bps > 50`. |

There is no `confidence` column on `router_trades_gated`; the dialog derives its
confidence display from the discrete cost columns. Therefore **`manipulation_flag` is
the persisted downgrade signal** — the dashboard's confidence renderer maps
`manipulation_flag = true` (and a large `pool_divergence_bps`) to a low-confidence /
warning state. The string flags from `BenchmarkResult.flags` merge into the existing
decomposition `flags` array.

Generated via a Drizzle migration in `packages/db/drizzle/`.

### 3. Integration

`benchmarkPrice.ts` replaces the `getReferencePrice(POOL_5BPS, …)` call in all three
benchmark sites so every benchmark flows through the same validated path:

- `reextract-gated.ts` — the live path that writes `router_trades_gated` (what the
  dialog reads). Persists the four new columns alongside `market_mid`.
- `extract-router-trades.ts`
- `normalizeSmokeTrade.ts`

`marketMid` continues to feed `signedDeviationBps(direction, marketMid, realizedPrice)`
exactly as today; the new fields are written alongside, not in place of, the existing
cost path. The hardcoded `POOL_5BPS` constants in these files are removed in favor of
the registry in `benchmarkPrice.ts`.

### 4. Dashboard

In the Transaction Details dialog (`TradesTable.tsx`), near the existing
"Market Price" row:

- Show the Chainlink deviation (`chainlink_dev_bps`) and a manipulation warning badge
  when `manipulation_flag` is true.
- Reflect the confidence downgrade in the dialog's existing confidence display when
  `manipulation_flag` is set or `pool_divergence_bps` exceeds tolerance.

Minimal: one detail row plus a badge.

### 5. Testing

- **Median / divergence math** with stubbed pool prices: 3 valid, 2 valid, 1 valid
  (`LOW_POOL_COVERAGE`), 0 valid (throws).
- **Chainlink deviation thresholds**: just under and just over 50 bps boundary.
- **`CHAINLINK_UNAVAILABLE`** path: oracle read fails → flagged, no crash, no false
  manipulation flag, confidence untouched by the oracle step.
- **Conversion correctness** reuses existing `sqrtPriceX96ToUsdcPerWeth` tests; no new
  math there.

## Future upgrade (earmarked — NOT in this scope)

**TWAP-based manipulation detector.** Add a short (2–5 minute) Uniswap V3 `observe()`
TWAP as a second, oracle-independent manipulation signal: compare the `slot0` median
against the pool TWAP and flag a manipulated/illiquid block when they diverge beyond
a threshold. This complements the Chainlink check (no external-oracle dependency) and
composes cleanly with this design — it adds a signal, it does not change the benchmark
value (which stays `slot0`-based for instantaneous-mid semantics). Tracked as a
follow-up.

## Out of scope

- Multi-pair generalization — pipeline remains WETH/USDC-only.
- Changing the ±100 bps plausibility gate (`MAX_PLAUSIBLE_BPS`).
- Replacing `slot0` semantics with a TWAP for the benchmark **value** itself.
- Config-only refactors beyond consolidating the pool addresses into the registry.
