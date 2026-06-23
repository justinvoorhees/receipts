# Smoke-Test Bespoke Normalization (ETL Orientation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a bespoke, normalization-first ETL that takes our *own* controlled swaps from the v1 "Aggregator Benchmark" smoke tests (known tx hash + known trader + known provider per row) and normalizes each one into the existing v2 dashboard cost framework (Accuracy, LP Fee, Agg Fee, Slippage, Gas, Variability), validated incrementally at 1 → 10 → 100 trades per aggregator with a dashboard review at each checkpoint.

**Architecture:** Classic ETL. **Extract** reads the v1 Supabase DB (read-only) and emits a candidate file of `{txHash, aggregator, trader, ...ground-truth}` rows from the most recent `smoke-%` experiment. **Transform/normalize** is bespoke per aggregator: a settlement-event *signature registry* identifies/confirms each aggregator's settlement contract event, then the trade is normalized to v2 fields by reusing the existing trace extractor + cost decomposer. **Load** writes idempotently into a new `smoke_trades` table that mirrors `router_trades_gated`'s columns (plus provenance). **Display** adds a Funnel/Smoke dataset toggle to the dashboard so the hard-earned funnel data stays viewable. The smoke set deliberately **bypasses** the $1k notional floor and ±100 bps gate (these are tiny $1–$2.50 trades; the point is to exercise the *process*, not produce clean cost numbers).

**Tech Stack:** TypeScript (strict), viem (Base mainnet), Drizzle ORM + Postgres (Supabase), Next.js (App Router) dashboard, vitest, `npx tsx` for ingest scripts.

## Global Constraints

- **Do not change the dashboard cost framework.** The columns Accuracy, LP Fee, Agg Fee, Slippage, Gas, Variability, Trades and the Trust Matrix stay exactly as they are. We add a dataset *source*, not new metrics.
- **Do not touch `router_trades`, `router_trades_gated`, or their `*_backup` tables.** All new work writes only to the new `smoke_trades` table. (Mirror the read-only discipline in `packages/ingest/src/reextract-gated.ts`.)
- **Accuracy basis = realized price vs market mid @ block N-1**, identical to the funnel: `allInCostBps = signedDeviationBps(direction, marketMid, realizedPrice)` where `marketMid = getReferencePrice({ rpcUrl, poolAddress: POOL_5BPS, blockNumber })`. The v1 quote/realized amounts are stored only as ground-truth cross-check columns, never as Accuracy.
- **Smoke set bypasses the floor and gate.** No `MIN_NOTIONAL` (1000) check, no `MAX_PLAUSIBLE_BPS` (±100) rejection. Keep every successfully-normalized row.
- **Known-trader normalization.** Unlike the funnel, the trader EOA is known from v1 data — pass it in; do not infer it via the selection gate.
- **Constants (copy verbatim):**
  - `USDC = 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`, `WETH = 0x4200000000000000000000000000000000000006` (import from `tradeEndpoints.ts`).
  - `POOL_5BPS = 0xd0b53D9277642d899DF5C87A3966A349A798F224` (deepest USDC/WETH 5bps pool; reference-mid source).
  - Gas: `gasCostEth = gasUsed * effectiveGasPrice / 1e18`; `gasCostUsd = gasCostEth * realizedPrice`.
- **Aggregator/provider universe (v1 `ALL_PROVIDERS`):** `fabric, kyberswap, 0x, nordstern, odos, relay, velora`. Router addresses are in `configs/routers.json`.
- **Run pattern for ingest scripts:** `set -a && source .env && set +a && npx tsx packages/ingest/src/<script>.ts`.
- **Two databases.** The decoder's own DB is `TCA_DATABASE_URL` (holds `smoke_trades`, `router_trades*`). The v1 benchmark DB is a *different* Supabase instance; its connection string lives in `/Users/justinvoorhees/withfabricxyz/fabric-tca/.worktrees/mvp-implementation/.env` as `TCA_DATABASE_URL`. Copy that value into the decoder's `.env` as **`V1_DATABASE_URL`** (read-only use). Never write to it.

---

## File Structure

**Create:**
- `packages/ingest/src/aggregatorSignatures.ts` — bespoke per-aggregator settlement-event signature registry + a discovery helper that lists the distinct events a tx's router/settlement contract emitted.
- `packages/ingest/src/aggregatorSignatures.test.ts` — unit tests for the discovery helper.
- `packages/ingest/src/extract-smoke-candidates.ts` — **Extract** stage: read v1 DB (latest `smoke-%` experiment) → `/tmp/smoke_candidates.json`.
- `packages/ingest/src/normalizeSmokeTrade.ts` — **Transform** stage: pure-ish `normalizeSmokeTrade(input)` → `SmokeTradeRow | { ok: false, reason }`, reusing the existing extractor + decomposer + reference price.
- `packages/ingest/src/normalizeSmokeTrade.test.ts` — unit tests for the normalizer (synthetic trace fixtures).
- `packages/ingest/src/load-smoke-trades.ts` — **Load** stage: orchestrate normalization over candidates (with `PER_AGG_LIMIT`) and idempotently insert into `smoke_trades`; print a per-aggregator success/failure report.
- `packages/dashboard/lib/datasets.ts` — `Dataset` type + table/identifier maps shared by queries and pages.
- `packages/dashboard/components/DatasetToggle.tsx` — client toggle that flips `?ds=funnel|smoke`.

**Modify:**
- `packages/db/src/schema.ts` — add the `smokeTrades` pgTable + inferred type export.
- `packages/db/drizzle/` — generated migration for `smoke_trades`.
- `packages/dashboard/lib/queries.ts` — add a `dataset` parameter to `getAggregatorSummary`, `getRecentTrades`, `getCostByAggregator`.
- `packages/dashboard/app/page.tsx` — read `?ds=`; pass to queries; render `DatasetToggle`.
- `packages/dashboard/app/trades/page.tsx` — read `?ds=`; pass to query; render `DatasetToggle`.

---

## Interfaces (cross-task contract)

```ts
// aggregatorSignatures.ts
export interface SettlementSignature {
  aggregator: string;            // lowercase provider slug, e.g. 'odos'
  settlementContract: string;    // lowercase router/settlement address (from configs/routers.json)
  eventTopic0: string | null;    // lowercase topic0 of the aggregator's distinctive event; null until discovered
  eventName: string | null;      // human label, e.g. 'Swap' / 'OrderFilled'; null until discovered
}
export const AGGREGATOR_SIGNATURES: Record<string, SettlementSignature>;
export interface EmittedEvent { address: string; topic0: string; count: number }
// Lists distinct non-Transfer/non-wrap events emitted BY the given contract address in a receipt.
export function findSettlementEvents(
  logs: readonly { address: string; topics: readonly string[] }[],
  settlementContract: string,
): EmittedEvent[];

// normalizeSmokeTrade.ts
export interface SmokeCandidate {
  txHash: `0x${string}`;
  aggregator: string;            // provider slug
  trader: `0x${string}`;         // known EOA from v1
  experimentSlug: string;
  runId: string;                 // v1 runs.id (uuid)
  v1Status: string;              // v1 execution_records.status
  v1QuoteAmountUsd: number | null;
  v1RealizedAmountUsd: number | null;
}
export interface SmokeTradeRow {
  txHash: string; aggregator: string; trader: string;
  direction: 'buy_weth' | 'sell_weth'; settledIn: 'WETH' | 'ETH';
  usdcAmount: number; wethAmount: number; realizedPrice: number;
  marketMid: number; allInCostBps: number; blockNumber: number;
  lpFeeBps: number | null; aggFeeBps: number; slippageBps: number | null;
  executionBps: number | null; gasCostUsd: number; routePure: boolean;
  experimentSlug: string; runId: string; v1Status: string;
  v1QuoteAmountUsd: number | null; v1RealizedAmountUsd: number | null;
  settlementEventName: string | null; settlementEventTopic0: string | null;
  settlementEventSeen: boolean; normalizeFlags: string[];
}
export type NormalizeResult =
  | { ok: true; row: SmokeTradeRow }
  | { ok: false; aggregator: string; txHash: string; reason: string };
export function normalizeSmokeTrade(args: {
  candidate: SmokeCandidate;
  rpcUrl: string;
}): Promise<NormalizeResult>;

// dashboard/lib/datasets.ts
export type Dataset = 'funnel' | 'smoke';
export const DEFAULT_DATASET: Dataset; // 'funnel'
export function parseDataset(v: string | undefined): Dataset;
```

---

### Task 1: `smoke_trades` schema + migration

**Files:**
- Modify: `packages/db/src/schema.ts` (append a new table after `routerTradesGated`, ~line 198)
- Generate: `packages/db/drizzle/*.sql` (via `drizzle-kit generate`)

**Interfaces:**
- Produces: `schema.smokeTrades`, `type SmokeTradeRow = typeof smokeTrades.$inferSelect` (DB row type; distinct from the normalizer's `SmokeTradeRow` interface — the normalizer builds plain numbers, the loader maps to DB string columns).

- [ ] **Step 1: Add the table to `schema.ts`**

Append after the `routerTradesGated` definition (keep the shared cost columns *named identically* to `router_trades_gated` so dashboard queries are uniform):

```ts
/**
 * Smoke-test validation set (ETL orientation). One row per controlled v1
 * "Aggregator Benchmark" swap, re-normalized into the v2 cost framework.
 * Mirrors router_trades_gated's cost columns so the dashboard reads it the
 * same way; adds v1 ground-truth + settlement-signature provenance.
 * Bypasses the notional floor and ±100bps gate by design.
 */
export const smokeTrades = pgTable('smoke_trades', {
	txHash: text('tx_hash').primaryKey(),
	aggregator: text('aggregator').notNull(),
	trader: text('trader').notNull(),
	direction: text('direction').notNull(),
	settledIn: text('settled_in').notNull(),
	usdcAmount: numeric('usdc_amount').notNull(),
	wethAmount: numeric('weth_amount').notNull(),
	realizedPrice: numeric('realized_price').notNull(),
	marketMid: numeric('market_mid').notNull(),
	allInCostBps: numeric('all_in_cost_bps').notNull(),
	blockNumber: integer('block_number').notNull(),
	// v2.1 decomposition (same columns as router_trades_gated)
	lpFeeBps: numeric('lp_fee_bps'),
	aggFeeBps: numeric('agg_fee_bps'),
	slippageBps: numeric('slippage_bps'),
	executionBps: numeric('execution_bps'),
	gasCostUsd: numeric('gas_cost_usd'),
	routePure: boolean('route_pure'),
	// provenance / ground-truth from v1
	experimentSlug: text('experiment_slug').notNull(),
	runId: text('run_id').notNull(),
	v1Status: text('v1_status').notNull(),
	v1QuoteAmountUsd: numeric('v1_quote_amount_usd'),
	v1RealizedAmountUsd: numeric('v1_realized_amount_usd'),
	// settlement-signature provenance
	settlementEventName: text('settlement_event_name'),
	settlementEventTopic0: text('settlement_event_topic0'),
	settlementEventSeen: boolean('settlement_event_seen').notNull().default(false),
	normalizeFlags: jsonb('normalize_flags'),
	loadedAt: timestamp('loaded_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
	byAggregator: index('smoke_trades_aggregator_idx').on(t.aggregator),
}));
```

Then add near the other type exports at the bottom:

```ts
export type SmokeTradeRow = typeof smokeTrades.$inferSelect;
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`
Expected: a new file under `packages/db/drizzle/` containing `CREATE TABLE "smoke_trades"` and `CREATE INDEX "smoke_trades_aggregator_idx"`.

- [ ] **Step 3: Apply the migration**

Run: `set -a && source .env && set +a && npm run db:migrate`
Expected: applies cleanly. Verify:
`set -a && source .env && set +a && npx tsx -e "import postgres from 'postgres'; const s=postgres(process.env.TCA_DATABASE_URL); console.log(await s\`select count(*) from smoke_trades\`); await s.end()"`
Expected: `[ { count: '0' } ]`.

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck`
Expected: passes.
```bash
git add packages/db/src/schema.ts packages/db/drizzle
git commit -m "feat(db): add smoke_trades table for ETL orientation set"
```

---

### Task 2 (EXTRACT): `extract-smoke-candidates.ts`

**Files:**
- Create: `packages/ingest/src/extract-smoke-candidates.ts`
- Setup: add `V1_DATABASE_URL` to `.env` (copy the value of `TCA_DATABASE_URL` from `/Users/justinvoorhees/withfabricxyz/fabric-tca/.worktrees/mvp-implementation/.env`).

**Interfaces:**
- Produces: `/tmp/smoke_candidates.json` — `SmokeCandidate[]` (see interfaces block).

- [ ] **Step 1: Add the v1 connection string to `.env`**

Append to `packages/.../.env` (repo root `.env`):
```
# v1 "Aggregator Benchmark" Supabase DB — READ ONLY (source of smoke-test txs)
V1_DATABASE_URL=<paste TCA_DATABASE_URL from fabric-tca/.worktrees/mvp-implementation/.env>
```
Also add the same key (with placeholder) to `.env.example`.

- [ ] **Step 2: Write the extractor**

```ts
/**
 * EXTRACT — pull controlled swaps from the v1 "Aggregator Benchmark" DB.
 *
 * Reads the most recent smoke-% experiment (or EXPERIMENT_SLUG override),
 * joins runs + execution_records, and emits one SmokeCandidate per execution
 * with a tx hash. READ ONLY against V1_DATABASE_URL. No writes.
 *
 * Output: /tmp/smoke_candidates.json
 * Run: set -a && source .env && set +a && npx tsx packages/ingest/src/extract-smoke-candidates.ts
 */
import { writeFileSync } from 'fs';
import postgres from 'postgres';

const OUT_PATH = process.env.OUT_PATH ?? '/tmp/smoke_candidates.json';

async function main(): Promise<void> {
	const url = process.env.V1_DATABASE_URL;
	if (!url) throw new Error('V1_DATABASE_URL not set');
	const sql = postgres(url, { prepare: false });

	// Pick the experiment: explicit override, else the most recent smoke-% run.
	const slugOverride = process.env.EXPERIMENT_SLUG;
	const exp = slugOverride
		? await sql`SELECT id, slug FROM experiments WHERE slug = ${slugOverride} LIMIT 1`
		: await sql`SELECT id, slug FROM experiments WHERE slug LIKE 'smoke-%' ORDER BY started_at DESC LIMIT 1`;
	if (exp.length === 0) throw new Error('no smoke experiment found');
	const { id: experimentId, slug: experimentSlug } = exp[0]!;

	// All executions for that experiment that actually landed a tx hash.
	const rows = await sql`
		SELECT er.run_id, er.provider, er.tx_hash, er.status,
		       er.quote_amount_usd, er.realized_amount_usd,
		       r.intent
		FROM execution_records er
		JOIN runs r ON r.id = er.run_id
		WHERE r.experiment_id = ${experimentId}
		  AND er.tx_hash IS NOT NULL
		ORDER BY er.provider, er.submitted_at`;

	// The trader EOA is the signer; in v1 the intent records the sender.
	// `intent.account` / `intent.from` holds it (string). Fall back to env.
	const candidates = rows.map((r: Record<string, unknown>) => {
		const intent = (r.intent ?? {}) as Record<string, unknown>;
		const trader = String(
			intent.account ?? intent.from ?? intent.signer ?? process.env.SMOKE_TRADER ?? '',
		).toLowerCase();
		return {
			txHash: String(r.tx_hash).toLowerCase(),
			aggregator: String(r.provider).toLowerCase(),
			trader,
			experimentSlug,
			runId: String(r.run_id),
			v1Status: String(r.status),
			v1QuoteAmountUsd: r.quote_amount_usd == null ? null : Number(r.quote_amount_usd),
			v1RealizedAmountUsd: r.realized_amount_usd == null ? null : Number(r.realized_amount_usd),
		};
	});

	writeFileSync(OUT_PATH, JSON.stringify(candidates, null, 2));

	// Orientation report: provider × status breakdown.
	const byKey = new Map<string, number>();
	for (const c of candidates) {
		const k = `${c.aggregator}\t${c.v1Status}`;
		byKey.set(k, (byKey.get(k) ?? 0) + 1);
	}
	console.log(`Experiment: ${experimentSlug} (${candidates.length} executions with tx hashes)`);
	console.log('provider\tstatus\tcount');
	for (const [k, n] of [...byKey.entries()].sort()) console.log(`${k}\t${n}`);
	const missingTrader = candidates.filter((c) => !c.trader).length;
	if (missingTrader > 0) console.log(`WARN: ${missingTrader} rows missing trader — set SMOKE_TRADER env to the benchmark EOA.`);
	console.log(`Wrote ${OUT_PATH}`);
	await sql.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
```

- [ ] **Step 3: Run the extractor (CHECKPOINT — orientation)**

Run: `set -a && source .env && set +a && npx tsx packages/ingest/src/extract-smoke-candidates.ts`
Expected: prints the chosen `smoke-N` experiment and a provider×status table; writes `/tmp/smoke_candidates.json`.
**Review:** confirm the experiment is the intended "last smoke test", that the 7 providers appear, and that `status='success'` rows exist for each major aggregator. If `trader` is blank, inspect one v1 `runs.intent` JSON shape and either fix the field path or set `SMOKE_TRADER` and re-run.
**STOP and report the table to the user before proceeding.**

- [ ] **Step 4: Commit**

```bash
git add packages/ingest/src/extract-smoke-candidates.ts .env.example
git commit -m "feat(ingest): extract smoke-test candidates from v1 benchmark DB"
```

---

### Task 3 (TRANSFORM — signatures): `aggregatorSignatures.ts`

**Files:**
- Create: `packages/ingest/src/aggregatorSignatures.ts`
- Test: `packages/ingest/src/aggregatorSignatures.test.ts`

**Interfaces:**
- Consumes: router addresses from `configs/routers.json` (hardcode the lowercase map below — they are stable, already verified).
- Produces: `AGGREGATOR_SIGNATURES`, `findSettlementEvents(logs, settlementContract)` (see interfaces block).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { findSettlementEvents, AGGREGATOR_SIGNATURES } from './aggregatorSignatures.js';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ROUTER = '0x19ceead7105607cd444f5ad10dd51356436095a1'; // odos v2

describe('findSettlementEvents', () => {
	it('returns distinct non-Transfer events emitted by the settlement contract only', () => {
		const logs = [
			{ address: ROUTER, topics: [TRANSFER_TOPIC] },              // excluded: Transfer
			{ address: ROUTER, topics: ['0xaaa'] },                      // kept
			{ address: ROUTER, topics: ['0xaaa'] },                      // same -> count 2
			{ address: '0xpool', topics: ['0xbbb'] },                    // excluded: not the contract
		];
		const out = findSettlementEvents(logs, ROUTER);
		expect(out).toEqual([{ address: ROUTER, topic0: '0xaaa', count: 2 }]);
	});

	it('is case-insensitive on the contract address', () => {
		const logs = [{ address: ROUTER.toUpperCase(), topics: ['0xccc'] }];
		expect(findSettlementEvents(logs, ROUTER)).toEqual([
			{ address: ROUTER, topic0: '0xccc', count: 1 },
		]);
	});

	it('has a signature entry per v1 provider', () => {
		for (const slug of ['fabric', 'kyberswap', '0x', 'nordstern', 'odos', 'relay', 'velora']) {
			expect(AGGREGATOR_SIGNATURES[slug]).toBeTruthy();
			expect(AGGREGATOR_SIGNATURES[slug]!.settlementContract).toMatch(/^0x[0-9a-f]{40}$/);
		}
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ingest/src/aggregatorSignatures.test.ts`
Expected: FAIL — `Cannot find module './aggregatorSignatures.js'`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Bespoke per-aggregator settlement-event signature registry.
 *
 * The founding-engineer process: for each aggregator, find the unique event
 * its settlement contract emits. That signature (a) confirms a tx really
 * routed through that aggregator and (b) is the seed for future automated
 * discovery. `eventTopic0`/`eventName` start null and are filled in as we
 * inspect the first sample tx per aggregator (Checkpoint A).
 */
const WETH = '0x4200000000000000000000000000000000000006';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEPOSIT_TOPIC = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c';
const WITHDRAWAL_TOPIC = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
const NOISE_TOPICS = new Set([TRANSFER_TOPIC, DEPOSIT_TOPIC, WITHDRAWAL_TOPIC]);

export interface SettlementSignature {
	aggregator: string;
	settlementContract: string;
	eventTopic0: string | null;
	eventName: string | null;
}

// Router/settlement addresses (lowercase) from configs/routers.json.
export const AGGREGATOR_SIGNATURES: Record<string, SettlementSignature> = {
	odos:      { aggregator: 'odos',      settlementContract: '0x19ceead7105607cd444f5ad10dd51356436095a1', eventTopic0: null, eventName: null },
	'0x':      { aggregator: '0x',        settlementContract: '0xdef1c0ded9bec7f1a1670819833240f027b25eff', eventTopic0: null, eventName: null },
	kyberswap: { aggregator: 'kyberswap', settlementContract: '0x6131b5fae19ea4f9d964eac0408e4408b66337b5', eventTopic0: null, eventName: null },
	'1inch':   { aggregator: '1inch',     settlementContract: '0x111111125421ca6dc452d289314280a0f8842a65', eventTopic0: null, eventName: null },
	velora:    { aggregator: 'velora',    settlementContract: '0x6a000f20005980200259b80c5102003040001068', eventTopic0: null, eventName: null },
	fabric:    { aggregator: 'fabric',    settlementContract: '0x7c137a37742437d2212b7bd873ed135b5c4c61da', eventTopic0: null, eventName: null },
	nordstern: { aggregator: 'nordstern', settlementContract: '0xc87de04e2ec1f4282dff2933a2d58199f688fc3d', eventTopic0: null, eventName: null },
	relay:     { aggregator: 'relay',     settlementContract: '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be', eventTopic0: null, eventName: null },
};

export interface EmittedEvent { address: string; topic0: string; count: number }

/**
 * Distinct non-Transfer/non-wrap events emitted BY `settlementContract` in a
 * tx's logs, with counts. This is the inspection tool used to discover each
 * aggregator's unique settlement event.
 */
export function findSettlementEvents(
	logs: readonly { address: string; topics: readonly string[] }[],
	settlementContract: string,
): EmittedEvent[] {
	const target = settlementContract.toLowerCase();
	const counts = new Map<string, number>();
	for (const l of logs) {
		if (l.address.toLowerCase() !== target) continue;
		const topic0 = l.topics[0]?.toLowerCase();
		if (!topic0 || NOISE_TOPICS.has(topic0)) continue;
		counts.set(topic0, (counts.get(topic0) ?? 0) + 1);
	}
	return [...counts.entries()].map(([topic0, count]) => ({ address: target, topic0, count }));
}

// (WETH constant exported for reuse by callers that filter wrap noise.)
export { WETH };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ingest/src/aggregatorSignatures.test.ts`
Expected: PASS (3 tests). Note: the `1inch` slug exists in the registry but is not in `ALL_PROVIDERS`; that is intentional headroom and does not break the per-provider test.

- [ ] **Step 5: Commit**

```bash
git add packages/ingest/src/aggregatorSignatures.ts packages/ingest/src/aggregatorSignatures.test.ts
git commit -m "feat(ingest): aggregator settlement-event signature registry + discovery helper"
```

---

### Task 4 (TRANSFORM — normalizer): `normalizeSmokeTrade.ts`

**Files:**
- Create: `packages/ingest/src/normalizeSmokeTrade.ts`
- Test: `packages/ingest/src/normalizeSmokeTrade.test.ts`

**Interfaces:**
- Consumes: `extractTradeEndpoints` is *not* used (we know the trader); instead reuse `decodeTransferLogs`, `collectNativeEthDeltas`, `USDC`, `WETH` from `tradeEndpoints.js`; `decomposeTrade` from `decompose-trade.js`; `getReferencePrice` + `POOL_5BPS`; `signedDeviationBps`; `findSettlementEvents` + `AGGREGATOR_SIGNATURES`.
- Produces: `normalizeSmokeTrade(args)` → `NormalizeResult` (see interfaces block).

The normalizer factors out a **pure** core `buildSmokeRow(...)` (no I/O — takes trace + receipt-ish + marketMid) so it is unit-testable without RPC, plus the async `normalizeSmokeTrade` wrapper that does the RPC fetches.

- [ ] **Step 1: Write the failing test (pure core)**

```ts
import { describe, expect, it } from 'vitest';
import { buildSmokeRow } from './normalizeSmokeTrade.js';

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const trader = '0x000000000000000000000000000000000000d00d';
const pad = (a: string) => '0x' + a.slice(2).padStart(64, '0');
const hex = (n: bigint) => '0x' + n.toString(16);

// Synthetic trace: trader sends 2.00 USDC, receives 0.001 WETH (buy_weth).
const trace = {
	logs: [
		{ address: USDC, topics: [TRANSFER, pad(trader), pad('0xpool')], data: hex(2_000_000n) },
		{ address: WETH, topics: [TRANSFER, pad('0xpool'), pad(trader)], data: hex(1_000_000_000_000_000n) },
	],
	calls: [],
};

describe('buildSmokeRow', () => {
	it('normalizes a known-trader buy_weth into v2 fields with Accuracy vs market mid', () => {
		const r = buildSmokeRow({
			candidate: {
				txHash: '0xabc', aggregator: 'odos', trader,
				experimentSlug: 'smoke-9', runId: 'run-1', v1Status: 'success',
				v1QuoteAmountUsd: 2, v1RealizedAmountUsd: 1.99,
			},
			trace,
			receiptLogs: trace.logs,
			gasUsed: 200000n,
			effectiveGasPriceWei: 50000000n, // 0.05 gwei
			marketMid: 2100, // USDC per WETH
			blockNumber: 12345,
			// decomposition is exercised in the async path; here pass a stub
			decomposition: { lpFeeBps: 5, aggFeeBps: 0, slippageBps: 1, executionBps: 6, gasBps: 0, hops: [], feeSinks: [], flags: [] },
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.row.direction).toBe('buy_weth');
		expect(r.row.usdcAmount).toBeCloseTo(2.0, 6);
		expect(r.row.wethAmount).toBeCloseTo(0.001, 9);
		expect(r.row.realizedPrice).toBeCloseTo(2000, 6);
		// buy_weth, realized 2000 vs mid 2100 -> negative cost (got it cheaper)
		expect(r.row.allInCostBps).toBeLessThan(0);
		expect(r.row.settledIn).toBe('WETH');
		expect(r.row.gasCostUsd).toBeGreaterThan(0);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ingest/src/normalizeSmokeTrade.test.ts`
Expected: FAIL — module/function not found.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * TRANSFORM — normalize one controlled v1 swap into the v2 cost framework.
 *
 * Known-trader path: we already know the trader EOA (from v1), so we skip the
 * selection gate and the floor/±100 gate entirely. We compute the trader's net
 * USDC + WETH/ETH deltas, derive direction/realizedPrice, look up market mid,
 * run the standard decomposition, and confirm the aggregator's settlement event.
 */
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import {
	USDC, WETH, decodeTransferLogs, collectNativeEthDeltas,
	type Direction,
} from './tradeEndpoints.js';
import { decomposeTrade, type DecomposeResult } from './decompose-trade.js';
import { getReferencePrice } from './referencePrice.js';
import { signedDeviationBps } from './priceMath.js';
import { AGGREGATOR_SIGNATURES, findSettlementEvents } from './aggregatorSignatures.js';

const POOL_5BPS = '0xd0b53D9277642d899DF5C87A3966A349A798F224' as `0x${string}`;
const WETH_DUST_RAW = 10_000_000_000n;

export interface SmokeCandidate {
	txHash: `0x${string}`; aggregator: string; trader: `0x${string}`;
	experimentSlug: string; runId: string; v1Status: string;
	v1QuoteAmountUsd: number | null; v1RealizedAmountUsd: number | null;
}
export interface SmokeTradeRow {
	txHash: string; aggregator: string; trader: string;
	direction: Direction; settledIn: 'WETH' | 'ETH';
	usdcAmount: number; wethAmount: number; realizedPrice: number;
	marketMid: number; allInCostBps: number; blockNumber: number;
	lpFeeBps: number | null; aggFeeBps: number; slippageBps: number | null;
	executionBps: number | null; gasCostUsd: number; routePure: boolean;
	experimentSlug: string; runId: string; v1Status: string;
	v1QuoteAmountUsd: number | null; v1RealizedAmountUsd: number | null;
	settlementEventName: string | null; settlementEventTopic0: string | null;
	settlementEventSeen: boolean; normalizeFlags: string[];
}
export type NormalizeResult =
	| { ok: true; row: SmokeTradeRow }
	| { ok: false; aggregator: string; txHash: string; reason: string };

interface TraceNode {
	from?: string; to?: string; value?: string;
	logs?: { address: string; data: string; topics: readonly string[] }[];
	calls?: TraceNode[];
}
const absBI = (n: bigint) => (n < 0n ? -n : n);

function collectTraceLogs(trace: TraceNode): { address: string; data: string; topics: readonly string[] }[] {
	const out: { address: string; data: string; topics: readonly string[] }[] = [];
	const visit = (n: TraceNode) => { if (n.logs) out.push(...n.logs); n.calls?.forEach(visit); };
	visit(trace);
	return out;
}

/** Pure core: build a row from already-fetched trace + decomposition + mid. */
export function buildSmokeRow(args: {
	candidate: SmokeCandidate;
	trace: TraceNode;
	receiptLogs: { address: string; data: string; topics: readonly string[] }[];
	gasUsed: bigint;
	effectiveGasPriceWei: bigint;
	marketMid: number;
	blockNumber: number;
	decomposition: DecomposeResult;
}): NormalizeResult {
	const { candidate: c } = args;
	const trader = c.trader.toLowerCase();
	const transfers = decodeTransferLogs(collectTraceLogs(args.trace) as never);
	const nativeEth = collectNativeEthDeltas(args.trace as never);

	let usdcNet = 0n, wethErc20Net = 0n;
	for (const t of transfers) {
		const token = t.token.toLowerCase();
		if (t.from.toLowerCase() === trader) {
			if (token === USDC) usdcNet -= t.value; else if (token === WETH) wethErc20Net -= t.value;
		}
		if (t.to.toLowerCase() === trader) {
			if (token === USDC) usdcNet += t.value; else if (token === WETH) wethErc20Net += t.value;
		}
	}
	const ethNet = nativeEth.get(trader) ?? 0n;
	const wethEquivNet = wethErc20Net + ethNet;

	if (usdcNet === 0n || wethEquivNet === 0n) {
		return { ok: false, aggregator: c.aggregator, txHash: c.txHash, reason: 'no_usdc_weth_delta_for_trader' };
	}
	const settledIn: 'WETH' | 'ETH' = absBI(wethErc20Net) > WETH_DUST_RAW ? 'WETH' : 'ETH';
	const direction: Direction = usdcNet < 0n && wethEquivNet > 0n ? 'buy_weth' : 'sell_weth';
	const usdcAmount = Math.abs(Number(usdcNet)) / 1e6;
	const wethAmount = Math.abs(Number(wethEquivNet)) / 1e18;
	const realizedPrice = usdcAmount / wethAmount;
	const allInCostBps = signedDeviationBps(direction, args.marketMid, realizedPrice);

	const gasCostEth = (Number(args.gasUsed) * Number(args.effectiveGasPriceWei)) / 1e18;
	const gasCostUsd = gasCostEth * realizedPrice;

	const sig = AGGREGATOR_SIGNATURES[c.aggregator];
	let settlementEventSeen = false;
	if (sig) {
		const events = findSettlementEvents(args.receiptLogs, sig.settlementContract);
		settlementEventSeen = sig.eventTopic0
			? events.some((e) => e.topic0 === sig.eventTopic0)
			: events.length > 0;
	}

	const d = args.decomposition;
	const flags = [...d.flags];
	if (!sig) flags.push(`NO_SIGNATURE: unknown aggregator '${c.aggregator}'`);
	if (sig && !settlementEventSeen) flags.push(`SETTLEMENT_EVENT_MISSING: no distinctive event from ${sig.settlementContract}`);

	return {
		ok: true,
		row: {
			txHash: c.txHash.toLowerCase(), aggregator: c.aggregator, trader,
			direction, settledIn, usdcAmount, wethAmount, realizedPrice,
			marketMid: args.marketMid, allInCostBps, blockNumber: args.blockNumber,
			lpFeeBps: d.lpFeeBps, aggFeeBps: d.aggFeeBps, slippageBps: d.slippageBps,
			executionBps: d.executionBps, gasCostUsd, routePure: d.slippageBps !== null,
			experimentSlug: c.experimentSlug, runId: c.runId, v1Status: c.v1Status,
			v1QuoteAmountUsd: c.v1QuoteAmountUsd, v1RealizedAmountUsd: c.v1RealizedAmountUsd,
			settlementEventName: sig?.eventName ?? null,
			settlementEventTopic0: sig?.eventTopic0 ?? null,
			settlementEventSeen, normalizeFlags: flags,
		},
	};
}

/** Async wrapper: fetch receipt + trace + market mid, run decomposition, build row. */
export async function normalizeSmokeTrade(args: { candidate: SmokeCandidate; rpcUrl: string }): Promise<NormalizeResult> {
	const { candidate: c, rpcUrl } = args;
	try {
		const rpc = createPublicClient({ chain: base, transport: http(rpcUrl) });
		const [receipt, rawTrace] = await Promise.all([
			rpc.getTransactionReceipt({ hash: c.txHash }),
			(rpc.request as unknown as (r: { method: string; params: unknown[] }) => Promise<unknown>)({
				method: 'debug_traceTransaction',
				params: [c.txHash, { tracer: 'callTracer', tracerConfig: { withLog: true, onlyTopCall: false } }],
			}),
		]);
		const trace = rawTrace as TraceNode;
		const blockNumber = Number(receipt.blockNumber);
		const receiptLogs = receipt.logs.map((l) => ({ address: l.address, data: l.data, topics: l.topics }));

		const marketMid = await getReferencePrice({ rpcUrl, poolAddress: POOL_5BPS, blockNumber: receipt.blockNumber });

		// Derive trader deltas first to feed decomposeTrade's required inputs.
		const probe = buildSmokeRow({
			candidate: c, trace, receiptLogs,
			gasUsed: receipt.gasUsed, effectiveGasPriceWei: receipt.effectiveGasPrice,
			marketMid, blockNumber,
			decomposition: { lpFeeBps: null, aggFeeBps: 0, slippageBps: null, executionBps: null, gasBps: 0, hops: [], feeSinks: [], flags: [] },
		});
		if (!probe.ok) return probe;

		const decomposition = await decomposeTrade({
			trace: trace as never,
			txHash: c.txHash,
			trader: probe.row.trader,
			direction: probe.row.direction,
			settledIn: probe.row.settledIn,
			allInCostBps: probe.row.allInCostBps,
			notionalUsdc: probe.row.usdcAmount,
			realizedPrice: probe.row.realizedPrice,
			gasCostUsd: probe.row.gasCostUsd,
			aggregator: capitalizeAgg(c.aggregator),
			blockNumber: receipt.blockNumber,
			rpcUrl,
		});

		return buildSmokeRow({
			candidate: c, trace, receiptLogs,
			gasUsed: receipt.gasUsed, effectiveGasPriceWei: receipt.effectiveGasPrice,
			marketMid, blockNumber, decomposition,
		});
	} catch (e) {
		return { ok: false, aggregator: c.aggregator, txHash: c.txHash, reason: e instanceof Error ? e.message : String(e) };
	}
}

// decompose-trade.ts keys its vault map by Capitalized names ('Odos','Velora','Relay').
function capitalizeAgg(slug: string): string {
	const map: Record<string, string> = { odos: 'Odos', velora: 'Velora', relay: 'Relay', kyberswap: 'KyberSwap', fabric: 'Fabric', nordstern: 'Nordstern', '0x': '0x', '1inch': '1inch' };
	return map[slug] ?? slug;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/ingest/src/normalizeSmokeTrade.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: passes.
```bash
git add packages/ingest/src/normalizeSmokeTrade.ts packages/ingest/src/normalizeSmokeTrade.test.ts
git commit -m "feat(ingest): normalize smoke trades into v2 cost framework (known-trader path)"
```

---

### Task 5 (LOAD): `load-smoke-trades.ts`

**Files:**
- Create: `packages/ingest/src/load-smoke-trades.ts`

**Interfaces:**
- Consumes: `/tmp/smoke_candidates.json` (`SmokeCandidate[]`), `normalizeSmokeTrade`.
- Produces: rows in `smoke_trades`; a per-aggregator success/failure report on stdout.

- [ ] **Step 1: Write the loader**

```ts
/**
 * LOAD — normalize candidates and upsert into smoke_trades.
 *
 * PER_AGG_LIMIT caps how many candidates per aggregator we attempt (the 1→10→100
 * checkpoints). ONLY_SUCCESS=1 (default) restricts to v1 status='success'.
 * Idempotent on tx_hash. Writes ONLY to smoke_trades.
 *
 * Run: set -a && source .env && set +a && PER_AGG_LIMIT=1 npx tsx packages/ingest/src/load-smoke-trades.ts
 */
import { readFileSync } from 'fs';
import postgres from 'postgres';
import { schema } from '@fabric-tca/db';
import { drizzle } from 'drizzle-orm/postgres-js';
import { normalizeSmokeTrade, type SmokeCandidate } from './normalizeSmokeTrade.js';

const IN_PATH = process.env.IN_PATH ?? '/tmp/smoke_candidates.json';
const PER_AGG_LIMIT = Number(process.env.PER_AGG_LIMIT ?? '1');
const ONLY_SUCCESS = process.env.ONLY_SUCCESS !== '0';

async function main(): Promise<void> {
	const rpcUrl = process.env.TCA_RPC_URL;
	const dbUrl = process.env.TCA_DATABASE_URL;
	if (!rpcUrl) throw new Error('TCA_RPC_URL not set');
	if (!dbUrl) throw new Error('TCA_DATABASE_URL not set');

	const all = JSON.parse(readFileSync(IN_PATH, 'utf8')) as SmokeCandidate[];
	const eligible = all.filter((c) => c.trader && (!ONLY_SUCCESS || c.v1Status === 'success'));

	// Take up to PER_AGG_LIMIT per aggregator.
	const perAgg = new Map<string, SmokeCandidate[]>();
	for (const c of eligible) {
		const list = perAgg.get(c.aggregator) ?? [];
		if (list.length < PER_AGG_LIMIT) { list.push(c); perAgg.set(c.aggregator, list); }
	}
	const chosen = [...perAgg.values()].flat();
	console.log(`Attempting ${chosen.length} candidates (≤${PER_AGG_LIMIT}/agg, only_success=${ONLY_SUCCESS}).`);

	const client = postgres(dbUrl, { prepare: false });
	const db = drizzle(client, { schema });

	const report: Record<string, { ok: number; fail: number; reasons: string[] }> = {};
	for (const c of chosen) {
		const r = await normalizeSmokeTrade({ candidate: c, rpcUrl });
		report[c.aggregator] ??= { ok: 0, fail: 0, reasons: [] };
		if (!r.ok) { report[c.aggregator]!.fail++; report[c.aggregator]!.reasons.push(`${c.txHash.slice(0, 10)}: ${r.reason}`); continue; }
		const row = r.row;
		await db.insert(schema.smokeTrades).values({
			txHash: row.txHash, aggregator: row.aggregator, trader: row.trader,
			direction: row.direction, settledIn: row.settledIn,
			usdcAmount: String(row.usdcAmount), wethAmount: String(row.wethAmount),
			realizedPrice: String(row.realizedPrice), marketMid: String(row.marketMid),
			allInCostBps: String(row.allInCostBps), blockNumber: row.blockNumber,
			lpFeeBps: row.lpFeeBps == null ? null : String(row.lpFeeBps),
			aggFeeBps: String(row.aggFeeBps),
			slippageBps: row.slippageBps == null ? null : String(row.slippageBps),
			executionBps: row.executionBps == null ? null : String(row.executionBps),
			gasCostUsd: String(row.gasCostUsd), routePure: row.routePure,
			experimentSlug: row.experimentSlug, runId: row.runId, v1Status: row.v1Status,
			v1QuoteAmountUsd: row.v1QuoteAmountUsd == null ? null : String(row.v1QuoteAmountUsd),
			v1RealizedAmountUsd: row.v1RealizedAmountUsd == null ? null : String(row.v1RealizedAmountUsd),
			settlementEventName: row.settlementEventName, settlementEventTopic0: row.settlementEventTopic0,
			settlementEventSeen: row.settlementEventSeen, normalizeFlags: row.normalizeFlags,
		}).onConflictDoUpdate({
			target: schema.smokeTrades.txHash,
			set: {
				allInCostBps: String(row.allInCostBps), lpFeeBps: row.lpFeeBps == null ? null : String(row.lpFeeBps),
				aggFeeBps: String(row.aggFeeBps), slippageBps: row.slippageBps == null ? null : String(row.slippageBps),
				executionBps: row.executionBps == null ? null : String(row.executionBps), gasCostUsd: String(row.gasCostUsd),
				settlementEventSeen: row.settlementEventSeen, normalizeFlags: row.normalizeFlags,
			},
		});
		report[c.aggregator]!.ok++;
	}

	console.log('\n=== LOAD REPORT (per aggregator) ===');
	for (const [agg, s] of Object.entries(report).sort()) {
		console.log(`${agg}: ok=${s.ok} fail=${s.fail}${s.reasons.length ? ' | ' + s.reasons.join('; ') : ''}`);
	}
	const total = await client`SELECT COUNT(*) AS n FROM smoke_trades`;
	console.log(`\nsmoke_trades now holds ${total[0]!.n} rows.`);
	await client.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add packages/ingest/src/load-smoke-trades.ts
git commit -m "feat(ingest): load/normalize smoke trades with per-aggregator limit + report"
```

---

### Task 6 (DISPLAY): dashboard dataset toggle + parameterized queries

**Files:**
- Create: `packages/dashboard/lib/datasets.ts`
- Create: `packages/dashboard/components/DatasetToggle.tsx`
- Modify: `packages/dashboard/lib/queries.ts`
- Modify: `packages/dashboard/app/page.tsx`, `packages/dashboard/app/trades/page.tsx`

**Interfaces:**
- Produces: `Dataset`, `parseDataset`, `DEFAULT_DATASET`; `getAggregatorSummary(dataset)`, `getRecentTrades(sort, limit, dataset)`, `getCostByAggregator(dataset)`.

- [ ] **Step 1: Create `datasets.ts`**

```ts
import { schema } from '@fabric-tca/db';

export type Dataset = 'funnel' | 'smoke';
export const DEFAULT_DATASET: Dataset = 'funnel';

export function parseDataset(v: string | undefined): Dataset {
	return v === 'smoke' ? 'smoke' : 'funnel';
}

/** Drizzle table object per dataset (typed selects). */
export const DATASET_TABLE = {
	funnel: schema.routerTradesGated,
	smoke: schema.smokeTrades,
} as const;

/** Physical table name per dataset (raw-SQL aggregate). Whitelisted — never user input. */
export const DATASET_TABLE_NAME: Record<Dataset, string> = {
	funnel: 'router_trades_gated',
	smoke: 'smoke_trades',
};
```

- [ ] **Step 2: Parameterize `queries.ts`**

Edit the three exported query functions. For `getAggregatorSummary`, inject the table name via `sql.raw` from the whitelist:

```ts
import { asc, desc, sql } from 'drizzle-orm';
import { schema } from '@fabric-tca/db';
import { getDb } from './db';
import { DEFAULT_DATASET, DATASET_TABLE, DATASET_TABLE_NAME, type Dataset } from './datasets';
// ...
export async function getAggregatorSummary(dataset: Dataset = DEFAULT_DATASET): Promise<AggregatorSummaryRow[]> {
	const db = getDb();
	const table = sql.raw(DATASET_TABLE_NAME[dataset]);
	const rows = await db.execute<{ /* ...same shape... */ }>(sql`
		SELECT
			aggregator,
			COUNT(*) AS trade_count,
			percentile_cont(0.5) WITHIN GROUP (ORDER BY all_in_cost_bps::numeric) AS median_cost_bps,
			STDDEV_POP(all_in_cost_bps::numeric) AS stdev_cost_bps,
			percentile_cont(0.5) WITHIN GROUP (ORDER BY lp_fee_bps::numeric) AS median_lp_fee_bps,
			percentile_cont(0.5) WITHIN GROUP (ORDER BY agg_fee_bps::numeric) AS median_agg_fee_bps,
			percentile_cont(0.5) WITHIN GROUP (ORDER BY slippage_bps::numeric) AS median_slippage_bps,
			percentile_cont(0.5) WITHIN GROUP (ORDER BY gas_cost_usd::numeric) AS median_gas_usd,
			SUM((settled_in = 'WETH')::int) AS weth_count,
			SUM((settled_in = 'ETH')::int) AS eth_count
		FROM ${table}
		GROUP BY aggregator
		ORDER BY trade_count DESC
	`);
	// ...unchanged mapping...
}

export async function getRecentTrades(
	sort: TradesSort = { column: 'block', direction: 'desc' },
	limit = 500,
	dataset: Dataset = DEFAULT_DATASET,
): Promise<RouterTradeRow[]> {
	const db = getDb();
	const table = DATASET_TABLE[dataset];
	const column = (table as typeof schema.routerTradesGated)[TRADES_SORT_COLUMN_KEYS[sort.column]];
	const orderFn = sort.direction === 'asc' ? asc : desc;
	return db.select().from(table).orderBy(orderFn(column)).limit(limit) as Promise<RouterTradeRow[]>;
}

export async function getCostByAggregator(dataset: Dataset = DEFAULT_DATASET): Promise<{ aggregator: string; costBps: number }[]> {
	const db = getDb();
	const table = DATASET_TABLE[dataset];
	const rows = await db.select({ aggregator: table.aggregator, allInCostBps: table.allInCostBps }).from(table);
	return rows.map((r) => ({ aggregator: r.aggregator, costBps: Number(r.allInCostBps) }));
}
```

Replace the existing `TRADES_SORT_COLUMNS` (which bound to `routerTradesGated` columns) with a key map that works against either table, since both tables share these column names:

```ts
export const TRADES_SORT_COLUMN_KEYS = {
	block: 'blockNumber', aggregator: 'aggregator', side: 'direction',
	size: 'usdcAmount', accuracy: 'allInCostBps', lpFee: 'lpFeeBps',
	aggFee: 'aggFeeBps', slippage: 'slippageBps', gas: 'gasCostUsd',
} as const;
export type TradesSortColumn = keyof typeof TRADES_SORT_COLUMN_KEYS;
// Keep TRADES_SORT_COLUMNS as an alias for the trades page's VALID_SORT_COLUMNS check:
export const TRADES_SORT_COLUMNS = TRADES_SORT_COLUMN_KEYS;
```

(Note: `smoke_trades` is a structural superset of the columns `TradesTable` reads, so the `as RouterTradeRow[]` cast is safe.)

- [ ] **Step 3: Create `DatasetToggle.tsx`**

```tsx
'use client';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import type { Dataset } from '../lib/datasets';

const OPTIONS: { value: Dataset; label: string }[] = [
	{ value: 'funnel', label: 'Funnel' },
	{ value: 'smoke', label: 'Smoke test' },
];

export function DatasetToggle({ dataset }: { dataset: Dataset }) {
	const router = useRouter();
	const pathname = usePathname() ?? '/';
	const params = useSearchParams();
	const [pending, startTransition] = useTransition();

	const select = (value: Dataset) => {
		const next = new URLSearchParams(params?.toString() ?? '');
		if (value === 'funnel') next.delete('ds'); else next.set('ds', value);
		const qs = next.toString();
		startTransition(() => router.push((qs ? `${pathname}?${qs}` : pathname) as never));
	};

	return (
		<div className={`flex gap-[16px] font-['Sohne_Mono'] text-[12px] uppercase ${pending ? 'opacity-60' : ''}`}>
			{OPTIONS.map((o) => (
				<button
					key={o.value}
					type="button"
					onClick={() => select(o.value)}
					className={`underline decoration-dotted underline-offset-[2px] cursor-pointer ${dataset === o.value ? 'text-[var(--color-primary)]' : 'text-[var(--color-secondary)]'}`}
				>
					{o.label}
				</button>
			))}
		</div>
	);
}
```

- [ ] **Step 4: Wire `app/page.tsx`**

Make it read `searchParams` and pass the dataset:

```tsx
import { DatasetToggle } from '../components/DatasetToggle';
import { parseDataset } from '../lib/datasets';
// ...
export default async function DashboardIndex({ searchParams }: { searchParams: Promise<{ ds?: string }> }) {
	const dataset = parseDataset((await searchParams).ds);
	const [costSamples, summary] = await Promise.all([
		getCostByAggregator(dataset),
		getAggregatorSummary(dataset),
	]);
	// ...existing points/totals...
	// In the header row, render <DatasetToggle dataset={dataset} /> next to the counts.
}
```

- [ ] **Step 5: Wire `app/trades/page.tsx`**

```tsx
import { DatasetToggle } from '../../components/DatasetToggle';
import { parseDataset } from '../../lib/datasets';
// ...
export default async function TradesPage({ searchParams }: { searchParams: Promise<{ sort?: string; dir?: string; ds?: string }> }) {
	const sp = await searchParams;
	const sort = parseSort(sp);
	const dataset = parseDataset(sp.ds);
	const rows = await getRecentTrades(sort, 500, dataset);
	// render <DatasetToggle dataset={dataset} /> in the header row.
}
```

- [ ] **Step 6: Typecheck + build the dashboard**

Run: `npm run typecheck`
Expected: passes.
Run: `npm --workspace packages/dashboard run build`
Expected: builds without type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/dashboard/lib/datasets.ts packages/dashboard/components/DatasetToggle.tsx packages/dashboard/lib/queries.ts packages/dashboard/app/page.tsx packages/dashboard/app/trades/page.tsx
git commit -m "feat(dashboard): Funnel/Smoke dataset toggle; parameterize queries by dataset"
```

---

### Checkpoint A — 1 trade per aggregator (REVIEW GATE)

- [ ] **Step 1: Load one per aggregator**

Run: `set -a && source .env && set +a && PER_AGG_LIMIT=1 npx tsx packages/ingest/src/load-smoke-trades.ts`
Expected: a per-aggregator report; ideally `ok=1` for each provider that had a successful smoke tx. `smoke_trades` holds ~7 rows.

- [ ] **Step 2: Discover + record each settlement signature**

For each aggregator's loaded tx, inspect what its settlement contract emitted and fill in `AGGREGATOR_SIGNATURES[...].eventTopic0` / `eventName`:

Run (repeat per tx hash):
```
set -a && source .env && set +a && npx tsx -e "
import { createPublicClient, http } from 'viem'; import { base } from 'viem/chains';
import { findSettlementEvents, AGGREGATOR_SIGNATURES } from './packages/ingest/src/aggregatorSignatures.ts';
const agg='odos'; const tx='0x...';
const rpc=createPublicClient({chain:base,transport:http(process.env.TCA_RPC_URL)});
const r=await rpc.getTransactionReceipt({hash:tx});
console.log(findSettlementEvents(r.logs, AGGREGATOR_SIGNATURES[agg].settlementContract));
"
```
Record the distinctive `topic0` (and a human name from the contract's verified ABI on Basescan if available) into `aggregatorSignatures.ts`. Re-run `PER_AGG_LIMIT=1` load so `settlement_event_seen` becomes `true`.

- [ ] **Step 3: View the dashboard on the Smoke dataset**

Run: `npm run dev` (dashboard on http://localhost:3001)
Open `http://localhost:3001/?ds=smoke` and `http://localhost:3001/trades?ds=smoke`.
**Review with the user:** every aggregator appears with all columns populated (Accuracy, LP Fee, Agg Fee, Slippage, Gas, Variability — Variability will be 0/NaN at n=1, expected); the Trades table shows the 7 rows; the Funnel view (`?ds=funnel`) is unchanged. Spot-check one row's Accuracy sign against the trade direction.
**STOP. Report results and the recorded signatures to the user before scaling.**

- [ ] **Step 4: Commit the discovered signatures**

```bash
git add packages/ingest/src/aggregatorSignatures.ts
git commit -m "feat(ingest): record settlement-event signatures from checkpoint A"
```

---

### Checkpoint B — 10 trades per aggregator (REVIEW GATE)

- [ ] **Step 1: Load ten per aggregator**

Run: `set -a && source .env && set +a && PER_AGG_LIMIT=10 npx tsx packages/ingest/src/load-smoke-trades.ts`
Expected: report shows up to `ok=10` per aggregator; failures are listed with reasons.

- [ ] **Step 2: Triage failures → bespoke fixes**

For each aggregator with `fail > 0`, read the reason. Apply the **smallest** bespoke fix in `normalizeSmokeTrade.ts` (e.g. a provider needs the native-ETH leg counted, or its fee vault added to `decompose-trade.ts`'s `AGG_FEE_VAULTS`). Add a regression unit test in `normalizeSmokeTrade.test.ts` for any fix using a synthetic trace. Re-run.
Acceptable to leave genuinely undecodable txs failing (the goal is orientation, not perfection) — but each remaining failure must have a one-line documented reason.

- [ ] **Step 3: View + review**

Open `http://localhost:3001/?ds=smoke`. Variability now meaningful (n≥5 dims removed). Confirm the Trust Matrix plots aggregators with ≥5 trades.
**STOP. Report the per-aggregator ok/fail counts and any bespoke fixes to the user.**

- [ ] **Step 4: Commit**

```bash
git add -A packages/ingest/src
git commit -m "fix(ingest): bespoke normalization fixes from checkpoint B (10/agg)"
```

---

### Checkpoint C — full ~100 per aggregator (REVIEW GATE)

- [ ] **Step 1: Load the full set**

Run: `set -a && source .env && set +a && PER_AGG_LIMIT=100 npx tsx packages/ingest/src/load-smoke-trades.ts`
Expected: the full report. Many failures are acceptable per the brief.

- [ ] **Step 2: Produce a final orientation summary**

Run (failure histogram by reason):
```
set -a && source .env && set +a && npx tsx -e "
import postgres from 'postgres'; const s=postgres(process.env.TCA_DATABASE_URL);
console.log(await s\`SELECT aggregator, COUNT(*) n, AVG(all_in_cost_bps::numeric) avg_acc, SUM((settlement_event_seen)::int) sig_seen FROM smoke_trades GROUP BY aggregator ORDER BY n DESC\`);
await s.end();"
```
Confirm `sig_seen` ≈ row count per aggregator (signatures recognized) and that Accuracy values are sane in sign/scale (gas-dominated, large bps — expected at $1–$2.50).

- [ ] **Step 3: Final dashboard review**

Open `http://localhost:3001/?ds=smoke` and `/trades?ds=smoke`. Walk the full framework with the user. Confirm the Funnel dataset is still intact and selectable.
**STOP. Final report to the user.**

- [ ] **Step 4: Commit any last fixes + write a short doc**

Create `docs/smoke-etl-orientation.md` capturing: which `smoke-N` experiment was used, the discovered settlement signatures table (aggregator → topic0 → event name), final ok/fail counts per aggregator, and the top failure reasons. This is the orientation deliverable that feeds the next automated-discovery iteration.
```bash
git add -A
git commit -m "docs(tca): smoke-test ETL orientation summary + settlement signatures"
```

---

## Self-Review notes (author)

- **Spec coverage:** ETL understanding → the three explicit stages (Tasks 2/3-4/5) + display (Task 6). Founding-engineer "normalization first, bespoke per aggregator, unique settlement event" → `aggregatorSignatures.ts` (Task 3) + Checkpoint A discovery + Checkpoint B bespoke-fix loop. "Pull last smoke test, 1 → 10 → 100 with dashboard at each checkpoint" → Task 2 picks the latest `smoke-%`; Checkpoints A/B/C with `PER_AGG_LIMIT`. "Keep funnel data; keep dashboard framework" → Global Constraints + new table + dataset toggle, no metric changes.
- **Type consistency:** the DB row type `schema.SmokeTradeRow` (Task 1) is distinct from the normalizer's `SmokeTradeRow` interface (Task 4) — the loader maps numbers→numeric strings. `TRADES_SORT_COLUMN_KEYS` replaces the table-bound `TRADES_SORT_COLUMNS` so sorting works against either dataset table; an alias keeps the trades page's validation intact.
- **Open risk to verify during execution:** v1 `runs.intent` JSON field name for the trader EOA (Task 2 Step 3 handles fallbacks + `SMOKE_TRADER`); and whether `decomposeTrade`'s `Direction` import path/type matches (`./decoder.js` vs `./tradeEndpoints.js` both export `Direction` — use the one `decompose-trade.ts` expects, i.e. `tradeEndpoints`'s `'buy_weth'|'sell_weth'`).
```
