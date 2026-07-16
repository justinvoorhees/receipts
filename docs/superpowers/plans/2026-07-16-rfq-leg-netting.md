# RFQ Maker Leg Netting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Routes where an RFQ maker has round-trip flows (paid gross, received change) reconstruct instead of failing conservation, un-nulling the trade-level LP fee / slippage for that class.

**Architecture:** One pure-logic change in `routeGraph.ts` `buildLegs` (leg amounts use net deltas when the address has a round-trip in a leg token), surfaced through `decomposeRoute.ts` as a `LEG_AMOUNTS_NETTED` normalize flag plus a confidence cap at `medium`. The existing conservation checks stay untouched as the fail-closed guard.

**Tech Stack:** TypeScript (ESM, bigint graph logic), vitest, viem (e2e only), postgres (repopulation only).

**Spec:** `docs/superpowers/specs/2026-07-16-rfq-leg-netting-design.md` — read it first.

## Global Constraints

- NEVER run root `npm run build` (it runs `next build` into the live dev server's `.next`). Compile core with `npx tsc --build` only.
- Env vars: `source .env` does NOT export — use `set -a && source .env && set +a`.
- vitest CLI args are substring filters — always pass full file paths.
- DB rows are repopulated **in place** (UPDATE preserving id) — never delete+re-POST (paste path is cache-first; id churn breaks links).
- Tab/indent style: this repo uses tabs in `packages/core/src` — match surrounding code.
- All commits end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: Net-clamped leg amounts in `buildLegs`

**Files:**
- Modify: `packages/core/src/routeGraph.ts` (Leg interface ~line 14-23; `buildLegs` ~lines 155-204)
- Test: `packages/core/src/routeGraph.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Leg.amountsNetted?: boolean` (optional; set ONLY when true — absent otherwise). Task 2 reads `graph.legs[].amountsNetted`.

- [ ] **Step 1: Write the failing pin test**

Append to `packages/core/src/routeGraph.test.ts` inside the top-level of the file (new `describe` block at the end). Reuses the module-level `USDC`, `WETH`, `VIRTUAL`, `trader` constants already defined at the top of the file:

```ts
describe('RFQ maker round-trip netting (id 189 pin — 0xb020…9e26)', () => {
  // Shaped like the 0x Settler route in receipts id 189: the maker pays USDC
  // gross through a settlement helper and receives change back, so its gross
  // USDC outflow (7000) overstates the conserved flow (4023). Pre-fix, legs
  // used gross amounts and the intermediate-USDC conservation check failed →
  // ROUTE_NOT_DECOMPOSED. Netting the round-trip makes the route reconstruct.
  const maker = '0x69a9f15600000000000000000000000000000001';
  const helper = '0x7c97680100000000000000000000000000000002';
  const pool = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const t = [
    // trader funds the maker via the helper (WETH passes through cleanly)
    { token: WETH, from: trader, to: helper, value: 2_100000000000000000n },
    { token: WETH, from: helper, to: maker, value: 2_100000000000000000n },
    // maker pays 7000 USDC gross; helper returns 2977 change, forwards 4023
    { token: USDC, from: maker, to: helper, value: 7000_000000n },
    { token: USDC, from: helper, to: maker, value: 2977_000000n },
    { token: USDC, from: helper, to: pool, value: 4023_000000n },
    // pool produces the output token
    { token: VIRTUAL, from: pool, to: trader, value: 1000_000000000000000000n },
  ];
  const venuesRT = new Map([[pool, { type: 'univ3' as const }]]);

  it('nets the maker leg and reconstructs the route as linear', () => {
    const g = buildRouteGraph({ transfers: t, trader, venues: venuesRT, denylist: new Set() });
    expect(g.reconstructed).toBe(true);
    expect(g.shape).toBe('linear');
    const makerLeg = g.legs.find((l) => l.venue === maker)!;
    expect(makerLeg).toBeDefined();
    // Gross USDC out was 7000; net (conserved) is 4023.
    expect(makerLeg.amountOutRaw).toBe(4023_000000n);
    // WETH side had no round-trip → gross, unchanged.
    expect(makerLeg.amountInRaw).toBe(2_100000000000000000n);
    expect(makerLeg.amountsNetted).toBe(true);
    // The clean pool leg is untouched and NOT marked netted.
    const poolLeg = g.legs.find((l) => l.venue === pool)!;
    expect(poolLeg.amountInRaw).toBe(4023_000000n);
    expect(poolLeg.amountsNetted).toBeUndefined();
  });

  it('leaves routes without round-trips byte-identical (no amountsNetted)', () => {
    // The module-level linear fixture: no address has a round-trip.
    const g = buildRouteGraph({ transfers, trader, venues, denylist: new Set() });
    expect(g.legs.every((l) => l.amountsNetted === undefined)).toBe(true);
    expect(g.legs[0]!.amountInRaw).toBe(2_000000n); // gross == net, unchanged
  });
});
```

- [ ] **Step 2: Run tests to verify the pin test fails**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder && npx vitest run packages/core/src/routeGraph.test.ts
```

Expected: the new "nets the maker leg" test FAILS (today `reconstructed` is `false`, `shape` is `'complex'`, and `amountOutRaw` is `7000_000000n`). The "byte-identical" test may pass already (fine). All pre-existing tests PASS.

- [ ] **Step 3: Implement netting**

In `packages/core/src/routeGraph.ts`:

3a. Add the field to `Leg` (after `amountOutRaw`):

```ts
export interface Leg {
  venue: string;            // lowercase address (or 'rfq_fill:<idx>')
  type: VenueType;
  tokenIn: string;          // lowercase
  tokenOut: string;         // lowercase
  amountInRaw: bigint;
  amountOutRaw: bigint;
  /** true → the address had a round-trip in a leg token (e.g. RFQ maker change),
   *  so amounts are net deltas, not gross flows. Absent when gross == net. */
  amountsNetted?: boolean;
  v4PoolId?: string;        // for univ4 (from Swap event id)
  v4FeeRaw?: number;        // for univ4 (from Swap event fee)
}
```

3b. Add a helper above `buildLegs`:

```ts
/**
 * Leg amounts for a candidate address. Gross flows are the default measure;
 * when the address has a ROUND-TRIP in a leg token (it both sent and received
 * that token — e.g. an RFQ maker that paid gross and was given change), gross
 * double-counts the change, so the conserved measure is the net delta.
 * tokenIn is net-received (delta > 0) and tokenOut net-sent (delta < 0) by
 * construction in buildLegs, so the deltas carry the expected signs.
 */
function legAmounts(
  addrDeltas: Map<string, bigint>,
  addrGross: Map<string, { received: bigint; sent: bigint }>,
  tokenIn: string,
  tokenOut: string,
): { amountInRaw: bigint; amountOutRaw: bigint; amountsNetted: boolean } {
  const inFlows = addrGross.get(tokenIn) ?? { received: 0n, sent: 0n };
  const outFlows = addrGross.get(tokenOut) ?? { received: 0n, sent: 0n };
  const inNetted = inFlows.sent > 0n;       // tokenIn also flowed out → round-trip
  const outNetted = outFlows.received > 0n; // tokenOut also flowed in → round-trip
  return {
    amountInRaw: inNetted ? (addrDeltas.get(tokenIn) ?? 0n) : inFlows.received,
    amountOutRaw: outNetted ? -(addrDeltas.get(tokenOut) ?? 0n) : outFlows.sent,
    amountsNetted: inNetted || outNetted,
  };
}
```

3c. In `buildLegs`, replace BOTH amount computations with the helper.

Known-venue branch — replace:

```ts
        // amountIn = gross received for tokenIn at this address
        // amountOut = gross sent for tokenOut at this address
        const amountInRaw = addrGross.get(tokenIn)?.received ?? 0n;
        const amountOutRaw = addrGross.get(tokenOut)?.sent ?? 0n;

        const leg: Leg = {
          venue: addr,
          type: knownVenue.type,
          tokenIn,
          tokenOut,
          amountInRaw,
          amountOutRaw,
        };
```

with:

```ts
        const { amountInRaw, amountOutRaw, amountsNetted } = legAmounts(addrDeltas, addrGross, tokenIn, tokenOut);

        const leg: Leg = {
          venue: addr,
          type: knownVenue.type,
          tokenIn,
          tokenOut,
          amountInRaw,
          amountOutRaw,
        };
        if (amountsNetted) leg.amountsNetted = true;
```

Unknown branch — replace:

```ts
        const amountInRaw = addrGross.get(tokenIn)?.received ?? 0n;
        const amountOutRaw = addrGross.get(tokenOut)?.sent ?? 0n;

        legs.push({
          venue: addr,
          type: 'unknown',
          tokenIn,
          tokenOut,
          amountInRaw,
          amountOutRaw,
        });
```

with:

```ts
        const { amountInRaw, amountOutRaw, amountsNetted } = legAmounts(addrDeltas, addrGross, tokenIn, tokenOut);

        const leg: Leg = {
          venue: addr,
          type: 'unknown',
          tokenIn,
          tokenOut,
          amountInRaw,
          amountOutRaw,
        };
        if (amountsNetted) leg.amountsNetted = true;
        legs.push(leg);
```

- [ ] **Step 4: Run tests to verify all pass**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder && npx vitest run packages/core/src/routeGraph.test.ts
```

Expected: ALL pass, including both new tests and every pre-existing test (gross == net when no round-trip, so nothing else may move).

- [ ] **Step 5: Commit**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder && git add packages/core/src/routeGraph.ts packages/core/src/routeGraph.test.ts && git commit -m "feat(core): net leg amounts for round-trip maker flows in buildLegs

An RFQ maker that pays gross and receives change (id 189, 0xb020…9e26) had
its leg amounts taken from gross flows, overstating the intermediate-token
flow and failing reconstructDag's conservation check → ROUTE_NOT_DECOMPOSED.
When an address has a round-trip in a leg token, the conserved measure is
the net delta; legs carry amountsNetted so decomposeRoute can flag it.
Routes without round-trips are byte-identical (gross == net).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Surface `LEG_AMOUNTS_NETTED` + confidence cap in decomposeRoute

**Files:**
- Modify: `packages/core/src/decomposeRoute.ts` (after graph build ~line 753; confidence section in the reconstructed branch ~lines 876-882)
- Test: `packages/core/src/decomposeRoute.test.ts`

**Interfaces:**
- Consumes: `Leg.amountsNetted?: boolean` from Task 1.
- Produces: normalize flag string `LEG_AMOUNTS_NETTED: leg <venue10> had round-trip flows; amounts use net deltas` (prefix `LEG_AMOUNTS_NETTED` is what Task 3's e2e asserts on); `confidence` capped at `'medium'` when any leg is netted.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe('decomposeRoute', …)` block in `packages/core/src/decomposeRoute.test.ts`, modeled on the `PI_IMPLAUSIBLE clamp` synthetic-trace pattern (reuse the file's existing `transferLog` helper and `USDC`/`VIRTUAL`/`WETH` constants; copy the `swapLog` helper into this block since it's scoped to the PI describe):

```ts
  describe('RFQ maker round-trip netting (id 189 shape)', () => {
    // 2-hop linear USDC→VIRTUAL→WETH where the FIRST hop is an event-less
    // maker with a round-trip in the intermediate token: it sends 3.5 VIRTUAL
    // gross through a helper, gets 0.5 back as change, and only 3.0 reaches
    // the V3 pool. Pre-fix the VIRTUAL conservation check failed → complex.
    const syntheticTrader = '0x00000000000000000000000000000000000000d0' as `0x${string}`;
    const maker = '0x69a9f1560000000000000000000000000000dddd' as `0x${string}`;
    const helper = '0x7c9768010000000000000000000000000000eeee' as `0x${string}`;
    const poolB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;

    const UNI_V3_SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67' as `0x${string}`;
    function swapLog(pool: `0x${string}`): { address: `0x${string}`; data: `0x${string}`; topics: [`0x${string}`, `0x${string}`, `0x${string}`] } {
      return {
        address: pool,
        data: '0x' + '00'.repeat(160) as `0x${string}`,
        topics: [UNI_V3_SWAP_TOPIC, '0x' + '00'.repeat(32) as `0x${string}`, '0x' + '00'.repeat(32) as `0x${string}`],
      };
    }

    const syntheticTrace = {
      from: syntheticTrader,
      to: '0xcccccccccccccccccccccccccccccccccccccccc' as `0x${string}`,
      input: '0x' as `0x${string}`,
      logs: [
        swapLog(poolB), // only the pool has a Swap event; the maker is event-less
        transferLog(USDC as `0x${string}`, syntheticTrader, maker, 1_000000n),
        transferLog(VIRTUAL as `0x${string}`, maker, helper, 3_500000000000000000n),
        transferLog(VIRTUAL as `0x${string}`, helper, maker, 500000000000000000n),   // change
        transferLog(VIRTUAL as `0x${string}`, helper, poolB, 3_000000000000000000n),
        transferLog(WETH as `0x${string}`, poolB, syntheticTrader, 500000000000000n),
      ],
      calls: [],
    };

    const input: DecomposeTradeInput = {
      trace: syntheticTrace as any,
      txHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      trader: syntheticTrader,
      direction: 'buy_weth',
      settledIn: 'WETH',
      allInCostBps: -5.0,
      notionalUsdc: 1.0,
      realizedPrice: 1800,
      gasCostUsd: 0.001,
      aggregator: 'Unknown',
      blockNumber: 100n,
      rpcUrl: 'unused',
      dustUsdc: 1e-6,
      structuralFloorUsd: 0,
      structuralFloorBps: 0.5,
    };

    it('reconstructs, flags LEG_AMOUNTS_NETTED, and caps confidence at medium', async () => {
      const result = await decomposeRoute(input, {
        trace: syntheticTrace as any,
        // Both tiers resolved (defaulted: false) so any confidence downgrade
        // must come from the netting cap, not the defaulted-fee path.
        feeReader: async (_addr, type) =>
          type === 'univ3' ? { bps: 5, defaulted: false } : { bps: 0, defaulted: false },
      });

      // Pre-fix this was complex/not-reconstructed with null LP/slippage.
      expect(result.routeShape).toBe('linear');
      expect(result.lpFeeBps).not.toBeNull();
      expect(result.slippageBps).not.toBeNull();
      expect(result.flags.some((f) => f.startsWith('LEG_AMOUNTS_NETTED'))).toBe(true);
      expect(result.flags.some((f) => f.startsWith('ROUTE_NOT_DECOMPOSED'))).toBe(false);
      // Netted amounts are inferred, not observed → never 'high'.
      expect(result.confidence).toBe('medium');
    });
  });
```

- [ ] **Step 2: Run test to verify it fails on the flag/confidence assertions**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder && npx vitest run packages/core/src/decomposeRoute.test.ts
```

Expected: the new test FAILS on `flags.some(LEG_AMOUNTS_NETTED)` (flag not yet emitted) and on `confidence === 'medium'` (it is `'high'` — Task 1 already makes the route reconstruct). Pre-existing tests PASS. NOTE: this file has a known ~15s-per-test smell (un-injectable RPC probing against `rpcUrl:'unused'`); if the new test times out, give the `it(…)` a third arg `20_000` like the convergent-DAG test does.

- [ ] **Step 3: Implement flag + confidence cap**

In `packages/core/src/decomposeRoute.ts`:

3a. After Step 4 (`const graph = buildRouteGraph({ … });`, ~line 753), add:

```ts
	// Round-trip netted legs (e.g. RFQ maker change flows): surface a per-leg
	// flag; the reconstructed branch caps confidence at medium because netted
	// amounts are an interpretation of the flows, not an observation.
	const nettedLegs = graph.legs.filter((l) => l.amountsNetted);
	for (const l of nettedLegs) {
		routeFlags.push(`LEG_AMOUNTS_NETTED: leg ${l.venue.slice(0, 10)} had round-trip flows; amounts use net deltas`);
	}
```

3b. In the reconstructed branch, directly after the `hasApproxLegs` downgrade block:

```ts
		// Downgrade to medium if any leg has approximate notional or defaulted fee
		const hasApproxLegs = legFeeInputs.some((lfi) => lfi.notionalApprox);
		if (hasApproxLegs || !allFeesResolved) {
			confidence = 'medium';
		}
```

add:

```ts
		// Netted leg amounts (round-trip flows) are inferred — cap at medium.
		if (nettedLegs.length > 0 && confidence === 'high') {
			confidence = 'medium';
		}
```

- [ ] **Step 4: Run the full core test suite**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder && npx vitest run packages/core/src
```

Expected: ALL pass (re-measure the count — do not cite a remembered number).

- [ ] **Step 5: Commit**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder && git add packages/core/src/decomposeRoute.ts packages/core/src/decomposeRoute.test.ts && git commit -m "feat(core): flag netted legs and cap decomposition confidence at medium

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: RPC e2e pin test on the real tx

**Files:**
- Test: `packages/core/src/analyzeTransaction.test.ts` (inside the existing `describe.runIf(RPC)('analyzeTransaction (integration)', …)` block)

**Interfaces:**
- Consumes: full pipeline from Tasks 1-2 (`analyzeTransaction`, flag prefix `LEG_AMOUNTS_NETTED`).
- Produces: nothing downstream; this is the verification gate for the real id 189 route.

- [ ] **Step 1: Write the e2e test**

```ts
	it('reconstructs the 0x Settler RFQ+AMM hybrid route (id 189 pin: round-trip maker netting)', async () => {
		// 2.8 ETH → 1.30M jesse. Pre-fix: the RFQ maker's USDC change flow broke
		// intermediate-token conservation → ROUTE_NOT_DECOMPOSED, null LP/slippage.
		const r = await analyzeTransaction(
			'0xb02037466b0756a3972f77d674413a0d7468663aca62e8c6eb757f15ced59e26',
			8453,
			{ rpcUrl: RPC! },
		);
		expect(r).not.toBeNull();
		expect(r!.lpFeeBps).not.toBeNull();
		expect(r!.slippageBps).not.toBeNull();
		expect(r!.normalizeFlags.some((f) => f.startsWith('LEG_AMOUNTS_NETTED'))).toBe(true);
		expect(r!.normalizeFlags.some((f) => f.startsWith('ROUTE_NOT_DECOMPOSED'))).toBe(false);
		expect(r!.decompConfidence).not.toBe('high');
	}, 60_000);
```

- [ ] **Step 2: Run it with the RPC exported**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder && set -a && source .env && set +a && npx vitest run packages/core/src/analyzeTransaction.test.ts
```

Expected: PASS. Verify in the output that the integration describe RAN (it silently skips when `TCA_RPC_URL` is missing — a skip is NOT a pass).

**CHECKPOINT — if this test fails:** STOP. Do not weaken the assertions and do not patch further. The real route has a wrinkle the synthetic tests don't model (native-transfer modeling, an extra non-conserved edge, etc.). Report the exact failure output and return to root-cause investigation (superpowers:systematic-debugging) before any further code change.

- [ ] **Step 3: Commit**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder && git add packages/core/src/analyzeTransaction.test.ts && git commit -m "test(core): e2e-pin the id 189 RFQ round-trip route reconstruction

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Corpus dry run + repopulate row 189 in place

**Files:**
- Create: `<scratchpad>/repopulate-189.mjs` (ad-hoc, NOT committed — scratchpad dir is listed in the session's system prompt)
- No repo source changes in this task.

**Interfaces:**
- Consumes: `analyzeTransaction` from compiled core (`packages/core/dist/index.js`), `postgres` from repo `node_modules`, `TCA_DATABASE_URL` + `TCA_RPC_URL` from `.env`.
- Produces: updated DB row id 189 (id preserved).

- [ ] **Step 1: Compile core**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder && npx tsc --build
```

Expected: exits 0. (NEVER root `npm run build` — it runs `next build` over the live dev server's `.next`.)

- [ ] **Step 2: Write the dry-run/repopulation script**

Create `<scratchpad>/repopulate-189.mjs` (substitute the real scratchpad path):

```js
// Dry-run recompute of every stored receipt; --write <id> updates that row in place.
// Modeled on the venue-attribution repopulation discipline: full-corpus dry run
// must show ONLY the expected row changing before any write.
import { analyzeTransaction } from '/Users/justinvoorhees/withfabricxyz/fabric-tca-decoder/packages/core/dist/index.js';
import postgres from '/Users/justinvoorhees/withfabricxyz/fabric-tca-decoder/node_modules/postgres/src/index.js';

const sql = postgres(process.env.TCA_DATABASE_URL);
const RPC = process.env.TCA_RPC_URL;
const writeId = process.argv.includes('--write') ? Number(process.argv[process.argv.indexOf('--write') + 1]) : null;

const num = (v) => (v == null ? null : String(v));
const rows = await sql`select * from receipts order by id`;
let diffs = 0;
for (const row of rows) {
  const r = await analyzeTransaction(row.tx_hash, row.chain_id, { rpcUrl: RPC });
  if (!r) { console.log(`id ${row.id}: analyze returned null (stored row kept)`); continue; }
  const cmp = [
    ['lp_fee_bps', row.lp_fee_bps, num(r.lpFeeBps)],
    ['slippage_bps', row.slippage_bps, num(r.slippageBps)],
    ['all_in_cost_bps', row.all_in_cost_bps, num(r.allInCostBps)],
    ['route_shape', row.route_shape, r.routeShape],
    ['decomp_confidence', row.decomp_confidence, r.decompConfidence],
  ];
  const changed = cmp.filter(([, a, b]) => (a == null ? null : Number(a).toPrecision(10)) !== (b == null ? null : Number(b).toPrecision?.(10) ?? b) && String(a) !== String(b));
  if (changed.length === 0) continue;
  diffs++;
  console.log(`id ${row.id} (${row.tx_hash.slice(0, 10)}…) CHANGES:`);
  for (const [k, a, b] of changed) console.log(`  ${k}: ${a} -> ${b}`);
  if (writeId === row.id) {
    await sql`update receipts set
      lp_fee_bps = ${num(r.lpFeeBps)}, slippage_bps = ${num(r.slippageBps)},
      execution_bps = ${num(r.executionBps)}, all_in_cost_bps = ${num(r.allInCostBps)},
      recon_residual_bps = ${num(r.reconResidualBps)}, route_shape = ${r.routeShape},
      route_pure = ${r.routePure}, hop_count = ${r.hopCount},
      route_legs = ${sql.json(r.routeLegs)}, normalize_flags = ${sql.json(r.normalizeFlags)},
      decomp_confidence = ${r.decompConfidence}
      where id = ${row.id}`;
    console.log(`  WROTE id ${row.id}`);
  }
}
console.log(`done: ${diffs} row(s) differ`);
await sql.end();
```

- [ ] **Step 3: Dry run (no --write)**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder && set -a && source .env && set +a && node <scratchpad>/repopulate-189.mjs
```

Expected: `id 189 … CHANGES` with `lp_fee_bps: null -> <number>`, `slippage_bps: null -> <number>`, `route_shape: complex -> split` (or reconstructed complex), `decomp_confidence: low -> medium` — and **no other row with a cost-field change** (float-noise-only diffs in `all_in_cost_bps` from live re-pricing are tolerable if the value moves in the far decimals; anything structural on another row = STOP and diagnose before writing).

**CHECKPOINT:** If any row other than 189 shows a structural change (lp_fee/slippage/route_shape/confidence), STOP — do not write. Report the diff.

- [ ] **Step 4: Write row 189**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder && set -a && source .env && set +a && node <scratchpad>/repopulate-189.mjs --write 189
```

Expected: `WROTE id 189`, still only 1 differing row.

- [ ] **Step 5: Verify the invariant and re-run to confirm 0 diffs**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder && set -a && source .env && set +a && node -e "
const postgres = require('postgres');
const sql = postgres(process.env.TCA_DATABASE_URL);
(async () => {
  const [r] = await sql\`select lp_fee_bps, agg_fee_bps, slippage_bps, all_in_cost_bps, route_shape, decomp_confidence from receipts where id = 189\`;
  console.log(r);
  const resid = Number(r.all_in_cost_bps) - Number(r.lp_fee_bps) - Number(r.agg_fee_bps) - Number(r.slippage_bps);
  console.log('all_in - (LP+Agg+Slippage) =', resid, Math.abs(resid) < 0.01 ? 'OK' : 'VIOLATION');
  await sql.end();
})();
"
node <scratchpad>/repopulate-189.mjs   # with env exported: expect id 189 no longer diffs
```

Expected: invariant `all_in = LP + Agg + Slippage` holds (|residual| < 0.01 bps — it's an arithmetic identity in `decomposeRoute`); the follow-up dry run reports id 189 clean.

- [ ] **Step 6: Final full-suite check and no stray tree changes**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder && npx vitest run packages/core/src && git status --short
```

Expected: all core tests pass; working tree clean (the script lives in the scratchpad, not the repo).

---

## Self-Review Notes

- Spec coverage: netting rule (Task 1), flag + confidence cap (Task 2), RPC e2e (Task 3), dry-run + in-place repopulation + invariant (Task 4). Out-of-scope items (rfq typing, benchmark semantic, ids 56/134) have no tasks — intentional per spec.
- The spec's "expected `route_shape: split`" is asserted loosely in Task 3/4 (reconstruction evidence via flags + non-null costs) because the exact shape tag on the real tx depends on native-transfer modeling; the dry-run output records the actual value.
- Type consistency: `amountsNetted?: boolean` (Task 1) is read as `l.amountsNetted` in Task 2 and reaches Task 3 only via the flag string prefix `LEG_AMOUNTS_NETTED`.
