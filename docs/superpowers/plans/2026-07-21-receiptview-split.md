# ReceiptView.tsx Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `packages/dashboard/components/ReceiptView.tsx` (855 lines) into two focused leaves plus the trimmed composition file, with no behavior change.

**Architecture:** The file has three cleanly separable layers. Extract the pure formatting/orientation helpers into `receipt/priceFormat.ts` (no JSX) and the presentational row sub-components into `receipt/receiptRows.tsx` (no hooks), leaving `Receipt` + `ReceiptView` in place. The two leaves are independent of each other and import only established leaves — one-directional graph, no cycle.

**Tech Stack:** TypeScript, React (Next.js, `jsx: preserve` — `React.ReactNode` resolves via a global type, no React import needed), vitest. Built with `tsc --build` from the repo root; tests via `npx vitest run`; lint via `npm run lint`.

## Global Constraints

- **No behavior change.** Pure code motion. Do not edit any component's JSX, any helper's logic, or any string literal.
- **Baseline: 427 tests pass across 32 files.** Every task ends with exactly 427 green. No new tests.
- **Three gates per task, in order:** `npx tsc --build` (clean), `npm run lint` (clean — catches imports orphaned by a move), `npx vitest run` (427 pass). Plus a dev-render check (below) on the task that moves JSX.
- **Move whole symbol bodies, byte-identical.** Reference symbols by name, not line number. The only permitted change to a moved body is an added `export` where specified.
- **Reconcile imports against the compiler.** The import blocks below are derived from the source; after each edit, `tsc` names anything missing and `lint` names anything unused in `ReceiptView.tsx`. Add/remove exactly what they report — the pure helpers and rows were the sole users of some of ReceiptView's current imports (e.g. `providerColor`/`formatProvider` for the rows, `formatPriceMagnitude` for the helpers), so several will become unused.
- **Export only what `Receipt` imports.** Helpers/components used only within their new leaf stay private. Specifically `TooltipBubble`, `priceDeltaSentence`, `symbolAnchorRank`, and `NAMED_CHAINS` stay private; lint/tsc confirm the exact export set.
- Commit trailer on every commit:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01ATi8n599KY63NMFrzJzbg2
  ```

---

### Task 1: Extract `receipt/priceFormat.ts` (pure helpers)

The pure formatting + orientation helpers — return strings/numbers, no JSX. This task also repoints the test's 17 helper-import sites.

**Files:**
- Create: `packages/dashboard/components/receipt/priceFormat.ts`
- Modify: `packages/dashboard/components/ReceiptView.tsx`
- Modify: `packages/dashboard/components/ReceiptView.test.tsx` (17 import-site repoints)

**Interfaces:**
- Produces (exported from `priceFormat.ts`):
  - `formatPriceDelta(marketMid: unknown, realizedPrice: unknown, quoteSymbol: string): string`
  - `interface PriceDeltaRow`
  - `formatPriceDeltaUsd(deltaUsdPerBase: number, base: string, baseIsOutput: boolean, execResultUsd: number): PriceDeltaRow`
  - `formatPriceDeltaToken(marketMid: unknown, realizedPrice: unknown, base: string, quote: string, baseIsOutput: boolean): PriceDeltaRow`
  - `fallbackMethodology(pricingStatus: string): string`
  - `priceDeltaDirection(marketMid: unknown, realizedPrice: unknown): 'above' | 'below' | null`
  - `receiptPairTitle(row): string`, `chainLabel(chainId: number): string`, `pairBaseQuote(row): { base; quote; baseIsOutput }`, and the `UNAVAILABLE` const
- Consumes: nothing from other tasks.

- [ ] **Step 1: Create `priceFormat.ts`**

```typescript
/**
 * priceFormat — pure price-delta and base/quote orientation helpers for the receipt.
 * Split out of ReceiptView.tsx (2026-07-21). No JSX, no React: string/number logic.
 */
import type { ReceiptRow } from '../../lib/queries';
import { formatPriceMagnitude, formatSubvalueUsd } from './receiptDisplay';
import { STABLE_SYMBOLS, ETH_SYMBOLS } from './symbols';
```

Move these symbols from `ReceiptView.tsx` (full bodies + doc comments, byte-identical):
- `formatPriceDelta`, `PriceDeltaRow`, `priceDeltaSentence`, `formatPriceDeltaUsd`,
  `formatPriceDeltaToken`, `fallbackMethodology`, `priceDeltaDirection`
- `receiptPairTitle`, `NAMED_CHAINS`, `chainLabel`, `symbolAnchorRank`, `pairBaseQuote`,
  `UNAVAILABLE`

Keep the already-`export`ed ones exported. Add `export` to `receiptPairTitle`,
`chainLabel`, `pairBaseQuote`, `UNAVAILABLE` (Receipt imports them). Leave
`priceDeltaSentence`, `symbolAnchorRank`, `NAMED_CHAINS` private (used only within
this leaf).

- [ ] **Step 2: Update `ReceiptView.tsx` imports**

Remove those symbols from `ReceiptView.tsx`. Add:

```typescript
import {
	formatPriceDelta,
	formatPriceDeltaUsd,
	formatPriceDeltaToken,
	fallbackMethodology,
	priceDeltaDirection,
	receiptPairTitle,
	chainLabel,
	pairBaseQuote,
	UNAVAILABLE,
} from './receipt/priceFormat';
```

Then reconcile ReceiptView's existing imports per lint: `formatPriceMagnitude` (was used only by the moved helpers) will likely become unused in ReceiptView's `receiptDisplay` import — remove it if lint says so. Keep `formatSubvalueUsd` if `Receipt` still uses it directly. `STABLE_SYMBOLS`/`ETH_SYMBOLS` were used by the moved `symbolAnchorRank` — remove from ReceiptView's `symbols` import if now unused there. **Remove exactly what lint names.**

- [ ] **Step 3: Repoint the 17 helper-import sites in `ReceiptView.test.tsx`**

Each of these is an isolated single-symbol `await import('./ReceiptView')`. Repoint only these five destructure patterns to `./receipt/priceFormat` (the `Receipt`/`ReceiptView` imports stay at `./ReceiptView`):

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder
perl -pi -e "s{const \{ (formatPriceDelta|formatPriceDeltaUsd|formatPriceDeltaToken|fallbackMethodology|priceDeltaDirection) \} = await import\('./ReceiptView'\)}{const { \$1 } = await import('./receipt/priceFormat')}g" packages/dashboard/components/ReceiptView.test.tsx
```

Then verify the count: `grep -c "await import('./receipt/priceFormat')" packages/dashboard/components/ReceiptView.test.tsx` should print `17`, and `grep -c "await import('./ReceiptView')" ...` should print `49` (the remaining Receipt/ReceiptView imports).

- [ ] **Step 4: Gate — tsc, lint, vitest**

```bash
npx tsc --build && npm run lint && npx vitest run 2>&1 | grep -E "Tests |Test Files "
```
Expected: tsc exits 0, lint no errors, `Test Files 32 passed (32)` / `Tests 427 passed (427)`.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/components/receipt/priceFormat.ts packages/dashboard/components/ReceiptView.tsx packages/dashboard/components/ReceiptView.test.tsx
git commit -m "$(cat <<'EOF'
refactor(dashboard): extract receipt/priceFormat from ReceiptView

The pure price-delta and base/quote orientation helpers (no JSX) move to their
own leaf. The test's 17 isolated helper-import sites repoint to priceFormat; the
Receipt/ReceiptView imports are untouched. Pure code motion; suite unchanged at 427.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ATi8n599KY63NMFrzJzbg2
EOF
)"
```

---

### Task 2: Extract `receipt/receiptRows.tsx` (presentational components)

The row sub-components — JSX, no hooks. `Receipt` renders these.

**Files:**
- Create: `packages/dashboard/components/receipt/receiptRows.tsx`
- Modify: `packages/dashboard/components/ReceiptView.tsx`

**Interfaces:**
- Produces (exported): `Divider`, `DetailRow`, `AggregatorValue`, `FillerRow`, `BkdHeading`, `BkdRow`, `LegRow`. `TooltipBubble` stays internal (used only by DetailRow/BkdRow/BkdHeading within this module).

- [ ] **Step 1: Create `receiptRows.tsx`**

```typescript
'use client';
/**
 * receiptRows — the presentational row/layout sub-components of the receipt
 * (DetailRow, the Cost-Breakdown rows, dividers, aggregator/filler rows). Split out
 * of ReceiptView.tsx (2026-07-21). No hooks; each takes props and renders JSX. Marked
 * 'use client' to match the receipt/ leaf convention.
 */
import { providerColor, formatProvider } from '../../lib/formatters';
import type { ReceiptRow, RouteLeg } from '../../lib/queries';
import {
	getVenueLabel,
	isMakerLeg,
	RFQ_LEG_TOOLTIP,
	legPairContext,
	getStepContext,
} from './receiptDisplay';
```

Move these symbols from `ReceiptView.tsx` (full bodies + doc comments, byte-identical):
- `TooltipBubble` (keep private — no `export`), `Divider`, `DetailRow`,
  `AggregatorValue`, `FillerRow`, `BkdHeading`, `BkdRow`, `LegRow`

Add `export` to `Divider`, `DetailRow`, `AggregatorValue`, `FillerRow`, `BkdHeading`,
`BkdRow`, `LegRow` (they were private module functions; `Receipt` now imports them).

`React.ReactNode` (used in `TooltipBubble`/`DetailRow` prop types) resolves via the
global React type exactly as it did in `ReceiptView.tsx` — no React import needed. If
tsc reports `React` not found, add `import type React from 'react';`.

- [ ] **Step 2: Update `ReceiptView.tsx` imports**

Remove those components from `ReceiptView.tsx`. Add:

```typescript
import {
	Divider,
	DetailRow,
	AggregatorValue,
	FillerRow,
	BkdHeading,
	BkdRow,
	LegRow,
} from './receipt/receiptRows';
```

Reconcile ReceiptView's existing imports per lint: `providerColor` and `formatProvider`
(used only by the moved `AggregatorValue`) will likely become unused in ReceiptView —
remove from its `lib/formatters` import if lint says so. `getVenueLabel`, `isMakerLeg`,
`RFQ_LEG_TOOLTIP`, `legPairContext`, `getStepContext` (used by the moved `LegRow`/
`BkdRow`) may also become unused in ReceiptView's `receiptDisplay` import — remove
exactly what lint names. `RouteLeg` type may become unused too.

- [ ] **Step 3: Gate — tsc, lint, vitest**

```bash
npx tsc --build && npm run lint && npx vitest run 2>&1 | grep -E "Tests |Test Files "
```
Expected: clean / clean / 427 passed.

- [ ] **Step 4: Verify the running app renders a receipt**

The moved components are the receipt's visible rows, so a bundler-level break would
show here (vitest cannot catch it). With the dev server on `:3000`:

```bash
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/?tx=0xeeb5a12f8b737f87e80b978da362b625efec4afaf55cbeaf24affcbbb8f69caf"
```
Expected: `200`. Optionally confirm the body still contains `Spread`, `Market Price`,
and `Cost Breakdown`. If the dev server is not running, note it and rely on the suite;
do NOT run `next build` (it clobbers the dev server's `.next`).

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/components/receipt/receiptRows.tsx packages/dashboard/components/ReceiptView.tsx
git commit -m "$(cat <<'EOF'
refactor(dashboard): extract receipt/receiptRows from ReceiptView

The presentational row sub-components (DetailRow, the Cost-Breakdown rows,
dividers, aggregator/filler rows) move to their own leaf; TooltipBubble stays
internal to it. ReceiptView keeps the Receipt + ReceiptView composition. Pure
code motion; suite unchanged at 427, dev render 200.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ATi8n599KY63NMFrzJzbg2
EOF
)"
```

---

### Task 3: Update the refactor backlog memory

**Files:**
- Modify: `/Users/justinvoorhees/.claude/projects/-Users-justinvoorhees-withfabricxyz-fabric-tca-decoder/memory/refactor-backlog.md`
- Modify: `/Users/justinvoorhees/.claude/projects/-Users-justinvoorhees-withfabricxyz-fabric-tca-decoder/memory/MEMORY.md`

- [ ] **Step 1: Record the split as done**

In `refactor-backlog.md`, remove `ReceiptView.tsx` from the "still open" list and add a DONE entry naming the three files (`priceFormat.ts`, `receiptRows.tsx`, `ReceiptView.tsx`) and the commit range. Note that the two open items now remaining are the lowercase-first dashboard file-rename pass and the `Direction` rename. Update the MEMORY.md index line accordingly. (Memory files are outside the repo — no commit.)

---

## Notes for the executor

- **Task order:** priceFormat (Task 1) before receiptRows (Task 2) — they're independent, but Task 1 carries the test repoint, so doing it first keeps the test green earliest.
- **If a gate fails, stop and diagnose.** A failing test after pure code motion means a symbol or import was missed — not that behavior changed. The fix is in the move or the import reconciliation, never in a component's JSX or a helper's logic.
- **Expected final shape:** `priceFormat.ts` ~160L, `receiptRows.tsx` ~310L, `ReceiptView.tsx` ~380L. If `ReceiptView.tsx` is still >450L after both tasks, a symbol that should have moved was left behind.
- **The file stays named `ReceiptView.tsx` (PascalCase) here.** The lowercase-first rename is a deliberate separate follow-up — do not rename it in this plan.
