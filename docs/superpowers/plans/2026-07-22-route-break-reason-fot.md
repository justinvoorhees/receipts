# Route Break-Reason + Fee-on-Transfer Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a route fails to reconstruct, surface *why* — specifically distinguishing a fee-on-transfer (taxed) intermediate token from an orphan (un-modeled venue) token — and emit a specific flag instead of the bare `ROUTE_NOT_DECOMPOSED`.

**Architecture:** Add a pure `diagnoseBreak()` to `routeGraph.ts` that classifies an unreconstructable leg set into a `RouteBreakReason`. Thread that reason through `chainLegs` → `buildRouteGraph` → the `RouteGraph` object, then branch on it in `decomposeRoute.ts`'s non-reconstructed return to push a `FEE_ON_TRANSFER` or `MISSING_LEG` flag. No behavior change to the numbers — nulling LP/slippage on these routes stays correct; this only improves the explanation. This break-reason signal is also the foundation the V4-leg-extraction plan consumes (the `orphan_token` case is the V4 signal).

**Tech Stack:** TypeScript, vitest. `packages/core` only. Built with `tsc --build`; tests via `npx vitest run`; lint via `npm run lint`.

## Global Constraints

- Work is confined to `packages/core`. No new runtime dependencies.
- `routeGraph.ts` MUST stay pure (no viem / RPC / DB / fs imports) — it is bigint graph logic only.
- Flag strings use the existing truncated-address style already used by the `MULTI-HOP` flag in this codebase: `` `${token.slice(0, 6)}...${token.slice(-4)}` ``.
- Gates for every task: `npx tsc --build`, `npm run lint`, `npx vitest run`.
- ⚠️ vitest `-t` filters are **substring** matches — keep test titles distinctive.
- The existing `conserved(inflow, outflow)` helper (`routeGraph.ts`, ~line 299) is the single source of truth for the ≤0.1% conservation tolerance. Reuse it; do not re-derive the tolerance.

---

### Task 1: `RouteBreakReason` type + `diagnoseBreak()` pure classifier

**Files:**
- Modify: `packages/core/src/routeGraph.ts` (add type near the `RouteShape` export ~line 28; add function near `reconstructDag` ~line 345)
- Test: `packages/core/src/routeGraph.test.ts`

**Interfaces:**
- Produces: `export type RouteBreakReason` and `export function diagnoseBreak(legs: Leg[], inputToken: string, outputToken: string): RouteBreakReason`.
- Consumes: the existing private `conserved(inflow: bigint, outflow: bigint): boolean`.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/routeGraph.test.ts`:

```typescript
import { buildRouteGraph, chainLegs, diagnoseBreak } from './routeGraph.js';
import type { Leg } from './routeGraph.js';

const SWARM = '0xea87169699dabd028a78d4b91544b4298086baf6';
const MENTE = '0x4cd9a847f39106e19a4e41aea8a232e915c82af5';
const ORPHAN = '0xcbb7c000000000000000000000000000000cbb7c0';

/** Minimal Leg builder for graph-logic tests. */
function mkLeg(tokenIn: string, tokenOut: string, amountInRaw: bigint, amountOutRaw: bigint): Leg {
  return { venue: '0x' + '0'.repeat(40), type: 'univ3', tokenIn, tokenOut, amountInRaw, amountOutRaw };
}

describe('diagnoseBreak', () => {
  it('flags a fee-on-transfer intermediate (SWARM ~1% skim) as fee_on_transfer', () => {
    // WETH→SWARM produces 1000 SWARM, SWARM→MENTE only consumes 990 (1% tax).
    const legs = [
      mkLeg(WETH, SWARM, 5n, 1000n),
      mkLeg(SWARM, MENTE, 990n, 42n),
    ];
    const r = diagnoseBreak(legs, WETH, MENTE);
    expect(r.kind).toBe('fee_on_transfer');
    if (r.kind === 'fee_on_transfer') {
      expect(r.token).toBe(SWARM);
      expect(r.gapBps).toBe(100); // 10/1000 = 1.00%
    }
  });

  it('flags an orphan intermediate (consumed, never produced) as orphan_token', () => {
    // ORPHAN is spent by a leg but produced by none (inflow=0).
    const legs = [
      mkLeg(WETH, MENTE, 5n, 1000n),
      mkLeg(ORPHAN, MENTE, 490n, 500n),
    ];
    const r = diagnoseBreak(legs, WETH, MENTE);
    expect(r.kind).toBe('orphan_token');
    if (r.kind === 'orphan_token') {
      expect(r.token).toBe(ORPHAN);
      expect(r.outflowRaw).toBe(490n);
    }
  });

  it('returns unreconstructed when every intermediate conserves (no specific cause)', () => {
    const legs = [
      mkLeg(WETH, SWARM, 5n, 1000n),
      mkLeg(SWARM, MENTE, 1000n, 42n),
    ];
    const r = diagnoseBreak(legs, WETH, MENTE);
    expect(r.kind).toBe('unreconstructed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/routeGraph.test.ts -t "diagnoseBreak"`
Expected: FAIL — `diagnoseBreak is not exported` / `is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `packages/core/src/routeGraph.ts`, add after the `RouteShape` type (~line 28):

```typescript
/**
 * Why a leg set could not be reconstructed into a conserved input→output DAG.
 * `orphan_token` (inflow=0, outflow>0) means a leg spends a token no leg
 * produces — an un-modeled venue (e.g. a V4 multi-pool PoolManager). A
 * `fee_on_transfer` intermediate has BOTH flows > 0 but they disagree beyond
 * the conservation tolerance — a taxed token, where the amounts genuinely
 * cannot be trusted for per-leg attribution. `unreconstructed` is the residual
 * (cyclic / disconnected / degenerate) with no single culprit token.
 */
export type RouteBreakReason =
  | { kind: 'fee_on_transfer'; token: string; inflowRaw: bigint; outflowRaw: bigint; gapBps: number }
  | { kind: 'orphan_token'; token: string; outflowRaw: bigint }
  | { kind: 'unreconstructed' };
```

Add near `reconstructDag` (~line 345), after the `conserved` helper so it is in scope:

```typescript
/**
 * Classify an unreconstructable leg set. Call ONLY on the non-reconstructed
 * path — a conserved input→output flow returns `unreconstructed` here but would
 * not have reached this function. Pure: mirrors reconstructDag's per-token
 * inflow/outflow accounting, then names the first offending intermediate.
 * Orphan is checked before fee-on-transfer because an orphan (inflow=0) is also
 * technically non-conserving, but the more specific cause is "missing leg".
 */
export function diagnoseBreak(legs: Leg[], inputToken: string, outputToken: string): RouteBreakReason {
  const inflow = new Map<string, bigint>();
  const outflow = new Map<string, bigint>();
  for (const l of legs) {
    outflow.set(l.tokenIn, (outflow.get(l.tokenIn) ?? 0n) + l.amountInRaw);
    inflow.set(l.tokenOut, (inflow.get(l.tokenOut) ?? 0n) + l.amountOutRaw);
  }
  const tokens = new Set<string>([...inflow.keys(), ...outflow.keys()]);
  for (const t of tokens) {
    if (t === inputToken || t === outputToken) continue;
    const inn = inflow.get(t) ?? 0n;
    const out = outflow.get(t) ?? 0n;
    if (inn === 0n && out > 0n) {
      return { kind: 'orphan_token', token: t, outflowRaw: out };
    }
    if (!conserved(inn, out)) {
      const max = inn > out ? inn : out;
      const diff = inn > out ? inn - out : out - inn;
      const gapBps = max === 0n ? 0 : Number((diff * 10_000n) / max);
      return { kind: 'fee_on_transfer', token: t, inflowRaw: inn, outflowRaw: out, gapBps };
    }
  }
  return { kind: 'unreconstructed' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/routeGraph.test.ts -t "diagnoseBreak"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/routeGraph.ts packages/core/src/routeGraph.test.ts
git commit -m "feat(core): classify route break reason (fee-on-transfer vs orphan token)"
```

---

### Task 2: Thread `breakReason` through `chainLegs` → `buildRouteGraph` → `RouteGraph`

**Files:**
- Modify: `packages/core/src/routeGraph.ts` (`RouteGraph` interface ~line 30; `chainLegs` return type + false-path returns ~line 243–294; `buildRouteGraph` ~line 455–473)
- Test: `packages/core/src/routeGraph.test.ts`

**Interfaces:**
- Consumes: `diagnoseBreak` (Task 1).
- Produces: `RouteGraph.breakReason?: RouteBreakReason` — set whenever `reconstructed === false`, absent otherwise. `chainLegs` now returns `{ ordered: Leg[]; shape: RouteShape; reconstructed: boolean; breakReason?: RouteBreakReason }`.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/routeGraph.test.ts`:

```typescript
describe('buildRouteGraph breakReason', () => {
  it('sets a fee_on_transfer breakReason on a taxed-intermediate route', () => {
    const trader = '0x00000000000000000000000000000000000000e1';
    const poolA = '0x00000000000000000000000000000000000000a2';
    const poolB = '0x00000000000000000000000000000000000000b2';
    const SWARM = '0xea87169699dabd028a78d4b91544b4298086baf6';
    // trader sends WETH to poolA, poolA sends 1000 SWARM to poolB, but only 990
    // SWARM arrives (1% tax), poolB sends USDC to trader.
    const transfers = [
      { token: WETH, from: trader, to: poolA, value: 5n },
      { token: SWARM, from: poolA, to: poolB, value: 1000n },
      { token: SWARM, from: poolB, to: '0x000000000000000000000000000000000000dead', value: 10n },
      { token: USDC, from: poolB, to: trader, value: 42n },
    ];
    const venues = new Map([[poolA, { type: 'univ3' as const }], [poolB, { type: 'univ3' as const }]]);
    const g = buildRouteGraph({ transfers, trader, venues, denylist: new Set() });
    expect(g.reconstructed).toBe(false);
    expect(g.breakReason?.kind).toBe('fee_on_transfer');
  });

  it('leaves breakReason undefined on a cleanly reconstructed route', () => {
    const g = buildRouteGraph({ transfers, trader, venues, denylist: new Set() });
    expect(g.reconstructed).toBe(true);
    expect(g.breakReason).toBeUndefined();
  });
});
```

(The second test reuses the module-level `transfers`/`venues`/`trader` fixtures already defined at the top of the file for the linear USDC→VIRTUAL→WETH route.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/routeGraph.test.ts -t "buildRouteGraph breakReason"`
Expected: FAIL — `breakReason` is `undefined` on the taxed route (property does not exist yet).

- [ ] **Step 3: Write minimal implementation**

In `routeGraph.ts`, add to the `RouteGraph` interface (~line 36, after `reconstructed`):

```typescript
  reconstructed: boolean;   // false → could not order the path
  breakReason?: RouteBreakReason; // set only when reconstructed === false
```

Change `chainLegs`'s return type annotation (~line 247) to include the field:

```typescript
): { ordered: Leg[]; shape: RouteShape; reconstructed: boolean; breakReason?: RouteBreakReason } {
```

Update the three `reconstructed: false` return sites in `chainLegs`:

```typescript
  if (legs.length === 0) {
    return { ordered: [], shape: 'complex', reconstructed: false, breakReason: { kind: 'unreconstructed' } };
  }

  if (legs.length === 1) {
    const leg = legs[0]!;
    if (leg.tokenIn === inputToken && leg.tokenOut === outputToken) {
      return { ordered: [leg], shape: 'single', reconstructed: true };
    }
    return { ordered: [leg], shape: 'complex', reconstructed: false, breakReason: diagnoseBreak(legs, inputToken, outputToken) };
  }
```

And the final complex fallback (~line 293):

```typescript
  return { ordered: complexOrdered, shape: 'complex', reconstructed: false, breakReason: diagnoseBreak(legs, inputToken, outputToken) };
```

In `buildRouteGraph`, update the destructure and return (~line 455 and ~line 466):

```typescript
  const { ordered, shape, reconstructed, breakReason } = chainLegs(legs, inputToken, outputToken);
```

```typescript
  return {
    legs: ordered,
    shape,
    inputToken,
    outputToken,
    tokens: Array.from(tokenSet),
    reconstructed,
    ...(breakReason ? { breakReason } : {}),
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/routeGraph.test.ts`
Expected: PASS — the full file (existing tests unchanged, 2 new tests pass).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/routeGraph.ts packages/core/src/routeGraph.test.ts
git commit -m "feat(core): thread route breakReason through buildRouteGraph"
```

---

### Task 3: Emit `FEE_ON_TRANSFER` / `MISSING_LEG` flags in `decomposeRoute`

**Files:**
- Modify: `packages/core/src/decomposeRoute.ts` (import `RouteBreakReason` from `./routeGraph.js` ~line 20; non-reconstructed branch ~line 632–636)
- Test: `packages/core/src/decomposeRoute.test.ts`

**Interfaces:**
- Consumes: `graph.breakReason` (Task 2).
- Produces: adds one of these strings to `routeFlags` (before the existing `ROUTE_NOT_DECOMPOSED` line, which is retained for backward compatibility):
  - `` `FEE_ON_TRANSFER: token ${short} loses ~${pct}% between hops — LP/slippage not separable` ``
  - `` `MISSING_LEG: token ${short} is consumed but never produced (un-modeled venue, likely V4 multi-pool) — LP/slippage not separable` ``

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/decomposeRoute.test.ts`. This builds a synthetic taxed-intermediate trace using the file's existing `transferLog` helper (already imported/defined near the top of that test file). Model: trader→poolA (WETH), poolA→poolB (1000 TAX), 1% of TAX skimmed to a burn address, poolB→trader (USDC).

```typescript
describe('decomposeRoute fee-on-transfer flag', () => {
  const TAX = '0xea87169699dabd028a78d4b91544b4298086baf6';
  const poolA = '0x00000000000000000000000000000000000000c1';
  const poolB = '0x00000000000000000000000000000000000000c2';
  const burn = '0x000000000000000000000000000000000000dead';

  it('emits FEE_ON_TRANSFER naming the taxed intermediate token', async () => {
    const trace = {
      type: 'CALL', from: TRADER, to: poolA, value: '0x0', calls: [],
      logs: [
        transferLog(WETH as `0x${string}`, TRADER as `0x${string}`, poolA as `0x${string}`, 5n),
        transferLog(TAX as `0x${string}`, poolA as `0x${string}`, poolB as `0x${string}`, 1000n),
        transferLog(TAX as `0x${string}`, poolB as `0x${string}`, burn as `0x${string}`, 10n),
        transferLog(USDC as `0x${string}`, poolB as `0x${string}`, TRADER as `0x${string}`, 42n),
        // Uni V3 Swap events so both pools are recognized venues
        { address: poolA, topics: [UNI_V3_SWAP_TOPIC], data: '0x' },
        { address: poolB, topics: [UNI_V3_SWAP_TOPIC], data: '0x' },
      ],
    };
    const input: DecomposeTradeInput = {
      trader: TRADER, realizedPrice: 1, notionalUsdc: 42, allInCostBps: 0,
      gasCostUsd: 0, blockNumber: 1n, rpcUrl: '',
    } as DecomposeTradeInput;
    const result = await decomposeRoute(input, {
      trace,
      feeReader: () => ({ bps: 30, defaulted: false }),
      rfqProbe: () => 'contract',
    });
    expect(result.slippageBps).toBeNull();
    const fot = result.flags.find(f => f.startsWith('FEE_ON_TRANSFER'));
    expect(fot).toBeDefined();
    expect(fot).toContain(`${TAX.slice(0, 6)}...${TAX.slice(-4)}`);
  });
});
```

> Note for the implementer: confirm the exact shape of `DecomposeTradeInput` and the `decomposeRoute` deps against the existing passing tests in this file (they already construct `input` and pass `{ trace, feeReader, rfqProbe }`). Mirror whatever those tests do for any additional required fields — do not invent fields.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/decomposeRoute.test.ts -t "fee-on-transfer flag"`
Expected: FAIL — no flag starting `FEE_ON_TRANSFER` exists (`fot` is `undefined`).

- [ ] **Step 3: Write minimal implementation**

In `decomposeRoute.ts`, extend the routeGraph import (~line 20):

```typescript
import { buildRouteGraph, type RouteShape, type VenueType, type Leg, type RouteBreakReason } from './routeGraph.js';
```

Replace the non-reconstructed flag block (~line 632–636):

```typescript
	// Else: !reconstructed (non-conserved, cyclic, or disconnected) — cannot
	// reliably separate LP/Slippage. Name the specific cause when we know it.
	const br: RouteBreakReason | undefined = graph.breakReason;
	if (br?.kind === 'fee_on_transfer') {
		const short = `${br.token.slice(0, 6)}...${br.token.slice(-4)}`;
		routeFlags.push(
			`FEE_ON_TRANSFER: token ${short} loses ~${(br.gapBps / 100).toFixed(2)}% between hops — LP/slippage not separable`,
		);
	} else if (br?.kind === 'orphan_token') {
		const short = `${br.token.slice(0, 6)}...${br.token.slice(-4)}`;
		routeFlags.push(
			`MISSING_LEG: token ${short} is consumed but never produced (un-modeled venue, likely V4 multi-pool) — LP/slippage not separable`,
		);
	}
	routeFlags.push(
		`ROUTE_NOT_DECOMPOSED: shape=${graph.shape}, reconstructed=${graph.reconstructed}`,
	);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/decomposeRoute.test.ts`
Expected: PASS — new FoT test plus all existing decomposeRoute tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/decomposeRoute.ts packages/core/src/decomposeRoute.test.ts
git commit -m "feat(core): emit FEE_ON_TRANSFER / MISSING_LEG flags on undecomposed routes"
```

---

### Task 4: End-to-end verification + repopulate affected rows

**Files:**
- Use: `scripts/repopulateReceipts.mjs` (existing, dry-run-gated)
- No source changes.

**Interfaces:**
- Consumes: the flags from Task 3, live via RPC.

- [ ] **Step 1: Full gate**

Run: `npx tsc --build && npm run lint && npx vitest run`
Expected: all green.

- [ ] **Step 2: Confirm the new flags appear live**

Re-analyze the two representative rows and confirm the flag text. Dry-run only:

Run: `node scripts/repopulateReceipts.mjs --ids=219,56`
Expected: both print `no change` on the WATCH columns (slippage stays null — correct), and the run completes with `errors=0`. (The flag change lives in `normalize_flags`, which is not a WATCH column, so "no change" on WATCH is expected.)

- [ ] **Step 3: Persist the refreshed flags**

Run: `node scripts/repopulateReceipts.mjs --ids=219,56 --commit`
Expected: `WROTE: 2 rows · errors=0`.

- [ ] **Step 4: Verify in the DB**

Confirm id 219 now carries a `FEE_ON_TRANSFER` flag and id 56 a `MISSING_LEG` flag by inspecting `normalize_flags` for those ids (via the same postgres pattern used elsewhere in this session, or a `getReceiptByHash` call). Expected: id 219 → `FEE_ON_TRANSFER: token 0xea87...baf6 …`; id 56 → `MISSING_LEG: token 0xcbb7...bb7c0 …` (exact orphan token address as computed).

- [ ] **Step 5: Commit (docs/state note only, if any)**

No code to commit here. If keeping a run log, add it under `docs/`. Otherwise this task is verification-only.

---

## Self-Review

**Spec coverage:** Break-reason classification (Task 1) ✓; propagation to `RouteGraph` (Task 2) ✓; specific flags in `decomposeRoute` (Task 3) ✓; live verification + repopulation of id 219 (FoT) and id 56 (orphan) (Task 4) ✓. The `orphan_token` reason is deliberately included here — it is the signal the V4-extraction plan (`2026-07-22-v4-multipool-leg-extraction.md`) keys off.

**Placeholder scan:** No TBD/TODO. The one soft spot — the exact `DecomposeTradeInput` field list in Task 3's test — is explicitly delegated to "mirror the existing passing tests in this file," because those tests are the authority and inventing fields would be worse than pointing at them.

**Type consistency:** `RouteBreakReason` union defined in Task 1, exported and reused verbatim in Tasks 2–3. `diagnoseBreak` signature identical across tasks. `breakReason` optional field name consistent in `RouteGraph`, `chainLegs` return, and `buildRouteGraph`.

**Behavior invariant:** LP/slippage remain `null` on these routes — Task 4 Step 2 asserts WATCH columns are unchanged. This plan changes only the *explanation*, never the numbers.
