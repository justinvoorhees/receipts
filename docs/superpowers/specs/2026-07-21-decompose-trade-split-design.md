# decompose-trade.ts split — design

**Date:** 2026-07-21
**Scope:** `packages/core/src/decompose-trade.ts` (827L) → four modules, and rename
the file to `decomposeTrade.ts` to match the camelCase convention. Pure code
motion. **No behavior change** beyond what a move/rename forces.

## Why

`decompose-trade.ts` is dominated by a single **619-line function** (`decomposeTrade`)
that runs seven sequential steps. Unlike `decomposeRoute.ts` (split earlier the same
day), its RPC calls are *interleaved* — Step 2 probes addresses with `fee()`/
`getReserves()`, Step 4 does per-hop `fee()` calls — sharing an `rpc` client and a
pool-info cache with the surrounding logic. So there is no clean "isolate all I/O"
seam. The safe, high-value move is to extract the **pure** steps and the leaf
primitives, shrinking the orchestrator without threading RPC state across module
boundaries.

The file is also the lone kebab-case outlier: it and its test are the only two
hyphenated names among 30 files in `core/src`, and the name even mismatches its own
export (`decomposeTrade`). The split rewrites the file anyway, so it is renamed in the
same pass.

## Split depth (decided)

Conservative: extract the leaf primitives and the genuinely-pure steps; leave the
RPC-bound orchestration (Steps 2 and 4) in the coordinating function. **Not** a full
seven-step decomposition (Steps 2/4 threading shared mutable state across the RPC
boundary was rejected as too risky for a no-behavior-change refactor). **Not** a
dedup of the swap-topic constants against `routeVenueScan.ts` — that would couple two
independent subsystems; the constants stay local to this file's own decoder module.

## The four modules

### 1. `tradeDecoders.ts` (~120L) — decoding primitives

- The swap/sync/wrap topic + event constants: `SWAP_TOPIC`, `V3_SWAP_EVENT`,
  `PANCAKE_V3_SWAP_TOPIC`, `PANCAKE_V3_SWAP_EVENT`, `V4_SWAP_EVENT`, `V4_SWAP_TOPIC`,
  `V2_SWAP_TOPIC`, `V2_SYNC_TOPIC`, `AERODROME_SWAP_TOPIC`, `AERODROME_SYNC_TOPIC`,
  `WITHDRAWAL_TOPIC`, `DEPOSIT_TOPIC`, `UNISWAP_V4_POOL_MANAGER`.
- The two tail decoders: `decodeV3LikeSwaps`, `decodeV4SwapFees`.
- Imports: `viem` (`parseAbiItem`, `toEventSelector`, `decodeEventLog`), and the
  `LogLike` type from `tradeEndpoints`. **Imports nothing internal to this split.**
- The constants are exported so `tradeValueGraph` and the orchestrator can share them.

### 2. `tradeValueGraph.ts` (~90L) — Step 1, the value-flow graph

- `buildValueFlowGraph(trace: TraceNode) => { logs: LogLike[]; transfers: RawTransfer[]; addrDeltas: Map<string, { usdc: number; weth: number; nativeEth: number }> }`
- Pure. The cleanest extraction: one input, three outputs, no shared state.
- Imports: `collectTraceLogs`, `decodeTransferLogs`, `collectNativeEthDeltas`, `USDC`,
  `WETH`, and the `TraceNode`/`LogLike`/`RawTransfer` types from `tradeEndpoints`
  (`RawTransfer` newly exported — see Open decisions); `WITHDRAWAL_TOPIC`,
  `DEPOSIT_TOPIC` from `tradeDecoders`.

### 3. `tradeFees.ts` (~200L) — the two pure fee steps

- `computeAggFee(...)` — Step 3. Inputs (bounded): `transfers`, `addrDeltas`,
  an `isInfra: (addr: string) => boolean` predicate, `realizedPrice`, `dustUsdc`,
  `knownVaults: Set<string>`. Returns `{ feeSinks: FeeSink[]; flags: string[]; ... }`
  — see the flags note below. This is the one non-trivial interface; it is the seam
  to watch in review.
- `detectRoutePurity(...)` — Step 4b. Inputs: `transfers`, `venueAddresses: Set<string>`,
  `impureOnVenueThirdToken: boolean`. Returns `{ isImpure: boolean; thirdTokens: Set<string>; thirdTokenHubs: Map<string, string>; flags: string[] }`.
- `interface FeeSink` lives here (its producer), so the orchestrator imports it —
  the one-directional edge that avoids a cycle.
- Imports: `USDC`, `WETH`, `DENYLIST` from `tradeEndpoints`; the `DUST_USDC` constant
  (moves here with Step 4b, or is passed in — see Open decisions).

### 4. `decomposeTrade.ts` (~380L) — orchestrator (renamed from decompose-trade.ts)

- The `decomposeTrade` function: Step 2 (RPC address classification), Step 4 (RPC
  per-hop LP fee), Step 5 (slippage), Step 6 (gas + result assembly), calling the
  extracted pure steps for Steps 1, 3, 4b.
- The RPC-bound constants: `POOL_FEE_TIERS`, `AGG_FEE_VAULTS`, `COUNTERPARTY_THRESHOLD`,
  `STRUCTURAL_FEE_FLOOR_USD`, `STRUCTURAL_FEE_FLOOR_BPS`.
- The public interface types: `DecomposeTradeInput`, `VenueHop`, `DecomposeResult`
  (which references `FeeSink`, imported from `tradeFees`).
- Imports all three new modules.

## The `flags` discipline (the correctness rule)

`flags` is a running `string[]` appended at 17 sites across the seven steps. In the
current monolith it is one shared array. After the split, each extracted pure step
**returns its own `flags` array**, and the orchestrator concatenates them in the
original step order. No extracted step may receive and mutate the orchestrator's
array — that would reintroduce the shared-state coupling the split removes, and get
the flag ordering wrong. Preserving flag *content and order* is part of "no behavior
change" and must be checked in review (the suite asserts on specific flag strings).

## Dependency graph

```
analyzeTransaction ──▶ decomposeTrade ──▶ tradeDecoders
decomposeRoute ────────▶ decomposeTrade ─▶ tradeValueGraph ──▶ tradeDecoders
                                        └─▶ tradeFees
```

`tradeDecoders`, `tradeValueGraph`, and `tradeFees` import only external leaves (and
`tradeValueGraph`/orchestrator import `tradeDecoders`). No back edges.

## The rename

`git mv decompose-trade.ts decomposeTrade.ts` and
`git mv decompose-trade.test.ts decomposeTrade.test.ts` (history preserved). Update
the `.js` import specifier at the two external import sites — `decomposeRoute.ts` and
`decomposeRoute.test.ts` — from `./decompose-trade.js` to `./decomposeTrade.js`, and
the test's own self-import.

## Import-site updates

`analyzeTransaction.ts` imports `decomposeTrade` + `DecomposeTradeInput` — after the
rename, from `./decomposeTrade.js` (same symbols, new path). The test
(`decomposeTrade.test.ts`) imports `decodeV3LikeSwaps`/`decodeV4SwapFees`, which move
to `tradeDecoders` — repoint those to `./tradeDecoders.js`. No other consumer exists.

## Open decisions (resolved)

- **`DUST_USDC` placement:** used by Step 4b (`tradeFees`) and nowhere else after the
  split → moves to `tradeFees.ts`. `dustUsdc` (the per-call profile override) stays a
  parameter, as today.
- **`isInfra` for `computeAggFee`:** passed as a predicate parameter rather than
  rebuilt inside — it closes over `DENYLIST` + `venueAddresses`, both known to the
  orchestrator at call time. Keeps `computeAggFee` free of venue-classification logic.
- **`RawTransfer` gains `export` in `tradeEndpoints.ts`.** It is currently private
  there and the monolith merely *infers* it from `decodeTransferLogs`. Once the
  `transfers` array is passed as a typed parameter into `computeAggFee` /
  `detectRoutePurity` / `buildValueFlowGraph`'s return, the type must be nameable
  across modules. Exporting it is a one-line visibility change, directly analogous to
  the `LogLike`/`TraceNode` exports made in the decomposeRoute split. `tradeValueGraph`
  and `tradeFees` import `type RawTransfer` from `tradeEndpoints`.

## Testing

Pure code motion + a rename, so the existing suite is the whole safety net — no new
tests. Baseline: **427 pass across 32 files** (`decompose-trade.test.ts` is one of
them; it renames but its assertions are unchanged). Gate every step with
`tsc --build` + `npm run lint` + `vitest run`. Lint catches imports and helpers
orphaned by a move.

Because a human-authored 619-line function is being carved into pure steps, the
review must additionally confirm, per extracted step, that the moved body is
byte-identical to the original and that flag content/order is preserved.

## Out of scope

- Decomposing Steps 2 and 4 (the RPC-bound orchestration).
- Deduping swap-topic constants against `routeVenueScan.ts`.
- The `ReceiptView.tsx` split and the `Direction` rename — separate backlog items.
