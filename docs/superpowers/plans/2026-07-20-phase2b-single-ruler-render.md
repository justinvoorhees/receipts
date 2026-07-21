# Single-Ruler Receipt — Phase 2b (ReceiptView Rendering) Implementation Plan

> **For agentic workers:** Execute inline (superpowers:executing-plans) with a BROWSER verification loop — UI fidelity to the Figma frames needs visual iteration, not fire-and-forget subagents. Steps use checkbox syntax.

**Goal:** Render the four single-ruler receipt states in `ReceiptView.tsx` per the Figma frames, driven by the persisted `tier` + the `receiptDollars` helper (both from Phase 2a). No new core/DB work.

**Architecture:** A `receiptDollars(row)` non-null result IS the "anchored" gate (it already requires a mid AND a USD-anchored side). Every anchored USD figure derives from `{notionalIn, notionalOut, execResultUsd}` + the base-leg amount. Non-anchored and no-market-price states keep today's token-denominated / `~Size` rendering, plus a methodology subline where a mid exists.

**Tech Stack:** Next.js (dashboard, `next dev -p 3002`), React/TSX, vitest for the component tests, `@fabric-tca/core` for `anchorsToUsd`.

**Scope:** Phase 2b of `docs/superpowers/specs/2026-07-20-phase2-single-ruler-receipt-design.md`. Phase 2a (data path + `receiptDollars` + retirement) is merged.

## Global Constraints

- **Anchor gate = `receiptDollars(row) != null`.** Do not re-derive anchoring from symbols; `receiptDollars` already uses core's address-based `anchorsToUsd` and returns null unless a mid exists and a side anchors.
- **Base leg = the non-anchored (volatile) side.** `baseAmount = pairBaseQuote(row).baseIsOutput ? outputAmount : inputAmount`. All per-base USD figures divide by `baseAmount`.
- **Execution Result is unsigned** — `formatExecutionResult` returns `{ text, sub, color }`; render `text` as the value and `sub` (Gained/Lost) as a colored subvalue. No `+`/`−`.
- **The three states are mutually exclusive:**
  - anchored (`receiptDollars != null`): per-side USD, Execution Result, USD Market Price + methodology, USD Price Delta; **no Size row**.
  - no-anchor (`receiptDollars == null && marketMid != null`): today's token-denominated Market Price/Price Delta + `~Size` + methodology subline.
  - no-market-price (`marketMid == null`): nulls + `~Size`.
- **`~Size`** (existing `Size` row) renders ONLY in the two non-anchored states, unsigned, `~`-prefixed.
- Don't touch the apparatus, `receiptDollars`/`formatExecutionResult` logic, per-leg Cost Breakdown, or the migrations.
- Verify visually against the Figma frames AND run the component tests. The browser check MUST include a **base-is-output** pair (ETH→WBTC) — that's where the orientation bug lived.

---

### Task 1: `DetailRow` subvalue + sublabel support

Add optional muted second-line slots so a row can show a value subvalue (USD) and a label subline (methodology).

**Files:** Modify `packages/dashboard/components/ReceiptView.tsx` (`DetailRow`).

- [ ] **Step 1:** Extend `DetailRow`'s props: add `subValue?: React.ReactNode`, `subValueColor?: string`, `subLabel?: React.ReactNode`. Render `subLabel` as a muted line under the label (left column), and `subValue` as a line under the value (right column), styled `text-[var(--color-secondary)] text-[10px]` (match the existing secondary/subvalue treatment; confirm the exact class used by `formatSubvalueUsd` consumers). `subValueColor`, when set, overrides the subvalue color (for Gained green).

- [ ] **Step 2:** Component test in `ReceiptView.test.tsx`: a `DetailRow` with `subValue`/`subLabel` renders both lines; without them, renders exactly as before (no empty nodes). Run `npx vitest run packages/dashboard/components/ReceiptView.test.tsx`.

- [ ] **Step 3:** Commit `feat(dashboard): DetailRow subvalue/sublabel slots`.

---

### Task 2: Render-state derivation + anchored USD figures

**Files:** Modify `packages/dashboard/components/ReceiptView.tsx`.

- [ ] **Step 1:** At the top of the detail component, derive:

```ts
import { anchorsToUsd } from '@fabric-tca/core';
import { receiptDollars, formatExecutionResult } from './receipt/qualityNotionals';
// ...
const dollars = receiptDollars(row);              // null unless mid + a side anchors
const anchored = dollars != null;
const baseAmount = Number(baseIsOutput ? row.outputAmount : row.inputAmount);
const execUsdPerBase   = anchored ? dollars!.notionalIn  / baseAmount : null; // effective paid $/base
const marketUsdPerBase = anchored ? dollars!.notionalOut / baseAmount : null; // market $/base
const deltaUsdPerBase  = anchored ? Math.abs(dollars!.execResultUsd) / baseAmount : null;
const execResult = anchored ? formatExecutionResult(dollars!.execResultUsd) : null;
```

- [ ] **Step 2:** Add a component test asserting, for a stored ETH→WBTC row fixture (marketMid `'35.0232'`, inputAmount `'1'`, outputAmount `'0.028625'`, notionalUsd `'1791.14'`, inputToken WETH addr, outputToken WBTC addr, symbols ETH/WBTC), that `anchored` is true, Token In shows `$1,791.14`, Token Out `$1,795.71`, Execution Result `$4.57` + `Gained` (green), and Market Price USD subline `$62,731.32`. Run the test (RED).

---

### Task 3: Wire the anchored rows

**Files:** Modify `packages/dashboard/components/ReceiptView.tsx`.

- [ ] **Step 1:** Token In / Token Out: when `anchored`, pass `subValue={formatSubvalueUsd(dollars.notionalIn)}` / `notionalOut`.

- [ ] **Step 2:** Replace the `Size` row with a conditional: render `Size` only when `!anchored`; when `anchored`, render an **Execution Result** `DetailRow` — value `execResult.text`, `subValue={execResult.sub}`, `subValueColor={execResult.color}`.

- [ ] **Step 3:** Execution Price: when `anchored`, add `subValue={formatSubvalueUsd(execUsdPerBase)}`.

- [ ] **Step 4:** Market Price: when `anchored`, add `subValue={formatSubvalueUsd(marketUsdPerBase)}` and `subLabel={row.methodology ?? undefined}`. When `!anchored && marketMid != null`, still add the methodology `subLabel`. (Keep the existing manipulation-flag ⚠ marker.)

- [ ] **Step 5:** Price Delta: when `anchored`, render the USD sentence — reuse `priceDeltaDirection` for below/above and `pairBaseQuote` for base + buy/sell, formatted as `"{Bought|Sold} at $${deltaUsdPerBase} {below|above} Market Price per 1 {base}"`. Add a `formatPriceDeltaUsd(deltaUsdPerBase, base, baseIsOutput, direction)` helper next to the existing `formatPriceDelta` and unit-test it. When `!anchored`, keep today's token-denominated `formatPriceDelta`.

- [ ] **Step 6:** Run `npx vitest run packages/dashboard/components/ReceiptView.test.tsx` (the Task-2 RED test now GREEN) + the full dashboard suite. `npx tsc --build` exit 0. Commit `feat(dashboard): render anchored single-ruler receipt rows`.

---

### Task 4: Browser verification loop (the fidelity gate)

**Files:** none (verification). Use the run/claude-in-chrome skill.

- [ ] **Step 1:** Start the dashboard: `npm run dev` (needs `TCA_RPC_URL` + DB env exported: `set -a && source .env && set +a` first). It serves on `:3002`.

- [ ] **Step 2:** In the receipts tool, paste the reference **base-is-output** hash `0x16e782f7a9dfefc3b84054ec81a366efbd603aea745ee5373ec005568adb360f` (ETH→WBTC). Screenshot. Compare against Figma frame `429-2858`: Token In/Out USD, Execution Result `$4.57 / Gained` (green, NOT "Lost"), Market Price methodology subline + `$62,731.32`, Price Delta `…$159.76 below Market Price per 1 WBTC`, no Size row.

- [ ] **Step 3:** Paste a **no-anchor** pair (a TOKEN→TOKEN swap with a pool but neither side stable/ETH) — confirm token-denominated Market Price/Price Delta + `~Size`, no Execution Result, matching frame `430-3251`.

- [ ] **Step 4:** Paste a **no-market-price** case (an illiquid pair, `tier: none`) — confirm nulls + `~Size`, matching frame `429-3050`.

- [ ] **Step 5:** Fix any visual gaps (spacing, muted color, wording) by iterating on the JSX and re-screenshotting. When all three frames match, commit any refinements.

---

## Self-Review

- Anchored gate uses `receiptDollars != null` (mid + address-based anchor) — no symbol re-derivation. ✓
- All anchored USD figures derive from `{notionalIn, notionalOut, execResultUsd}` + `baseAmount`, consistent with the Figma numbers (hand-checked: 1791.14 / 1795.71 / 4.57 / 62,571.56 / 62,731.32 / 159.76). ✓
- Unsigned Execution Result via `formatExecutionResult`. ✓
- Three mutually-exclusive states; `~Size` only in the non-anchored two. ✓
- Browser loop explicitly includes the base-is-output orientation case. ✓
- No apparatus/DB/logic changes.

**Placeholder note:** Task 1 Step 1's exact secondary CSS classes and Task 3's precise JSX are to be matched to the existing `DetailRow`/`formatSubvalueUsd` styling during implementation + the browser loop — this is a rendering plan whose fidelity gate is visual, not a fixed code block.
