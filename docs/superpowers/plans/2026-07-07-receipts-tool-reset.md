# Receipts Tool Reset — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the batch analytics pipeline into an on-demand, two-tab receipts tool: paste any transaction hash → computed itemized cost receipt; History tab saves/reviews/deletes past receipts.

**Architecture:** Rename `ingest` → `core` and reduce it to a single public entry point `analyzeTransaction(hash, chainId)` that fetches a trace, anchors the trader on `tx.from`, extracts generic net-token endpoints, decomposes cost (Execution Quality → LP Fee, Agg Fee, Price Impact, Slippage) via the existing `decomposeRoute`, and best-effort prices arbitrary pairs. A single Postgres `receipts` table (Drizzle) stores computed receipts. The Next.js dashboard keeps its two tabs (Receipts, History) and existing receipt components, rewired to compute on demand and to read/delete from `receipts`.

**Tech Stack:** TypeScript monorepo (npm workspaces), Drizzle ORM + Postgres, viem (Base RPC + `debug_traceTransaction`), Next.js (App Router, React), Vitest.

## Global Constraints

- **Salvage, don't rewrite.** Ported modules move with their existing tests intact; logic changes only where a task explicitly requires generalization. Copied verbatim from spec §4.1.
- **Best-effort pricing (graceful degradation).** No transaction is rejected for being an exotic pair. If a reliable reference mid / USD anchor is unavailable, emit a *partial* receipt (LP Fee + Agg Fee only) with `pricing_status='partial'` and Price Impact / Slippage marked unavailable. Spec §5.
- **Manual attribution only.** Untagged routers/pools/fee-sinks render as raw addresses; never fail on missing tags. Spec §3.
- **Single error state for MVP:** every failed analysis surfaces as **"Transaction not found."** via the existing `ReceiptSearch` `error` prop. Nothing is persisted on failure. Spec §7.3.
- **`user_id` is schema-only.** Present, nullable, unused; no auth wiring. Spec §3.
- **Base is the tested chain.** `chainId` is threaded through but only Base (8453) is exercised. Spec §10.
- **Frequent commits, TDD.** Each task ends green with a commit.
- Branch: `feat/receipts-reset` (already created; spec already committed).

---

## File Structure

**`packages/db`**
- Modify `src/schema.ts` — add `receipts` (and stub `users` comment); leave old tables until Task 12 drops them from the DB. New Drizzle migration under `drizzle/`.

**`packages/core`** (renamed from `packages/ingest`)
- `package.json` name `@fabric-tca/core`; keep tsconfig.
- Keep: `decoder.ts`, `tradeEndpoints.ts`, `routeGraph.ts`, `legFees.ts`, `decomposeRoute.ts`, `priceMath.ts`, `decompose-trade.ts`, `tokenPricing.ts`, `benchmarkPrice.ts`, `poolDiscovery.ts`, `referencePrice.ts`, `duneOracle.ts`, `routerRegistry.ts`, `aggregatorSignatures.ts`, and their `*.test.ts`.
- Create `tagging.ts` — pool-identity / fee-sink naming extracted from `selectionGate.ts`.
- Create `endpoints.ts` — generic trader-anchored net-delta extraction (any pair).
- Create `pricing.ts` — generic USD anchor + reference-mid with graceful degradation.
- Create `analyzeTransaction.ts` — the single public entry point; returns `Receipt`.
- Create `index.ts` — re-exports `analyzeTransaction`, `Receipt`.
- Delete everything else (funnel, v1 pipeline, smoke machinery, ~30 one-off scripts).

**`packages/dashboard`**
- Create `app/api/receipts/route.ts` — `POST` compute+persist, `GET` list, `DELETE` remove.
- Modify `lib/queries.ts` — replace curated-smoke queries with `receipts` CRUD.
- Modify `app/receipts/page.tsx` + `components/ReceiptSearch.tsx` — submit to the API, render computed receipt.
- Modify `components/ReceiptView.tsx` + `components/TradesTable.tsx` — generalize token display; add delete affordance.
- Modify `app/trades/page.tsx` — read `receipts`, receipts-appropriate empty state.
- Delete `components/TrustMatrix.tsx`, `AggregatorSummaryTable.tsx`, `IngestStatus.tsx`, `DatasetToggle.tsx`, `lib/datasets.ts`, `lib/trustMatrix.ts`, `app/page.tsx` Dashboard body.

---

## Phase 1 — Data model

### Task 1: `receipts` schema + migration

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/drizzle/0011_receipts.sql` (generated)
- Test: `packages/db/src/schema.test.ts` (create)

**Interfaces:**
- Produces: `schema.receipts` Drizzle table; `ReceiptRow = typeof schema.receipts.$inferSelect`. Columns:
  - identity: `id` serial PK, `txHash` text, `chainId` integer, `userId` text nullable, `createdAt` timestamptz default now
  - trade: `aggregator`, `trader`, `direction`, `inputToken`, `outputToken`, `inputSymbol`, `outputSymbol`, `inputAmount` numeric, `outputAmount` numeric, `notionalUsd` numeric nullable, `realizedPrice` numeric nullable, `marketMid` numeric nullable, `allInCostBps` numeric nullable, `pricingStatus` text (`'full'|'partial'`), `blockNumber` integer
  - decomposition: `executionBps`, `lpFeeBps`, `aggFeeBps`, `slippageBps`, `gasCostUsd`, `routePure` boolean, `routeShape`, `hopCount`, `routeLegs` jsonb, `reconResidualBps`, `decompConfidence`
  - tagging/provenance: `settlementEventName`, `settlementEventTopic0`, `settlementEventSeen` boolean, `normalizeFlags` jsonb
  - benchmark validation (nullable): `chainlinkPrice`, `chainlinkDevBps`, `poolDivergenceBps`, `manipulationFlag` boolean, `offchainPrice`, `offchainDevBps`, `chainlinkStalenessSecs`
  - unique index on `(userId, txHash, chainId)`

- [ ] **Step 1: Write the failing test** — assert the table type has the generalized + new columns.

```ts
// packages/db/src/schema.test.ts
import { describe, it, expectTypeOf } from 'vitest';
import { schema } from './index.js';

describe('receipts schema', () => {
  it('exposes generalized token + receipt columns', () => {
    type R = typeof schema.receipts.$inferSelect;
    expectTypeOf<R>().toHaveProperty('inputToken');
    expectTypeOf<R>().toHaveProperty('outputToken');
    expectTypeOf<R>().toHaveProperty('pricingStatus');
    expectTypeOf<R>().toHaveProperty('createdAt');
    expectTypeOf<R>().toHaveProperty('userId');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run schema.test.ts`
Expected: FAIL — `schema.receipts` does not exist.

- [ ] **Step 3: Add the `receipts` table to `schema.ts`** using the column list in Interfaces above, following the existing `pgTable` style in the file (import `boolean, pgTable, text, integer, numeric, jsonb, timestamp, uniqueIndex, serial`). Add `export type ReceiptRow = typeof receipts.$inferSelect;` and include `receipts` in the exported `schema` object. Add a one-line comment `// users table added when auth lands; receipts.userId is the forward hook`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Generate the migration**

Run: `npm run db:generate` (or the repo's existing generate script per `drizzle.config.ts`)
Expected: new `packages/db/drizzle/0011_receipts.sql` creating the table + unique index. Inspect it; confirm no destructive statements against existing tables (drops happen in Task 12).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/schema.test.ts packages/db/drizzle/0011_receipts.sql
git commit -m "feat(db): add receipts table + migration"
```

### Task 2: Seed the 25 receipts + apply migration

**Files:**
- Create: `packages/db/scripts/seed-receipts.ts`
- Test: `packages/db/scripts/seed-receipts.test.ts`

**Interfaces:**
- Consumes: existing `smoke_trades` rows (still present pre-Task-12); `schema.receipts` from Task 1.
- Produces: `mapSmokeToReceipt(row: SmokeTradeRow): NewReceipt` — pure mapper (USDC/WETH smoke row → generalized receipt insert: `inputToken/outputToken` from `direction`+USDC/WETH addresses, `inputSymbol/outputSymbol` = 'USDC'/'WETH', `inputAmount/outputAmount` from `usdcAmount`/`wethAmount` per direction, `notionalUsd = usdcAmount`, `pricingStatus='full'`, `createdAt` from `loadedAt`). Carries decomposition + benchmark columns straight across.

- [ ] **Step 1: Write the failing test** for the pure mapper.

```ts
// packages/db/scripts/seed-receipts.test.ts
import { describe, it, expect } from 'vitest';
import { mapSmokeToReceipt } from './seed-receipts.js';

const base = {
  txHash: '0xabc', aggregator: 'odos', trader: '0xt', direction: 'buy_weth',
  settledIn: 'WETH', usdcAmount: '1000', wethAmount: '0.3', realizedPrice: '3333',
  marketMid: '3300', allInCostBps: '5', blockNumber: 30000000,
  lpFeeBps: '1', aggFeeBps: '2', slippageBps: '1', executionBps: '2', gasCostUsd: '0.01',
  routePure: true, routeShape: 'single', hopCount: 1, routeLegs: [], reconResidualBps: '0',
  decompConfidence: 'high', settlementEventName: null, settlementEventTopic0: null,
  settlementEventSeen: false, normalizeFlags: [], chainlinkPrice: null, chainlinkDevBps: null,
  poolDivergenceBps: null, manipulationFlag: false, offchainPrice: null, offchainDevBps: null,
  chainlinkStalenessSecs: null, loadedAt: new Date('2026-06-27T00:00:00Z'),
} as any;

describe('mapSmokeToReceipt', () => {
  it('maps a buy_weth smoke row to a generalized receipt', () => {
    const r = mapSmokeToReceipt(base);
    expect(r.inputSymbol).toBe('USDC');
    expect(r.outputSymbol).toBe('WETH');
    expect(r.inputAmount).toBe('1000');
    expect(r.outputAmount).toBe('0.3');
    expect(r.pricingStatus).toBe('full');
    expect(r.notionalUsd).toBe('1000');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run seed-receipts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mapSmokeToReceipt` + a `main()`** that: connects via `TCA_DATABASE_URL`, reads the curated-25 (`batch IN (smoke-01,02,03)` + first-2-per-agg of `smoke-04`, mirroring the logic currently in `dashboard/lib/queries.ts:getCuratedTrades`), maps each, and `insert().onConflictDoNothing()` into `receipts`. Guard `main()` behind `if (import.meta.url === ...)` so the test only imports the pure mapper.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run seed-receipts.test.ts`
Expected: PASS.

- [ ] **Step 5: Apply migration + seed against the live DB**

Run: `npm run db:migrate` then `npx tsx packages/db/scripts/seed-receipts.ts`
Expected: `receipts` created; 25 rows inserted. Verify: `psql "$TCA_DATABASE_URL" -c "select count(*) from receipts;"` → 25.

- [ ] **Step 6: Commit**

```bash
git add packages/db/scripts/seed-receipts.ts packages/db/scripts/seed-receipts.test.ts
git commit -m "feat(db): seed 25 receipts from smoke_trades"
```

---

## Phase 2 — Extract the `core` library

### Task 3: Rename `ingest` → `core`, prune, keep tests green

**Files:**
- Rename: `packages/ingest/` → `packages/core/` (git mv)
- Modify: `packages/core/package.json` (name `@fabric-tca/core`), root `package.json` workspaces if pinned, any `@fabric-tca/ingest` importers.
- Delete: the funnel, v1 pipeline, smoke machinery, and one-off scripts (full list below).

**Interfaces:**
- Produces: `@fabric-tca/core` workspace whose kept modules + their tests pass unchanged.

- [ ] **Step 1: Rename the package**

```bash
git mv packages/ingest packages/core
```
Update `packages/core/package.json` `"name"` to `@fabric-tca/core`. Grep for consumers: `grep -rl "@fabric-tca/ingest" --include=*.ts --include=*.json .` and rewrite to `@fabric-tca/core`.

- [ ] **Step 2: Run the kept tests to confirm the rename is clean**

Run: `npm run test --workspace packages/core`
Expected: PASS for the modules we keep (decomposeRoute, legFees, routeGraph, benchmarkPrice, duneOracle, aggregatorSignatures, decompose-trade, normalizeSmokeTrade — normalize will be superseded in Phase 3 but should still pass now).

- [ ] **Step 3: Delete dead code.** Remove these files (funnel + v1 + smoke + one-offs):

```bash
cd packages/core/src
git rm discover-router-trades.ts extract-router-trades.ts extract-smoke-candidates.ts \
  load-router-trades.ts load-smoke-trades.ts reextract-gated.ts decompose-gated.ts \
  decompose-remaining.ts redecompose-smoke.ts \
  poller.ts promoter.ts quoter.ts tcaCalculator.ts processSwap.ts \
  backfill-*.ts scan-005-pool-backfill.ts sample-*.ts \
  inspect-*.ts investigate-*.ts patch-*.ts fix-*.ts diagnose-*.ts spotcheck-*.ts \
  survey-*.ts check-*.ts list-*.ts orient-*.ts revalue-*.ts prove-*.ts \
  batch-investigate.ts get-tx1-addrs.ts inspect-tx2.ts explore-eth-trace.ts \
  resolve-token-addrs.ts fix-route-types.ts enrich-router-trades.ts \
  explain-decomposition.ts prune-stale-flags.ts test-multiple-pools.ts \
  heartbeat.ts cli.ts backfill-p99.ts debug-aggregator.ts check-single-swap.ts \
  validate-trader-id.ts validate-trader-id-singlehop.ts
```
(If a name above doesn't exist, skip it. Do NOT delete `selectionGate.ts` here — its tagging maps are extracted in Task 4, which deletes the file. Do NOT delete `referencePrice.ts` — it's in the keep-list; if it proves unused it's flagged in the final review, not deleted here.)

- [ ] **Step 4: Fix the build** — resolve import breakages from deletions.

Run: `npm run build --workspace packages/core`
Expected: any remaining errors are only the 6 pre-existing tsc errors noted in memory OR reference deleted files; fix references, and if a kept file imported a now-deleted script, sever that import.

- [ ] **Step 5: Re-run kept tests**

Run: `npm run test --workspace packages/core`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A packages/core packages/dashboard
git commit -m "refactor: rename ingest->core, delete funnel/v1/smoke/one-off scripts"
```

### Task 4: Extract `tagging.ts` from `selectionGate.ts`

**Files:**
- Create: `packages/core/src/tagging.ts`
- Test: `packages/core/src/tagging.test.ts`
- Delete: `packages/core/src/selectionGate.ts` (after extracting the naming maps)

**Interfaces:**
- Produces: `labelAddress(addr: string): { label: string; kind: 'pool'|'fee-sink'|'router'|'unknown' }` — pure lookup over the pool-identity + fee-sink maps currently embedded in `selectionGate.ts` (Velora `0x0070…`, Relay `0xf70da9…`, filler `0x770004fe…`, etc.) merged with `routerRegistry.ts`. Unknown → `{ label: addr, kind: 'unknown' }` (never throws).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/tagging.test.ts
import { describe, it, expect } from 'vitest';
import { labelAddress } from './tagging.js';

describe('labelAddress', () => {
  it('names a known fee sink', () => {
    expect(labelAddress('0x0070...').kind).toBe('fee-sink'); // real Velora addr
  });
  it('passes unknown addresses through as raw', () => {
    const r = labelAddress('0xdeadbeef');
    expect(r.kind).toBe('unknown');
    expect(r.label).toBe('0xdeadbeef');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tagging.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `tagging.ts`** by lifting the address→name constants out of `selectionGate.ts` and combining with `routerRegistry.ts`. Then delete `selectionGate.ts` and repoint any remaining importer (there should be none after Task 3).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tagging.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tagging.ts packages/core/src/tagging.test.ts
git rm packages/core/src/selectionGate.ts
git commit -m "refactor(core): extract tagging from selectionGate, drop gating"
```

---

## Phase 3 — Any-token generalization + `analyzeTransaction`

### Task 5: Generic trader-anchored endpoint extraction

**Files:**
- Create: `packages/core/src/endpoints.ts`
- Test: `packages/core/src/endpoints.test.ts`

**Interfaces:**
- Consumes: the trace-log flattening + `decodeTransferLogs` + `collectNativeEthDeltas` from `tradeEndpoints.ts` (reuse; do not duplicate).
- Produces:
```ts
export interface Endpoints {
  trader: string;
  inputToken: string;  outputToken: string;   // addresses ('native' for ETH)
  inputAmountRaw: bigint; outputAmountRaw: bigint;
}
export function extractEndpoints(args: {
  trace: TraceNode; trader: string;            // trader = tx.from, lowercased
}): Endpoints | null;   // null when no clean 2-token in/out is found
```
Algorithm: sum signed net per token (ERC-20 Transfers + native ETH) for `trader`; input = the token with the most-negative net, output = the most-positive; require exactly one of each with non-zero magnitude, else `null`. Generalizes `buildSmokeRow`'s hardcoded USDC/WETH matching.

- [ ] **Step 1: Write the failing test** with a synthetic trace: trader sends 1000 TOKENA, receives 5 TOKENB.

```ts
// packages/core/src/endpoints.test.ts
import { describe, it, expect } from 'vitest';
import { extractEndpoints } from './endpoints.js';

const trace = { /* two Transfer logs: A out from trader, B in to trader */ } as any;

describe('extractEndpoints', () => {
  it('picks the largest opposite-signed tokens as in/out', () => {
    const e = extractEndpoints({ trace, trader: '0xt' });
    expect(e?.inputToken).toBe('0xA');
    expect(e?.outputToken).toBe('0xB');
    expect(e?.inputAmountRaw).toBe(1000n);
    expect(e?.outputAmountRaw).toBe(5n);
  });
  it('returns null when trader has no clean 2-token flow', () => {
    expect(extractEndpoints({ trace: { logs: [] } as any, trader: '0xt' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run endpoints.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `extractEndpoints`**, reusing helpers from `tradeEndpoints.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run endpoints.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/endpoints.ts packages/core/src/endpoints.test.ts
git commit -m "feat(core): generic trader-anchored endpoint extraction"
```

### Task 6: Generic USD anchor + reference mid (graceful degradation)

**Files:**
- Create: `packages/core/src/pricing.ts`
- Test: `packages/core/src/pricing.test.ts`
- Modify: `packages/core/src/poolDiscovery.ts` (add "deepest pool for an arbitrary pair" if not present; keep existing behavior for callers)

**Interfaces:**
- Consumes: `poolDiscovery.ts`, token metadata (decimals/symbol) reader, `benchmarkPrice.ts` (WETH/USD fast-path).
- Produces:
```ts
export interface PricingResult {
  status: 'full' | 'partial';
  marketMid: number | null;      // output-per-input at N-1, null when partial
  notionalUsd: number | null;
  inputSymbol: string; outputSymbol: string;
  inputDecimals: number; outputDecimals: number;
  // benchmark-validation passthrough (null when partial/unavailable)
  chainlinkPrice: number | null; poolDivergenceBps: number | null; manipulationFlag: boolean;
}
export function priceReceipt(args: {
  rpcUrl: string; blockNumber: bigint; chainId: number;
  inputToken: string; outputToken: string;
  inputAmountRaw: bigint; outputAmountRaw: bigint;
}): Promise<PricingResult>;
```
Policy: if the pair is USDC/WETH → reuse `getBenchmarkMid` (full, with oracle validation). Else find the deepest on-chain pool for `(input,output)`; if found and one side anchors to USD (stablecoin allowlist or WETH×WETH-USD) → `full`. Otherwise → `partial` (`marketMid=null`, `notionalUsd` best-effort or null). Never throws — catch → `partial`.

- [ ] **Step 1: Write the failing test** for the partial path.

```ts
// packages/core/src/pricing.test.ts
import { describe, it, expect, vi } from 'vitest';
import { priceReceipt } from './pricing.js';

describe('priceReceipt', () => {
  it('degrades to partial when no reference pool / USD anchor exists', async () => {
    // stub poolDiscovery to return no pool
    const r = await priceReceipt({
      rpcUrl: 'http://stub', blockNumber: 1n, chainId: 8453,
      inputToken: '0xExoticA', outputToken: '0xExoticB',
      inputAmountRaw: 1000n, outputAmountRaw: 5n,
    });
    expect(r.status).toBe('partial');
    expect(r.marketMid).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run pricing.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `priceReceipt`** with the USDC/WETH fast-path delegating to `getBenchmarkMid`, a generic deepest-pool branch via `poolDiscovery`, a stablecoin allowlist for USD anchoring, and a top-level try/catch returning `status:'partial'`. Add a `getDeepestPoolForPair(...)` helper to `poolDiscovery.ts` if absent (do not alter existing exports).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run pricing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pricing.ts packages/core/src/pricing.test.ts packages/core/src/poolDiscovery.ts
git commit -m "feat(core): generic USD anchor + reference mid with graceful degradation"
```

### Task 7: `analyzeTransaction` entry point

**Files:**
- Create: `packages/core/src/analyzeTransaction.ts`
- Create: `packages/core/src/index.ts`
- Test: `packages/core/src/analyzeTransaction.test.ts`

**Interfaces:**
- Consumes: `decoder.ts` (trace + receipt fetch), `extractEndpoints` (Task 5), `priceReceipt` (Task 6), `decomposeRoute` + `createDefaultMidReader` (existing), `aggregatorSignatures.ts`, `tagging.ts`.
- Produces:
```ts
export interface Receipt {
  txHash: string; chainId: number; blockNumber: number;
  aggregator: string; trader: string; direction: string;
  inputToken: string; outputToken: string; inputSymbol: string; outputSymbol: string;
  inputAmount: number; outputAmount: number; notionalUsd: number | null;
  realizedPrice: number | null; marketMid: number | null; allInCostBps: number | null;
  pricingStatus: 'full' | 'partial';
  executionBps: number | null; lpFeeBps: number | null; aggFeeBps: number | null;
  slippageBps: number | null; gasCostUsd: number | null;
  routePure: boolean | null; routeShape: string | null; hopCount: number | null;
  routeLegs: unknown[] | null; reconResidualBps: number | null; decompConfidence: string | null;
  settlementEventName: string | null; settlementEventTopic0: string | null;
  settlementEventSeen: boolean; normalizeFlags: string[];
  chainlinkPrice: number | null; chainlinkDevBps: number | null; poolDivergenceBps: number | null;
  manipulationFlag: boolean; offchainPrice: number | null; offchainDevBps: number | null;
  chainlinkStalenessSecs: number | null;
}
export async function analyzeTransaction(
  hash: string, chainId: number, opts: { rpcUrl: string }
): Promise<Receipt | null>;   // null => surfaces as "Transaction not found."
```
Flow: fetch receipt+trace; `trader = tx.from.toLowerCase()`; `extractEndpoints`; if null → return null. `priceReceipt`. Run `decomposeRoute` (as wired in `normalizeSmokeTrade`, but fed generic endpoints; when `pricingStatus==='partial'`, skip price-impact/slippage and set them null, keep LP+Agg). Assemble `Receipt`. Aggregator name via `tagging`/`routerRegistry` (best-effort; unknown → raw). Wrap in try/catch → `null`.

- [ ] **Step 1: Write the failing test** — a pinned Base swap hash exercised against a real RPC (integration), guarded to skip without `TCA_RPC_URL`.

```ts
// packages/core/src/analyzeTransaction.test.ts
import { describe, it, expect } from 'vitest';
import { analyzeTransaction } from './analyzeTransaction.js';

const RPC = process.env.TCA_RPC_URL;
describe.runIf(RPC)('analyzeTransaction (integration)', () => {
  it('produces a full receipt for a known USDC/WETH smoke hash', async () => {
    const r = await analyzeTransaction(
      '0x9703bfa335528a8e01c6b63dd3046ccd6e13a66ba2e6954956aa2df39da269c1',
      8453, { rpcUrl: RPC! },
    );
    expect(r).not.toBeNull();
    expect(r!.pricingStatus).toBe('full');
    expect(r!.inputSymbol === 'USDC' || r!.outputSymbol === 'USDC').toBe(true);
    // LP + Agg + PriceImpact + Slippage reconcile to all-in within tolerance
    expect(Math.abs(Number(r!.allInCostBps))).toBeLessThan(200);
  });
  it('returns null for a non-swap hash', async () => {
    const r = await analyzeTransaction('0x' + '00'.repeat(32), 8453, { rpcUrl: RPC! });
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TCA_RPC_URL=$TCA_RPC_URL npx vitest run analyzeTransaction.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `analyzeTransaction.ts` + `index.ts`** (re-export `analyzeTransaction`, `Receipt`). Reuse the `decomposeRoute` wiring from `normalizeSmokeTrade` verbatim where possible; feed it generic endpoints.

- [ ] **Step 4: Run test to verify it passes**

Run: `TCA_RPC_URL=$TCA_RPC_URL npx vitest run analyzeTransaction.test.ts`
Expected: PASS (both cases). If `TCA_RPC_URL` unset, tests skip — set it before claiming done.

- [ ] **Step 5: Delete `normalizeSmokeTrade.ts` + `buildSmokeRow`** now that `analyzeTransaction` supersedes it (its test too). Confirm nothing else imports it: `grep -rl normalizeSmokeTrade packages`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/analyzeTransaction.ts packages/core/src/index.ts packages/core/src/analyzeTransaction.test.ts
git rm packages/core/src/normalizeSmokeTrade.ts packages/core/src/normalizeSmokeTrade.test.ts
git commit -m "feat(core): analyzeTransaction entry point (any-pair, on-demand)"
```

---

## Phase 4 — Dashboard: compute on demand

### Task 8: `receipts` data layer (queries)

**Files:**
- Modify: `packages/dashboard/lib/queries.ts` (replace curated-smoke functions)
- Test: `packages/dashboard/lib/queries.test.ts` (create)

**Interfaces:**
- Produces:
```ts
export type ReceiptRow = typeof schema.receipts.$inferSelect;
export function listReceipts(): Promise<ReceiptRow[]>;            // order by createdAt desc
export function getReceiptByHash(hash: string): Promise<ReceiptRow | null>;
export function insertReceipt(r: NewReceipt): Promise<ReceiptRow>; // onConflictDoNothing→return existing
export function deleteReceipt(id: number): Promise<void>;
```
Remove `getCuratedTrades`, `getCuratedAggregatorSummary`, `getCostByAggregator`, `getRecentTrades`, `getAggregatorSummary`, `getHeartbeats`, and the `RouteLeg`/`TradeRow` smoke-specific types (replace `TradeRow` usage with `ReceiptRow`; keep a `RouteLeg` interface for the JSONB legs).

- [ ] **Step 1: Write the failing test** for `getReceiptByHash` case-insensitivity (unit against a mocked db, or an integration test guarded by `TCA_DATABASE_URL`).

```ts
// packages/dashboard/lib/queries.test.ts
import { describe, it, expect } from 'vitest';
import { getReceiptByHash } from './queries.js';
const DB = process.env.TCA_DATABASE_URL;
describe.runIf(DB)('getReceiptByHash', () => {
  it('finds a seeded receipt regardless of hash case', async () => {
    const r = await getReceiptByHash(
      '0x9703BFA335528A8E01C6B63DD3046CCD6E13A66BA2E6954956AA2DF39DA269C1');
    expect(r).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TCA_DATABASE_URL=$TCA_DATABASE_URL npx vitest run queries.test.ts`
Expected: FAIL — `getReceiptByHash` not exported.

- [ ] **Step 3: Implement the four functions** against `schema.receipts` using Drizzle (`eq`, `desc`, `sql\`lower(...)\`` for case-insensitive hash match). Delete the removed functions and fix importers (they'll be rewired in Tasks 9–11).

- [ ] **Step 4: Run test to verify it passes**

Run: `TCA_DATABASE_URL=$TCA_DATABASE_URL npx vitest run queries.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/lib/queries.ts packages/dashboard/lib/queries.test.ts
git commit -m "feat(dashboard): receipts data layer (list/get/insert/delete)"
```

### Task 9: `POST /api/receipts` route + wire Receipts tab

**Files:**
- Create: `packages/dashboard/app/api/receipts/route.ts`
- Modify: `packages/dashboard/app/receipts/page.tsx`, `packages/dashboard/components/ReceiptSearch.tsx`

**Interfaces:**
- Consumes: `analyzeTransaction` (`@fabric-tca/core`), `insertReceipt`/`getReceiptByHash` (Task 8).
- Produces: `POST /api/receipts { hash, chainId? }` → `200 ReceiptRow` (existing-or-computed-and-saved) | `404 { error: 'Transaction not found.' }`. Handler: `getReceiptByHash` → return if present; else `analyzeTransaction(hash, chainId ?? 8453, { rpcUrl: process.env.TCA_RPC_URL! })` → null ⇒ 404; else `insertReceipt` ⇒ 200.

- [ ] **Step 1: Write the failing test** (route unit test with `analyzeTransaction` + queries mocked).

```ts
// packages/dashboard/app/api/receipts/route.test.ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('@fabric-tca/core', () => ({ analyzeTransaction: vi.fn().mockResolvedValue(null) }));
vi.mock('../../../lib/queries.js', () => ({
  getReceiptByHash: vi.fn().mockResolvedValue(null),
  insertReceipt: vi.fn(),
}));
import { POST } from './route.js';

describe('POST /api/receipts', () => {
  it('404s "Transaction not found." when analysis yields null', async () => {
    const res = await POST(new Request('http://x', {
      method: 'POST', body: JSON.stringify({ hash: '0xnope' }),
    }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Transaction not found.' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run route.test.ts`
Expected: FAIL — route not found.

- [ ] **Step 3: Implement `route.ts`.** Then change `ReceiptSearch` to `POST` to the API (replace the `router.push('/receipts?tx=...')` navigation with a `fetch`, showing the returned receipt or the 404 error via its existing `error` prop), and make `app/receipts/page.tsx` a client flow (or keep server page + a client search island) that renders `ReceiptView` from the API result. On success, revalidate History.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run route.test.ts`
Expected: PASS.

- [ ] **Step 5: Manually verify end-to-end.** `TCA_RPC_URL` + `TCA_DATABASE_URL` set; `npm run dev --workspace packages/dashboard`; paste a fresh non-seeded Base swap hash → receipt renders → appears in History. Paste garbage → "Transaction not found."

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/app/api/receipts packages/dashboard/app/receipts packages/dashboard/components/ReceiptSearch.tsx
git commit -m "feat(dashboard): POST /api/receipts, Receipts tab computes on demand"
```

### Task 10: Generalize `ReceiptView` token display

**Files:**
- Modify: `packages/dashboard/components/ReceiptView.tsx`, `packages/dashboard/components/TradesTable.tsx` (the shared `formatTokenIn/Out`, `receiptPairTitle`, hardcoded strings)
- Test: `packages/dashboard/components/ReceiptView.test.tsx` (exists — extend)

**Interfaces:**
- Consumes: `ReceiptRow` (Task 8) — reads `inputSymbol/outputSymbol/inputAmount/outputAmount/notionalUsd/pricingStatus` instead of `usdcAmount/wethAmount/settledIn`.
- Produces: a `ReceiptView` that renders any pair, shows a "Price Impact / Slippage unavailable for this pair" state when `pricingStatus==='partial'`, and derives the "Market Price" tooltip + "Chain" label from the row rather than hardcoding "ETH/USD"/"Base".

- [ ] **Step 1: Extend the failing test** — render a partial, non-WETH receipt; assert the pair title and the unavailable state.

```tsx
// add to ReceiptView.test.tsx
it('renders a partial exotic-pair receipt with impact/slippage unavailable', () => {
  const row = { inputSymbol: 'AAA', outputSymbol: 'BBB', inputAmount: '1000',
    outputAmount: '5', pricingStatus: 'partial', lpFeeBps: '3', aggFeeBps: '2',
    slippageBps: null, marketMid: null, realizedPrice: null, routeLegs: [], /* ... */ } as any;
  render(<ReceiptView trade={row} hash="0xabc" />);
  expect(screen.getByText(/BBB→AAA|AAA→BBB/)).toBeInTheDocument();
  expect(screen.getByText(/unavailable for this pair/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run ReceiptView.test.tsx`
Expected: FAIL — reads undefined `usdcAmount`, no unavailable state.

- [ ] **Step 3: Generalize the component** — swap `usdcAmount/wethAmount/settledIn` reads for the generalized fields; add the partial-state rendering; de-hardcode "ETH/USD" and "Base".

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run ReceiptView.test.tsx`
Expected: PASS. Also re-run the existing seed-row (USDC/WETH) assertions to confirm no regression.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/components/ReceiptView.tsx packages/dashboard/components/TradesTable.tsx packages/dashboard/components/ReceiptView.test.tsx
git commit -m "feat(dashboard): generalize ReceiptView to any token pair + partial state"
```

---

## Phase 5 — History: read receipts + delete

### Task 11: History reads `receipts`; add delete

**Files:**
- Modify: `packages/dashboard/app/trades/page.tsx`, `packages/dashboard/components/TradesTable.tsx`
- Create: (delete handler already exists as `DELETE` in `app/api/receipts/route.ts`) — extend Task 9's route with `DELETE`.
- Test: `packages/dashboard/components/TradesTable.test.tsx` (exists — extend)

**Interfaces:**
- Consumes: `listReceipts` (Task 8); `DELETE /api/receipts?id=` (extends Task 9 route → `deleteReceipt`).
- Produces: History table over `ReceiptRow[]`, row-click → existing `TransactionDetailsDialog`, plus a delete affordance per row (and/or in the dialog) that calls `DELETE` and refreshes.

- [ ] **Step 1: Extend the failing test** — a delete control is present and invokes the handler.

```tsx
// add to TradesTable.test.tsx
it('renders a delete control per row and calls onDelete', async () => {
  const onDelete = vi.fn();
  render(<TradesTable rows={[sampleReceiptRow]} initialSort={{column:'block',direction:'desc'}} onDelete={onDelete} />);
  await userEvent.click(screen.getAllByRole('button', { name: /delete/i })[0]);
  expect(onDelete).toHaveBeenCalledWith(sampleReceiptRow.id);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run TradesTable.test.tsx`
Expected: FAIL — no delete control / prop.

- [ ] **Step 3: Implement** — add `DELETE` to the route (`deleteReceipt(Number(id))`); add an `onDelete` prop + per-row delete button to `TradesTable` (confirm-then-`fetch`, then `router.refresh()`); change `app/trades/page.tsx` to `listReceipts()` and a receipts-appropriate empty state ("No receipts yet — paste a transaction hash on the Receipts tab."). Keep the row-click→dialog interaction intact.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run TradesTable.test.tsx`
Expected: PASS.

- [ ] **Step 5: Manually verify** — History lists 25 seeded rows; clicking a row opens the receipt dialog; deleting removes it and the list refreshes.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/app/trades/page.tsx packages/dashboard/components/TradesTable.tsx packages/dashboard/components/TradesTable.test.tsx packages/dashboard/app/api/receipts/route.ts
git commit -m "feat(dashboard): History reads receipts + row delete"
```

---

## Phase 6 — Remove dead UI + drop old tables

### Task 12: Delete trust-matrix/smoke UI; drop pipeline tables

**Files:**
- Delete: `packages/dashboard/components/TrustMatrix.tsx`, `AggregatorSummaryTable.tsx`, `IngestStatus.tsx`, `DatasetToggle.tsx`, `lib/datasets.ts`, `lib/trustMatrix.ts`
- Modify: `packages/dashboard/app/page.tsx` (remove Dashboard body → redirect to `/receipts`), `components/NavTabs.tsx` (drop the hidden Dashboard tab entry)
- Modify: `packages/db/src/schema.ts` — remove old table definitions; Create migration `packages/db/drizzle/0012_drop_pipeline_tables.sql`

**Interfaces:**
- Produces: a dashboard with exactly two tabs and a DB with only `receipts` (+ drizzle metadata).

- [ ] **Step 1: Delete the dead components** and fix imports.

```bash
cd packages/dashboard
git rm components/TrustMatrix.tsx components/AggregatorSummaryTable.tsx \
  components/IngestStatus.tsx components/DatasetToggle.tsx lib/datasets.ts lib/trustMatrix.ts
```
Update `app/page.tsx` to `redirect('/receipts')`; remove the hidden Dashboard entry from `NavTabs.tsx`.

- [ ] **Step 2: Typecheck + build**

Run: `npm run build --workspace packages/dashboard`
Expected: PASS (no references to deleted modules).

- [ ] **Step 3: Drop old tables.** Remove `swapsStaging, swaps, routerTrades, routerTradesGated, p99Thresholds, pollState, ingestHeartbeats, smokeTrades` from `schema.ts`; generate migration.

Run: `npm run db:generate`
Expected: `0012_drop_pipeline_tables.sql` with `DROP TABLE` for each (and backups: `router_trades_backup`, `router_trades_gated_backup` — add manual `DROP TABLE IF EXISTS` for those since they're not in the Drizzle schema).

- [ ] **Step 4: Apply + verify**

Run: `npm run db:migrate` then `psql "$TCA_DATABASE_URL" -c "\dt"`
Expected: only `receipts` (+ drizzle `__drizzle_migrations`) remain.

- [ ] **Step 5: Full suite + build across workspaces**

Run: `npm test && npm run build`
Expected: PASS. (Any residual pre-existing tsc errors from deleted-script land should now be gone since those files were removed.)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove trust-matrix/smoke UI, drop pipeline tables"
```

---

## Self-Review

**Spec coverage:**
- Two tabs (Receipts compute-on-demand, History review/delete) → Tasks 9, 11. ✅
- Cost-only decomposition into LP/Agg/PriceImpact/Slippage → Task 7 (reuses `decomposeRoute`). ✅
- Any token pair → Tasks 5, 6, 7, 10. ✅
- Best-effort graceful degradation / partial receipts → Tasks 6, 7, 10. ✅
- Keep decomposition core + tagging + receipt UI → Tasks 3, 4, 10. ✅
- Postgres `receipts` (+ `user_id` schema-only) → Task 1. ✅
- 25 seed rows → Task 2. ✅
- `core` as a library, `ingest` service gone → Task 3, 7. ✅
- Delete funnel/v1/smoke/one-offs/trust-matrix + drop tables → Tasks 3, 12. ✅
- Single "Transaction not found." error → Tasks 7, 9, 10. ✅

**Placeholder scan:** No "TBD/handle edge cases/similar to Task N" — port tasks show the `git mv`/`git rm` commands and the reused wiring is pointed at by file (`normalizeSmokeTrade`'s `decomposeRoute` call). Integration tests carry real code and skip-guards.

**Type consistency:** `Receipt` (Task 7) ⊇ the `receipts` columns (Task 1); `ReceiptRow` (Task 8) = `schema.receipts.$inferSelect`; `ReceiptView`/`TradesTable` (Tasks 10, 11) consume `ReceiptRow`. `pricingStatus: 'full'|'partial'` consistent across Tasks 1, 6, 7, 10. `extractEndpoints`→`Endpoints` (Task 5) feeds `priceReceipt` (Task 6) and `analyzeTransaction` (Task 7).

**Known judgment calls left to the implementer (not placeholders):**
- Stablecoin allowlist contents for USD anchoring (Task 6) — start with USDC/USDbC/DAI on Base.
- Whether `app/receipts/page.tsx` stays a server page with a client search island or becomes fully client (Task 9) — either satisfies the behavior; pick the smaller diff.
