# Multi-Hop Route Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the pure/impure "collapse to execution" decomposition with a route-aware model that reconstructs each trade's swap path and attributes **LP fee** and **Slippage** across multi-hop / 3rd-token / RFQ routes — so the dashboard shows non-null LP + Slippage for trades like USDC→VIRTUAL→WETH, and the model is ready for the more complex routing we'll see as size grows.

**Architecture:** Two phases. **Phase 1 (table-level fix):** reconstruct the ordered legs of the route from token transfers, sum each leg's LP fee (pool fee tier × that leg's USDC-valued notional), and define `Slippage = all_in − LP − Agg` (the same residual definition pure routes already use). This needs **no intermediate-token price oracle** — in a linear route every leg either touches USDC/WETH (directly priceable) or processes ~the full trade value, so leg notionals are valuable from the endpoints. This alone delivers non-null LP+Slippage for multi-hop. **Phase 2 (per-leg attribution + display):** add a generalized per-pair mid-price service (V3/PancakeV3/V2/Aerodrome/V4 at block N-1) to measure each leg's price-impact independently, reconcile against the top-line `all_in`, store per-leg detail, and surface it in the dashboard.

**Tech Stack:** TypeScript (strict), viem (Base mainnet), Drizzle/Postgres, Next.js dashboard, vitest, `npx tsx`.

## Global Constraints

- **Funnel stays frozen.** Do NOT change the funnel decomposition path (`decompose-gated.ts` → `router_trades_gated`) or its data. All new behavior is gated behind the smoke-set decomposition profile (the `DecomposeTradeInput` optional params added in commit `c91371c`/`4b14034`) or a new code path the funnel does not call. `router_trades_gated` must remain 165 rows with unchanged values. Re-run ONLY the smoke pipeline (`load-smoke-trades.ts` / `redecompose-smoke.ts`).
- **`all_in_cost_bps` remains the anchor and is unchanged.** It is realized USDC/WETH price vs the deepest USDC/WETH pool mid @ block N-1 (`referencePrice.ts` `POOL_5BPS`, `signedDeviationBps`). The decomposition must reconcile to it; never redefine it.
- **Decomposition invariant:** `all_in = LP + Agg + Slippage` (rolled-up). Slippage is the residual after LP and Agg. LP and Slippage are `null` ONLY when the route cannot be reconstructed (unknown venue / unparseable split) — record why via a confidence flag; do not silently null.
- **Reuse existing primitives:** `decodeTransferLogs`, `collectNativeEthDeltas`, `USDC`, `WETH`, `DENYLIST` from `tradeEndpoints.ts`; `getReferencePrice`/`sqrtPriceX96ToUsdcPerWeth` from `referencePrice.ts`; `signedDeviationBps` from `priceMath.ts`; the agg-fee + known-vault logic in `decompose-trade.ts`.
- **Verified facts (Base mainnet), use verbatim:**
  - USDC `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` (6 dec), WETH `0x4200000000000000000000000000000000000006` (18 dec).
  - Uniswap V3 Swap topic `0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67`.
  - PancakeSwap V3 Swap topic `0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83`; factory `0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865`.
  - Uniswap V4 PoolManager `0x498581ff718922c3f8e6a244956af099b2652b2b`; V4 StateView `0xa3c0c9b65bad0b08107aa264b0f3db444b867a71` (reads slot0 by poolId); V4 Swap event carries `id` (poolId, indexed) and `fee` (uint24).
  - V2 Swap topic `0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822`; Aerodrome Swap topic `0xb3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b`.
  - Reference multi-hop test txns (smoke-36): kyber batch-01 `0x1ca5f7caf6543e0c0cbe7c82a17939c1561bf1bb5bc87b94d5a399c745c29f97` (USDC→VIRTUAL via PancakeSwap V3 5bps → VIRTUAL/WETH via Uni V4 4.5bps); kyber batch-02 `0x710f173aff460c85f573d8ca88877f6101732dc8d4d64e509536fb0c53071fb4` (USDC→VIRTUAL via RFQ filler `0xbee32…` → VIRTUAL/WETH via Uni V4 100bps); nordstern batch-02 `0x111364bf81…`.
- **Run pattern:** `set -a && source .env && set +a && npx tsx packages/ingest/src/<script>.ts`. Typecheck bar: `npx tsc --build packages/ingest 2>&1 | grep -E '<file>'` prints nothing (the repo has pre-existing unrelated ingest errors; do not fix them).

## Design Decisions (documented; flag on review if any should change)

1. **Numeraire = USDC.** Self-consistent with the existing top-line. All per-leg notionals and fees are valued in USDC at block N-1.
2. **Leg notional valuation (Phase 1, no oracle):** value a leg by whichever endpoint touches USDC or WETH (USDC directly; WETH via the existing USDC/WETH mid). If neither side is USDC/WETH (a purely-intermediate leg in a 3+-hop route), approximate the leg notional as the trade notional (value-conservation) and mark `notionalApprox=true`. This is exact for the common 2-leg case.
3. **Slippage = residual.** `Slippage = all_in − LP − Agg`, identical to pure routes. This guarantees reconciliation to the anchor by construction. (Phase 2 adds *independent* per-leg price-impact for attribution/display, reconciled separately.)
4. **Remove the ±100 plausibility collapse for reconstructed routes.** It was a heuristic for direct USDC/WETH trades; multi-hop routes legitimately have large offsetting LP/slippage. Replace with a confidence flag + a per-leg sanity check (LP per leg ≤ a generous cap, e.g. 300 bps) rather than a hard collapse.
5. **Per-leg reference mid (Phase 2):** use the deepest independent pool for each pair @ N-1 where discoverable; fall back to the leg's own pool slot0 @ N-1. Independent per-leg slippage and the trade-level residual are stored for confidence/QA; the rolled-up Slippage column stays the residual from Decision 3.
6. **Scope: smoke pipeline first.** Funnel reuse is a later follow-up (its own task at the end), not part of the core delivery.
7. **Splits/complex routes:** Phase 1 handles single and linear paths precisely. Parallel splits or unresolvable graphs are flagged `route_shape='complex'` with `confidence='low'`; LP is best-effort (sum of identified legs) and Slippage stays the residual, but the confidence flag tells the dashboard/QA not to over-trust the split. (Full split handling is out of scope here.)

---

## File Structure

**Create (Phase 1):**
- `packages/ingest/src/routeGraph.ts` — pure route reconstruction: transfers + venue classification → ordered `Leg[]` + `RouteShape`.
- `packages/ingest/src/routeGraph.test.ts`
- `packages/ingest/src/legFees.ts` — pure: per-leg fee-tier lookup inputs + leg-notional valuation (USDC) + roll-up to trade-level LP. (Pure math; on-chain fee reads are passed in.)
- `packages/ingest/src/legFees.test.ts`
- `packages/ingest/src/decomposeRoute.ts` — orchestrates: fetch trace, build route graph, read per-pool fee tiers, value legs, compute LP + residual Slippage + Agg (reuse), confidence; returns a `RouteDecomposeResult`.
- `packages/ingest/src/decomposeRoute.test.ts`

**Create (Phase 2):**
- `packages/ingest/src/tokenPricing.ts` — `getPairMidAtBlock(rpc, tokenA, tokenB, block)` + `getTokenUsdcValue(...)` across V3/PancakeV3/V2/Aerodrome/V4, with a decimals cache and pool discovery.
- `packages/ingest/src/tokenPricing.test.ts`
- `packages/ingest/src/poolDiscovery.ts` — find a reference pool for a pair (factories + the route's own pools as fallback).

**Modify:**
- `packages/ingest/src/normalizeSmokeTrade.ts` — call `decomposeRoute` (smoke profile); populate per-leg breakdown.
- `packages/db/src/schema.ts` — add to `smokeTrades`: `route_shape text`, `hop_count integer`, `route_legs jsonb`, `recon_residual_bps numeric`, `decomp_confidence text`. (LP/Slippage columns already exist; now populated for multi-hop.)
- `packages/db/drizzle/*` — migration (ALTER smoke_trades only).
- `packages/ingest/src/redecompose-smoke.ts` — persist the new fields.
- `packages/dashboard/lib/queries.ts`, `packages/dashboard/components/TradesTable.tsx` — show LP/Slippage for multi-hop + a hop-count badge; (Phase 2) per-leg drill-down.

---

## Interfaces (cross-task contract)

```ts
// routeGraph.ts
export type VenueType = 'univ3' | 'pancakev3' | 'univ4' | 'univ2' | 'aerodrome' | 'rfq' | 'unknown';
export interface Leg {
  venue: string;            // lowercase address (or 'rfq_fill:<idx>')
  type: VenueType;
  tokenIn: string;          // lowercase
  tokenOut: string;         // lowercase
  amountInRaw: bigint;
  amountOutRaw: bigint;
  v4PoolId?: string;        // for univ4 (from Swap event id)
  v4FeeRaw?: number;        // for univ4 (from Swap event fee)
}
export type RouteShape = 'single' | 'linear' | 'split' | 'complex';
export interface RouteGraph {
  legs: Leg[];              // ordered tokenIn→…→tokenOut for linear; best-effort otherwise
  shape: RouteShape;
  inputToken: string;       // trader's input (lowercase)
  outputToken: string;      // trader's output
  tokens: string[];         // all distinct tokens on the path
  reconstructed: boolean;   // false → could not order the path
}
export interface BuildRouteArgs {
  transfers: { token: string; from: string; to: string; value: bigint }[];
  trader: string;
  /** venue address → {type, v4PoolId?, v4FeeRaw?} from Swap-event scan */
  venues: Map<string, { type: VenueType; v4PoolId?: string; v4FeeRaw?: number }>;
  denylist: ReadonlySet<string>;
}
export function buildRouteGraph(args: BuildRouteArgs): RouteGraph;

// legFees.ts
export interface LegFeeInput {
  leg: Leg;
  feeTierBps: number;          // resolved per leg (rfq=0)
  notionalUsdc: number;        // leg notional in USDC
  notionalApprox: boolean;
}
export interface LpRollup { lpFeeBps: number; legs: LegFeeInput[]; }
export function valueLegNotionalUsdc(leg: Leg, usdcPerWeth: number, tradeNotionalUsdc: number,
  decimalsOf: (token: string) => number): { notionalUsdc: number; approx: boolean };
export function rollupLpFee(legFees: LegFeeInput[], tradeNotionalUsdc: number): LpRollup;

// decomposeRoute.ts
export interface RouteDecomposeResult {
  lpFeeBps: number | null;
  aggFeeBps: number;
  slippageBps: number | null;
  gasBps: number;
  routeShape: RouteShape;
  hopCount: number;
  legs: (LegFeeInput & { lpFeeBps: number })[];
  reconResidualBps: number | null;   // Phase 2
  confidence: 'high' | 'medium' | 'low';
  flags: string[];
}
export function decomposeRoute(input: DecomposeTradeInput): Promise<RouteDecomposeResult>;
// (DecomposeTradeInput is the existing interface in decompose-trade.ts.)
```

---

## PHASE 1 — Route-aware LP + residual Slippage

### Task 1: Route graph reconstruction (`routeGraph.ts`)

**Files:** Create `packages/ingest/src/routeGraph.ts`, `packages/ingest/src/routeGraph.test.ts`.
**Interfaces:** Produces `buildRouteGraph` (see contract).

Algorithm: from `transfers`, compute each non-trader, non-denylist address's net delta per token. A **venue** is any address in `args.venues` (emitted a Swap) OR an address that net-received exactly one token and net-sent exactly one other (an RFQ filler). For each venue derive `tokenIn` = the token it net-received, `tokenOut` = the token it net-sent, and `amountIn/Out` from the gross flows. Order legs by chaining from `inputToken` (the trader's net-negative token) through matching tokenOut→tokenIn until reaching `outputToken` (trader's net-positive token). If a single chain consumes all legs → `shape='linear'` (or `'single'` if one leg); if the trader's input fans out to multiple first-legs → `'split'`; if chaining stalls → `'complex'`, `reconstructed=false`.

- [ ] **Step 1: Write the failing test (linear 2-leg)**

```ts
import { describe, expect, it } from 'vitest';
import { buildRouteGraph } from './routeGraph.js';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';
const VIRTUAL = '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b';
const trader = '0x00000000000000000000000000000000000000d0';
const pcs = '0x7cb770d0513c30e0cb45e4899e4a2cbeed6f9830';
const v4 = '0x498581ff718922c3f8e6a244956af099b2652b2b';
// USDC→VIRTUAL (pcs) → VIRTUAL→WETH (v4)
const transfers = [
  { token: USDC, from: trader, to: pcs, value: 2_000000n },
  { token: VIRTUAL, from: pcs, to: v4, value: 3_000000000000000000n },
  { token: WETH, from: v4, to: trader, value: 1_000000000000000n },
];
const venues = new Map([[pcs, { type: 'pancakev3' as const }], [v4, { type: 'univ4' as const }]]);
describe('buildRouteGraph', () => {
  it('orders a linear USDC→VIRTUAL→WETH route', () => {
    const g = buildRouteGraph({ transfers, trader, venues, denylist: new Set() });
    expect(g.shape).toBe('linear');
    expect(g.reconstructed).toBe(true);
    expect(g.inputToken).toBe(USDC);
    expect(g.outputToken).toBe(WETH);
    expect(g.legs.map(l => `${l.type}:${l.tokenIn.slice(0,6)}>${l.tokenOut.slice(0,6)}`))
      .toEqual([`pancakev3:${USDC.slice(0,6)}>${VIRTUAL.slice(0,6)}`, `univ4:${VIRTUAL.slice(0,6)}>${WETH.slice(0,6)}`]);
    expect(g.legs[0]!.amountInRaw).toBe(2_000000n);
    expect(g.legs[1]!.amountOutRaw).toBe(1_000000000000000n);
  });
  it('flags an RFQ filler (no Swap event) as an rfq leg', () => {
    const rfq = '0xbee3211ab312a8d065c4fef0247448e17a8da000';
    const t2 = [
      { token: USDC, from: trader, to: rfq, value: 2_000000n },
      { token: VIRTUAL, from: rfq, to: v4, value: 3_000000000000000000n },
      { token: WETH, from: v4, to: trader, value: 1_000000000000000n },
    ];
    const g = buildRouteGraph({ transfers: t2, trader, venues: new Map([[v4, { type: 'univ4' as const }]]), denylist: new Set() });
    expect(g.legs[0]!.type).toBe('rfq');
    expect(g.shape).toBe('linear');
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run packages/ingest/src/routeGraph.test.ts` → module not found.
- [ ] **Step 3: Implement `routeGraph.ts`** per the algorithm above (pure; no I/O). Net per-address per-token deltas from `transfers`; classify venues (from `args.venues` or single-in/single-out RFQ); chain legs; set shape/reconstructed. Use bigint throughout.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `git add packages/ingest/src/routeGraph.ts packages/ingest/src/routeGraph.test.ts && git commit` (subject `feat(ingest): route-graph reconstruction for multi-hop decomposition`; include the standard Co-Authored-By + Claude-Session trailer).

### Task 2: Leg-fee valuation + LP roll-up (`legFees.ts`)

**Files:** Create `packages/ingest/src/legFees.ts`, `packages/ingest/src/legFees.test.ts`.
**Interfaces:** Consumes `Leg` from Task 1. Produces `valueLegNotionalUsdc`, `rollupLpFee`.

- [ ] **Step 1: Write failing tests** covering: (a) a USDC-input leg → notional = amountIn/1e6, approx=false; (b) a WETH-output leg → notional = amountOut/1e18 × usdcPerWeth, approx=false; (c) an intermediate VIRTUAL→VIRTUAL2 leg (neither USDC/WETH) → notional = tradeNotionalUsdc, approx=true; (d) `rollupLpFee` of `[{feeTierBps:5,notionalUsdc:2},{feeTierBps:100,notionalUsdc:2}]` with tradeNotional 2 → lpFeeBps = (5*2 + 100*2)/2/... — assert `lpFeeBps = Σ(feeTierBps×notionalUsdc)/tradeNotionalUsdc` = (10+200)/2 = 105.

```ts
import { describe, expect, it } from 'vitest';
import { valueLegNotionalUsdc, rollupLpFee } from './legFees.js';
const USDC='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', WETH='0x4200000000000000000000000000000000000006', V='0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b';
const dec = (t:string)=> t===USDC?6:18;
const baseLeg = { venue:'0x', type:'univ3' as const, amountInRaw:0n, amountOutRaw:0n };
describe('valueLegNotionalUsdc', () => {
  it('values a USDC-input leg directly', () => {
    const r = valueLegNotionalUsdc({...baseLeg, tokenIn:USDC, tokenOut:V, amountInRaw:2_000000n, amountOutRaw:3n}, 2000, 2.0, dec);
    expect(r.notionalUsdc).toBeCloseTo(2.0, 6); expect(r.approx).toBe(false);
  });
  it('values a WETH-output leg via usdcPerWeth', () => {
    const r = valueLegNotionalUsdc({...baseLeg, tokenIn:V, tokenOut:WETH, amountInRaw:3n, amountOutRaw:1_000000000000000n}, 2000, 2.0, dec);
    expect(r.notionalUsdc).toBeCloseTo(2.0, 6); expect(r.approx).toBe(false); // 0.001 WETH * 2000
  });
  it('approximates a pure-intermediate leg with the trade notional', () => {
    const r = valueLegNotionalUsdc({...baseLeg, tokenIn:V, tokenOut:'0xother', amountInRaw:3n, amountOutRaw:4n}, 2000, 1.8027, dec);
    expect(r.notionalUsdc).toBeCloseTo(1.8027, 6); expect(r.approx).toBe(true);
  });
});
describe('rollupLpFee', () => {
  it('sums fee tiers weighted by leg notional over trade notional', () => {
    const r = rollupLpFee([
      { leg:{...baseLeg,tokenIn:USDC,tokenOut:V}, feeTierBps:5, notionalUsdc:2, notionalApprox:false },
      { leg:{...baseLeg,tokenIn:V,tokenOut:WETH}, feeTierBps:100, notionalUsdc:2, notionalApprox:false },
    ], 2);
    expect(r.lpFeeBps).toBeCloseTo(105, 6);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `valueLegNotionalUsdc`: if tokenIn===USDC → amountInRaw/1e6; elif tokenOut===USDC → amountOutRaw/1e6; elif tokenIn===WETH → amountInRaw/1e18×usdcPerWeth; elif tokenOut===WETH → amountOutRaw/1e18×usdcPerWeth; else → {tradeNotionalUsdc, approx:true}. `rollupLpFee`: `lpFeeBps = Σ(feeTierBps×notionalUsdc)/tradeNotionalUsdc`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** (`feat(ingest): per-leg notional valuation + LP roll-up`).

### Task 3: Route decomposition orchestrator (`decomposeRoute.ts`)

**Files:** Create `packages/ingest/src/decomposeRoute.ts`, `packages/ingest/src/decomposeRoute.test.ts`.
**Interfaces:** Consumes Tasks 1–2 + the existing agg-fee/known-vault logic. Produces `decomposeRoute` (see contract).

Behavior: fetch trace logs (reuse the pattern in `decompose-trade.ts`), scan Swap events to build the `venues` map (Uni V3 / PancakeSwap V3 / V2 / Aerodrome / V4 — reuse `decodeV3LikeSwaps` for V3-likes; capture V4 `id`+`fee` from the V4 Swap event), decode all transfers (`decodeTransferLogs`), call `buildRouteGraph`. Resolve each leg's `feeTierBps`: V3/PancakeV3 → `fee()` at block (reuse existing read); V4 → `v4FeeRaw/100`; V2 → 30; Aerodrome → read pool (stable/volatile) or default 30 with a flag; RFQ/unknown → 0. Value legs (`valueLegNotionalUsdc`, using `usdcPerWeth = realizedPrice` or marketMid and `tradeNotionalUsdc = input.notionalUsdc`). `rollupLpFee` → `lpFeeBps`. Reuse the existing agg-fee computation from `decompose-trade.ts` (extract or import the fee-sink logic) → `aggFeeBps`. `slippageBps = input.allInCostBps − lpFeeBps − aggFeeBps`. Set `confidence`: `high` if `reconstructed && shape∈{single,linear} && no approx legs && all fee tiers resolved`; `medium` if approx legs or a defaulted fee; `low` if `!reconstructed || shape∈{split,complex}` (LP best-effort, slippage still residual). Gas bps as today.

- [ ] **Step 1: Write failing test** using the real kyber batch-01 fixture trace. Record the trace once to a fixture file (`packages/ingest/src/__fixtures__/kyber-b1-trace.json`) via a one-off `tsx -e` dump, then assert: `routeShape==='linear'`, `hopCount===2`, `lpFeeBps≈9.5` (5 PancakeSwap + 4.5 V4), `slippageBps≈ allIn − 9.5`, `confidence==='high'`. (Fee-tier reads that need RPC: in the test, inject a `feeReader` stub returning {pcs:500, v4 via event}. Make `decomposeRoute` accept an optional injected `feeReader`/`rpc` so the core is testable without live RPC; default to real RPC.)
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `decomposeRoute.ts`.** Keep it focused; reuse `decompose-trade.ts` helpers (export the agg-fee fee-sink routine from there if needed rather than duplicating). Apply the smoke profile floors for agg-fee (Decisions / existing params). Replace the ±100 collapse with the confidence flag + a per-leg LP sanity cap (≤300 bps/leg → else flag `LEG_FEE_IMPLAUSIBLE`, keep value, confidence `low`).
- [ ] **Step 4: Run, expect PASS.** Also add a test with the kyber batch-02 fixture (RFQ leg1 + V4 100bps): `lpFeeBps≈100`, `aggFeeBps≈1.66` (the `0x4f…eb29` skim via the existing fee-sink logic), `slippageBps≈ allIn − 100 − 1.66`, `confidence` medium (RFQ leg → notional via WETH endpoint, not approx; but rfq fee defaulted 0 is fine → high if all else resolved — assert the actual computed value and document it).
- [ ] **Step 5: Commit** (`feat(ingest): route-aware decomposition (LP across legs, residual slippage)`).

### Task 4: Schema + normalizer integration + re-decompose

**Files:** Modify `packages/db/src/schema.ts` (+ migration), `packages/ingest/src/normalizeSmokeTrade.ts`, `packages/ingest/src/redecompose-smoke.ts`.

- [ ] **Step 1: Add columns** to `smokeTrades`: `routeShape text('route_shape')`, `hopCount integer('hop_count')`, `routeLegs jsonb('route_legs')`, `reconResidualBps numeric('recon_residual_bps')`, `decompConfidence text('decomp_confidence')`. Run `npm run db:generate`; ensure the migration is **ALTER smoke_trades only** (delete any spurious CREATE for other tables, as in prior migrations). Apply with `npm run db:migrate`.
- [ ] **Step 2: Wire `normalizeSmokeTrade.ts`** to call `decomposeRoute` instead of `decomposeTrade` (smoke profile). Map the result into `SmokeTradeRow` (lp/agg/slippage/execution + the new route fields; `route_legs` = the per-leg array). Keep `buildSmokeRow` pure-core behavior; the route fields ride alongside. `executionBps` stays = `allIn − agg` for `confidence==='low'` rows where slippage is null; otherwise `slippageBps` is populated and `routePure` reflects `shape==='single'`.
- [ ] **Step 3: Update `redecompose-smoke.ts`** to persist the new columns.
- [ ] **Step 4: Re-decompose smoke** — `npx tsx packages/ingest/src/redecompose-smoke.ts`. Verify: kyber b1 → lp≈9.5, slippage non-null, shape linear, hop 2; kyber b2 → lp≈100, agg≈1.66, slippage non-null; nordstern b2 → lp non-null (or low-confidence with reason); the 5 direct trades unchanged (shape single, prior LP intact). Confirm `router_trades_gated` still 165, `decompose-gated.ts` zero diff.
- [ ] **Step 5: Typecheck + commit** (`feat(smoke): persist route decomposition (multi-hop LP+slippage, per-leg breakdown)`).

**CHECKPOINT A (review gate):** Present the re-decomposed smoke set (LP/Slippage now populated for multi-hop, per-leg `route_legs`) for human verification against Basescan before Phase 2.

---

## PHASE 2 — Per-leg independent pricing + display

### Task 5: Generalized pair-mid pricing (`tokenPricing.ts` + `poolDiscovery.ts`)

**Files:** Create `packages/ingest/src/tokenPricing.ts`, `poolDiscovery.ts`, `tokenPricing.test.ts`.

- [ ] **Step 1: Write failing unit tests** for the pure math: `sqrtPriceX96ToPrice(sqrtPriceX96, dec0, dec1)` → human token1-per-token0 (generalize `sqrtPriceX96ToUsdcPerWeth`; assert it reproduces the USDC/WETH case `×10^12`). `v2MidFromReserves(r0, r1, dec0, dec1)`. Decimals cache behavior.
- [ ] **Step 2: Implement** `getPairMidAtBlock(rpc, tokenA, tokenB, block)`: discover a reference pool via `poolDiscovery` (UniV3 factory `getPool(a,b,fee)` across tiers; PancakeSwap V3 factory `0x0BFbCF9f…91865`; V2/Aerodrome; V4 via StateView `0xa3c0…a71` `getSlot0(poolId)` — confirm the StateView ABI as Step 0 of this task and record it); read slot0/reserves at `block`; return human mid (B per A) or `null`. `getTokenUsdcValue(rpc, token, amountRaw, block)`: USDC→direct; else token/USDC pool; else token/WETH × WETH/USDC. Decimals via a cached `decimals()` reader.
- [ ] **Step 3: Integration check** (not a unit test): a `tsx -e` snippet pricing VIRTUAL in USDC @ the kyber-b1 block via the PancakeSwap pool; sanity vs the trade's implied VIRTUAL price. Record output in the task report.
- [ ] **Step 4: Commit** (`feat(ingest): generalized pair-mid + token-USDC pricing at block N-1`).

### Task 6: Per-leg price-impact attribution + reconciliation

**Files:** Modify `decomposeRoute.ts` (+ tests).

- [ ] **Step 1: Write failing test** (kyber-b1 fixture + injected pricing stub): each leg gets `priceImpactBps` = (leg realized price vs leg reference mid) − `feeTierBps`; assert per-leg `lpFeeBps + priceImpactBps` ≈ leg total cost; assert trade-level `reconResidualBps = allIn − (Σ legLp + Σ legPriceImpact + agg)` is small (|residual| < a tolerance, e.g. 5 bps) → `confidence='high'`; large residual → downgrade confidence.
- [ ] **Step 2: Implement** per-leg pricing in `decomposeRoute` using `tokenPricing.getPairMidAtBlock` at `blockNumber-1`; populate each leg's `priceImpactBps`; compute `reconResidualBps`; set confidence from residual magnitude. The rolled-up `slippageBps` remains the residual definition (Decision 3); store the independent `Σ legPriceImpact` and `reconResidualBps` for QA. RFQ legs: mid from the pair's reference pool → their spread shows as price-impact.
- [ ] **Step 3: Re-decompose smoke; verify** residuals are small for linear routes; record the per-leg attribution table.
- [ ] **Step 4: Commit** (`feat(ingest): per-leg price-impact attribution + reconciliation residual`).

### Task 7: Dashboard — multi-hop LP/Slippage + per-leg drill-down

**Files:** Modify `packages/dashboard/lib/queries.ts`, `packages/dashboard/components/TradesTable.tsx` (+ a small `RouteLegs` detail component).

- [ ] **Step 1:** Surface `hop_count`, `route_shape`, `decomp_confidence`, `route_legs` in the trades query/types.
- [ ] **Step 2:** In `TradesTable`, render LP/Slippage normally for multi-hop (no more blank), add a small hop-count badge (e.g. "2-hop") and a low-confidence indicator (dim/asterisk). Keep the 6-column framework intact (Accuracy/LP/Agg/Slippage/Gas/Variability) — the badge is metadata, not a new cost column.
- [ ] **Step 3:** Add an expandable per-leg detail (tooltip or row expansion) showing each leg: venue type, pair, fee tier, price-impact. Build the dashboard (`npm --workspace packages/dashboard run build`) — must pass.
- [ ] **Step 4:** Manual check: `?ds=smoke` / `?ds=smoke02` show multi-hop LP+Slippage + hop badges; pure rows unchanged. Commit (`feat(dashboard): multi-hop LP/slippage + per-leg route detail`).

**CHECKPOINT B (review gate):** Full dashboard review of the multi-hop decomposition + per-leg detail.

### Task 8: Validation, docs, memory

- [ ] **Step 1:** Add `packages/ingest/src/validate-route-decomposition.ts` (reference script, like the existing `validate-*`): over all smoke rows, print all_in vs (LP+Agg+Slippage) reconciliation and the residual/confidence distribution; assert invariant within tolerance.
- [ ] **Step 2:** Write `docs/route-decomposition-v2.md`: the new model, leg notional valuation, residual vs per-leg slippage, confidence semantics, known limits (splits/complex).
- [ ] **Step 3:** Update memory `route-decomposition-limitation.md` → status RESOLVED for smoke (link the plan + key commits); note the funnel-reuse follow-up.
- [ ] **Step 4:** Commit (`docs(tca): route decomposition v2 — multi-hop attribution`).

### Task 9 (follow-up, optional): Funnel reuse
- [ ] Behind a deliberate, separately-reviewed change: point the funnel decomposition at `decomposeRoute` (or enable the route path for `router_trades_gated`), re-extract, and compare deltas. Out of scope for the smoke delivery; do only on explicit go-ahead (funnel data is currently frozen/locked).

---

## Self-Review

- **Spec coverage:** "handle multi-hop + display fees + slippage" → Tasks 1–4 (reconstruct + LP + residual slippage, non-null for multi-hop) + Task 7 (display). "Expand for advanced routing as size grows" → Tasks 5–6 (generalized pricing + per-leg attribution + reconciliation) and the `split/complex` confidence handling (Decision 7). "Understand the pricing-model limit" → Decisions 1–5 + Task 6 reconciliation makes the residual explicit.
- **Funnel safety:** every change is in new files or the smoke path; `decompose-gated.ts` untouched; explicit verification of `router_trades_gated` = 165 in Tasks 4 & 6; Task 9 isolates any funnel change behind a separate gate.
- **Type consistency:** `Leg`/`RouteGraph`/`RouteDecomposeResult` defined in Task 1/3 and consumed unchanged downstream; `valueLegNotionalUsdc`/`rollupLpFee` signatures fixed in Task 2 and used in Task 3.
- **Testability:** pure cores (`routeGraph`, `legFees`, pricing math) are unit-tested without RPC; `decomposeRoute` takes injectable fee/price readers so it's testable on recorded fixtures; live RPC only in integration steps.
- **Open risks flagged in-plan:** V4 StateView ABI (confirm in Task 5 Step 0); Aerodrome fee read (default + flag); split/complex routes (Decision 7, low-confidence, not fully solved here).
