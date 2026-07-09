# Native-ETH Route Decomposition — list the pools a native-ETH trade touched

Date: 2026-07-09
Status: Approved design (pre-implementation)

## Problem

Trades that settle in **native ETH** (e.g. WARP→ETH,
`0xa21e4d82b961726614ce6f310e30e29a4b55b8eca1d6a46621c3adaf8edf6ab1`) fail to
decompose: the receipt renders a single generic, non-interactive "Route" row
under Liquidity Provider Fee and Price Impact instead of listing the pools the
route actually touched.

### Confirmed root cause (traced on-chain)

The WARP trade is a clean **3-hop linear chain** through three real, detectable
pools:

| Hop | Pool | Type | Flow |
|-----|------|------|------|
| 1 | `0x53932cbd…` | Uniswap V3 | WARP → WETH |
| 2 | `0x72ab388e…` | Maverick V2 | WETH → USDC |
| 3 | `0x498581ff…` | Uniswap V4 (PoolManager) | USDC → **native ETH** |

All three pools are already identified by the Swap-event scan. Decomposition
still fails because of **how native ETH moves**: it emits no ERC-20 `Transfer`
event. In `routeGraph.buildRouteGraph`:

```
1. buildDeltas(transfers)        // ERC-20 only — native ETH invisible
2. identifyTraderTokens(deltas)  // ❌ returns null → early return
   → { legs: [], shape: 'complex', reconstructed: false }
3. buildLegs(...)                // never runs
```

`identifyTraderTokens` (`routeGraph.ts:116`) requires the trader to have both a
net-negative ERC-20 (input) and a net-positive ERC-20 (output). The WARP trader
sends WARP and receives **native ETH** — no net-received ERC-20 — so
`outputToken` is null and the graph bails with empty legs **before any pool is
examined**. That yields the stored state `route_legs: []`, `hop_count: 0`,
`route_shape: 'complex'` → `ROUTE_NOT_DECOMPOSED` → the generic "Route" row.

The existing `resolveV4Settlement` rewriter (`decomposeRoute.ts:418`) already
massages transfers so `buildRouteGraph` can chain a V4 leg — but it only handles
**ERC-20** settlement and cannot fix a V4 pool that pays out native ETH. Native
ETH is currently modeled nowhere in the transfer set.

## Goals

- Native-ETH routes (ETH as input, output, or mid-route) decompose into the
  same **fully-costed per-leg breakdown** as any other trade — each pool listed
  with its LP Fee and per-pool Price Impact/Slippage, interactive Basescan
  links. WARP shows its three pools.
- Genuine **wrap/unwrap** steps are surfaced as informational route steps.
- A **pools-touched fallback** lists the detected pools for any route that still
  cannot be costed, instead of a generic placeholder.

## Non-goals

- No new pricing/oracle behavior — pricing tier logic is unchanged (WARP stays
  `estimated`).
- No DB migration.
- Not attempting to cost genuinely-undecomposable routes; those get the
  best-effort pools-touched list only.

## Design

### 1. Native-ETH modeling (the core fix)

Model native ETH as WETH in the transfer set, upstream of everything that
already works. Insert **Step 3a** in `decomposeRoute` between transfer decoding
and `resolveV4Settlement`:

```
Step 3:  collectTraceLogs → decodeTransferLogs (ERC-20)
Step 3a: extractNativeTransfers(trace) → append as WETH-token transfers   ← NEW
Step 3b: resolveV4Settlement(...)      (now sees complete flows)
Step 4:  buildRouteGraph(...)          (identifyTraderTokens + legs succeed)
```

New pure helper `extractNativeTransfers(trace): { token, from, to, value }[]`,
mirroring `collectTraceLogs`. It walks the callTracer frames and, for each frame
that actually moves ETH, emits `{ token: WETH, from, to, value }`. Inclusion
rule:

- `value > 0`,
- frame type is `CALL` or `CALLCODE` (never `DELEGATECALL`/`STATICCALL`),
- the frame did **not** revert (skip frames carrying an `error`).

**Key decision: native ETH maps to the canonical WETH address, not a distinct
sentinel.** Rationale:

- It keeps cost math correct: WETH and native ETH are economically identical
  (18 decimals, same mid), so the V4 `USDC → ETH` leg prices as `USDC/WETH`.
- It avoids turning an **unwrap** into a spurious `WETH→ETH` swap leg. Canonical
  WETH9 `withdraw()` emits a `Withdrawal` event (no burn `Transfer`) plus a
  native ETH payout; under this mapping the WETH contract and the router end up
  as receive-only / send-only nodes, which the 1-in-1-out rule skips — rather
  than a clean two-sided swap. Unwraps are surfaced deliberately instead (§2).
- The graph's internal token identity is **display-invisible**: the receipt's
  input/output symbols come from `endpoints`, which already resolves native to
  `'ETH'`/`native`. Collapsing native into WETH inside the graph is therefore
  safe for display.

**Why this is robust against trace noise:**

- Gas is not a frame `value`, so it never enters the set.
- Pass-through hubs (the aggregator/router) net to zero across all tokens and
  are skipped, exactly as today.
- Fee recipients become receive-only (`recv=[WETH], sent=[]`) → skipped by
  `buildLegs`'s 1-in-1-out rule.
- With native modeled, the V4 PoolManager net-sends WETH, so
  `resolveV4Settlement` sees a complete picture (no spurious rewrite).

**Worked result for WARP** (verified against the live trace): after Step 3a the
trader nets `WARP` out / `WETH` (native) in → `identifyTraderTokens` succeeds;
the V4 PM leg becomes a clean `USDC → WETH`; the chain reconstructs as
`WARP → WETH → USDC → WETH` = `shape: 'linear'`, `reconstructed: true`, 3 costed
legs.

### 2. Wrap/unwrap informational steps

Because §1 collapses native↔WETH, a wrap/unwrap cannot be a *chained* leg (it
would be WETH→WETH). It is detected separately and appended for **display only**,
never part of chaining or cost/recon math.

Scan the already-collected logs for events emitted by the canonical WETH
contract (`0x4200000000000000000000000000000000000006`):

- `Deposit(dst, wad)` → a **Wrap (ETH→WETH)** step.
- `Withdrawal(src, wad)` → an **Unwrap (WETH→ETH)** step.

Each present direction yields **one** informational leg (amounts summed if the
event fires more than once), represented as:

```
{ type: 'wrap' | 'unwrap', venue: WETH, tokenIn, tokenOut,
  lpFeeBps: null, priceImpactBps: null, notionalUsdc: null }
```

Appended to `routeLegs` for display — wrap prepended (input side), unwrap
appended (output side). The dashboard labels them "Wrap (ETH→WETH)" /
"Unwrap (WETH→ETH)", links the WETH contract, and shows "–" for cost. They are
omitted from the Price Impact list to avoid redundant "–" rows.

The WARP trade contains **no** wrap/unwrap (V4 pays native ETH directly), so
these steps are additive for other trades and do not affect WARP.

### 3. Pools-touched fallback

When decomposition still yields **no costed legs** but the Swap-event scan found
pools, `decomposeRoute` emits best-effort **uncosted** entries instead of an
empty array — one per detected venue:

```
{ type, venue, tokenIn?, tokenOut?, lpFeeBps: null, priceImpactBps: null,
  notionalUsdc: null }
```

`tokenIn`/`tokenOut` are filled only when that venue's net flow is unambiguous
(clean 1-in-1-out); otherwise left undefined. This replaces the `legs: []` in the
`ROUTE_NOT_DECOMPOSED` branch (`decomposeRoute.ts:752`).

### 4. Render signal & receipt sections (dashboard)

A route counts as "decomposed" iff **at least one leg has a numeric
`lpFeeBps`**. `ReceiptView` then renders:

- **≥1 costed leg** → the existing per-leg **Liquidity Provider Fee** and
  **Price Impact** sections. Costed pools show numbers; wrap/unwrap rows show
  "–" (and are excluded from Price Impact).
- **0 costed legs but legs exist** (fallback venues and/or wrap/unwrap) → a
  distinct **"Pools Touched"** section: venue label + Basescan link +
  best-effort pair, no cost columns. Replaces the generic placeholder.
- **0 legs** → the placeholder row, relabeled from "Route" to **"No Route
  Found"**.

### 5. Data model & storage

**No DB migration.** `route_legs` (jsonb) gains two new entry shapes: uncosted
pool entries (null cost fields) and wrap/unwrap informational entries (new
`type` values `'wrap'`/`'unwrap'`). `routeShape`/`hopCount`/`routePure` keep
their meanings; a fixed WARP becomes `routeShape: 'linear'`, `hopCount: 3`,
`routePure: false`, with 3 costed legs.

Type/consumer updates:

- Core `analyzeTransaction` per-leg mapping (`analyzeTransaction.ts:282`) passes
  the new/uncosted leg shapes through unchanged (already `unknown[]`).
- Dashboard `RouteLeg` type + `normalizeRouteLegs` widen to accept
  `lpFeeBps: null` and `type` values `'wrap'`/`'unwrap'`.
- `getVenueLabel` learns the wrap/unwrap labels.

## Edge cases

- **Reverted / no-op sub-calls:** excluded via the `error`/type filter in
  `extractNativeTransfers`.
- **Mid-route unwrap in a WETH-in/WETH-out trade:** collapses to zero in the
  delta map (no distortion); still surfaced as an informational unwrap step.
- **Multiple `Deposit`/`Withdrawal` events:** collapsed to one step per
  direction with summed amounts.
- **Route with costed legs AND a genuine unwrap** (e.g. token→WETH pool then
  unwrap): renders normal costed sections plus the informational unwrap row.
- **Ambiguous fallback venue** (multi-token net flow): listed without a token
  pair rather than guessing.

## Testing

- **Core unit (injected fixtures, no RPC):**
  - `extractNativeTransfers` returns symmetric WETH transfers from a synthetic
    trace with native-value frames; skips reverted and `DELEGATECALL` frames.
  - A WARP-shaped fixture decomposes to a **linear 3-leg** costed chain.
  - `Withdrawal` → an unwrap step; `Deposit` → a wrap step.
  - An undecomposable-with-venues fixture yields uncosted pools-touched entries;
    a truly-empty trace yields zero legs.
- **Core live e2e (gated on `TCA_RPC_URL`):** upgrade the existing WARP
  `0xa21e4d82…` test — still `estimated` tier, and now `routeLegs` has 3 costed
  legs (`0x53932cbd` univ3, `0x72ab388e` maverickv2, `0x498581ff` univ4),
  `routeShape: 'linear'`, and no wrap/unwrap.
- **Dashboard:** ReceiptView renders costed legs for a native route; a "Pools
  Touched" section for an uncosted fallback; an informational unwrap row; and
  "No Route Found" when there are no legs.

## Rollout / compatibility

- Purely additive. Existing decomposed (non-native) routes are unaffected — the
  native transfer set is empty for them, and the render signal (≥1 costed leg)
  matches today's behavior.
- Historical native-ETH receipts remain `route_legs: []` until recomputed; they
  render the "No Route Found" placeholder (a strict improvement over the old
  "Route –"). Re-analyzing a hash recomputes with the new logic.

## Open implementation details (for the plan)

- Exact call-frame value field / type discrimination for `extractNativeTransfers`
  against the callTracer shape (`value`, `type`, `error`).
- Confirm the V4 `USDC/ETH` leg resolves its fee tier via the `v4FeeRaw` carried
  on the Swap event, and that its mid prices as `USDC/WETH`.
- Precise placement of wrap/unwrap steps within the ordered `routeLegs` array
  and their exclusion from `reconResidualBps` / execution math.
- Whether the "Pools Touched" heading is a new `BkdHeading` or a relabel of the
  existing sections.
