# Input-token mid-chain recurrence — design

**Date:** 2026-07-22
**Scope:** Let a route reconstruct when the **input token recurs mid-chain**, by
replacing the "input is a pure source" check in `routeGraph.ts` with symmetric
net-flow conservation. Fixes id 134 (ETH→TOSHI) and any route of that shape.
`packages/core` only.

## Why

`routeGraph.ts` reconstructs a swap route by checking token flow conservation, in
two functions: `linearFlowValid` (guards the linear fast path) and `reconstructDag`
(the general DAG path). Both require the **input token to be a pure source** — it may
never appear as any leg's `tokenOut` (`inflow.get(inputToken) !== 0n → reject`).

The code already treats the **output** token asymmetrically: `linearFlowValid`
exempts it from conservation entirely, with a comment citing "WARP→WETH→USDC→WETH" as
an *intentional* feature — the output token may legitimately recur mid-chain.

id 134 decomposes to `WETH→USDC`, `USDC→WETH`, `WETH→TOSHI`. WETH is the input, and
leg 1 (`USDC→WETH`) produces it, so the pure-source check rejects a legitimate route.
It falls to "complex, non-reconstructed" → confidence pinned `low`. The defect is the
**input/output asymmetry**: the output may recur, the input may not.

## The fix: symmetric net-flow conservation

Model the route as a standard single-source / single-sink flow. Replace "input is a
*pure* source" with "input is a *net* source":

- **Input token:** net outflow must be positive — `outflow(input) > inflow(input)`.
  The net (`outflow − inflow`) is the amount injected. The token MAY recur mid-chain.
- **Output token:** unchanged in each function (`linearFlowValid` keeps exempting it;
  `reconstructDag` keeps its pure-sink check — see "Deliberately minimal" below).
- **Every other (intermediate) token:** strict conservation (`inflow ≈ outflow` within
  the existing 0.1% `conserved` tolerance) — unchanged.

Under this model id 134 validates: WETH nets positive outflow (leg0-in + leg2-in −
leg1-out), USDC conserves (leg0-out = leg1-in), TOSHI is the net sink → the route
reconstructs as a genuine multi-hop, and confidence is no longer floored by the
non-reconstruction.

### Exact changes in `routeGraph.ts`

**`linearFlowValid`** — replace the pure-source line:
```ts
// before
if ((inflow.get(inputToken) ?? 0n) !== 0n) return false;
// after
if ((outflow.get(inputToken) ?? 0n) <= (inflow.get(inputToken) ?? 0n)) return false; // net source
```
The conservation loop already `continue`s on `inputToken` and `outputToken`, so no
other change is needed there.

**`reconstructDag`** — relax the input branch from pure-source to net-source:
```ts
// before
if (t === inputToken) { if (inn !== 0n) return null; continue; } // pure source
// after
if (t === inputToken) { continue; } // net source — validated after the loop
```
and change the post-loop input check:
```ts
// before
if ((outflow.get(inputToken) ?? 0n) <= 0n) return null; // input must send
// after
if ((outflow.get(inputToken) ?? 0n) <= (inflow.get(inputToken) ?? 0n)) return null; // net source
```
The output pure-sink check and the output net-receive check are unchanged.

## Why it's safe

- **Strictly more permissive on the input.** The change relaxes `inflow == 0` to
  `outflow > inflow`; `outflow > 0` was already required. A route that reconstructed
  before still reconstructs (with `inflow == 0`, `outflow > 0` still gives
  `outflow > inflow`). It can only *accept more*, never reject a currently-passing route.
- **Net-flow is the correct conservation.** A route satisfying net-source /
  (net-)sink / intermediate-conservation genuinely is an input→output flow — the input
  passing through twice (id 134) is legitimate. The old pure-source rule existed to
  reject "a genuine cycle back to the input"; that guard is preserved differently: a
  true cycle with no net progress to the output fails the output net-receive check (or
  leaves the input with `outflow ≤ inflow`), so it still does not reconstruct.
- **Confidence is unchanged in mechanism.** Reconstruction only decides *shape*;
  confidence still comes from the reconciliation-residual and fee-resolution checks in
  `decomposeRoute`. This fix lets a real route be *seen* as reconstructed; it does not
  hand out confidence.

## Deliberately minimal

- Only the **input** source-check is relaxed. The remaining input/output asymmetry in
  `reconstructDag` (it still requires the output to be a *pure* sink, while
  `linearFlowValid` exempts the output) is **left as-is** — it is not id 134's bug and
  touching it would widen the blast radius on delicate, opus-reviewed code.
- **No DB retype.** id 134 and any similar rows relabel only on re-analysis (consistent
  with this session). No migration.

## Testing

- **`routeGraph.test.ts` — the fix accepts the legitimate pattern:** a 3-leg route
  `A→B`, `B→A`, `A→C` with input `A`, output `C` (the id-134 shape) reconstructs —
  assert `shape` is `linear`/`split`/`complex`-reconstructed (`reconstructed: true`),
  not the non-reconstructed `complex`.
- **`routeGraph.test.ts` — the adversarial cycle is still rejected:** a route that
  returns to the input with no net progress to the output (e.g. `A→B`, `B→A` with input
  `A`, output `C`, where `C` never receives) must NOT reconstruct (`reconstructed: false`).
  This proves the relaxation did not open a hole.
- **Every existing `routeGraph.test.ts` / `decomposeRoute.test.ts` case still passes**
  (baseline: 430 across 33 files) — the change is strictly more permissive, so no
  previously-reconstructing route may regress.
- **Acceptance (end-to-end, no DB write):** run `analyzeTransaction` on id 134's tx
  `0x173e019d69ff3bf642ca4024241aa9a9fe241f80dc24f262bf7ccd2c4ef76918` against RPC and
  confirm the route is reconstructed and `decompConfidence` is above `low` — the same
  direct-call verification used for the curated-maker fix (the receipt page reads the
  persisted DB row and never recomputes, so a UI check would not show it).

## Out of scope

- id 56 (its July "V4 multi-pool" diagnosis is stale post-repopulation — its current
  legs are a plain univ3+pancakev3 2-hop; it needs fresh diagnosis before a spec).
- The `reconstructDag` output pure-sink strictness (a separate, non-id-134 asymmetry).
