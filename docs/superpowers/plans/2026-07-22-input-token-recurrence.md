# Input-Token Recurrence Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a route reconstruct when the input token recurs mid-chain, by relaxing the "input is a pure source" check in `routeGraph.ts` to a symmetric net-source check — fixing id 134.

**Architecture:** Two one-line relaxations in `chainLegs`'s helpers `linearFlowValid` and `reconstructDag` (both currently require the input token to have zero inflow). Replace with "net source" (`outflow > inflow`). The change is strictly more permissive on the input; net-source/net-sink/intermediate-conservation together remain the flow guard.

**Tech Stack:** TypeScript, vitest. `packages/core` only. Built with `tsc --build`; tests via `npx vitest run`; lint via `npm run lint`.

## Global Constraints

- **Strictly more permissive on the input, no regression.** The change relaxes `inflow == 0` to `outflow > inflow` (`outflow > 0` was already required), so any route that reconstructed before still does. Every existing `routeGraph.test.ts` / `decomposeRoute.test.ts` case must still pass.
- **Only the input source-check changes.** Do not touch the output pure-sink check in `reconstructDag`, the intermediate `conserved` check, or `tryBuildChain`.
- **No DB retype.** id 134 relabels only on re-analysis; run no migration and write nothing to the database.
- **Baseline: 430 tests / 33 files.** The full suite must stay green; this adds tests, so the total rises (record it).
- Gates: `npx tsc --build`, `npm run lint`, `npx vitest run`.
- Commit trailer:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01ATi8n599KY63NMFrzJzbg2
  ```

---

### Task 1: Relax the input source-check to net-source

**Files:**
- Modify: `packages/core/src/routeGraph.ts` (functions `linearFlowValid`, `reconstructDag`)
- Modify: `packages/core/src/routeGraph.test.ts` (add two `chainLegs` tests)

**Interfaces:**
- Consumes: the exported `chainLegs(legs: Leg[], inputToken: string, outputToken: string): { ordered: Leg[]; shape: RouteShape; reconstructed: boolean }` (already exported; the test already imports it).
- `Leg` fields used by the fixtures: `{ venue: string; type: VenueType; tokenIn: string; tokenOut: string; amountInRaw: bigint; amountOutRaw: bigint }`.

- [ ] **Step 1: Write the two tests**

Add to `packages/core/src/routeGraph.test.ts` (it already `import { buildRouteGraph, chainLegs } from './routeGraph.js'`). Append a new describe block:

```typescript
describe('chainLegs input-token mid-chain recurrence', () => {
  const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // input (e.g. WETH)
  const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; // intermediate (e.g. USDC)
  const C = '0xcccccccccccccccccccccccccccccccccccccccc'; // output (e.g. TOSHI)
  const leg = (venue: string, tokenIn: string, tokenOut: string, amtIn: bigint, amtOut: bigint) =>
    ({ venue, type: 'univ3' as const, tokenIn, tokenOut, amountInRaw: amtIn, amountOutRaw: amtOut });

  it('reconstructs a route where the INPUT token recurs mid-chain (id 134 shape)', () => {
    // A→B, B→A, A→C — the input A is produced by leg 1 (B→A), then re-spent by leg 2.
    // Conservation: A net outflow = (100 + 90) − 90 = 100 > 0 (net source); B conserves
    // (200 out = 200 in); C is the net sink (500 in). Old pure-source check rejects this.
    const legs = [
      leg('0x01', A, B, 100n, 200n),
      leg('0x02', B, A, 200n, 90n),
      leg('0x03', A, C, 90n, 500n),
    ];
    const result = chainLegs(legs, A, C);
    expect(result.reconstructed).toBe(true);
  });

  it('still REJECTS a genuine cycle: input recurs but nets to zero, output never received', () => {
    // A→B, B→A returns all of A (net zero), and C never appears. Must NOT reconstruct —
    // proves the net-source relaxation did not open a hole (net-source fails: outflow 100
    // == inflow 100; and the output net-receive check fails: C inflow 0).
    const legs = [
      leg('0x01', A, B, 100n, 200n),
      leg('0x02', B, A, 200n, 100n),
    ];
    const result = chainLegs(legs, A, C);
    expect(result.reconstructed).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests — expect the positive one to FAIL, the cycle one to PASS**

Run: `npx vitest run packages/core/src/routeGraph.test.ts -t "input-token mid-chain recurrence"`
Expected: the "reconstructs … input token recurs" test FAILS (`reconstructed` is `false` under the current pure-source check); the "still REJECTS a genuine cycle" test PASSES (already rejected). This confirms the RED test targets exactly the bug and the guard test is green before the change.

- [ ] **Step 3: Relax `linearFlowValid`**

In `packages/core/src/routeGraph.ts`, in `linearFlowValid`, replace:
```typescript
  if ((inflow.get(inputToken) ?? 0n) !== 0n) return false;
```
with:
```typescript
  // Input is a NET source (may recur mid-chain): net outflow must be positive.
  // Symmetric with the output token, which already may recur (see below).
  if ((outflow.get(inputToken) ?? 0n) <= (inflow.get(inputToken) ?? 0n)) return false;
```

- [ ] **Step 4: Relax `reconstructDag`**

In `reconstructDag`, replace the input branch:
```typescript
    if (t === inputToken) { if (inn !== 0n) return null; continue; } // pure source
```
with:
```typescript
    if (t === inputToken) { continue; } // net source — validated after the loop
```
and replace the post-loop input check:
```typescript
  if ((outflow.get(inputToken) ?? 0n) <= 0n) return null; // input must send
```
with:
```typescript
  if ((outflow.get(inputToken) ?? 0n) <= (inflow.get(inputToken) ?? 0n)) return null; // net source
```
Leave the output pure-sink check (`if (t === outputToken) { if (out !== 0n) return null; ... }`) and the output net-receive check (`if ((inflow.get(outputToken) ?? 0n) <= 0n) return null;`) unchanged.

- [ ] **Step 5: Run the two tests — both pass**

Run: `npx vitest run packages/core/src/routeGraph.test.ts -t "input-token mid-chain recurrence"`
Expected: both PASS.

- [ ] **Step 6: Gate — full suite, tsc, lint (no regression)**

```bash
npx tsc --build && npm run lint && npx vitest run 2>&1 | grep -E "Tests |Test Files "
```
Expected: tsc 0, lint clean, `Test Files 33 passed (33)`, Tests = 430 + 2 (record it). If ANY previously-passing route test now fails, stop — the change was supposed to be strictly more permissive; a regression means an edit went beyond the input source-check.

- [ ] **Step 7: Acceptance — id 134 reconstructs with confidence above `low` (no DB write)**

Run `analyzeTransaction` directly against id 134's tx over RPC (the receipt page reads the persisted DB row and never recomputes, so a UI check cannot show the fix). Requires `TCA_RPC_URL`:

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder
npx tsc --build   # ensure dist/ is current (packages/core is ESM)
set -a && source .env && set +a
node -e "
import('./packages/core/dist/index.js').then(({ analyzeTransaction }) =>
  analyzeTransaction('0x173e019d69ff3bf642ca4024241aa9a9fe241f80dc24f262bf7ccd2c4ef76918', 8453, { rpcUrl: process.env.TCA_RPC_URL })
).then(r => { console.log('routeShape=' + r.routeShape, 'routePure=' + r.routePure, 'decompConfidence=' + r.decompConfidence); })
 .catch(e => { console.error('ERR', e.message); process.exit(1); });
"
```
(Dynamic `import()` — `require` fails because `packages/core` is `type: module`.) Expected: `decompConfidence` is `medium` or `high` (no longer `low`), and `routePure`/`routeShape` reflect a reconstructed route. If it is still `low`, capture the output and STOP — the fix did not flip id 134; do not weaken any check to force it. Note: `decompConfidence` may legitimately be capped by other factors (netting, reconciliation residual) — if it rises off `low` at all, that is success; if it stays exactly `low`, investigate whether id 134's low confidence has a second cause beyond non-reconstruction and report it.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/routeGraph.ts packages/core/src/routeGraph.test.ts
git commit -m "$(cat <<'EOF'
fix(core): reconstruct routes where the input token recurs mid-chain

linearFlowValid and reconstructDag required the input token to be a PURE source
(zero inflow), while the output token was already allowed to recur mid-chain — an
asymmetry that pinned id 134 (ETH→TOSHI = WETH→USDC→WETH→TOSHI) to a
non-reconstructed 'complex' shape and low confidence. Relax the input to a NET
source (outflow > inflow) in both, symmetric single-source/single-sink flow
conservation. Strictly more permissive; a genuine cycle (net-zero input / no output
sink) still rejects. New chainLegs tests cover the recurrence and the cycle guard.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ATi8n599KY63NMFrzJzbg2
EOF
)"
```

---

### Task 2: Update the memory

**Files:**
- Modify: `/Users/justinvoorhees/.claude/projects/-Users-justinvoorhees-withfabricxyz-fabric-tca-decoder/memory/rfq-maker-legs.md` (the "Still open elsewhere" line) and/or `history-validation-findings.md` / `dag-route-reconstruction.md` if more apt.
- Modify: `/Users/justinvoorhees/.claude/projects/-Users-justinvoorhees-withfabricxyz-fabric-tca-decoder/memory/MEMORY.md`

- [ ] **Step 1: Record the fix**

Note that id 134's input-token mid-chain recurrence is FIXED (routeGraph net-source relaxation, commit hash), the exact acceptance result (id 134's new `decompConfidence`), and that id 56's "V4 multi-pool" diagnosis is STALE (its current legs are a plain univ3+pancakev3 2-hop) and needs fresh diagnosis before a spec. Update the MEMORY.md index if warranted. (Memory files are outside the repo — no commit.)

---

## Notes for the executor

- **The exact change is two comparisons.** Old: input `inflow == 0`. New: input `outflow > inflow`. Both `linearFlowValid` (one line) and `reconstructDag` (the input branch + the post-loop check). Nothing else moves.
- **If the full suite regresses,** an edit went past the input source-check — revert and re-apply only the two comparisons. A strictly-more-permissive input check cannot break a previously-reconstructing route.
- **If Step 7 doesn't flip id 134,** do NOT weaken any other check to force it. Report the actual `decompConfidence` and whether a second cause (netting / recon residual) is capping it — that is a finding, not a failure of this task.
