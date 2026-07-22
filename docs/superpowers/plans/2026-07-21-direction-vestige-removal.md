# Remove Direction / settledIn Vestige Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the dead `Direction` type and the vestigial `direction`/`settledIn` fields from `DecomposeTradeInput`, with no behavior change.

**Architecture:** One atomic behavior-preserving removal across five files. `signedDeviationBps` keeps its name but loses its always-hardcoded `direction` parameter (the `'sell_weth'` branch is the only one ever taken). The type and both interface fields are proven unread. `tsc` surfaces every stale reference as a compile error.

**Tech Stack:** TypeScript, vitest. Built with `tsc --build` from the repo root; tests via `npx vitest run`; lint via `npm run lint`.

## Global Constraints

- **No behavior change.** Every removed thing is dead. `signedDeviationBps(marketMid, realizedPrice)` must return the identical number the old `signedDeviationBps('sell_weth', marketMid, realizedPrice)` did.
- **Baseline: 427 tests pass across 32 files.** Must stay 427 green.
- **Atomic:** one commit. The type and its fields must be removed together — the tree is uncompilable in between.
- **Do NOT touch** the receipt's `direction` field at `analyzeTransaction.ts:398` (the `inputSymbol->outputSymbol` pair-string) or the `receipts.direction` DB column — a separate concept.
- Gates before committing: `npx tsc --build` (clean), `npm run lint` (clean), `npx vitest run` (427 pass).
- Commit trailer:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01ATi8n599KY63NMFrzJzbg2
  ```

---

### Task 1: Remove the Direction type, the deviation-fn param, and the two dead fields

**Files:**
- Modify: `packages/core/src/priceMath.ts`
- Modify: `packages/core/src/tradeEndpoints.ts`
- Modify: `packages/core/src/decomposeTrade.ts`
- Modify: `packages/core/src/analyzeTransaction.ts`
- Modify: `packages/core/src/decomposeRoute.test.ts`

- [ ] **Step 1: `priceMath.ts` — drop the Direction import and the deviation param**

Replace the `signedDeviationBps` definition (currently taking `direction: Direction`) and its doc comment. The new form:

```typescript
/**
 * Signed deviation in basis points from `baselinePrice` to `comparePrice`.
 * Positive bps = cost paid by user (compare worse than baseline), matching the
 * ledger's convention. In the output-per-input convention the receipt uses, cost
 * is always (mid − realized)/mid, so this is direction-free.
 *
 * Lifted out of processSwap.ts so the v2 trade-centric extractor and the v1
 * pipeline share one definition.
 */
export function signedDeviationBps(
	baselinePrice: number,
	comparePrice: number,
): number {
	return ((baselinePrice - comparePrice) / baselinePrice) * 10_000;
}
```

Remove the now-unused `import type { Direction } from './tradeEndpoints.js';` at the top of `priceMath.ts` (it becomes orphaned; lint/tsc confirm).

- [ ] **Step 2: `tradeEndpoints.ts` — delete the Direction type**

Remove the `export type Direction = 'buy_weth' | 'sell_weth';` line and its `// ─── Types ───` section header if that header now has nothing under it. (Verify: after removal, confirm no other symbol lives under that header before deleting it.)

- [ ] **Step 3: `decomposeTrade.ts` — drop the import and the two dead fields**

In the `import { … } from './tradeEndpoints.js';` block, remove `type Direction,`.

In the `DecomposeTradeInput` interface, remove these two lines:
```typescript
	direction: Direction;
	settledIn: 'WETH' | 'ETH';
```

- [ ] **Step 4: `analyzeTransaction.ts` — drop the import, fix the call, remove the dead computations**

- Remove `import type { Direction } from './tradeEndpoints.js';`.
- Change the deviation call (currently `signedDeviationBps('sell_weth', marketMid, realizedPrice)`) to:
  ```typescript
  				? signedDeviationBps(marketMid, realizedPrice)
  ```
- Remove the two vestigial computations and their comment:
  ```typescript
  		// direction/settledIn are vestigial in decompose-trade (interface-only), but
  		// we derive faithful values for the WETH case anyway.
  		const decompDirection: Direction = outLc === WETH ? 'buy_weth' : 'sell_weth';
  		const settledIn: 'WETH' | 'ETH' = outLc === NATIVE ? 'ETH' : 'WETH';
  ```
- Remove the two fields from the `decomposeRoute({ … })` call:
  ```typescript
  				direction: decompDirection,
  				settledIn,
  ```
- Do NOT touch the receipt's `direction: \`${pricing.inputSymbol}->${pricing.outputSymbol}\`` field further down.
- `NATIVE` remains used elsewhere in the file (2 other references) — leave its import. If lint reports `WETH` or `NATIVE` as newly unused, remove only what lint names.

- [ ] **Step 5: `decomposeRoute.test.ts` — strip the dead fixture fields**

The 5 `DecomposeTradeInput` fixtures each set `direction: 'buy_weth',` and `settledIn: 'WETH',`. Remove all 10 lines:

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder
perl -ni -e "print unless /^\s*direction: 'buy_weth',\s*$/ || /^\s*settledIn: 'WETH',\s*$/" packages/core/src/decomposeRoute.test.ts
```

Verify exactly 10 lines were removed (5 of each):
```bash
grep -c "direction: 'buy_weth'" packages/core/src/decomposeRoute.test.ts   # expect 0
grep -c "settledIn: 'WETH'" packages/core/src/decomposeRoute.test.ts       # expect 0
```

- [ ] **Step 6: Sweep for any remaining reference to the removed symbols**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder
grep -rnE "\bDirection\b|'buy_weth'|'sell_weth'|\.settledIn\b|\bsettledIn\b" packages/core/src --include="*.ts" | grep -v "/dist/"
```
Expected: no output. Any hit is a stale reference to a removed symbol — resolve it before proceeding. (The receipt's `direction` *pair-string* field uses the property name `direction` but never the `Direction` type or the `buy_weth/sell_weth`/`settledIn` symbols, so it will not match this pattern.)

- [ ] **Step 7: Gate — tsc**

```bash
npx tsc --build
```
Expected: exits 0. A `Cannot find name 'Direction'` or `'direction' does not exist in type` here means a reference was missed — fix and re-run.

- [ ] **Step 8: Gate — lint**

```bash
npm run lint
```
Expected: no errors. Remove any import lint reports as newly unused.

- [ ] **Step 9: Gate — full suite**

```bash
npx vitest run 2>&1 | grep -E "Tests |Test Files "
```
Expected: `Test Files 32 passed (32)` / `Tests 427 passed (427)`. In particular the `signedDeviationBps` numeric results are unchanged (same branch), and any `priceMath`/`analyzeTransaction`/`decomposeRoute` tests still pass.

- [ ] **Step 10: Commit**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder
git add -A
git commit -m "$(cat <<'EOF'
refactor(core): remove the dead Direction / settledIn v1 vestige

Direction = 'buy_weth'|'sell_weth' described the v1 USDC/WETH-only world and is
now functionally dead: signedDeviationBps's only caller hardcoded 'sell_weth'
(cost is always (mid-realized)/mid in the v2 output-per-input convention), and
DecomposeTradeInput.direction/settledIn were declared but never read. Delete the
type, drop signedDeviationBps's param (name unchanged, identical result), remove
both interface fields + their setters, and strip 10 dead test-fixture lines. The
receipt's separate `direction` pair-string and its DB column are untouched.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ATi8n599KY63NMFrzJzbg2
EOF
)"
```

---

### Task 2: Update the refactor backlog memory

**Files:**
- Modify: `/Users/justinvoorhees/.claude/projects/-Users-justinvoorhees-withfabricxyz-fabric-tca-decoder/memory/refactor-backlog.md`
- Modify: `/Users/justinvoorhees/.claude/projects/-Users-justinvoorhees-withfabricxyz-fabric-tca-decoder/memory/MEMORY.md`

- [ ] **Step 1: Record the removal as done**

In `refactor-backlog.md`, remove the `Direction` v1-vestige item from the open list and add a DONE entry (turned out to be dead, not just misnamed → removed the type + settledIn + the deviation-fn param; DB pair-string untouched; commit hash). This was the last Phase-3 refactor item — note the Phase-3 refactor backlog is now clear. Update the MEMORY.md index line. (Memory files are outside the repo — no commit.)

---

## Notes for the executor

- **tsc is the safety net.** Removing an interface field surfaces every stale setter, and dropping a function parameter surfaces every stale call site, as compile errors. If tsc is clean, no reference was missed.
- **One atomic commit.** Do not commit between removing the type and removing its fields — the tree is uncompilable in between. All of Steps 1–9 precede the single commit in Step 10.
- **The receipt `direction` pair-string stays.** If you find yourself editing `direction: \`${…}->${…}\`` (analyzeTransaction:398) or anything touching the `receipts.direction` DB column, stop — that is a different, live field.
