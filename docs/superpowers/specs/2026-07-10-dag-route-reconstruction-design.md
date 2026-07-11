# DAG Route Reconstruction + Notional-Weighted Cost Attribution

**Date:** 2026-07-10
**Status:** Design — pending review

## Problem

`decomposeRoute` only attributes per-leg cost (LP fee, price impact, slippage) for routes whose graph reconstructs into one of three shapes: `single`, `linear` (a single chain consuming every leg), or a clean `split` (every leg a direct input→output pair). Anything else — notably **convergent multi-hop splits**, where flow splits at the input, runs through different hops, and *reconverges* at a shared token before the output — falls to the non-reconstructed branch and returns `lpFeeBps=null`, `slippageBps=null`, and per-leg `priceImpactBps=null` with a `ROUTE_NOT_DECOMPOSED` flag.

Real examples (Base, in the receipts DB): id 59 `LFI→GITLAWB` (`LFI→WETH→USDC→GITLAWB` + a parallel `LFI→USDC` reconverging at USDC), id 55/56 (CLAWD via shared hubs), id 75 (Odos USDC→ETH, 7 legs across USDT/cbBTC/WETH). These show real per-leg LP fees but "Null" price impact and no slippage.

The original author deliberately deferred this ("MULTI-HOP … LP/slippage not separable"). This spec removes that limitation for any **conserved acyclic flow**.

## Goals

- Reconstruct and cost-attribute **any acyclic input→output flow with conservation at every intermediate token** (general DAG), not just single/linear/clean-split.
- Per-leg price impact and route slippage populate for these routes, reconciling with the trade-level all-in.
- Preserve existing behavior byte-for-byte for routes that already reconstruct (single/linear/clean-split).
- Keep the honest fallback (`ROUTE_NOT_DECOMPOSED`) for genuinely non-conserved / cyclic / disconnected graphs.

## Non-goals

- Cyclic routes, non-conserved flows (missing/extra transfers), or graphs that don't connect input→output — these stay `reconstructed=false`.
- Changing the per-leg *price-impact computation* (leg mid vs realized). Only its *aggregation/weighting* changes.
- Any DB schema change (routeLegs is jsonb; existing numeric columns already hold these fields).

## Key insight (lowers risk)

Per-leg **LP fee is already notional-weighted**: `decomposeRoute.ts:723` sets
`lpFeeBps = feeTierBps × (legNotionalUsdc / tradeNotionalUsdc)`.
So summing per-leg `lpFeeBps` already yields the correct trade-level LP fee for *any* topology. The only inconsistency is **price impact**: Step 9 (`decomposeRoute.ts:778`) sets `priceImpactBps = legTotalCostBps − feeTierBps` in the leg's *own* bps, unweighted. For linear routes every leg carries ≈ the full notional, so weighted ≈ unweighted and today's raw-sum reconciliation holds; for splits/convergence it does not.

**Fix:** weight per-leg price impact the same way as LP fee. Then everything is in notional-weighted trade bps and the existing raw-sum reconciliation (`decomposeRoute.ts:794-797`) holds for DAGs too.

## Design

### A. DAG reconstruction — `routeGraph.ts` (`chainLegs`)

Add a general validity path. Given the legs (each with `tokenIn`, `tokenOut`, `amountInRaw`, `amountOutRaw`):

1. **Build a token-flow graph**: per token, sum inflow (`Σ amountOutRaw` of legs ending there... i.e. amount *received*) and outflow (`Σ amountInRaw` of legs starting there). Note: cross-token amounts are in different units, so conservation is checked **per token** in that token's own raw units.
2. **Conservation check** (per intermediate token T, T ≠ input, T ≠ output): `inflow(T) ≈ outflow(T)` within a small dust tolerance (relative epsilon, e.g. ≤ 0.5% or a few raw units — mirrors existing dust handling). The **input** token: outflow > 0, inflow = 0 (pure source). The **output** token: inflow > 0, outflow = 0 (pure sink).
3. **Acyclic + connected**: a topological sort over token nodes (edges = legs) must succeed and reach the output token from the input token. Cycle → fail.
4. If all hold → `reconstructed=true`; `shape` stays descriptive (retain `single`/`linear`/`split`; new multi-path convergent graphs → `complex` but now reconstructed). `ordered` = legs in topological order. Else → `reconstructed=false` (unchanged fallback).

Existing single/linear/clean-split branches remain (fast paths, byte-identical output); the general check is the new path for what previously fell through.

### B. Notional-weighted price impact — `decomposeRoute.ts` (Step 9/10)

- In Step 9, after computing `legTotalCostBps` and the raw per-leg impact, **weight it**:
  `priceImpactBps = (legTotalCostBps − feeTierBps) × (legNotionalUsdc / tradeNotionalUsdc)`
  — identical weighting factor to the LP-fee rollup (line 723). For a linear route the factor ≈ 1, preserving current values.
- `PI_IMPLAUSIBLE_CAP_BPS` clamp applies to the *raw* per-leg impact (before weighting), so the plausibility guard is unaffected by notional size.
- Step 10 reconciliation is unchanged in form (`allIn − Σlp − Σpi − agg`), now correct for DAGs because both `lp` and `pi` are notional-weighted.
- Slippage (`allIn − lp − agg`, line 734) is unchanged — it already keys off the weighted rollup.

### C. Gating — `decomposeRoute.ts:732`

Broaden the branch condition from `reconstructed && shape ∈ {single,linear,split}` to simply `graph.reconstructed` (the else branch already handles `reconstructed=false`). Reconstructed `complex` DAGs now flow through Step 9/10.

### D. Confidence

Unchanged mapping: a reconstructed DAG whose USD-/notional-weighted reconciliation residual exceeds `RECON_LOW_BPS` downgrades to `low`; poorly-reconciling routes still surface the decomposition, just flagged low (per product decision). `hopCount` for a reconstructed non-linear DAG: report the longest input→output path length (linear stays leg count; clean split stays 1).

## Testability (TDD)

Pure, no-RPC unit tests in `routeGraph.test.ts` and `decomposeRoute.test.ts` (both already inject fake mid/decimals readers):

- **routeGraph**: convergent multi-hop split reconstructs (topo order correct); non-conserved graph (missing outflow) → `reconstructed=false`; cyclic graph → false; existing linear/split fixtures unchanged.
- **decomposeRoute**: a convergent-split fixture with injected mids → per-leg weighted price impact + non-null slippage + tight `reconResidualBps`; an existing linear fixture → byte-identical `priceImpactBps` (weight ≈ 1 regression guard).

## Migration / rollout

- No schema change. After merge, repopulate the receipts DB (in-place, same pattern already used this session) so id 55/56/59/75 and any other split/complex rows gain per-leg PI + slippage.

## Risks

- **Reconciliation drift on real DAGs.** Mitigated by the confidence downgrade + honest display; the `PI_IMPLAUSIBLE` clamp still guards garbage per-leg mids.
- **Regression on existing linear/split routes.** Mitigated by keeping the fast-path branches and a byte-identical regression test (weight ≈ 1).
- **Conservation tolerance tuning** (dust, rebasing/fee-on-transfer tokens). Start strict; loosen only with evidence. Fee-on-transfer tokens may never conserve → correctly stay `reconstructed=false`.
