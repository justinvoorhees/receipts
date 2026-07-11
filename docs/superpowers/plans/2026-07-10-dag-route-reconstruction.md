# DAG Route Reconstruction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose convergent multi-hop / general-DAG routes (currently `ROUTE_NOT_DECOMPOSED`) into per-leg price impact + slippage that reconcile with the trade-level all-in.

**Architecture:** Generalize `chainLegs` (routeGraph.ts) to accept any conserved acyclic input→output flow via a topological sort, and extend the *existing* notional-weighting (already used for LP fees) to per-leg price impact in `decomposeRoute` so the raw-sum reconciliation holds for DAGs. Then broaden the Step-9 gate from `shape ∈ {single,linear,split}` to `reconstructed`.

**Tech Stack:** TypeScript, Vitest, pnpm/npm workspaces. Pure bigint graph logic (no RPC in routeGraph). decomposeRoute tests inject fake `midReader`/`decimalsReader`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-10-dag-route-reconstruction-design.md`.
- No DB schema change (routeLegs is jsonb; numeric columns already exist).
- Existing single/linear/clean-split routes MUST stay behaviorally identical (fast-path branches preserved; weight ≈ 1 for linear).
- Per-leg price-impact *computation* (leg mid vs realized) is unchanged — only its weighting/aggregation.
- Never-throw contracts in core are preserved (no new throwing paths).
- Run core tests from `packages/core`: `npx vitest run <file>`. RPC e2e needs env: `set -a; . ./.env; set +a` from repo root first (exports `TCA_RPC_URL`), then `cd packages/core && npx vitest run`.
- Commit messages end with the repo's Co-Authored-By / Claude-Session trailers.

---

### Task 1: General-DAG reconstruction in `chainLegs`

**Files:**
- Modify: `packages/core/src/routeGraph.ts` (export `chainLegs`; add `reconstructDag` + helpers; wire into `chainLegs`)
- Test: `packages/core/src/routeGraph.test.ts`

**Interfaces:**
- Consumes: `Leg` (has `tokenIn`, `tokenOut`, `amountInRaw: bigint`, `amountOutRaw: bigint`), `RouteShape`.
- Produces: `export function chainLegs(legs: Leg[], inputToken: string, outputToken: string): { ordered: Leg[]; shape: RouteShape; reconstructed: boolean }`.

- [ ] **Step 1: Write failing tests** in `packages/core/src/routeGraph.test.ts` (add a new `describe` at the end of the file). Merge `chainLegs` into the EXISTING `import { buildRouteGraph } from './routeGraph.js';` at line 2 — do not add a duplicate import line:

```typescript
// line 2 becomes:
import { buildRouteGraph, chainLegs } from './routeGraph.js';

describe('chainLegs — general DAG reconstruction', () => {
  const leg = (tokenIn: string, tokenOut: string, inRaw: bigint, outRaw: bigint) => ({
    venue: `0x${tokenIn}${tokenOut}`, type: 'univ3' as const, tokenIn, tokenOut,
    amountInRaw: inRaw, amountOutRaw: outRaw,
  });

  it('reconstructs a convergent multi-hop split (LFI→WETH→USDC→GITLAWB + LFI→USDC)', () => {
    // Flow: 100 LFI splits → 60 via WETH, 40 direct → 100 USDC → GITLAWB
    const legs = [
      leg('lfi', 'weth', 60n, 6n),
      leg('weth', 'usdc', 6n, 60n),
      leg('lfi', 'usdc', 40n, 40n),
      leg('usdc', 'gitlawb', 100n, 100n),
    ];
    const r = chainLegs(legs, 'lfi', 'gitlawb');
    expect(r.reconstructed).toBe(true);
    expect(r.ordered).toHaveLength(4);
    // topo order: every leg's tokenIn is produced by an earlier leg or is the input
    const produced = new Set(['lfi']);
    for (const l of r.ordered) { expect(produced.has(l.tokenIn)).toBe(true); produced.add(l.tokenOut); }
  });

  it('rejects a non-conserved flow (intermediate token leaks)', () => {
    // 100 USDC → 100 WETH-received, but only 40 WETH sent onward (60 leaks)
    const legs = [ leg('usdc', 'weth', 100n, 100n), leg('weth', 'dai', 40n, 40n) ];
    const r = chainLegs(legs, 'usdc', 'dai');
    expect(r.reconstructed).toBe(false);
  });

  it('rejects a cyclic flow', () => {
    const legs = [ leg('usdc', 'weth', 10n, 10n), leg('weth', 'usdc', 10n, 10n), leg('usdc', 'dai', 10n, 10n) ];
    const r = chainLegs(legs, 'usdc', 'dai');
    expect(r.reconstructed).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/core && npx vitest run src/routeGraph.test.ts -t "general DAG"`
Expected: FAIL — `chainLegs` is not exported (import error) / assertions fail.

- [ ] **Step 3: Export `chainLegs` and add the DAG path.** In `packages/core/src/routeGraph.ts`:

Change `function chainLegs(` (line ~213) to `export function chainLegs(`.

Replace the split-check + complex-fallback block (currently lines ~238-256, from `// Check for split:` through the final `return { ordered: complexOrdered, shape: 'complex', reconstructed: false };`) with:

```typescript
  // Clean direct-pair split: every leg swaps inputToken→outputToken directly.
  const firstLegs = legs.filter(l => l.tokenIn === inputToken);
  if (firstLegs.length > 1 && legs.every(l => l.tokenIn === inputToken && l.tokenOut === outputToken)) {
    return { ordered: legs, shape: 'split', reconstructed: true };
  }

  // General DAG: any conserved, acyclic input→output flow, including convergent
  // multi-hop splits (paths that reconverge at a shared token). Costs are
  // notional-weighted in decomposeRoute so per-leg attribution reconciles.
  const dag = reconstructDag(legs, inputToken, outputToken);
  if (dag) {
    return { ordered: dag, shape: firstLegs.length > 1 ? 'split' : 'complex', reconstructed: true };
  }

  // Complex / stalled — best-effort ordering (unchanged non-reconstructed path).
  let complexOrdered = chain ?? legs;
  if (chain) {
    const stop = chain.findIndex((l) => l.tokenOut === outputToken);
    if (stop >= 0) complexOrdered = chain.slice(0, stop + 1);
  }
  return { ordered: complexOrdered, shape: 'complex', reconstructed: false };
```

Add these helpers immediately after `chainLegs` (before `tryBuildChain`):

```typescript
/** Conservation tolerance: intermediate-token inflow vs outflow may differ by
 *  ≤0.1% (rounding/dust between pools). Fee-on-transfer tokens exceed this and
 *  correctly stay non-reconstructed. */
function conserved(inflow: bigint, outflow: bigint): boolean {
  const diff = inflow > outflow ? inflow - outflow : outflow - inflow;
  const max = inflow > outflow ? inflow : outflow;
  return max === 0n ? true : diff * 1000n <= max;
}

/**
 * Reconstruct a general DAG: returns legs topologically ordered when the flow is
 * a conserved, acyclic path from inputToken (pure source) to outputToken (pure
 * sink); null otherwise. Amounts are compared per token in that token's own raw
 * units (cross-token amounts are never mixed).
 */
function reconstructDag(legs: Leg[], inputToken: string, outputToken: string): Leg[] | null {
  const inflow = new Map<string, bigint>();  // token → total received (Σ amountOutRaw ending there)
  const outflow = new Map<string, bigint>(); // token → total sent (Σ amountInRaw starting there)
  for (const l of legs) {
    outflow.set(l.tokenIn, (outflow.get(l.tokenIn) ?? 0n) + l.amountInRaw);
    inflow.set(l.tokenOut, (inflow.get(l.tokenOut) ?? 0n) + l.amountOutRaw);
  }
  const tokens = new Set<string>([...inflow.keys(), ...outflow.keys()]);
  for (const t of tokens) {
    const inn = inflow.get(t) ?? 0n;
    const out = outflow.get(t) ?? 0n;
    if (t === inputToken) { if (inn !== 0n) return null; continue; } // pure source
    if (t === outputToken) { if (out !== 0n) return null; continue; } // pure sink
    if (!conserved(inn, out)) return null; // intermediate must balance
  }
  if ((outflow.get(inputToken) ?? 0n) <= 0n) return null; // input must send
  if ((inflow.get(outputToken) ?? 0n) <= 0n) return null; // output must receive

  // Greedy topological placement: place a leg once its tokenIn is available
  // (the input token, or a token produced by an already-placed leg). Leftover
  // legs ⇒ a cycle or a disconnected component ⇒ not reconstructable.
  const placed: Leg[] = [];
  const remaining = new Set(legs);
  const available = new Set<string>([inputToken]);
  let progress = true;
  while (remaining.size > 0 && progress) {
    progress = false;
    for (const l of [...remaining]) {
      if (available.has(l.tokenIn)) {
        placed.push(l);
        remaining.delete(l);
        available.add(l.tokenOut);
        progress = true;
      }
    }
  }
  return remaining.size === 0 ? placed : null;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/core && npx vitest run src/routeGraph.test.ts`
Expected: PASS (new DAG tests + all existing `buildRouteGraph` tests). If an existing test asserted a *non-clean* multi-first-leg split as `reconstructed=false`, and that fixture is actually a conserved DAG, it will now (correctly) reconstruct — update that assertion to `reconstructed=true`. A genuinely non-conserved fixture must still be `false`; if unsure whether a fixture is conserved, sum per-token inflow/outflow by hand before changing the assertion.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/routeGraph.ts packages/core/src/routeGraph.test.ts
git commit -m "feat(core): reconstruct general conserved-DAG routes in chainLegs"
```

---

### Task 2: Notional-weight per-leg price impact

**Files:**
- Modify: `packages/core/src/decomposeRoute.ts` (add `weightedPriceImpactBps` helper; apply it in Step 9)
- Test: `packages/core/src/decomposeRoute.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function weightedPriceImpactBps(legTotalCostBps: number, feeTierBps: number, legNotionalUsdc: number, tradeNotionalUsdc: number): number` — the raw per-leg impact (`legTotalCostBps − feeTierBps`) scaled by `legNotionalUsdc / tradeNotionalUsdc`, mirroring the LP-fee rollup weighting (`decomposeRoute.ts:723`).

- [ ] **Step 1: Write failing unit test** in `packages/core/src/decomposeRoute.test.ts` (add a new top-level `describe`, e.g. after the imports/before the main `describe('decomposeRoute'`):

```typescript
import { decomposeRoute, weightedPriceImpactBps } from './decomposeRoute.js';

describe('weightedPriceImpactBps', () => {
  it('equals the raw impact when the leg carries the full notional (linear)', () => {
    // legTotal 30, fee 5 → raw impact 25; weight = 1000/1000 = 1
    expect(weightedPriceImpactBps(30, 5, 1000, 1000)).toBeCloseTo(25, 10);
  });
  it('scales the impact by the leg notional share (split leg carries 40%)', () => {
    // raw impact 25, weight = 400/1000 → 10
    expect(weightedPriceImpactBps(30, 5, 400, 1000)).toBeCloseTo(10, 10);
  });
});
```

Note: `weightedPriceImpactBps` must be added to the existing `import { decomposeRoute } from './decomposeRoute.js';` line in the test file (merge, don't duplicate the import).

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/core && npx vitest run src/decomposeRoute.test.ts -t "weightedPriceImpactBps"`
Expected: FAIL — `weightedPriceImpactBps` is not exported.

- [ ] **Step 3: Add the helper and apply it.** In `packages/core/src/decomposeRoute.ts`, add near the other top-level helpers (e.g. just above `export async function decomposeRoute`):

```typescript
/**
 * Per-leg price impact as a notional-weighted contribution to the trade-level
 * cost, mirroring the LP-fee rollup weighting. For a linear leg (notional ≈ the
 * trade notional) the weight is ≈1, so this reduces to the raw impact; for
 * split/convergent legs it scales by the leg's share of the flow, so the raw
 * sum of per-leg costs reconciles with the trade-level all-in.
 */
export function weightedPriceImpactBps(
  legTotalCostBps: number,
  feeTierBps: number,
  legNotionalUsdc: number,
  tradeNotionalUsdc: number,
): number {
  const raw = legTotalCostBps - feeTierBps;
  return tradeNotionalUsdc > 0 ? raw * (legNotionalUsdc / tradeNotionalUsdc) : raw;
}
```

In Step 9, replace the raw impact assignment and its implausibility clamp. Change (currently ~line 778):

```typescript
        // Price impact = total cost − fee tier (LP fee is the "expected" cost)
        lwl.priceImpactBps = legTotalCostBps - lwl.feeTierBps;

        // Clamp implausible per-leg price-impact (stale-mid guard)
        if (Math.abs(lwl.priceImpactBps) > PI_IMPLAUSIBLE_CAP_BPS) {
```

to:

```typescript
        // Price impact = total cost − fee tier (LP fee is the "expected" cost),
        // notional-weighted so per-leg costs reconcile for split/convergent DAGs.
        const rawImpactBps = legTotalCostBps - lwl.feeTierBps;
        lwl.priceImpactBps = weightedPriceImpactBps(legTotalCostBps, lwl.feeTierBps, lwl.notionalUsdc, input.notionalUsdc);

        // Clamp implausible per-leg price-impact (stale-mid guard) on the RAW
        // per-leg impact, so the plausibility guard is independent of notional size.
        if (Math.abs(rawImpactBps) > PI_IMPLAUSIBLE_CAP_BPS) {
```

(The clamp body — `lwl.priceImpactBps = null; hasNullMid = true;` and the flag push — is unchanged; only its `if` condition switches from `lwl.priceImpactBps` to `rawImpactBps`.)

- [ ] **Step 4: Run to verify pass + no regression**

Run: `cd packages/core && npx vitest run src/decomposeRoute.test.ts`
Expected: PASS — new helper tests pass; existing linear fixtures (kyber batch-01, etc.) stay green because their legs carry ≈ the full notional (weight ≈ 1), so `priceImpactBps` and the `lpFeeBps + priceImpactBps ≈ legTotalCost` invariant remain within `toBeCloseTo(…, 0)`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/decomposeRoute.ts packages/core/src/decomposeRoute.test.ts
git commit -m "feat(core): notional-weight per-leg price impact for DAG reconciliation"
```

---

### Task 3: Broaden the Step-9 gate to any reconstructed route

**Files:**
- Modify: `packages/core/src/decomposeRoute.ts:732` (branch condition)
- Test: `packages/core/src/decomposeRoute.test.ts` (reconcile the existing non-reconstructed-fallback fixture)

**Interfaces:**
- Consumes: `graph.reconstructed`, `graph.shape` from Task 1.
- Produces: no new exports; reconstructed `complex` DAGs now flow through Step 9/10 (per-leg PI + slippage + reconResidual populated).

- [ ] **Step 1: Broaden the branch.** In `packages/core/src/decomposeRoute.ts`, change (line ~732):

```typescript
	if (graph.reconstructed && (graph.shape === 'single' || graph.shape === 'linear' || graph.shape === 'split')) {
```

to:

```typescript
	if (graph.reconstructed) {
```

- [ ] **Step 2: Run the full decomposeRoute suite to find fixtures affected by the broader acceptance**

Run: `cd packages/core && npx vitest run src/decomposeRoute.test.ts`
Expected: One likely failure — the "non-reconstructed fallback (Design Decision 7)" test, IF its fixture is actually a conserved DAG (it would now reconstruct → LP/slippage no longer null). Read that test.

- [ ] **Step 3: Reconcile the fallback fixture.** Open the failing test in `packages/core/src/decomposeRoute.test.ts`. Determine whether its route is genuinely non-decomposable:
  - If its fixture is **non-conserved / cyclic / disconnected** (the intended "cannot decompose" case), it should still return `reconstructed=false` after Task 1 — the test passes; no change needed (re-run to confirm).
  - If its fixture is actually a **conserved DAG** (it only failed before because the *shape* wasn't accepted), update the test to assert the new correct behavior: `reconstructed=true`, non-null `lpFeeBps`/`slippageBps`, and (with an injected `midReader`) non-null per-leg `priceImpactBps`. Keep a separate assertion that a deliberately **non-conserved** fixture still yields `ROUTE_NOT_DECOMPOSED` (add one if none exists), so the honest-fallback path stays covered.

Make the minimal edit that reflects true intent; do not weaken coverage of the genuine non-decomposable case.

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/core && npx vitest run src/decomposeRoute.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/decomposeRoute.ts packages/core/src/decomposeRoute.test.ts
git commit -m "feat(core): attribute costs for any reconstructed route (incl. DAGs)"
```

---

### Task 4: End-to-end validation on a real convergent route (RPC)

**Files:**
- Test: `packages/core/src/analyzeTransaction.test.ts` (add a case in the existing `describe.runIf(RPC)` block)

**Interfaces:**
- Consumes: `analyzeTransaction(hash, chainId, { rpcUrl })`.
- Produces: regression coverage that a real convergent-split trade decomposes.

- [ ] **Step 1: Add the failing/at-risk e2e** in the `describe.runIf(RPC)('analyzeTransaction (integration)', …)` block of `packages/core/src/analyzeTransaction.test.ts`:

```typescript
	it('decomposes a convergent multi-hop split (LFI->GITLAWB) with per-leg impact + slippage', async () => {
		const r = await analyzeTransaction(
			'0xe4b9514743e4f211b456f14c69fd3c4abddf68a620becbdcb1ffa7771c42f4b7',
			8453,
			{ rpcUrl: RPC! },
		);
		expect(r).not.toBeNull();
		// Previously ROUTE_NOT_DECOMPOSED (null slippage + all-null per-leg impact).
		expect(r!.slippageBps).not.toBeNull();
		const legs = r!.routeLegs as { priceImpactBps: number | null }[];
		expect(legs.filter((l) => typeof l.priceImpactBps === 'number').length).toBeGreaterThanOrEqual(1);
		expect((r!.normalizeFlags as string[]).some((f) => f.startsWith('ROUTE_NOT_DECOMPOSED'))).toBe(false);
	}, 30_000);
```

- [ ] **Step 2: Build dist and run with RPC**

Run (from repo root):
```bash
npx tsc --build
set -a; . ./.env; set +a
cd packages/core && npx vitest run src/analyzeTransaction.test.ts -t "convergent multi-hop split"
```
Expected: PASS (the test actually RAN — confirm it's in the passed list, not skipped). If it FAILS on `slippageBps` still null, inspect `r.normalizeFlags` for `ROUTE_NOT_DECOMPOSED` (reconstruction still bailing → revisit conservation tolerance in Task 1) vs `MID_NULL` on every leg (a mid-availability issue, not a reconstruction issue — note it and consult before loosening).

- [ ] **Step 3: Run the full core suite with RPC**

Run (from repo root): `set -a; . ./.env; set +a; cd packages/core && npx vitest run`
Expected: all pass (137+ tests). Also run `npx tsc --noEmit -p tsconfig.json` → clean.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/analyzeTransaction.test.ts
git commit -m "test(core): e2e convergent-split route decomposes with impact + slippage"
```

---

### Task 5: Repopulate the receipts DB + verify, then integrate

**Files:** none (operational).

- [ ] **Step 1: Confirm dashboard still green** (no dashboard change expected — it renders whatever's non-null):

Run: `cd packages/dashboard && npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: PASS + clean.

- [ ] **Step 2: Back up + repopulate the receipts DB in place.** Write a throwaway script at the repo root (import `analyzeTransaction` + `createDb`/`schema` via ABSOLUTE `dist` paths — core's package.json `exports` points to `src/*.ts` so package-name import fails under node; `drizzle-orm` `eq` resolves when run from repo root). Back up the table to a JSON file first, then re-analyze every row and update in place by `id` (preserve `id`/`createdAt`; keep the existing row on a null re-analysis). Run with `set -a; . ./.env; set +a` first. Delete the script after. (This mirrors the repopulation pattern used earlier in the receipts work.) Report: rows updated, and how many previously-`ROUTE_NOT_DECOMPOSED` rows (id 55/56/59/75) now have non-null `slippageBps`.

- [ ] **Step 3: Spot-check the target rows** via a read-only query: id 55/56/59/75 should now show non-null `slippageBps` and per-leg `priceImpactBps` where mids exist; `pricingStatus` unchanged; `confidence` may be `low` for poorly-reconciling DAGs (expected).

- [ ] **Step 4: Merge.** Fast-forward `main` to the feature branch (`git checkout main && git merge --ff-only feat/dag-route-reconstruction`), delete the branch, and update the `history-validation-findings` memory (reconstruction: DONE).

---

## Notes for the implementer

- The three genuinely-new reconstructions surface only for routes that previously hit the complex/non-clean-split fallback; single/linear/clean-split take earlier `return`s and are untouched.
- If Task 3 Step 2 surfaces additional fixtures that now reconstruct, apply the same judgment as Step 3: reflect true intent, keep coverage of the genuine non-decomposable (non-conserved) case.
- Conservation tolerance (`conserved`, 0.1%) is the one tuning knob. If a real route with trustworthy mids still won't reconstruct due to legitimate dust, widening it slightly is acceptable — but a route that only "conserves" under a loose tolerance is a signal to stay non-reconstructed, not to loosen.
