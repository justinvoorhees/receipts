# Route Decomposition v2 — Multi-Hop Attribution

> **STATUS — COMPLETE on smoke set (2026-06-26, branch `feat/cost-model-v2`).**
> All 15 smoke rows validate: LP+Agg+Slippage = all_in within 0.01 bps.
> Funnel (`router_trades_gated`, 165 rows) remains frozen on the prior decomposition path.
> Funnel reuse is a separate, gated follow-up (Task 9).

---

## Background

The v2.1 decomposition (`decompose-trade.ts`) handled only single-hop USDC/WETH routes. Any trade that routed through a third token (e.g. USDC→VIRTUAL→WETH) returned `lpFeeBps=null` / `slippageBps=null` and fell back to `executionBps = all_in − agg`, with a `MULTI-HOP` flag — an honest signal that the components weren't separable on that path.

This document describes the v2 model that fixes this by reconstructing the route from on-chain events and attributing LP fee and slippage across every leg.

---

## Core Invariant

```
all_in_cost_bps = LP + Agg + Slippage
```

`all_in_cost_bps` is the top-line anchor: `signedDeviationBps(realizedPrice, marketMid@N-1)` using the trader's true USDC/WETH endpoints. It is never redefined. The decomposition must reconcile to it; `Slippage` is always the residual.

---

## Route Reconstruction (`routeGraph.ts`)

Given the full token transfer log for a transaction, the route graph builder:

1. Computes each non-trader, non-denylist address's net delta per token.
2. Classifies **venues**: any address that emitted a Swap event (detected by topic0 for Uni V3, PancakeSwap V3, V2, Aerodrome, Uni V4) OR any address that net-received exactly one token and net-sent exactly one other (RFQ filler — no Swap event needed).
3. Derives each venue's `(tokenIn, amountIn, tokenOut, amountOut)` from its gross flows.
4. **Chains legs** starting from the trader's net-negative token (input), following tokenOut→tokenIn until reaching the trader's net-positive token (output).

Route shapes:

| Shape | Definition | LP treatment |
|-------|-----------|--------------|
| `single` | One leg, direct USDC/WETH pair | Exact |
| `linear` | ≥2 legs chained without branching | Exact (LP summed across legs) |
| `split` | Trader's input fans out to multiple parallel first-legs that all touch the direct USDC/WETH pair | Exact (each branch is a direct pair; summed) |
| `complex` | Chaining stalls — route cannot be fully ordered | Best-effort; confidence `low` |

The denylist (the 4 USDC/WETH reference pools + known vaults) is excluded from being venues **unless** the address also emitted a Swap event for this transaction — a venue that swaps through a reference pool is still a leg.

---

## LP Fee Roll-Up (`legFees.ts`)

For each leg:

1. **Resolve fee tier:** V3/PancakeV3 via `fee()` at block N-1; V4 from the Swap event `fee` field (`v4FeeRaw / 100`); V2 = 30 bps; Aerodrome stable/volatile read or 30 bps with `FEE_DEFAULTED` flag; RFQ/unknown = 0.
2. **Value the leg notional** in USDC:
   - If `tokenIn == USDC`: `amountIn / 1e6` (exact).
   - If `tokenOut == USDC`: `amountOut / 1e6` (exact).
   - If `tokenIn == WETH`: `amountIn / 1e18 × usdcPerWeth` (exact, uses market mid@N-1).
   - If `tokenOut == WETH`: `amountOut / 1e18 × usdcPerWeth` (exact).
   - Otherwise (purely intermediate leg — neither endpoint is USDC/WETH): approximate as `tradeNotionalUsdc` and mark `notionalApprox=true`. This is an upper-bound approximation; for 2-leg routes (the common case) it never fires.
3. **Roll up:** `lpFeeBps = Σ(leg.feeTierBps × leg.notionalUsdc) / tradeNotionalUsdc`.

This is value-weighted, not simple-average: a large first leg and a small second leg contribute proportionally to the trade's USDC cost.

---

## Slippage — Residual Definition

```
slippageBps = allInCostBps − lpFeeBps − aggFeeBps
```

Slippage is always the algebraic residual. It is never directly measured — that is intentional. The residual captures everything that isn't LP fee or aggregator fee: mid drift between legs, pool depth effects, MEV, and timing. For a trade that beats the mid, slippage is negative.

This is identical to the v2.1 definition for single-hop pure routes; v2 extends it to multi-hop by giving LP a real value instead of null.

---

## Per-Leg Price-Impact (`tokenPricing.ts`, `decomposeRoute.ts`)

In addition to the rolled-up slippage, v2 computes an independent per-leg price-impact for attribution and QA:

```
leg.priceImpactBps = (legRealizedPrice − legMidAtN-1) / legMidAtN-1 × 10000 − leg.feeTierBps
```

Each leg's mid is read from **that leg's own pool** at block N-1 (not a global USDC/WETH quote), so VIRTUAL/WETH legs use the specific PancakeSwap or Uni V4 pool the trade actually hit.

The **reconciliation residual** is:

```
reconResidualBps = allIn − (Σ legLpFeeBps + Σ legPriceImpactBps + aggFeeBps)
```

This is stored in `recon_residual_bps` for QA. It is non-zero when per-leg mids are approximated or stale. `reconResidualBps` does **not** replace `slippageBps` in the display model; `slippageBps` remains the exact residual by construction.

---

## Confidence Flags

| Level | Condition | Meaning |
|-------|-----------|---------|
| `high` | `reconstructed=true`, `shape ∈ {single, linear, split}`, all fee tiers resolved, no approx notionals | Full attribution; trust LP and Slippage |
| `medium` | `reconstructed=true` but has approx notionals, defaulted fee, or large recon residual | Attribution reasonable but imprecise |
| `low` | `!reconstructed` or `shape ∈ {complex}` | Route not fully ordered; LP best-effort; Slippage still the exact residual |

A `PI_IMPLAUSIBLE` flag is set (and `priceImpactBps` nulled) when `|priceImpactBps| > 500 bps` for a leg — this guards against stale pool discovery returning a wrong reference pool. A `LEG_FEE_IMPLAUSIBLE` flag is set when a leg's resolved fee tier exceeds 300 bps (which would indicate a bad fee read).

---

## Aggregator Fee

Unchanged from v2.1 (`decompose-trade.ts`). The fee-sink logic scans all non-denylist, non-trader addresses for USDC or WETH retained in the transaction. Known vaults (Velora `0x0070…`, Relay `0xf70da9…`) receive the fee; amounts below the dust threshold (`$0.01`) are excluded.

The smoke profile lowers the plausibility floor to accommodate small ($1–$2.50) smoke trades.

---

## Known Limitations

**Splits over non-direct pairs:** A split route where each branch routes through a different intermediate token (e.g. branch A: USDC→TOKEN-A→WETH, branch B: USDC→TOKEN-B→WETH) is classified `complex` with `confidence=low`. The LP is best-effort (sum of identified legs). This is uncommon in practice.

**RFQ legs:** An RFQ filler has no on-chain fee tier; its fee-tier contribution to LP is recorded as 0 bps. Its spread shows up entirely in `priceImpactBps` (measured vs the pair's reference pool at N-1). The rolled-up `slippageBps` still reconciles correctly regardless.

**V4 orientation heuristic:** For V4 legs the `tokenIn`/`tokenOut` orientation is inferred from the Swap event `amountSpecified` sign, not a deterministic PoolKey read. This can occasionally mis-orient, biasing per-leg `priceImpactBps` toward 0. It does not affect the rolled-up LP or Slippage.

**Pool discovery for per-leg mids:** `discoverPool` returns the first initialized pool found across factory tiers, not necessarily the deepest. For well-known pairs (USDC/WETH, VIRTUAL/WETH via PancakeSwap) the leg's own pool is used directly via `fallbackPool`, bypassing discovery. For exotic pairs, discovery may return a stale or low-liquidity pool, triggering the `PI_IMPLAUSIBLE` clamp.

**Funnel reuse:** The funnel decomposition path (`decompose-trade.ts` → `decompose-gated.ts` → `router_trades_gated`) is unchanged and still uses the v2.1 single-hop model. Multi-hop funnel trades still return `executionBps = all_in − agg`. Enabling `decomposeRoute` for the funnel is Task 9 and requires an explicit go-ahead.

---

## Files

| File | Role |
|------|------|
| `packages/ingest/src/routeGraph.ts` | Pure route reconstruction from transfers + Swap events |
| `packages/ingest/src/routeGraph.test.ts` | 10 unit tests |
| `packages/ingest/src/legFees.ts` | Per-leg notional valuation + LP roll-up |
| `packages/ingest/src/legFees.test.ts` | 8 unit tests |
| `packages/ingest/src/decomposeRoute.ts` | Orchestrator: route graph → LP + Agg + Slippage + per-leg PI |
| `packages/ingest/src/decomposeRoute.test.ts` | 23 unit tests |
| `packages/ingest/src/tokenPricing.ts` | Generalized pair-mid at block N-1 (V3/PancakeV3/V2/Aerodrome/V4) |
| `packages/ingest/src/poolDiscovery.ts` | Pool factory discovery for a token pair |
| `packages/ingest/src/tokenPricing.test.ts` | 10 unit tests |
| `packages/ingest/src/venueClassification.ts` | Venue type classification from Swap event topics |
| `packages/ingest/src/normalizeSmokeTrade.ts` | Calls `decomposeRoute` for smoke trades; populates route columns |
| `packages/ingest/src/redecompose-smoke.ts` | Re-runs decomposition on all `smoke_trades` rows |
| `packages/ingest/src/validate-route-decomposition.ts` | Reference validation script; asserts invariant across all smoke rows |
| `packages/dashboard/lib/queries.ts` | Exposes route columns + `RouteLeg` type to dashboard |
| `packages/dashboard/components/TradesTable.tsx` | Hop badges, low-conf markers, expandable per-leg detail |

---

## Validation Results (smoke set, 2026-06-26)

15 rows across 3 batches (smoke-01, smoke-02, smoke-03), 5 aggregators:

```
Confidence: high=9, medium=2, low=4
Shape:      single=9, linear=5, split=1
Invariant:  PASS — all 15 rows reconcile LP+Agg+Slippage=all_in within 0.01 bps
```

Representative multi-hop results:

| Trade | Shape | Hops | LP (bps) | Agg (bps) | Slip (bps) | Conf |
|-------|-------|------|----------|-----------|------------|------|
| kyber b1 (USDC→VIRTUAL→WETH via PancakeV3+V4) | linear | 2 | 9.50 | 0.00 | −12.65 | medium |
| kyber b2 (USDC→VIRTUAL via RFQ → VIRTUAL→WETH via V4 100bps) | linear | 2 | 100.02 | 1.66 | −111.77 | low |
| nordstern b2 (USDC→?→WETH via V4+V3) | linear | 2 | 15.00 | 0.00 | −22.11 | low |
| kyber b3 (3-hop via MaverickV2+RFQ+SushiV3) | linear | 3 | 5.10 | 0.00 | −11.38 | medium |
