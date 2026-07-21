# decomposeRoute.ts Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `packages/core/src/decomposeRoute.ts` (1113 lines) into three focused modules with no behavior change.

**Architecture:** Pure code motion along the seam identified in the spec: the entire viem/RPC surface (`routeReaders.ts`), venue detection (`routeVenueScan.ts`), and the orchestrator + pure logic (`decomposeRoute.ts`, the remainder and public entry point). The result is a one-directional dependency graph — both new modules import only external leaves, and `decomposeRoute` imports from both. `getLegMidAtBlock` moves *with* the readers because its only production caller is `createDefaultMidReader`; leaving it behind would create a new cycle.

**Tech Stack:** TypeScript, viem, vitest. Monorepo built with `tsc --build` from the repo root; tests via `npx vitest run`; lint via `npm run lint`.

## Global Constraints

- **No behavior change.** This is code motion only. Do not edit decomposition logic, fee/mid math, or reconciliation rules.
- **The existing suite is the whole safety net.** Baseline: **427 tests pass** across 32 files. No new tests are written; every task must end with the full suite green.
- **Three gates per task, in order:** `npx tsc --build` (clean), `npm run lint` (clean — this catches imports and private helpers orphaned by a move), `npx vitest run` (427 pass). A task is not done until all three pass.
- **Move whole symbol bodies.** Reference symbols by name, not line number — line numbers drift as code is removed. Move each named symbol's full body (signature through its closing brace) plus its leading doc-comment.
- **Reconcile imports against the compiler.** Each new module's import block below is derived from a reference-count of the moved region. After creating a file, `tsc` reports anything missing and `lint` reports anything unused — add/remove to match its output rather than assuming the block is exhaustive.
- Commit message trailer on every commit:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01ATi8n599KY63NMFrzJzbg2
  ```

---

### Task 1: Extract `routeVenueScan.ts`

Venue detection has no dependency on the readers or the orchestrator (its factory reader arrives as a function parameter), so it extracts cleanly first.

**Files:**
- Create: `packages/core/src/routeVenueScan.ts`
- Modify: `packages/core/src/decomposeRoute.ts` (remove the moved symbols, add one import)

**Interfaces:**
- Produces (exported from `routeVenueScan.ts`, consumed by `decomposeRoute.ts`):
  - `scanVenues(logs: readonly LogLike[], recognizeForks: boolean): Map<string, VenueInfo>`
  - `addKnownVenuesFromTransfers(...)` — keep the exact current signature
  - `addKnownFactoryVenuesFromTransfers(...)` — keep the exact current signature (async)
  - `refineV3VenueTypes(...)` — keep the exact current signature (async)
  - `interface VenueInfo`
- Consumes: nothing from other tasks.

- [ ] **Step 1: Create `routeVenueScan.ts` with its imports and moved symbols**

Create the file with this header, then paste the moved bodies below it (Step 2 removes them from the source):

```typescript
/**
 * routeVenueScan — detect the swap venues a trade touched, from its trace logs.
 *
 * Split out of decomposeRoute.ts (2026-07-21). Pure detection: it classifies
 * pool addresses by swap-event topic and factory, and takes any RPC-backed
 * factory reader as a parameter, so it depends on neither the orchestrator nor
 * the RPC reader factories.
 */
import { parseAbiItem, toEventSelector, decodeEventLog } from 'viem';
import type { VenueType } from './routeGraph.js';
import type { LogLike } from './tradeEndpoints.js';
import { classifyKnownVenueAddress, classifyV3Factory } from './venueClassification.js';
```

Move these symbols from `decomposeRoute.ts` into this file (full bodies + doc comments):
- The swap-topic constants: `PANCAKE_V3_SWAP_TOPIC`, `UNI_V3_SWAP_TOPIC`, `V4_SWAP_EVENT`, `V4_SWAP_TOPIC`, `V2_SWAP_TOPIC`, `AERODROME_SWAP_TOPIC`, `MAVERICK_V2_SWAP_TOPIC`, `MAVERICK_V1_SWAP_TOPIC`, `UNIPOOL_SWAP_TOPIC`, `CURVE_TOKEN_EXCHANGE_TOPIC`
- `interface VenueInfo`
- `function scanVenues`
- `function addKnownVenuesFromTransfers`
- `async function addKnownFactoryVenuesFromTransfers`
- `async function refineV3VenueTypes`

Add `export` to `scanVenues`, `addKnownVenuesFromTransfers`, `addKnownFactoryVenuesFromTransfers`, `refineV3VenueTypes`, and `VenueInfo` (they are currently private; the orchestrator now imports them).

- [ ] **Step 2: Remove the moved symbols from `decomposeRoute.ts` and add the import**

Delete the same symbols from `decomposeRoute.ts`. Add this import near the other `./` imports:

```typescript
import {
	scanVenues,
	addKnownVenuesFromTransfers,
	addKnownFactoryVenuesFromTransfers,
	refineV3VenueTypes,
	type VenueInfo,
} from './routeVenueScan.js';
```

Then remove any now-unused viem imports from `decomposeRoute.ts` (e.g. `toEventSelector` was only used by `V4_SWAP_TOPIC`, which moved — lint will flag it if still imported and unused).

- [ ] **Step 3: Gate — tsc**

Run: `npx tsc --build`
Expected: exits 0, no output.

If `TraceNode` or another type is reported missing in `routeVenueScan.ts`, add it to the import block (the reference-count may have missed a type-only use). If a viem symbol is unused in `decomposeRoute.ts`, remove it.

- [ ] **Step 4: Gate — lint**

Run: `npm run lint`
Expected: no errors. Lint is the cascade detector: if removing the symbols orphaned an import or a private helper in `decomposeRoute.ts`, it reports it here. Remove anything it flags as unused.

- [ ] **Step 5: Gate — full suite**

Run: `npx vitest run`
Expected: `Test Files 32 passed (32)`, `Tests 427 passed (427)`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/routeVenueScan.ts packages/core/src/decomposeRoute.ts
git commit -m "$(cat <<'EOF'
refactor(core): extract routeVenueScan from decomposeRoute

Venue detection (scanVenues + the swap-topic constants + the known/factory
venue helpers) moves to its own module. It takes the factory reader as a
parameter, so it imports neither the orchestrator nor the RPC readers. Pure
code motion; suite unchanged at 427.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ATi8n599KY63NMFrzJzbg2
EOF
)"
```

---

### Task 2: Extract `routeReaders.ts` and update the two import sites

The entire viem/RPC surface moves here, including `getLegMidAtBlock` (its only production caller, `createDefaultMidReader`, lives here). Two external consumers — `analyzeTransaction.ts` and `decomposeRoute.test.ts` — import symbols that move, so their import lines are updated to name the new source (chosen over a re-export shim in the spec).

**Files:**
- Create: `packages/core/src/routeReaders.ts`
- Modify: `packages/core/src/decomposeRoute.ts` (remove moved symbols, add one import)
- Modify: `packages/core/src/analyzeTransaction.ts` (repoint `createDefaultMidReader`)
- Modify: `packages/core/src/decomposeRoute.test.ts` (repoint `getLegMidAtBlock`)

**Interfaces:**
- Consumes: `VenueInfo` etc. from Task 1 are unaffected here.
- Produces (exported from `routeReaders.ts`):
  - `getLegMidAtBlock(client: PublicClient, leg: Leg, blockNumber: bigint, decimalsOf: (address: string) => Promise<number>): Promise<PairMidResult | null>` — keep the exact current signature
  - `createDefaultFeeReader(rpcUrl: string, blockNumber: bigint): (addr: string, type: VenueType, v4FeeRaw?: number) => Promise<{ bps: number; defaulted: boolean }>`
  - `createDefaultV3FactoryReader(rpcUrl: string, blockNumber: bigint): (addr: string) => Promise<string | null>`
  - `createDefaultRfqProbe(rpcUrl: string, blockNumber: bigint): (addr: string) => Promise<'eoa' | 'proxy1967' | 'contract'>`
  - `createDefaultMidReader(rpcUrl: string, _blockNumber: bigint): { midReader: ...; decimalsReader: ... }` — keep the exact current signature

- [ ] **Step 1: Create `routeReaders.ts` with its imports and moved symbols**

```typescript
/**
 * routeReaders — the RPC-backed default readers for route decomposition.
 *
 * Split out of decomposeRoute.ts (2026-07-21): every viem/RPC call in the
 * decomposition path lives here. The orchestrator uses these only as fallbacks
 * (`deps?.X ?? createDefaultX(...)`), so tests inject fakes and never hit this
 * module. getLegMidAtBlock lives here too — createDefaultMidReader is its only
 * production caller, so co-locating them keeps the graph acyclic.
 */
import { createPublicClient, http, parseAbiItem, type PublicClient } from 'viem';
import { base } from 'viem/chains';
import type { VenueType, Leg } from './routeGraph.js';
import { getPairMidAtBlock, makeRpcDecimalsCache, type PairMidResult } from './tokenPricing.js';
import { readSlot0, readV2Reserves, readV4Slot0, V4_POOL_MANAGER } from './poolDiscovery.js';
import { sqrtPriceX96ToPrice, v2MidFromReserves } from './priceMath.js';
```

Move these symbols from `decomposeRoute.ts` (full bodies + doc comments):
- `function sortLegTokens` (private helper for `getLegMidAtBlock`)
- `async function getLegMidAtBlock` (already exported — keep the export)
- `const EIP1967_IMPL_SLOT` (used only by the rfq probe)
- `function createDefaultFeeReader`
- `function createDefaultV3FactoryReader`
- `function createDefaultRfqProbe`
- `function createDefaultMidReader` (already exported — keep the export)

Add `export` to `createDefaultFeeReader`, `createDefaultV3FactoryReader`, `createDefaultRfqProbe` (currently private; the orchestrator now imports them). Leave `sortLegTokens` private in the new file.

- [ ] **Step 2: Remove the moved symbols from `decomposeRoute.ts` and add the import**

Delete those symbols from `decomposeRoute.ts`. Add:

```typescript
import {
	getLegMidAtBlock,
	createDefaultFeeReader,
	createDefaultV3FactoryReader,
	createDefaultRfqProbe,
	createDefaultMidReader,
} from './routeReaders.js';
```

Then remove now-unused imports from `decomposeRoute.ts`. After both extractions the remainder uses **no viem symbols at all** — delete the entire `import { ... } from 'viem'` line and the `import { base } from 'viem/chains'` line (Task 1 already moved `toEventSelector`/`decodeEventLog`/`parseAbiItem` usage to `routeVenueScan`; Task 2 moves the rest to `routeReaders`). Also remove the now-unused pool/price-read imports: `readSlot0`, `readV2Reserves`, `readV4Slot0`, `V4_POOL_MANAGER` (from `poolDiscovery`), `sqrtPriceX96ToPrice`, `v2MidFromReserves` (from `priceMath` — drop the whole line), and `getPairMidAtBlock`, `makeRpcDecimalsCache` (from `tokenPricing`). Keep `type PairMidResult` from `tokenPricing` if the orchestrator still annotates with it. **Do not guess — `lint` reports each unused import by name; remove exactly those it names and no others.**

- [ ] **Step 3: Repoint `analyzeTransaction.ts`**

Find its current import (one line):

```typescript
import { decomposeRoute, createDefaultMidReader } from './decomposeRoute.js';
```

Replace with two lines:

```typescript
import { decomposeRoute } from './decomposeRoute.js';
import { createDefaultMidReader } from './routeReaders.js';
```

- [ ] **Step 4: Repoint `decomposeRoute.test.ts`**

Find its current import (one line):

```typescript
import { decomposeRoute, extractNativeTransfers, detectWrapUnwrapSteps, venuesToUncostedLegs, weightedPriceImpactBps, getLegMidAtBlock } from './decomposeRoute.js';
```

Replace with:

```typescript
import { decomposeRoute, extractNativeTransfers, detectWrapUnwrapSteps, venuesToUncostedLegs, weightedPriceImpactBps } from './decomposeRoute.js';
import { getLegMidAtBlock } from './routeReaders.js';
```

- [ ] **Step 5: Gate — tsc**

Run: `npx tsc --build`
Expected: exits 0, no output. Reconcile any missing/unused import it reports.

- [ ] **Step 6: Gate — lint**

Run: `npm run lint`
Expected: no errors. Remove anything it flags as unused in `decomposeRoute.ts`.

- [ ] **Step 7: Gate — full suite**

Run: `npx vitest run`
Expected: `Test Files 32 passed (32)`, `Tests 427 passed (427)`.

- [ ] **Step 8: Verify the running app still decomposes a receipt**

The decomposition feeds the receipt's Cost Breakdown. With the dev server running on `:3000`, confirm a multi-leg trade still renders (HTTP 200 and a populated Cost Breakdown):

Run:
```bash
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/?tx=0x021f814d6ee757fc771f3fc27b282112faad751aa9160b5f6b707aabd7e44d1d"
```
Expected: `200`. (This is the WETH→wstETH row; any persisted multi-leg receipt works.) If the dev server is not running, note it and rely on the suite — do not run `next build`, which would clobber the dev server's `.next`.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/routeReaders.ts packages/core/src/decomposeRoute.ts packages/core/src/analyzeTransaction.ts packages/core/src/decomposeRoute.test.ts
git commit -m "$(cat <<'EOF'
refactor(core): extract routeReaders from decomposeRoute

The entire viem/RPC surface — the four createDefault* factories plus
getLegMidAtBlock (createDefaultMidReader's only caller, moved with it to keep
the graph acyclic) — becomes its own module. analyzeTransaction and the test
repoint to the new source; no re-export shim. decomposeRoute is now the
orchestrator + pure logic. Pure code motion; suite unchanged at 427.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ATi8n599KY63NMFrzJzbg2
EOF
)"
```

---

### Task 3: Update the refactor backlog memory

Record that the split landed, so the backlog stays accurate for the next session.

**Files:**
- Modify: `/Users/justinvoorhees/.claude/projects/-Users-justinvoorhees-withfabricxyz-fabric-tca-decoder/memory/refactor-backlog.md`
- Modify: `/Users/justinvoorhees/.claude/projects/-Users-justinvoorhees-withfabricxyz-fabric-tca-decoder/memory/MEMORY.md` (the one-line index entry)

- [ ] **Step 1: Move `decomposeRoute.ts` from "still open" to done**

In `refactor-backlog.md`, under the Phase 3 section, remove the `decomposeRoute.ts 1113L` line from the open list and add a DONE bullet naming the three modules (`decomposeRoute`, `routeReaders`, `routeVenueScan`) and the commits. Update the MEMORY.md index line for the backlog to reflect that only `decompose-trade.ts`, `ReceiptView.tsx`, and the `Direction` rename remain open.

- [ ] **Step 2: Commit is not required for memory files** (they live outside the repo). Confirm the two files are written and the open-item list is accurate.

---

## Notes for the executor

- **Task order is load-bearing.** Task 1 before Task 2: after Task 1, `decomposeRoute` imports the scan functions and passes the (still-local) factory reader into them; Task 2 then moves that factory reader out. Reversing the order briefly leaves `decomposeRoute` importing a factory it also defines.
- **If a gate fails, stop and diagnose — do not proceed to the next task.** A failing test after pure code motion means a symbol or import was missed, not that behavior changed. The fix is always in the move, never in the logic.
- **Expected final shape:** `routeReaders.ts` ~360L, `routeVenueScan.ts` ~210L, `decomposeRoute.ts` ~640L. If `decomposeRoute` is still >800L after both tasks, a symbol that should have moved was left behind — re-check against the spec's module lists.
