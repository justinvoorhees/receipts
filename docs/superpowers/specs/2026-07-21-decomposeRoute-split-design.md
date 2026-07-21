# decomposeRoute.ts split — design

**Date:** 2026-07-21
**Scope:** `packages/core/src/decomposeRoute.ts` (1144L) → three focused modules.
Pure code motion. **No behavior change.** No logic edits beyond what a move forces
(exporting three now-private factories; redistributing imports).

## Why

`decomposeRoute.ts` is the largest file in the project and does several jobs at
once: it orchestrates route decomposition, scans a trace for venues, builds the
RPC-backed default readers, computes per-leg mids, and detects wrap/unwrap steps.
Phase 3 of the 2026-07-21 refactor audit flagged it; this is the design for the
split the audit deferred pending a spec.

The file is already sectioned with banners and — the key structural fact — **every
viem/RPC call is confined to the `createDefault*` reader factories.** The rest is
pure or operates on injected `DecomposeRouteDeps`. That gives a clean primary seam:
isolate the I/O from the pure decomposition logic.

## The three modules

Boundaries verified against the current file: cross-references were traced so the
result is a one-directional DAG with no new cycle.

### 1. `routeReaders.ts` (~360L) — the RPC surface

Everything that touches viem, in one place.

- `createDefaultFeeReader`, `createDefaultV3FactoryReader`, `createDefaultRfqProbe`,
  `createDefaultMidReader`
- `getLegMidAtBlock` + `sortLegTokens` — the per-leg mid *read*. **These move here,
  not into decomposeRoute, and that placement is load-bearing:**
  `createDefaultMidReader` is `getLegMidAtBlock`'s only production caller, so keeping
  the reader here while the function stayed in decomposeRoute would create a new
  cycle (routeReaders → decomposeRoute → routeReaders). Co-locating them avoids it.
- Constant: `EIP1967_IMPL_SLOT` (used only by the rfq probe).
- Imports: viem, `poolDiscovery`, `tokenPricing`, `priceMath`, and types from
  `routeGraph` (`Leg`, `VenueType`) / `tokenPricing` (`PairMidResult`).
- **Imports nothing from `decomposeRoute.ts` or `routeVenueScan.ts`.**
- The three fee/factory/rfq factories are currently *private* (`function`, no
  `export`). They become exported so the orchestrator can import them. This is the
  only visibility change in the split.

### 2. `routeVenueScan.ts` (~210L) — venue detection

- `scanVenues`, `addKnownVenuesFromTransfers`, `addKnownFactoryVenuesFromTransfers`,
  `refineV3VenueTypes`, and the `VenueInfo` interface.
- The 9 swap-topic constants (`PANCAKE_V3_SWAP_TOPIC`, `UNI_V3_SWAP_TOPIC`,
  `V4_SWAP_TOPIC` + its `V4_SWAP_EVENT`, `V2_SWAP_TOPIC`, `AERODROME_SWAP_TOPIC`,
  `MAVERICK_V1/V2_SWAP_TOPIC`, `UNIPOOL_SWAP_TOPIC`, `CURVE_TOKEN_EXCHANGE_TOPIC`) —
  each is referenced only inside this region.
- Imports: `venueClassification`, types from `routeGraph`/`tradeEndpoints`, viem
  (`parseAbiItem`, `toEventSelector`) for the V4 event.
- The V3 factory reader is passed **in** as a parameter (already DI), so this module
  does **not** import `routeReaders`.
- **Imports nothing from `decomposeRoute.ts`.**

### 3. `decomposeRoute.ts` (~640L) — orchestrator + pure logic

The remainder, and it stays the public entry point.

- `decomposeRoute` (the orchestrator / composition root), `weightedPriceImpactBps`.
- Wrap/unwrap helpers: `extractNativeTransfers`, `detectWrapUnwrapSteps`,
  `wrapUnwrapToLegEntry`, `venuesToUncostedLegs`, plus `WETH_DEPOSIT_TOPIC` /
  `WETH_WITHDRAWAL_TOPIC`.
- `resolveV4Settlement` + `UNISWAP_V4_POOL_MANAGER`.
- The inline `decimalsOf` fallback (USDC=6 / else=18).
- Interfaces `RouteDecomposeResult`, `DecomposeRouteDeps`.
- Orchestrator constants: `RFQ_FILL_TOPICS`, `LEG_FEE_CAP_BPS`,
  `PI_IMPLAUSIBLE_CAP_BPS`, `RECON_TOL_BPS`, `RECON_LOW_BPS`.
- Imports `createDefault*` from `routeReaders` and the scan functions from
  `routeVenueScan`, then wires them (`deps?.X ?? createDefaultX(...)`).

## Resulting dependency graph

```
analyzeTransaction ──▶ decomposeRoute ──▶ routeReaders
                                     └──▶ routeVenueScan
analyzeTransaction ──▶ routeReaders (createDefaultMidReader)
```

`routeReaders` and `routeVenueScan` import only external leaves. No back edges.

The current file's *external* imports also partition cleanly, one module each —
verified by reference-counting per region:
- venue-classification (`classifyKnownVenueAddress`, `classifyV3Factory`) → scan only
- pool/price reads (`readSlot0`, `readV4Slot0`, `readV2Reserves`, `getPairMidAtBlock`,
  `makeRpcDecimalsCache`, `sqrtPriceX96ToPrice`, `v2MidFromReserves`) → readers only
- graph/fee/trade (`buildRouteGraph`, `valueLegNotionalUsdc`, `rollupLpFee`,
  `decomposeTrade`, `collectTraceLogs`, `decodeTransferLogs`, `DENYLIST`) → orchestrator only

So the top-of-file import block splits three ways with no import duplicated across
modules — a good signal the seams match the real dependency structure.

## Import-site updates (chosen: update, not re-export)

Two consumers reference symbols that move to `routeReaders`. Both are updated to
name the true source — no barrel shim.

- `analyzeTransaction.ts`: `createDefaultMidReader` now from `./routeReaders.js`;
  `decomposeRoute` stays from `./decomposeRoute.js`.
- `decomposeRoute.test.ts`: `getLegMidAtBlock` now from `./routeReaders.js`; the
  other five (`decomposeRoute`, `extractNativeTransfers`, `detectWrapUnwrapSteps`,
  `venuesToUncostedLegs`, `weightedPriceImpactBps`) stay from `./decomposeRoute.js`.

No other production or test file imports from `decomposeRoute.ts`.

## Testing

The split is pure code motion, so the existing suite is the whole safety net — no
new tests. Gate every step with `tsc --build` + `npm run lint` + `vitest run`. The
lint config is load-bearing here: moving a function orphans imports and private
helpers in the source file, and lint reports each so nothing is left dangling.

`decomposeRoute.test.ts` continues to exercise `getLegMidAtBlock` (now imported
from `routeReaders`) and drives the orchestrator through injected fake readers, so
both extracted modules stay covered. Suite baseline before the split: 427 pass.

Additionally verify the running dev server still renders a decomposed receipt
(a multi-leg trade) at `200` — the decomposition feeds the Cost Breakdown section.

## Out of scope

- Any change to decomposition *logic*, fee/mid math, or the reconciliation rules.
- The other oversized files (`decompose-trade.ts`, `ReceiptView.tsx`) and the
  `Direction` v1-vestige rename — separate items in the refactor backlog.
- Splitting the ~340L orchestrator itself further; it is one coherent job.
