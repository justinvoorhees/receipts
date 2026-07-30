# V4 Multi-Pool Fee Averaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop collapsing a multi-pool Uniswap V4 route into one leg carrying an
arbitrary pool's fee tier and poolId, so five receipts get real per-pool LP fees
and price impacts.

**Architecture:** The repair mechanism already exists — `synthesizeV4Legs`
produces one leg per `poolId` and is driven by a "rescue" block in
`decomposeRoute`. Two things stop it running here: a gate that only fires when
the route *fails* to reconstruct, and a merge rule that discards synthesized
legs whose token pair matches an existing `univ4` leg. This plan widens the gate
and inverts the merge preference when more than one pool is involved. No new
readers, no new venue types.

**Tech Stack:** TypeScript, Vitest, viem (RPC), Drizzle/Postgres, Node ESM
scripts.

Spec: `docs/superpowers/specs/2026-07-30-v4-multipool-fee-averaging-design.md`

## Global Constraints

- `packages/core/src/**` uses **2-space indentation**. (`packages/dashboard/**`
  uses tabs — do not carry that habit in.)
- **Never run `npm run build`** — it writes into the same `.next` a running dev
  server owns and the app renders unstyled. Use `npx tsc --build`.
- Test baseline to hold: **624/624** with `.env` exported
  (`set -a && source .env && set +a`); **621 passing + 3 skipped** without it.
  `npx tsc --build` exit 0, `npx eslint packages/dashboard packages/core` exit 0.
  Run both shell states before calling anything green — the 3 RPC e2e tests skip
  silently when `TCA_RPC_URL` is not exported, and `source .env` does not export
  by itself.
- ⚠️ `npx vitest run <path> -t 'name'` filters by **substring**, not exact match.
  A typo runs **zero** tests and reports green. Always confirm a non-zero count.
- Behaviour for a **single**-V4-pool route must be byte-identical to today. That
  is the regression surface: 21 of the 26 V4 receipts in the corpus are
  currently correct and must stay so.
- Work from the repo root: `/Users/justinvoorhees/withfabricxyz/fabric-tca-decoder`

## File Structure

| file | responsibility |
|---|---|
| `packages/core/src/v4Legs.ts` | **modify** — owns V4 Swap decoding and leg synthesis. Gains the rescue-gate predicate, so the decision is testable without a trace fixture. |
| `packages/core/src/v4Legs.test.ts` | **create** — unit tests for the predicate |
| `packages/core/src/routeGraph.ts` | **modify** — the `extraLegs` merge rule |
| `packages/core/src/routeGraph.test.ts` | **modify** — merge-rule tests |
| `packages/core/src/decomposeRoute.ts` | **modify** — call the predicate instead of the inline condition |
| `packages/core/src/routeVenueScan.ts` | **modify** — comment only, no behaviour change |
| `docs/receipts-v4-multipool-prerepop-backup.json` | **create** — pre-repopulation backup of the 5 rows |
| `docs/attribution-worklist.md` | **modify** — §2 marked done |

## Background: why the merge rule is the load-bearing half

All five affected receipts are splits across fee tiers of the **same token
pair**:

| id | notional | raw V4 fees (pips) | collapsed into |
|---|---:|---|---|
| 249 | $2,220 | 21222, 10000, 29500 | one `BRIAN→USDC` leg @295 bps |
| 55 | $1,446 | 500, 10000 | one `USDC→CLAWD` leg @100 bps |
| 59 | $637 | 3000, 500, 10003 | one `USDC→GITLAWB` leg @100.03 bps |
| 211 | $193 | 1002, 1006, 1000, 1004, 500, 1003 | one `WETH→USDC` leg @10.03 bps |
| 207 | $1 | 49, 500 | one `USDC→WETH` leg @5 bps |

`routeGraph.ts:511-517` drops any synthesized leg whose `(tokenIn, tokenOut)`
already exists as a `univ4` leg. Every synthesized leg here shares the collapsed
leg's pair, so **widening the gate alone would be a no-op** — all of them would
be discarded. Task 1 fixes that; Task 2 opens the gate. Task 1 lands first so
the mechanism is correct before anything starts using it.

Note ids 249, 211 and 207 are **not** clamped: they render confident LP Fee and
Price Impact numbers today with nothing flagging them.

---

### Task 1: The `extraLegs` merge rule

**Files:**
- Modify: `packages/core/src/routeGraph.ts:507-518`
- Test: `packages/core/src/routeGraph.test.ts`

**Interfaces:**
- Consumes: `Leg` (already exported from `routeGraph.ts`), whose optional
  `v4PoolId?: string` field is the discriminator.
- Produces: no new exports. `buildRouteGraph`'s behaviour changes only when
  `args.extraLegs` contains **two or more distinct** `v4PoolId` values.

⚠️ 2-space indentation.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('buildRouteGraph', …)` block in
`packages/core/src/routeGraph.test.ts`. The module-level fixtures (`USDC`,
`WETH`, `VIRTUAL`, `trader`, `pcs`, `v4`, `transfers`, `venues`) already exist at
the top of the file — use them, do not redefine them.

```ts
  it('extraLegs: replaces a collapsed V4 leg when the extras describe >1 pool', () => {
    // The module fixture's `v4` address yields ONE address-derived univ4 leg,
    // VIRTUAL→WETH. That is the collapsed PoolManager artifact: real routes put
    // several pools behind it and buildLegs cannot see the split. Two
    // synthesized legs on the SAME pair must REPLACE it, not be deduped against
    // it — this is the id 207 / id 211 shape (several fee tiers, one pair).
    const extraLegs: Leg[] = [
      { venue: 'v4:0xaaa', type: 'univ4', tokenIn: VIRTUAL, tokenOut: WETH,
        amountInRaw: 1_000000000000000000n, amountOutRaw: 400_000000000n, v4PoolId: '0xaaa' },
      { venue: 'v4:0xbbb', type: 'univ4', tokenIn: VIRTUAL, tokenOut: WETH,
        amountInRaw: 2_000000000000000000n, amountOutRaw: 600_000000000n, v4PoolId: '0xbbb' },
    ];
    const g = buildRouteGraph({ transfers, trader, venues, denylist: new Set(), extraLegs });

    // The bare-PoolManager leg is gone; both per-pool legs survive.
    expect(g.legs.filter((l) => l.venue === v4)).toHaveLength(0);
    expect(g.legs.filter((l) => l.venue.startsWith('v4:')).map((l) => l.venue).sort())
      .toEqual(['v4:0xaaa', 'v4:0xbbb']);
    expect(g.legs).toHaveLength(3); // pancakev3 + the two V4 pools
    expect(g.reconstructed).toBe(true);
  });

  it('extraLegs: a SINGLE pool still prefers the address-derived leg', () => {
    // The regression guard for the 21 V4 receipts that are currently correct.
    // One poolId ⇒ buildLegs' own leg is trustworthy and the extra is a
    // duplicate, exactly as before this change.
    const extraLegs: Leg[] = [
      { venue: 'v4:0xaaa', type: 'univ4', tokenIn: VIRTUAL, tokenOut: WETH,
        amountInRaw: 3_000000000000000000n, amountOutRaw: 1_000000000000000n, v4PoolId: '0xaaa' },
    ];
    const g = buildRouteGraph({ transfers, trader, venues, denylist: new Set(), extraLegs });
    expect(g.legs).toHaveLength(2);
    expect(g.legs.some((l) => l.venue === v4)).toBe(true);
    expect(g.legs.some((l) => l.venue.startsWith('v4:'))).toBe(false);
  });

  it('extraLegs: two legs from the SAME pool do not trigger replacement', () => {
    // Two Swap events on one poolId (e.g. a multi-hop through the same pool) is
    // NOT a collapsed multi-pool leg. Distinctness is what matters, not count —
    // counting extraLegs instead of poolIds would misfire here.
    const extraLegs: Leg[] = [
      { venue: 'v4:0xaaa', type: 'univ4', tokenIn: VIRTUAL, tokenOut: WETH,
        amountInRaw: 1_000000000000000000n, amountOutRaw: 400_000000000n, v4PoolId: '0xaaa' },
      { venue: 'v4:0xaaa', type: 'univ4', tokenIn: VIRTUAL, tokenOut: WETH,
        amountInRaw: 2_000000000000000000n, amountOutRaw: 600_000000000n, v4PoolId: '0xaaa' },
    ];
    const g = buildRouteGraph({ transfers, trader, venues, denylist: new Set(), extraLegs });
    expect(g.legs.some((l) => l.venue === v4)).toBe(true);
  });

  it('extraLegs: legs without a poolId never trigger replacement', () => {
    // v4PoolId is optional on Leg. Legs lacking it (older synthesis paths, or
    // non-V4 extras) must not be counted as distinct pools — a set of
    // `undefined` would otherwise look like one pool, or worse.
    const extraLegs: Leg[] = [
      { venue: 'v4:x', type: 'univ4', tokenIn: VIRTUAL, tokenOut: WETH,
        amountInRaw: 1n, amountOutRaw: 1n },
      { venue: 'v4:y', type: 'univ4', tokenIn: VIRTUAL, tokenOut: WETH,
        amountInRaw: 1n, amountOutRaw: 1n },
    ];
    const g = buildRouteGraph({ transfers, trader, venues, denylist: new Set(), extraLegs });
    expect(g.legs.some((l) => l.venue === v4)).toBe(true);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run packages/core/src/routeGraph.test.ts -t 'extraLegs'
```

Expected: the first test FAILS (the two synthesized legs are deduped away, so
`g.legs` has length 2 and the `v4` leg is still present). The other three PASS
already — they encode current behaviour, and their job is to stay green through
Step 3.

⚠️ Confirm the run reports a non-zero test count.

- [ ] **Step 3: Implement**

In `packages/core/src/routeGraph.ts`, replace the block at `:507-518` (from the
`// 3b. Merge in any synthesized extra legs` comment through the `const allLegs`
line) with:

```ts
  // 3b. Merge in any synthesized extra legs (e.g. V4 multi-pool legs from Swap
  // events).
  //
  // When the extras describe MORE THAN ONE distinct V4 pool, buildLegs' own
  // univ4 leg is the collapsed PoolManager artifact: routeVenueScan.ts keys
  // venues by emitter address and the V4 singleton emits for every pool it
  // hosts, so that leg carries only the LAST pool's fee and poolId. The
  // per-pool legs are strictly better information, so they REPLACE it.
  //
  // With one pool (or none) the address-derived leg is trustworthy and the
  // extra is a duplicate — keep the original pair-based guard, which is what
  // stops a single-pool V4 route double-counting.
  const extraPoolIds = new Set(
    (args.extraLegs ?? []).map((l) => l.v4PoolId).filter((id): id is string => id != null),
  );
  const legsAfterV4 = extraPoolIds.size > 1 ? legs.filter((l) => l.type !== 'univ4') : legs;
  const existingUniv4Pairs = new Set(
    legsAfterV4.filter((l) => l.type === 'univ4').map((l) => `${l.tokenIn}>${l.tokenOut}`),
  );
  const dedupedExtraLegs = (args.extraLegs ?? []).filter(
    (l) => !existingUniv4Pairs.has(`${l.tokenIn}>${l.tokenOut}`),
  );
  const allLegs = dedupedExtraLegs.length > 0 ? [...legsAfterV4, ...dedupedExtraLegs] : legsAfterV4;
```

Note `existingUniv4Pairs` is now built from `legsAfterV4`, not `legs`. When
replacement fires that set is empty, so every synthesized leg survives.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run packages/core/src/routeGraph.test.ts
npx tsc --build
```

Expected: all PASS (including the pre-existing
`extraLegs de-dup guard: drops a synthesized V4 leg already captured cleanly by
buildLegs` at `:51`, whose extra leg has no `v4PoolId` and so must be
unaffected), `tsc` exit 0.

- [ ] **Step 5: Verify the new test by mutation**

The first test must fail if the replacement is removed. Change
`extraPoolIds.size > 1` to `false`, re-run
`npx vitest run packages/core/src/routeGraph.test.ts -t 'extraLegs'`, and confirm
**only** the replacement test fails while the other three stay green. Then
revert and confirm all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/routeGraph.ts packages/core/src/routeGraph.test.ts
git commit -m "fix(core): let per-pool V4 legs replace the collapsed PoolManager leg

When synthesized extraLegs describe more than one distinct V4 poolId, the
address-derived univ4 leg is the collapsed singleton artifact carrying only
the last pool's fee and poolId. Prefer the per-pool legs instead of deduping
them away by token pair. Single-pool behaviour is unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The rescue gate

**Files:**
- Modify: `packages/core/src/v4Legs.ts` (append the predicate)
- Create: `packages/core/src/v4Legs.test.ts`
- Modify: `packages/core/src/decomposeRoute.ts:450-455`
- Modify: `packages/core/src/routeVenueScan.ts:88-94` (comment only)

**Interfaces:**
- Consumes: Task 1's merge rule (no API change — it just works now).
  `collectV4Swaps(logs): V4Swap[]` and `V4Swap { poolId, fee, amount0, amount1,
  sqrtPriceX96 }` already exist in `v4Legs.ts`.
- Produces: `shouldAttemptV4Rescue(args: { reconstructed: boolean; breakReason?:
  { kind: string } | undefined; v4Swaps: readonly V4Swap[] }): boolean`,
  exported from `v4Legs.ts`.

⚠️ 2-space indentation.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/v4Legs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { shouldAttemptV4Rescue } from './v4Legs.js';
import type { V4Swap } from './v4Legs.js';

const swap = (poolId: string, fee = 500): V4Swap => ({
  poolId, fee, amount0: 1n, amount1: -1n, sqrtPriceX96: 1n,
});

describe('shouldAttemptV4Rescue', () => {
  it('fires on the original path: a failed graph with an orphan token', () => {
    expect(shouldAttemptV4Rescue({
      reconstructed: false, breakReason: { kind: 'orphan_token' }, v4Swaps: [swap('0xa')],
    })).toBe(true);
  });

  it('fires on the original path: a failed graph blamed on fee-on-transfer', () => {
    expect(shouldAttemptV4Rescue({
      reconstructed: false, breakReason: { kind: 'fee_on_transfer' }, v4Swaps: [swap('0xa')],
    })).toBe(true);
  });

  it('does NOT fire on a failed graph with an unrelated break reason', () => {
    // A cyclic/disconnected route is not a hidden-V4-pool problem; synthesizing
    // legs there would be guesswork.
    expect(shouldAttemptV4Rescue({
      reconstructed: false, breakReason: { kind: 'unreconstructed' }, v4Swaps: [swap('0xa')],
    })).toBe(false);
  });

  it('THE NEW PATH: fires on a graph that reconstructed over >1 distinct pool', () => {
    // ids 55/59/207/211/249 — the route chains fine, but on ONE leg that
    // collapsed several pools and took an arbitrary pool's fee tier.
    expect(shouldAttemptV4Rescue({
      reconstructed: true, breakReason: undefined,
      v4Swaps: [swap('0xa', 49), swap('0xb', 500)],
    })).toBe(true);
  });

  it('does NOT fire on a reconstructed single-pool route', () => {
    // The regression guard: 21 of 26 V4 receipts are correct today.
    expect(shouldAttemptV4Rescue({
      reconstructed: true, breakReason: undefined, v4Swaps: [swap('0xa')],
    })).toBe(false);
  });

  it('counts DISTINCT pools, not swap events', () => {
    // Two swaps through one pool is not a collapsed multi-pool leg.
    expect(shouldAttemptV4Rescue({
      reconstructed: true, breakReason: undefined,
      v4Swaps: [swap('0xa', 500), swap('0xa', 500)],
    })).toBe(false);
  });

  it('never fires without V4 swaps', () => {
    expect(shouldAttemptV4Rescue({
      reconstructed: false, breakReason: { kind: 'orphan_token' }, v4Swaps: [],
    })).toBe(false);
    expect(shouldAttemptV4Rescue({
      reconstructed: true, breakReason: undefined, v4Swaps: [],
    })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run packages/core/src/v4Legs.test.ts
```

Expected: FAIL — no export named `shouldAttemptV4Rescue`.

- [ ] **Step 3: Add the predicate**

Append to `packages/core/src/v4Legs.ts`:

```ts
/**
 * Should we try synthesizing per-pool V4 legs for this route?
 *
 * Two independent reasons, and the second is easy to miss:
 *
 *  1. The first-pass graph FAILED in a way a hidden V4 pool explains — a token
 *     consumed but never produced (`orphan_token`), or an intermediate whose
 *     captured legs under-account for it (`fee_on_transfer`). Other break
 *     reasons (cyclic, disconnected) are not V4 problems and synthesizing there
 *     would be guesswork.
 *
 *  2. The graph RECONSTRUCTED, but over more than one distinct V4 pool. The V4
 *     PoolManager is a singleton and routeVenueScan keys venues by emitter
 *     address, so several pools collapse into ONE leg that keeps only the last
 *     pool's fee tier and poolId. Such a route chains perfectly well — it is
 *     simply wrong. Reconstruction success is NOT evidence of correctness here.
 *
 * Distinctness, not swap count: two Swap events through the same pool are a
 * single pool and need no rescue.
 */
export function shouldAttemptV4Rescue(args: {
  reconstructed: boolean;
  breakReason?: { kind: string } | undefined;
  v4Swaps: readonly V4Swap[];
}): boolean {
  const { reconstructed, breakReason, v4Swaps } = args;
  if (v4Swaps.length === 0) return false;
  if (!reconstructed) {
    return breakReason?.kind === 'orphan_token' || breakReason?.kind === 'fee_on_transfer';
  }
  return new Set(v4Swaps.map((s) => s.poolId)).size > 1;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run packages/core/src/v4Legs.test.ts
```

Expected: 7 PASS.

- [ ] **Step 5: Wire it into `decomposeRoute`**

In `packages/core/src/decomposeRoute.ts`, the block currently opens with these
six lines (around `:450-456`):

```ts
	if (
		!graph.reconstructed &&
		(graph.breakReason?.kind === 'orphan_token' || graph.breakReason?.kind === 'fee_on_transfer')
	) {
		const v4Swaps = collectV4Swaps(logs);
		if (v4Swaps.length > 0) {
```

Replace all six with these five:

```ts
	const v4Swaps = collectV4Swaps(logs);
	if (
		shouldAttemptV4Rescue({
			reconstructed: graph.reconstructed,
			breakReason: graph.breakReason,
			v4Swaps,
		})
	) {
```

`shouldAttemptV4Rescue` already returns `false` for an empty `v4Swaps`, so the
inner `if (v4Swaps.length > 0)` is now dead — delete it rather than leaving a
redundant guard. That means:

1. de-indent the block's body one tab level, and
2. remove **one** closing brace from the four at `:486-489`.

`npx tsc --build` and eslint will both fail loudly on a brace mistake, so
run them before moving on.

Keep everything else exactly as-is — the `pmTokens.size > 1` guard, the
`poolKeys` loop, `synthesizeV4Legs`, and above all the
`if (v4Graph.reconstructed)` adoption check, which is what makes a rescue that
cannot reconstruct a no-op.

Extend the import at `decomposeRoute.ts:40`:

```ts
import { collectV4Swaps, shouldAttemptV4Rescue, synthesizeV4Legs } from './v4Legs.js';
```

- [ ] **Step 6: Add the comment at the source**

In `packages/core/src/routeVenueScan.ts`, replace the comment at `:88`
(`// V4 PoolManager can host multiple pools; use the latest fee info`) with:

```ts
				// ⚠️ The V4 PoolManager is a SINGLETON: it emits Swap for every pool it
				// hosts, and this map is keyed by emitter address, so a multi-pool route
				// leaves only the LAST pool's fee and poolId here. That is not a
				// preference — it is a lossy collapse, and it corrupts both the LP fee
				// (v4FeeRaw) and the mid read (v4PoolId) for every pool but one.
				// Do not "fix" it by re-keying: legs are matched to venues by emitter
				// address throughout. The repair is decomposeRoute's V4 rescue, which
				// synthesizes one leg per poolId — see shouldAttemptV4Rescue.
```

- [ ] **Step 7: Run the full suite in both shell states**

```bash
npx vitest run
set -a && source .env && set +a && npx vitest run
npx tsc --build && npx eslint packages/dashboard packages/core
```

Expected: **621 passing + 3 skipped** unexported; **all passing** exported
(≥624 + the 11 tests this plan adds). `tsc` exit 0, eslint exit 0.

⚠️ Pay attention to `decomposeRoute V4 multi-pool extraction (id 56)` — it
exercises the rescue's original path end-to-end against a real trace, and it is
also this plan's coverage for "a rescue that cannot reconstruct is a no-op": the
`if (v4Graph.reconstructed)` adoption check it depends on is untouched code, so
that test passing means the safety valve still works. It must stay green.

⚠️ Run the two `vitest` commands as **separate** tool calls. Chaining them in
one shell leaks the exported env into the second and you will not actually test
the unexported state.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/v4Legs.ts packages/core/src/v4Legs.test.ts \
        packages/core/src/decomposeRoute.ts packages/core/src/routeVenueScan.ts
git commit -m "fix(core): rescue V4 routes that reconstruct over multiple pools

The V4 multi-pool rescue only ran when the first-pass graph FAILED. A route
that collapses several V4 pools into one leg chains perfectly well and is
simply wrong, so it never qualified. shouldAttemptV4Rescue adds that case:
reconstructed, but more than one distinct poolId in the trace.

Also documents the lossy collapse at its source in routeVenueScan, where
the comment previously read as intentional.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Back up and repopulate the five receipts

**Files:**
- Create: `docs/receipts-v4-multipool-prerepop-backup.json`
- Modify: `docs/attribution-worklist.md` (§2)

**Interfaces:**
- Consumes: Tasks 1 and 2, both committed. `packages/core/dist` must be rebuilt
  before the scripts see the change.
- Produces: nothing consumed by later tasks.

⚠️ These scripts hit a **live production database**. The backup is not optional.

- [ ] **Step 1: Rebuild core dist**

```bash
npx tsc --build packages/core
```

The repopulate script imports `packages/core/dist/analyzeTransaction.js`. Without
this it re-runs the OLD code and reports "no change" — which you would then
misread as the fix not working.

- [ ] **Step 2: Back up the five rows**

```bash
node --input-type=module -e '
import { connect } from "./scripts/analysis/_env.mjs";
import { writeFileSync } from "node:fs";
const sql = await connect();
const rows = await sql`select * from receipts where id in (55,59,207,211,249) order by id`;
await sql.end();
writeFileSync("docs/receipts-v4-multipool-prerepop-backup.json", JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? String(v) : v), 2));
console.log("backed up", rows.length, "rows");
'
```

Expected: `backed up 5 rows`. Confirm the file is non-empty before continuing.

- [ ] **Step 3: Dry-run the repopulation**

```bash
node scripts/repopulateReceipts.mjs --ids=55,59,207,211,249
```

Read the diff. Expected direction: `lpFeeBps` moves on all five, and `tier` /
`pricingStatus` may improve for 55 and 59 (whose V4 legs were nulled by the
clamp).

⚠️ The script's `WATCH` list (line 61) does **not** include `routeLegs`, so a
legs-only change prints `no change` and `changed=0`. **Do not read `changed=0`
as "nothing happened"** — Step 5 verifies the legs directly.

- [ ] **Step 4: Commit the repopulation**

```bash
node scripts/repopulateReceipts.mjs --ids=55,59,207,211,249 --commit
```

Five rows runs well inside the 5-minute tool timeout. (A full-corpus run does
not — background it if you ever need one.)

- [ ] **Step 5: Verify against the success criteria**

```bash
node --input-type=module -e '
import { connect, costedLegs, num } from "./scripts/analysis/_env.mjs";
const sql = await connect();
const rows = await sql`select id, notional_usd, lp_fee_bps, slippage_bps, normalize_flags, route_legs
  from receipts where id in (55,59,207,211,249) order by id`;
await sql.end();
for (const r of rows) {
  const legs = costedLegs(r);
  const v4 = legs.filter((l) => String(l.type) === "univ4");
  const bare = v4.filter((l) => !String(l.venue).startsWith("v4:"));
  const flags = (r.normalize_flags ?? []).map(String);
  console.log(`id ${String(r.id).padStart(3)}  lpFee=${Number(r.lp_fee_bps).toFixed(2).padStart(8)}  v4legs=${v4.length}  bare=${bare.length}`);
  for (const l of v4) console.log(`     ${l.venue.slice(0, 20).padEnd(20)} fee=${String(l.feeTierBps).padStart(7)}  PI=${l.priceImpactBps}`);
  for (const f of flags.filter((f) => /V4_MULTIPOOL|multiple V4|PI_IMPLAUSIBLE/.test(f))) console.log(`     FLAG ${f}`);
}
'
```

**ids 207 and 211 are the load-bearing checks here**, and not only because they
are the same-pair splits. Both settle in **native ETH**, which is the one shape
that could trip the untouched `pmTokens.size > 1` guard inside the rescue — that
guard counts tokens the PoolManager moved, and native ETH is not an ERC-20
transfer. It is fine in theory, because `decomposeRoute.ts:422` models native
value transfers as WETH *before* the graph is built, so the PoolManager
registers two tokens either way. These two receipts are the empirical proof of
that reasoning, which is why the spec's synthetic "native-ETH split" test is
deliberately not in this plan: a real native-ETH route through the real code
path is a stronger check than a hand-built fixture, and cheaper.

Per receipt, confirm:
- `bare=0` — no leg left at the bare `0x498581ff…` PoolManager address
- `v4legs` ≥ 2, each with its **own** plausible `feeTierBps` (for id 207: 0.49
  and 5, not 5 and 5)
- a `V4_MULTIPOOL_LEGS: synthesized N V4 pool leg(s)` flag is present
- for 55 and 59, no `PI_IMPLAUSIBLE` naming a V4 leg
- `lp_fee_bps` differs from the backup's value for 207, 211 and 249

If any receipt fails these, **stop and report** — do not paper over it by
editing the criteria. The backup at
`docs/receipts-v4-multipool-prerepop-backup.json` is the way back.

⚠️ The `NEEDS REVIEW: multiple V4 Swap fees detected` flag is **expected to
remain**. It comes from `decomposeTrade.ts:342-358`, a separate path feeding the
route-level rollup, and is deliberately out of scope — it is also the marker
these receipts were found by. Its presence is not a failure.

- [ ] **Step 6: Mark §2 done in the worklist**

In `docs/attribution-worklist.md`, change the §2 heading to:

```markdown
## 2. V4 multi-pool fee averaging  ✅ DONE 2026-07-30
```

and append at the end of the section, before the `---`:

```markdown
**Delivered 2026-07-30.** `shouldAttemptV4Rescue` (`v4Legs.ts`) widens the
rescue gate to routes that reconstruct over more than one distinct V4 poolId,
and `routeGraph.ts` now lets per-pool legs REPLACE the collapsed PoolManager leg
instead of deduping them away by token pair — the second half was load-bearing,
since every affected route is a split across fee tiers of one pair. Receipts 55,
59, 207, 211 and 249 repopulated; backup at
`docs/receipts-v4-multipool-prerepop-backup.json`.

⚠️ Still open, and deliberately not touched here: `decomposeTrade.ts:342-358`
still averages V4 fees for the route-level rollup, and ids 329/330/402/403
(single V4 pool, implausible PI, no averaging flag) and id 215 (Hydrex) remain
undiagnosed.
```

- [ ] **Step 7: Commit**

```bash
git add docs/receipts-v4-multipool-prerepop-backup.json docs/attribution-worklist.md
git commit -m "chore(receipts): repopulate the 5 V4 multi-pool receipts

Backs up rows 55, 59, 207, 211, 249 and re-analyzes them against the fixed
per-pool V4 leg synthesis. Marks worklist item 2 done.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Out of scope

- **`decomposeTrade.ts:342-358`'s fee averaging.** It feeds the route-level
  `lp_fee_bps` rollup, not `route_legs`; once the rescue runs, `decomposeRoute`
  recomputes `lpFeeBps` from the per-pool legs (`:566`). Its `NEEDS REVIEW` flag
  stays, and removing it would destroy the marker these receipts are found by.
- **Re-keying V4 venues by poolId in `routeVenueScan`.** The true source of the
  loss, but the venue map is address-keyed across four modules and legs are
  matched that way. Task 2 Step 6 documents it instead.
- **ids 329, 330, 402, 403** — `PI_IMPLAUSIBLE` on a *single* V4 pool with no
  averaging flag. Different failure mode; a 20% tier is plausible for a hooked
  memecoin pool, so it may not be a bug.
- **id 215** — its implausible leg is Hydrex (`0x53ab4c60…`), not V4.
- **id 219** — `ROUTE_NOT_DECOMPOSED`, a genuine fee-on-transfer route ($41).
- **Worklist items 3 and 4** (twin venues, PancakeSwap Infinity).
