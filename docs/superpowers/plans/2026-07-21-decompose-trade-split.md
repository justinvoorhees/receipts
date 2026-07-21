# decompose-trade.ts Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `packages/core/src/decompose-trade.ts` (827 lines) into four focused modules with no behavior change, and rename it to `decomposeTrade.ts` to match the camelCase convention.

**Architecture:** Conservative split of a monolithic 619-line function whose RPC is interleaved. Extract only the pure pieces — the decoding primitives (`tradeDecoders.ts`), the Step-1 value-flow graph (`tradeValueGraph.ts`), and the two pure fee steps (`tradeFees.ts`) — leaving the RPC-bound Steps 2 and 4 in the coordinating function. Each extracted pure step returns its own `flags` array for the orchestrator to concatenate; no shared mutable flag state crosses a module boundary.

**Tech Stack:** TypeScript, viem, vitest. Built with `tsc --build` from the repo root; tests via `npx vitest run`; lint via `npm run lint`.

## Global Constraints

- **No behavior change.** Pure code motion + a file rename. Do not edit decomposition logic, fee/slippage math, thresholds, or flag strings.
- **Baseline: 427 tests pass across 32 files.** Every task must end with exactly 427 green. No new tests.
- **Three gates per task, in order:** `npx tsc --build` (clean), `npm run lint` (clean — catches imports/helpers orphaned by a move), `npx vitest run` (427 pass).
- **`flags` discipline (the correctness rule).** `flags` is a running `string[]` appended at 17 sites across the steps. Each extracted pure step must **return** its own `flags` array; the orchestrator concatenates them in the original step order. No extracted step receives-and-mutates the orchestrator's array. The suite asserts on specific flag strings and their presence — preserving flag content AND order is part of "no behavior change".
- **Move whole symbol bodies, byte-identical.** Reference symbols by name, not line number. The only permitted change to a moved body is an added `export` where specified.
- **Reconcile imports against the compiler.** The import blocks below are reference-counted from the source; after each edit, `tsc` names anything missing and `lint` names anything unused. Add/remove exactly what they report.
- Commit trailer on every commit:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01ATi8n599KY63NMFrzJzbg2
  ```

---

### Task 1: Rename `decompose-trade.ts` → `decomposeTrade.ts`

The file and its test are the only two kebab-case names in `core/src`, and the name mismatches its own export (`decomposeTrade`). Rename first, so all extraction happens in the correctly-named file. Nothing else in this task.

**Files:**
- Rename: `packages/core/src/decompose-trade.ts` → `packages/core/src/decomposeTrade.ts`
- Rename: `packages/core/src/decompose-trade.test.ts` → `packages/core/src/decomposeTrade.test.ts`
- Modify: `packages/core/src/decomposeRoute.ts` (import specifier)
- Modify: `packages/core/src/decomposeRoute.test.ts` (import specifier)

- [ ] **Step 1: git mv both files**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder
git mv packages/core/src/decompose-trade.ts packages/core/src/decomposeTrade.ts
git mv packages/core/src/decompose-trade.test.ts packages/core/src/decomposeTrade.test.ts
```

- [ ] **Step 2: Repoint the import specifiers**

In `packages/core/src/decomposeRoute.ts`, change:
```typescript
import { decomposeTrade, type DecomposeTradeInput } from './decompose-trade.js';
```
to:
```typescript
import { decomposeTrade, type DecomposeTradeInput } from './decomposeTrade.js';
```

In `packages/core/src/decomposeRoute.test.ts`, change:
```typescript
import type { DecomposeTradeInput } from './decompose-trade.js';
```
to:
```typescript
import type { DecomposeTradeInput } from './decomposeTrade.js';
```

The test's own self-import (`decomposeTrade.test.ts` line 3, importing `decodeV4SwapFees, decodeV3LikeSwaps` from `./decompose-trade.js`) must also change to `./decomposeTrade.js`. (Those decoders move to `tradeDecoders` in Task 2; leave the specifier at `./decomposeTrade.js` for now — Task 2 repoints it.)

No other file imports this module (confirmed: `analyzeTransaction.ts` and `tradeEndpoints.ts` only mention it in comments).

- [ ] **Step 3: Gate — tsc, lint, vitest**

```bash
npx tsc --build && npm run lint && npx vitest run 2>&1 | grep -E "Tests |Test Files "
```
Expected: tsc exits 0, lint no errors, `Test Files 32 passed (32)` / `Tests 427 passed (427)`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(core): rename decompose-trade.ts to decomposeTrade.ts

The file and its test were the only two kebab-case names in core/src, and the
name mismatched its own export (decomposeTrade). Pure rename via git mv;
repointed the two import specifiers in decomposeRoute.{ts,test.ts}.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ATi8n599KY63NMFrzJzbg2
EOF
)"
```

---

### Task 2: Extract `tradeDecoders.ts`

The decoding primitives — swap/sync/wrap topic + event constants and the two tail decoders — have no dependency on the rest of the function.

**Files:**
- Create: `packages/core/src/tradeDecoders.ts`
- Modify: `packages/core/src/decomposeTrade.ts` (remove moved symbols, add import)
- Modify: `packages/core/src/decomposeTrade.test.ts` (repoint decoder import)

**Interfaces:**
- Produces (exported from `tradeDecoders.ts`):
  - All the topic/event constants (names below)
  - `decodeV3LikeSwaps(logs: readonly LogLike[], recognizeForks: boolean): Array<...>` — keep the exact current signature and body
  - `decodeV4SwapFees(logs: readonly LogLike[]): number[]` — keep exact

- [ ] **Step 1: Create `tradeDecoders.ts`**

```typescript
/**
 * tradeDecoders — swap/sync/wrap event topics and the log decoders for trade
 * decomposition. Split out of decomposeTrade.ts (2026-07-21). Pure: decodes logs,
 * no RPC and no shared state. These constants stay local to decompose-trade's world
 * (deliberately NOT deduped against routeVenueScan.ts, which is a separate subsystem).
 */
import { parseAbiItem, toEventSelector, decodeEventLog } from 'viem';
import type { LogLike } from './tradeEndpoints.js';
```

Move these symbols from `decomposeTrade.ts` (full bodies + doc comments), keeping every value byte-identical:
- Constants: `SWAP_TOPIC`, `V3_SWAP_EVENT`, `PANCAKE_V3_SWAP_TOPIC`, `PANCAKE_V3_SWAP_EVENT`, `V4_SWAP_EVENT`, `V4_SWAP_TOPIC`, `V2_SWAP_TOPIC`, `V2_SYNC_TOPIC`, `AERODROME_SWAP_TOPIC`, `AERODROME_SYNC_TOPIC`, `WITHDRAWAL_TOPIC`, `DEPOSIT_TOPIC`, `UNISWAP_V4_POOL_MANAGER`
- Functions: `decodeV3LikeSwaps`, `decodeV4SwapFees` (both already `export`ed — keep it)

Add `export` to each moved constant (the orchestrator and `tradeValueGraph` import them).

- [ ] **Step 2: Update `decomposeTrade.ts`**

Remove those symbols. Add an import for the constants the orchestrator still uses (Steps 2 and 4 use the swap/sync topics + `UNISWAP_V4_POOL_MANAGER`; Step 1 — until Task 3 moves it — uses `WITHDRAWAL_TOPIC`/`DEPOSIT_TOPIC`):

```typescript
import {
	SWAP_TOPIC,
	V3_SWAP_EVENT,
	PANCAKE_V3_SWAP_TOPIC,
	PANCAKE_V3_SWAP_EVENT,
	V4_SWAP_EVENT,
	V4_SWAP_TOPIC,
	V2_SWAP_TOPIC,
	V2_SYNC_TOPIC,
	AERODROME_SWAP_TOPIC,
	AERODROME_SYNC_TOPIC,
	WITHDRAWAL_TOPIC,
	DEPOSIT_TOPIC,
	UNISWAP_V4_POOL_MANAGER,
	decodeV3LikeSwaps,
	decodeV4SwapFees,
} from './tradeDecoders.js';
```

Then remove now-unused viem imports from `decomposeTrade.ts` — `toEventSelector` (only used by `V4_SWAP_TOPIC`, moved) is a candidate; `parseAbiItem`/`decodeEventLog` may still be used elsewhere in the orchestrator. **Remove exactly what lint names.** Reconcile: if lint flags any of the 15 imported names above as unused (e.g. a constant only Step 1 used, and this is after Task 3), remove it — but in Task 2 all should be used.

- [ ] **Step 3: Repoint the test's decoder import**

In `packages/core/src/decomposeTrade.test.ts`, change:
```typescript
import { decodeV4SwapFees, decodeV3LikeSwaps } from './decomposeTrade.js';
```
to:
```typescript
import { decodeV4SwapFees, decodeV3LikeSwaps } from './tradeDecoders.js';
```

- [ ] **Step 4: Gate — tsc, lint, vitest**

```bash
npx tsc --build && npm run lint && npx vitest run 2>&1 | grep -E "Tests |Test Files "
```
Expected: clean / clean / 427 passed. Reconcile any import lint/tsc names.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tradeDecoders.ts packages/core/src/decomposeTrade.ts packages/core/src/decomposeTrade.test.ts
git commit -m "$(cat <<'EOF'
refactor(core): extract tradeDecoders from decomposeTrade

The swap/sync/wrap event constants and the two log decoders (decodeV3LikeSwaps,
decodeV4SwapFees) move to their own pure module. Test decoder import repointed.
Pure code motion; suite unchanged at 427.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ATi8n599KY63NMFrzJzbg2
EOF
)"
```

---

### Task 3: Extract `tradeValueGraph.ts` (Step 1)

The value-flow graph is the cleanest step: one input, three outputs, no shared state.

**Files:**
- Create: `packages/core/src/tradeValueGraph.ts`
- Modify: `packages/core/src/decomposeTrade.ts`

**Interfaces:**
- Consumes: `WITHDRAWAL_TOPIC`, `DEPOSIT_TOPIC` from `tradeDecoders` (Task 2).
- Produces:
  - `buildValueFlowGraph(trace: TraceNode): { logs: LogLike[]; transfers: RawTransfer[]; addrDeltas: Map<string, { usdc: number; weth: number; nativeEth: number }> }`

- [ ] **Step 1: Create `tradeValueGraph.ts`**

```typescript
/**
 * tradeValueGraph — Step 1 of trade decomposition: from the callTracer trace,
 * build per-address net USDC/WETH/native-ETH deltas (the value-flow graph).
 * Split out of decomposeTrade.ts (2026-07-21). Pure.
 */
import {
	collectTraceLogs,
	decodeTransferLogs,
	collectNativeEthDeltas,
	USDC,
	WETH,
	type TraceNode,
	type LogLike,
	type RawTransfer,
} from './tradeEndpoints.js';
import { WITHDRAWAL_TOPIC, DEPOSIT_TOPIC } from './tradeDecoders.js';
```

Move the body of Step 1 (the block under `// ── Step 1: Collect all logs and build value-flow graph ──`, from `const logs = collectTraceLogs(...)` through the native-ETH-deltas loop that ends Step 1, just before `// ── Step 2`) into this function:

```typescript
export function buildValueFlowGraph(trace: TraceNode): {
	logs: LogLike[];
	transfers: RawTransfer[];
	addrDeltas: Map<string, { usdc: number; weth: number; nativeEth: number }>;
} {
	// ... the moved Step-1 body, verbatim, using `trace` (was `input.trace`) ...
	return { logs, transfers, addrDeltas };
}
```

Two mechanical adjustments inside the moved body (NOT behavior changes): `input.trace` becomes the `trace` parameter; `nativeEthDeltas` remains a local (it is not returned — it is only used to populate `addrDeltas`).

- [ ] **Step 2: Export `RawTransfer` from `tradeEndpoints.ts`**

In `packages/core/src/tradeEndpoints.ts`, add `export` to the `RawTransfer` interface (it is currently private and only inferred; it now crosses a module boundary as a typed return):

```typescript
export interface RawTransfer {
```

- [ ] **Step 3: Update `decomposeTrade.ts` to call `buildValueFlowGraph`**

Replace the entire Step-1 body with a call. Add the import:

```typescript
import { buildValueFlowGraph } from './tradeValueGraph.js';
```

Replace the Step-1 block with:

```typescript
	// ── Step 1: Collect all logs and build value-flow graph ──
	const { logs, transfers, addrDeltas } = buildValueFlowGraph(input.trace);
```

Then remove imports from `decomposeTrade.ts` that Step 1 was the sole user of — `collectTraceLogs`, `collectNativeEthDeltas` are candidates (Steps 2/4 may still use `decodeTransferLogs`? No — `transfers` now comes from the graph; check). **Remove exactly what lint names**; `WITHDRAWAL_TOPIC`/`DEPOSIT_TOPIC` are now used only by `tradeValueGraph`, so lint will flag them as unused in `decomposeTrade` — remove them from its `tradeDecoders` import.

- [ ] **Step 4: Gate — tsc, lint, vitest**

```bash
npx tsc --build && npm run lint && npx vitest run 2>&1 | grep -E "Tests |Test Files "
```
Expected: clean / clean / 427 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tradeValueGraph.ts packages/core/src/decomposeTrade.ts packages/core/src/tradeEndpoints.ts
git commit -m "$(cat <<'EOF'
refactor(core): extract tradeValueGraph (Step 1) from decomposeTrade

Step 1 — build per-address USDC/WETH/native-ETH deltas from the trace — becomes
a pure buildValueFlowGraph(trace) => { logs, transfers, addrDeltas }. RawTransfer
gains export from tradeEndpoints (now crosses a module boundary). Pure code
motion; suite unchanged at 427.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ATi8n599KY63NMFrzJzbg2
EOF
)"
```

---

### Task 4: Extract `tradeFees.ts` (Steps 3 and 4b)

The two pure fee steps. This is the largest task and the one to review most carefully — `computeAggFee` has an 8-field input contract, and both steps must return their `flags` for the orchestrator to concatenate in order.

**Files:**
- Create: `packages/core/src/tradeFees.ts`
- Modify: `packages/core/src/decomposeTrade.ts`

**Interfaces:**
- Consumes: `RawTransfer` (exported in Task 3), `USDC`/`WETH`/`DENYLIST` from `tradeEndpoints`.
- Produces:
  - `interface FeeSink` (moved here — its producer)
  - `computeAggFee(args: { transfers: RawTransfer[]; addrDeltas: Map<string, { usdc: number; weth: number; nativeEth: number }>; isInfra: (addr: string) => boolean; knownVaults: Set<string>; dustUsdc: number; structuralFloor: number; realizedPrice: number; notionalUsdc: number }): { aggFeeBps: number; feeSinks: FeeSink[]; vaultMapFeeUsdc: number; flags: string[] }`
  - `detectRoutePurity(args: { transfers: RawTransfer[]; venueAddresses: Set<string>; impureOnVenueThirdToken: boolean }): { isImpure: boolean; thirdTokens: Set<string>; thirdTokenHubs: Map<string, string> }` — **no `flags`**: Step 4b's moved range pushes none; the impurity flag is pushed later in the orchestrator (Step 6, based on `isImpure`) and stays there.

- [ ] **Step 1: Create `tradeFees.ts` with `FeeSink`, `computeAggFee`, `detectRoutePurity`**

```typescript
/**
 * tradeFees — the pure fee steps of trade decomposition. Step 3 (aggregator-fee
 * sink detection) and Step 4b (route-purity detection). Split out of
 * decomposeTrade.ts (2026-07-21). Pure: no RPC. Each function returns its own
 * `flags` array for the orchestrator to concatenate in step order — never mutates
 * a shared array.
 */
import { USDC, WETH, DENYLIST, type RawTransfer } from './tradeEndpoints.js';

export interface FeeSink {
	// ... the exact current FeeSink fields, moved verbatim from decomposeTrade.ts ...
}
```

Move the `FeeSink` interface from `decomposeTrade.ts` here (byte-identical fields).

Create `computeAggFee` by wrapping the current Step-3 body (from `// ── Step 3: Agg fee ──` through the `aggFeeBps`/`AGG_FEE_FLOORED` finalization, ending just before `// ── Step 4: LP fee`). Mechanical adjustments only:
- The free variables it reads become destructured parameters: `transfers`, `addrDeltas`, `isInfra`, `knownVaults`, `dustUsdc`, `structuralFloor`, and `input.realizedPrice`/`input.notionalUsdc` become `realizedPrice`/`notionalUsdc`.
- It declares its own `const flags: string[] = []` at the top and `push`es to that; return it.
- Return `{ aggFeeBps, feeSinks, vaultMapFeeUsdc, flags }`.

Create `detectRoutePurity` by wrapping the current Step-4b body (from `// ── Step 4b: Route-purity detection ──` through `const isImpure = thirdTokens.size > 0;`). Mechanical adjustments only:
- Free variables become parameters: `transfers`, `venueAddresses`, and `input.impureOnVenueThirdToken` → `impureOnVenueThirdToken`.
- It uses `DENYLIST`, `USDC`, `WETH`, and the `DUST_USDC` constant — move the `DUST_USDC` constant definition into `tradeFees.ts` (it is used only by Step 4b after this split). Define it near the top: `const DUST_USDC = 0.01;` (byte-identical to the original).
- Step 4b pushes **no flags** in the moved range (verified: its only flag, `MULTI-HOP: …`, is pushed later in the orchestrator based on `isImpure`). So `detectRoutePurity` returns `{ isImpure, thirdTokens, thirdTokenHubs }` — no `flags` field.

- [ ] **Step 2: Update `decomposeTrade.ts` to call the two functions**

Add the import:
```typescript
import { computeAggFee, detectRoutePurity, type FeeSink } from './tradeFees.js';
```

Replace the Step-3 body with a call, threading its flags into the orchestrator's `flags` in order:
```typescript
	// ── Step 3: Agg fee (≥ 0) ──
	const aggFee = computeAggFee({
		transfers, addrDeltas, isInfra, knownVaults,
		dustUsdc, structuralFloor,
		realizedPrice: input.realizedPrice,
		notionalUsdc: input.notionalUsdc,
	});
	const { aggFeeBps, feeSinks, vaultMapFeeUsdc } = aggFee;
	flags.push(...aggFee.flags);
```

Replace the Step-4b body with a call, likewise:
```typescript
	// ── Step 4b: Route-purity detection ──
	const { isImpure, thirdTokens, thirdTokenHubs } = detectRoutePurity({
		transfers, venueAddresses,
		impureOnVenueThirdToken: input.impureOnVenueThirdToken,
	});
```

**Flag-order check:** confirm `flags.push(...aggFee.flags)` sits exactly where Step 3's pushes were (before Step 4 begins). Step 4b contributes no flags. The orchestrator's own `flags` array and its pushes in Steps 2/4/6 (including the `MULTI-HOP` push that reads `isImpure`) are unchanged.

Remove the now-moved `DUST_USDC` constant and `FeeSink` interface from `decomposeTrade.ts`. Reconcile imports per lint (`DENYLIST` may now be unused in the orchestrator if Step 4b was its only user — remove if lint says so).

- [ ] **Step 3: Gate — tsc, lint, vitest**

```bash
npx tsc --build && npm run lint && npx vitest run 2>&1 | grep -E "Tests |Test Files "
```
Expected: clean / clean / 427 passed. If any test asserting on a flag string fails, the flag content or order was altered — revisit Step 2's concatenation, do NOT edit the flag strings.

- [ ] **Step 4: Verify the running app still decomposes a receipt**

With the dev server on `:3000`, confirm a multi-leg trade still renders (its Cost Breakdown is what decomposeTrade feeds):
```bash
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/?tx=0x021f814d6ee757fc771f3fc27b282112faad751aa9160b5f6b707aabd7e44d1d"
```
Expected: `200`. If the dev server is not running, note it and rely on the suite; do NOT run `next build`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tradeFees.ts packages/core/src/decomposeTrade.ts
git commit -m "$(cat <<'EOF'
refactor(core): extract tradeFees (Steps 3 + 4b) from decomposeTrade

The two pure fee steps — computeAggFee (aggregator-fee sink detection) and
detectRoutePurity — move to their own module, along with FeeSink (its producer)
and the DUST_USDC constant. Each returns its own flags array; the orchestrator
concatenates them in the original step order. Pure code motion; suite unchanged
at 427, dev render 200.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ATi8n599KY63NMFrzJzbg2
EOF
)"
```

---

### Task 5: Update the refactor backlog memory

**Files:**
- Modify: `/Users/justinvoorhees/.claude/projects/-Users-justinvoorhees-withfabricxyz-fabric-tca-decoder/memory/refactor-backlog.md`
- Modify: `/Users/justinvoorhees/.claude/projects/-Users-justinvoorhees-withfabricxyz-fabric-tca-decoder/memory/MEMORY.md`

- [ ] **Step 1: Record the split as done**

In `refactor-backlog.md`, remove `decompose-trade.ts` from the "still open" list and add a DONE entry naming the four modules (`tradeDecoders`, `tradeValueGraph`, `tradeFees`, `decomposeTrade`), the rename, and the commit range. Update the MEMORY.md index line so only `ReceiptView.tsx` split and the `Direction` rename remain open. (Memory files live outside the repo — no commit needed.)

---

## Notes for the executor

- **Task order is load-bearing.** Rename first (Task 1) so all extraction lands in `decomposeTrade.ts`. Then leaf-up: decoders (Task 2) before value-graph (Task 3, which imports the wrap topics), before fees (Task 4).
- **Task 4 is the risk.** `computeAggFee`'s 8-input contract and the flag ordering are where a subtle behavior change could hide. If a gate fails, the fix is in the parameter threading or the flag concatenation — never in the moved logic or the flag strings.
- **If a gate fails, stop and diagnose.** A failing test after pure code motion means a symbol, import, or flag was missed — not that behavior changed.
- **Expected final shape:** `tradeDecoders.ts` ~120L, `tradeValueGraph.ts` ~90L, `tradeFees.ts` ~200L, `decomposeTrade.ts` ~380L. If `decomposeTrade.ts` is still >500L after Task 4, a step that should have moved was left behind.
