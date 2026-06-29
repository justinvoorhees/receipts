# Robust Multi-Pool Benchmark with Oracle Validation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-hardcoded-pool "Market Price" benchmark with a median of the three deepest WETH/USDC pools at block N−1, validated against a Chainlink ETH/USD oracle that flags possible pre-block manipulation.

**Architecture:** A new `benchmarkPrice.ts` module splits into a pure, fully-unit-tested core (`median`, `computeBenchmark`) and a thin RPC reader (`getBenchmarkMid`) that reads three pools + Chainlink and delegates to the core. It is a drop-in replacement for `getReferencePrice(POOL_5BPS, …)` at all three ingest call sites. Four nullable columns on `router_trades_gated` persist the validation metrics; the dashboard surfaces them.

**Tech Stack:** TypeScript, viem (Base RPC), Drizzle ORM + postgres, Vitest, React (dashboard).

## Global Constraints

- Pipeline stays **WETH/USDC-only**. No multi-pair generalization.
- Benchmark value keeps **instantaneous `slot0` semantics** — no TWAP smoothing of the value.
- Reference price is sampled at **block N−1** (the trade block minus one), matching existing `getReferencePrice` behavior.
- WETH = `0x4200000000000000000000000000000000000006` (18 dec); USDC = `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` (6 dec). For all benchmark pools token0 = WETH, token1 = USDC, so `sqrtPriceX96ToUsdcPerWeth` (× 10^12) applies without inversion.
- Constants (verbatim): `DIVERGENCE_TOL_BPS = 15`, `MANIPULATION_TOL_BPS = 50`, `MIN_VALID_POOLS = 2`.
- Tests run from repo root: `npx vitest run <path>`. Implementation imports use the `.js` extension (NodeNext).
- New DB columns land on `router_trades_gated` only.
- **Env loading:** credentials live in the gitignored repo-root `.env` (`TCA_RPC_URL`, `TCA_DATABASE_URL`). Any standalone script (`tsx`) MUST `import 'dotenv/config';` as its first line AND be run with **cwd = repo root** (dotenv reads `./.env` from cwd). The DB env var is **`TCA_DATABASE_URL`** (NOT `DATABASE_URL`).
- **No `psql`** in this environment: apply and verify migrations via a `postgres`-package `tsx` script, not `psql`.
- Commit after every task.

---

### Task 1: Resolve & pin pool + oracle addresses

**Files:**
- Create (temporary): `packages/ingest/src/resolve-benchmark-addrs.ts`

**Interfaces:**
- Produces: the three pool addresses and the Chainlink ETH/USD feed address, pinned as constants in Task 2.

- [ ] **Step 1: Write a one-off discovery script**

Create `packages/ingest/src/resolve-benchmark-addrs.ts`:

```ts
import 'dotenv/config';
import { createPublicClient, http, parseAbi } from 'viem';
import { base } from 'viem/chains';

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const UNIV3_FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const AERO_CL_FACTORY = '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A';
const CHAINLINK_ETH_USD = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70';

const v3 = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const aero = parseAbi(['function getPool(address,address,int24) view returns (address)']);
const feed = parseAbi([
  'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
  'function decimals() view returns (uint8)',
]);

async function main() {
  const rpcUrl = process.env.TCA_RPC_URL!;
  const c = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const uni30 = await c.readContract({ address: UNIV3_FACTORY, abi: v3, functionName: 'getPool', args: [WETH, USDC, 3000] });
  const aeroCl = await c.readContract({ address: AERO_CL_FACTORY, abi: aero, functionName: 'getPool', args: [WETH, USDC, 1] });
  const dec = await c.readContract({ address: CHAINLINK_ETH_USD, abi: feed, functionName: 'decimals' });
  const [, answer] = await c.readContract({ address: CHAINLINK_ETH_USD, abi: feed, functionName: 'latestRoundData' });
  console.log('univ3_30bps:', uni30);
  console.log('aero_cl    :', aeroCl);
  console.log('chainlink decimals:', dec, 'ETH/USD:', Number(answer) / 10 ** Number(dec));
}
main();
```

- [ ] **Step 2: Run it and record the output**

Run from repo root: `npx tsx packages/ingest/src/resolve-benchmark-addrs.ts`
Expected: three non-zero addresses and a plausible ETH/USD price (e.g. ~2000–4000), `chainlink decimals: 8`. Record the `univ3_30bps` and `aero_cl` addresses — they are pasted into Task 2's `BENCHMARK_POOLS`. Confirm the Chainlink feed answers and is 8-decimal.

- [ ] **Step 3: Delete the throwaway script**

```bash
rm packages/ingest/src/resolve-benchmark-addrs.ts
```

- [ ] **Step 4: Commit** (records the resolved addresses in the commit message for provenance)

```bash
git commit --allow-empty -m "chore(ingest): resolve benchmark pool + Chainlink addresses

univ3_5bps  = 0xd0b53D9277642d899DF5C87A3966A349A798F224
univ3_30bps = <paste>
aero_cl     = <paste>
chainlink ETH/USD = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70 (8 dec)"
```

---

### Task 2: Pure benchmark core + RPC reader (`benchmarkPrice.ts`)

**Files:**
- Create: `packages/ingest/src/benchmarkPrice.ts`
- Test: `packages/ingest/src/benchmarkPrice.test.ts`

**Interfaces:**
- Consumes: `sqrtPriceX96ToUsdcPerWeth` from `./referencePrice.js`; `readSlot0` from `./poolDiscovery.js`.
- Produces:
  - `median(xs: number[]): number`
  - `computeBenchmark(perPool: { label: string; price: number | null }[], chainlinkPrice: number | null): BenchmarkResult`
  - `getBenchmarkMid(args: { rpcUrl: string; blockNumber: bigint }): Promise<BenchmarkResult>` — reads at `blockNumber - 1n`.
  - `interface BenchmarkResult { marketMid: number; perPool: { label: string; price: number | null }[]; poolDivergenceBps: number; chainlinkPrice: number | null; chainlinkDevBps: number | null; manipulationSuspect: boolean; flags: string[]; lowConfidence: boolean }`

- [ ] **Step 1: Write the failing tests**

Create `packages/ingest/src/benchmarkPrice.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { median, computeBenchmark } from './benchmarkPrice.js';

const P = (label: string, price: number | null) => ({ label, price });

describe('median', () => {
  it('odd count returns middle', () => expect(median([3000, 3010, 2990])).toBe(3000));
  it('even count averages two middle', () => expect(median([3000, 3010])).toBe(3005));
  it('throws on empty', () => expect(() => median([])).toThrow());
});

describe('computeBenchmark', () => {
  it('3 agreeing pools + close oracle → high confidence, no flags', () => {
    const r = computeBenchmark([P('a', 3000), P('b', 3001), P('c', 2999)], 3000);
    expect(r.marketMid).toBe(3000);
    expect(r.poolDivergenceBps).toBeCloseTo(6.67, 1);
    expect(r.manipulationSuspect).toBe(false);
    expect(r.lowConfidence).toBe(false);
    expect(r.flags).toEqual([]);
  });

  it('pool spread > 15 bps → POOL_DIVERGENCE + low confidence', () => {
    const r = computeBenchmark([P('a', 3000), P('b', 3010), P('c', 2990)], 3000);
    expect(r.flags).toContain('POOL_DIVERGENCE');
    expect(r.lowConfidence).toBe(true);
  });

  it('oracle deviation > 50 bps → MANIPULATION_SUSPECT + low confidence', () => {
    const r = computeBenchmark([P('a', 3000), P('b', 3001), P('c', 2999)], 2970);
    expect(r.manipulationSuspect).toBe(true);
    expect(r.chainlinkDevBps).toBeCloseTo(101.01, 1);
    expect(r.flags).toContain('MANIPULATION_SUSPECT');
    expect(r.lowConfidence).toBe(true);
  });

  it('only 1 valid pool → LOW_POOL_COVERAGE + low confidence, divergence 0', () => {
    const r = computeBenchmark([P('a', 3000), P('b', null), P('c', null)], 3000);
    expect(r.marketMid).toBe(3000);
    expect(r.poolDivergenceBps).toBe(0);
    expect(r.flags).toContain('LOW_POOL_COVERAGE');
    expect(r.lowConfidence).toBe(true);
  });

  it('0 valid pools → throws', () => {
    expect(() => computeBenchmark([P('a', null), P('b', null), P('c', null)], 3000)).toThrow();
  });

  it('chainlink unavailable → CHAINLINK_UNAVAILABLE, no manipulation, confidence unchanged by oracle', () => {
    const r = computeBenchmark([P('a', 3000), P('b', 3001), P('c', 2999)], null);
    expect(r.chainlinkDevBps).toBeNull();
    expect(r.manipulationSuspect).toBe(false);
    expect(r.flags).toContain('CHAINLINK_UNAVAILABLE');
    expect(r.lowConfidence).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/ingest/src/benchmarkPrice.test.ts`
Expected: FAIL — `Cannot find module './benchmarkPrice.js'`.

- [ ] **Step 3: Implement `benchmarkPrice.ts`**

Create `packages/ingest/src/benchmarkPrice.ts` (paste the resolved addresses from Task 1 into `BENCHMARK_POOLS`):

```ts
/**
 * benchmarkPrice.ts — Robust WETH/USDC reference mid at block N-1.
 *
 * Replaces the single-hardcoded-pool slot0 read. Reads the three deepest
 * WETH/USDC pools, takes the median (instantaneous-mid semantics preserved),
 * and cross-checks the median against the Chainlink ETH/USD oracle to flag
 * possible pre-block manipulation.
 */
import { createPublicClient, http, parseAbi } from 'viem';
import { base } from 'viem/chains';
import { sqrtPriceX96ToUsdcPerWeth } from './referencePrice.js';
import { readSlot0 } from './poolDiscovery.js';

// Tolerances (see design spec 2026-06-26-robust-benchmark-oracle-validation).
export const DIVERGENCE_TOL_BPS = 15;
export const MANIPULATION_TOL_BPS = 50;
export const MIN_VALID_POOLS = 2;

/** Three deepest WETH/USDC pools on Base. token0 = WETH for all (10^12 adjust). */
export const BENCHMARK_POOLS: { label: string; address: `0x${string}` }[] = [
  { label: 'univ3_5bps', address: '0xd0b53D9277642d899DF5C87A3966A349A798F224' },
  { label: 'univ3_30bps', address: '0x<PASTE_FROM_TASK_1>' },
  { label: 'aero_cl', address: '0x<PASTE_FROM_TASK_1>' },
];

/** Chainlink ETH/USD feed on Base (8 decimals). Confirmed on-chain (Task 1). */
export const CHAINLINK_ETH_USD = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70' as `0x${string}`;

const CHAINLINK_ABI = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

export interface BenchmarkResult {
  marketMid: number;
  perPool: { label: string; price: number | null }[];
  poolDivergenceBps: number;
  chainlinkPrice: number | null;
  chainlinkDevBps: number | null;
  manipulationSuspect: boolean;
  flags: string[];
  lowConfidence: boolean;
}

export function median(xs: number[]): number {
  if (xs.length === 0) throw new Error('median: empty input');
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

export function computeBenchmark(
  perPool: { label: string; price: number | null }[],
  chainlinkPrice: number | null,
): BenchmarkResult {
  const flags: string[] = [];
  let lowConfidence = false;

  const valid = perPool.filter((p): p is { label: string; price: number } => p.price != null && p.price > 0);
  if (valid.length === 0) throw new Error('computeBenchmark: no valid pool prices');

  const prices = valid.map((p) => p.price);
  const marketMid = median(prices);

  let poolDivergenceBps = 0;
  if (valid.length < MIN_VALID_POOLS) {
    flags.push('LOW_POOL_COVERAGE');
    lowConfidence = true;
  } else {
    poolDivergenceBps = ((Math.max(...prices) - Math.min(...prices)) / marketMid) * 10_000;
    if (poolDivergenceBps > DIVERGENCE_TOL_BPS) {
      flags.push('POOL_DIVERGENCE');
      lowConfidence = true;
    }
  }

  let chainlinkDevBps: number | null = null;
  let manipulationSuspect = false;
  if (chainlinkPrice == null) {
    flags.push('CHAINLINK_UNAVAILABLE');
  } else {
    // Chainlink is ETH/USD; mid is USDC/WETH. USDC depeg (<10bps) sits inside the
    // 50bps tolerance, so the USDC != USD gap does not false-trigger.
    chainlinkDevBps = (Math.abs(marketMid - chainlinkPrice) / chainlinkPrice) * 10_000;
    if (chainlinkDevBps > MANIPULATION_TOL_BPS) {
      manipulationSuspect = true;
      flags.push('MANIPULATION_SUSPECT');
      lowConfidence = true;
    }
  }

  return { marketMid, perPool, poolDivergenceBps, chainlinkPrice, chainlinkDevBps, manipulationSuspect, flags, lowConfidence };
}

export async function getBenchmarkMid(args: { rpcUrl: string; blockNumber: bigint }): Promise<BenchmarkResult> {
  const client = createPublicClient({ chain: base, transport: http(args.rpcUrl) });
  const at = args.blockNumber - 1n;

  const perPool = await Promise.all(
    BENCHMARK_POOLS.map(async (pool) => {
      const sqrtPriceX96 = await readSlot0(client as never, pool.address, at);
      return { label: pool.label, price: sqrtPriceX96 === null ? null : sqrtPriceX96ToUsdcPerWeth(sqrtPriceX96) };
    }),
  );

  let chainlinkPrice: number | null = null;
  try {
    const round = await client.readContract({
      address: CHAINLINK_ETH_USD,
      abi: CHAINLINK_ABI,
      functionName: 'latestRoundData',
      blockNumber: at,
    });
    chainlinkPrice = Number(round[1]) / 1e8; // 8 decimals
  } catch {
    chainlinkPrice = null;
  }

  return computeBenchmark(perPool, chainlinkPrice);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/ingest/src/benchmarkPrice.test.ts`
Expected: PASS (all 9 assertions).

- [ ] **Step 5: Integration spotcheck against a real block**

Create a throwaway `packages/ingest/src/spotcheck-benchmark.ts`:

```ts
import 'dotenv/config';
import { getBenchmarkMid } from './benchmarkPrice.js';
const block = BigInt(process.env.BLOCK!);
getBenchmarkMid({ rpcUrl: process.env.TCA_RPC_URL!, blockNumber: block }).then((r) => console.log(JSON.stringify(r, null, 2)));
```

Pick a real gated block: `npx tsx -e "import('dotenv/config').then(async()=>{const p=(await import('postgres')).default;const s=p(process.env.TCA_DATABASE_URL);console.log((await s\`SELECT block_number FROM router_trades_gated LIMIT 1\`)[0]);await s.end()})"` (run from repo root).
Run from repo root: `BLOCK=<that block> npx tsx packages/ingest/src/spotcheck-benchmark.ts`
Expected: a `marketMid` near the trade's known price, ≥2 non-null `perPool` prices, a `chainlinkPrice` close to `marketMid`, small `poolDivergenceBps`/`chainlinkDevBps`, empty or benign `flags`. Then delete it: `rm packages/ingest/src/spotcheck-benchmark.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/ingest/src/benchmarkPrice.ts packages/ingest/src/benchmarkPrice.test.ts
git commit -m "feat(ingest): robust multi-pool benchmark with Chainlink validation"
```

---

### Task 3: DB migration — four validation columns on `router_trades_gated`

**Files:**
- Modify: `packages/db/src/schema.ts:153-179` (the `routerTradesGated` table)
- Create: `packages/db/drizzle/0008_<name>.sql`

**Interfaces:**
- Produces: columns `chainlink_price`, `chainlink_dev_bps`, `pool_divergence_bps` (numeric, nullable) and `manipulation_flag` (boolean, nullable) on `router_trades_gated`. Because `queries.ts` does `db.select().from(table)`, these auto-appear on `RouterTradeRow` (`= typeof schema.routerTradesGated.$inferSelect`).

- [ ] **Step 1: Add the columns to the Drizzle schema**

In `packages/db/src/schema.ts`, inside the `routerTradesGated` table, after `routePure: boolean('route_pure'),` (line ~177) add:

```ts
		// v2.2 benchmark validation (nullable — backfilled)
		chainlinkPrice: numeric('chainlink_price'),
		chainlinkDevBps: numeric('chainlink_dev_bps'),
		poolDivergenceBps: numeric('pool_divergence_bps'),
		manipulationFlag: boolean('manipulation_flag'),
```

- [ ] **Step 2: Write the migration SQL**

Create `packages/db/drizzle/0008_benchmark_validation.sql`:

```sql
ALTER TABLE "router_trades_gated" ADD COLUMN "chainlink_price" numeric;--> statement-breakpoint
ALTER TABLE "router_trades_gated" ADD COLUMN "chainlink_dev_bps" numeric;--> statement-breakpoint
ALTER TABLE "router_trades_gated" ADD COLUMN "pool_divergence_bps" numeric;--> statement-breakpoint
ALTER TABLE "router_trades_gated" ADD COLUMN "manipulation_flag" boolean;
```

- [ ] **Step 3: Apply the migration (via postgres-package script, no psql)**

Create a throwaway `packages/ingest/src/_apply-0008.ts`:

```ts
import 'dotenv/config';
import { readFileSync } from 'fs';
import postgres from 'postgres';
const sql = postgres(process.env.TCA_DATABASE_URL!);
const ddl = readFileSync('packages/db/drizzle/0008_benchmark_validation.sql', 'utf8')
  .split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
for (const stmt of ddl) await sql.unsafe(stmt);
console.log(`applied ${ddl.length} statements`);
await sql.end();
```

Run from repo root: `npx tsx packages/ingest/src/_apply-0008.ts`
Expected: `applied 4 statements`, no errors. Then delete it: `rm packages/ingest/src/_apply-0008.ts`

- [ ] **Step 4: Verify the columns exist**

Run from repo root:
```bash
npx tsx -e "import('dotenv/config').then(async()=>{const p=(await import('postgres')).default;const s=p(process.env.TCA_DATABASE_URL);const r=await s\`SELECT column_name,data_type FROM information_schema.columns WHERE table_name='router_trades_gated' AND column_name IN ('chainlink_price','chainlink_dev_bps','pool_divergence_bps','manipulation_flag') ORDER BY column_name\`;console.table(r);await s.end()})"
```
Expected: four rows — `chainlink_dev_bps` (numeric), `chainlink_price` (numeric), `manipulation_flag` (boolean), `pool_divergence_bps` (numeric).

- [ ] **Step 5: Build the db package to confirm the schema typechecks**

Run: `npm run build --workspace packages/db`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle/0008_benchmark_validation.sql
git commit -m "feat(db): benchmark validation columns on router_trades_gated"
```

---

### Task 4: Wire `getBenchmarkMid` into the live gated path (`reextract-gated.ts`)

**Files:**
- Modify: `packages/ingest/src/reextract-gated.ts` (import + `POOL_5BPS` removal, `getReferencePrice` call ~line 319, `GatedRow` interface ~line 197, the row literal ~line 340, inline `CREATE TABLE` DDL ~line 391, the `INSERT` ~line 479)

**Interfaces:**
- Consumes: `getBenchmarkMid` from `./benchmarkPrice.js` (Task 2).

- [ ] **Step 1: Swap the import**

In `packages/ingest/src/reextract-gated.ts`, remove the `POOL_5BPS` constant (line ~34) and the `getReferencePrice` import; add:

```ts
import { getBenchmarkMid } from './benchmarkPrice.js';
```

- [ ] **Step 2: Replace the market-mid computation**

Replace the `getReferencePrice({ rpcUrl, poolAddress: POOL_5BPS, blockNumber: BigInt(blockNumber) })` block (line ~319) with:

```ts
		// ── Market mid (robust median + oracle validation) ──
		const bench = await getBenchmarkMid({ rpcUrl, blockNumber: BigInt(blockNumber) });
		const marketMid = bench.marketMid;
```

- [ ] **Step 3: Extend `GatedRow` and the row literal**

In the `GatedRow` interface (line ~197) add:

```ts
	chainlink_price: number | null;
	chainlink_dev_bps: number | null;
	pool_divergence_bps: number;
	manipulation_flag: boolean;
```

In the row literal (line ~340), after `gate_reason: 'ok',` add:

```ts
			chainlink_price: bench.chainlinkPrice,
			chainlink_dev_bps: bench.chainlinkDevBps,
			pool_divergence_bps: bench.poolDivergenceBps,
			manipulation_flag: bench.manipulationSuspect,
```

- [ ] **Step 4: Update the inline CREATE TABLE DDL**

In the inline `CREATE TABLE` (line ~391), after the `gate_reason` column add:

```sql
			chainlink_price     numeric,
			chainlink_dev_bps   numeric,
			pool_divergence_bps numeric,
			manipulation_flag   boolean,
```

- [ ] **Step 5: Update the INSERT statement**

In the `INSERT INTO router_trades_gated` (line ~479), add the four columns to the column list and the four values:

```ts
		await sql`
			INSERT INTO router_trades_gated (
				tx_hash, aggregator, trader, original_trader, re_anchored,
				direction, settled_in, usdc_amount, weth_amount, realized_price,
				market_mid, all_in_cost_bps, block_number, gate_reason,
				chainlink_price, chainlink_dev_bps, pool_divergence_bps, manipulation_flag
			) VALUES (
				${row.tx_hash}, ${row.aggregator}, ${row.trader}, ${row.original_trader},
				${row.re_anchored}, ${row.direction}, ${row.settled_in},
				${row.usdc_amount}, ${row.weth_amount}, ${row.realized_price},
				${row.market_mid}, ${row.all_in_cost_bps}, ${row.block_number},
				${row.gate_reason},
				${row.chainlink_price}, ${row.chainlink_dev_bps},
				${row.pool_divergence_bps}, ${row.manipulation_flag}
			)
			ON CONFLICT (tx_hash) DO NOTHING
		`;
```

- [ ] **Step 6: Typecheck the ingest package**

Run: `npm run build --workspace packages/ingest`
Expected: exit 0 (no unused `POOL_5BPS`/`getReferencePrice`, no type errors on the new fields).

- [ ] **Step 7: Commit**

```bash
git add packages/ingest/src/reextract-gated.ts
git commit -m "feat(ingest): reextract-gated uses robust benchmark + persists validation"
```

---

### Task 5: Wire the remaining two benchmark call sites (value-only)

**Files:**
- Modify: `packages/ingest/src/extract-router-trades.ts:16,64` (`POOL_5BPS`, `getReferencePrice` call)
- Modify: `packages/ingest/src/normalizeSmokeTrade.ts:20,165` (`POOL_5BPS`, `getReferencePrice` call)

**Interfaces:**
- Consumes: `getBenchmarkMid` from `./benchmarkPrice.js`.

These paths don't persist the new columns (no migration on their tables); they only adopt the robust median `marketMid` for consistency.

- [ ] **Step 1: Update `extract-router-trades.ts`**

Remove `POOL_5BPS` (line 16) and the `getReferencePrice` import; add `import { getBenchmarkMid } from './benchmarkPrice.js';`. Replace line 64:

```ts
		const { marketMid } = await getBenchmarkMid({ rpcUrl, blockNumber: r.blockNumber });
```

- [ ] **Step 2: Update `normalizeSmokeTrade.ts`**

Remove `POOL_5BPS` (line 20) and the `getReferencePrice` import; add `import { getBenchmarkMid } from './benchmarkPrice.js';`. Replace line 165:

```ts
		const { marketMid } = await getBenchmarkMid({ rpcUrl, blockNumber: receipt.blockNumber });
```

- [ ] **Step 3: Typecheck**

Run: `npm run build --workspace packages/ingest`
Expected: exit 0.

- [ ] **Step 4: Confirm no stragglers reference the old constant**

Run: `grep -rn "POOL_5BPS\|getReferencePrice" packages/ingest/src`
Expected: only `referencePrice.ts` (the helper itself, still exporting `sqrtPriceX96ToUsdcPerWeth`) — no remaining `POOL_5BPS` usages.

- [ ] **Step 5: Commit**

```bash
git add packages/ingest/src/extract-router-trades.ts packages/ingest/src/normalizeSmokeTrade.ts
git commit -m "refactor(ingest): route remaining benchmark call sites through getBenchmarkMid"
```

---


### Task 6: Migration — validation columns on `smoke_trades`

> **Pivot note:** The plan now targets the 15-row `smoke_trades` set, NOT the 165-row `router_trades_gated` (left untouched; its Task-3 columns stay, nullable/harmless). `smoke_trades` bypasses the notional floor and ±100bps gate by design, so there is no gate handling here.

**Files:**
- Modify: `packages/db/src/schema.ts` (the `smokeTrades` table — after `normalizeFlags`, before `loadedAt`)
- Create: `packages/db/drizzle/0009_smoke_benchmark_validation.sql`

- [ ] **Step 1: Add the columns to the Drizzle schema**

In `packages/db/src/schema.ts`, inside the `smokeTrades` table, immediately after `normalizeFlags: jsonb('normalize_flags'),` add:

```ts
	// v2.2 benchmark validation (nullable)
	chainlinkPrice: numeric('chainlink_price'),
	chainlinkDevBps: numeric('chainlink_dev_bps'),
	poolDivergenceBps: numeric('pool_divergence_bps'),
	manipulationFlag: boolean('manipulation_flag'),
```

(`numeric` and `boolean` are already imported in this file.)

- [ ] **Step 2: Write the migration SQL**

Create `packages/db/drizzle/0009_smoke_benchmark_validation.sql`:

```sql
ALTER TABLE "smoke_trades" ADD COLUMN "chainlink_price" numeric;--> statement-breakpoint
ALTER TABLE "smoke_trades" ADD COLUMN "chainlink_dev_bps" numeric;--> statement-breakpoint
ALTER TABLE "smoke_trades" ADD COLUMN "pool_divergence_bps" numeric;--> statement-breakpoint
ALTER TABLE "smoke_trades" ADD COLUMN "manipulation_flag" boolean;
```

- [ ] **Step 3: Apply the migration (postgres-package script, no psql)**

Create throwaway `packages/ingest/src/_apply-0009.ts`:

```ts
import 'dotenv/config';
import { readFileSync } from 'fs';
import postgres from 'postgres';
const sql = postgres(process.env.TCA_DATABASE_URL!);
const ddl = readFileSync('packages/db/drizzle/0009_smoke_benchmark_validation.sql', 'utf8')
  .split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
for (const stmt of ddl) await sql.unsafe(stmt);
console.log(`applied ${ddl.length} statements`);
await sql.end();
```

Run from repo root: `npx tsx packages/ingest/src/_apply-0009.ts` → expect `applied 4 statements`. Then `rm packages/ingest/src/_apply-0009.ts`.

- [ ] **Step 4: Verify columns exist**

Run from repo root:
```bash
npx tsx -e "import('dotenv/config').then(async()=>{const p=(await import('postgres')).default;const s=p(process.env.TCA_DATABASE_URL);console.table(await s\`SELECT column_name,data_type FROM information_schema.columns WHERE table_name='smoke_trades' AND column_name IN ('chainlink_price','chainlink_dev_bps','pool_divergence_bps','manipulation_flag') ORDER BY column_name\`);await s.end()})"
```
Expected: four rows — `chainlink_dev_bps`/`chainlink_price`/`pool_divergence_bps` (numeric), `manipulation_flag` (boolean).

- [ ] **Step 5: Build the db package**

Run: `npm run build --workspace packages/db` → expect exit 0.

- [ ] **Step 6: Commit** (stage exactly these two files; do NOT `git add -A`)

```bash
git add packages/db/src/schema.ts packages/db/drizzle/0009_smoke_benchmark_validation.sql
git commit -m "feat(db): benchmark validation columns on smoke_trades"
```

---

### Task 7: Persist benchmark validation through the smoke loader

**Files:**
- Modify: `packages/ingest/src/normalizeSmokeTrade.ts` (`SmokeTradeRow` interface; `buildSmokeRow` args/body/return; the async `normalizeSmokeTrade` wrapper)
- Modify: `packages/ingest/src/load-smoke-trades.ts` (the Drizzle `.values({})` and `.onConflictDoUpdate({ set })`)
- Test: `packages/ingest/src/normalizeSmokeTrade.test.ts`

**Interfaces consumed:** `getBenchmarkMid(...) → BenchmarkResult` with `marketMid`, `chainlinkPrice`, `chainlinkDevBps`, `poolDivergenceBps`, `manipulationSuspect`, `flags: string[]`, `lowConfidence: boolean`.

- [ ] **Step 1: Write the failing test**

In `packages/ingest/src/normalizeSmokeTrade.test.ts`, add a second case inside the existing `describe('buildSmokeRow', …)` (reuse the `trace`/`trader` fixtures already defined at top of file):

```ts
	it('forces decompConfidence to low and merges bench flags when benchLowConfidence is set', () => {
		const r = buildSmokeRow({
			candidate: {
				txHash: '0xdef', aggregator: 'odos', trader,
				experimentSlug: 'smoke-9', runId: 'run-1', v1Status: 'success',
				v1QuoteAmountUsd: 2, v1RealizedAmountUsd: 1.99,
			},
			trace,
			receiptLogs: trace.logs,
			gasUsed: 200000n,
			effectiveGasPriceWei: 50000000n,
			marketMid: 2100,
			blockNumber: 12345,
			decomposition: { lpFeeBps: 5, aggFeeBps: 0, slippageBps: 1, executionBps: 6, gasBps: 0, flags: [] },
			decompConfidence: 'high',
			benchLowConfidence: true,
			benchFlags: ['MANIPULATION_SUSPECT'],
			manipulationFlag: true,
			chainlinkDevBps: 80,
			poolDivergenceBps: 4,
			chainlinkPrice: 2080,
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.row.decompConfidence).toBe('low');
		expect(r.row.normalizeFlags).toContain('MANIPULATION_SUSPECT');
		expect(r.row.manipulationFlag).toBe(true);
		expect(r.row.chainlinkDevBps).toBe(80);
	});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/ingest/src/normalizeSmokeTrade.test.ts`
Expected: FAIL — `benchLowConfidence`/`benchFlags`/`manipulationFlag`/`chainlinkDevBps` are not valid `buildSmokeRow` args yet (type error / undefined fields).

- [ ] **Step 3: Extend the `SmokeTradeRow` interface**

In `normalizeSmokeTrade.ts`, in the `SmokeTradeRow` interface, immediately after `settlementEventSeen: boolean; normalizeFlags: string[];` add:

```ts
	chainlinkPrice: number | null; chainlinkDevBps: number | null;
	poolDivergenceBps: number | null; manipulationFlag: boolean;
```

- [ ] **Step 4: Extend `buildSmokeRow` args**

In the `buildSmokeRow` args object type, after `decompConfidence?: string | null;` add:

```ts
	chainlinkPrice?: number | null;
	chainlinkDevBps?: number | null;
	poolDivergenceBps?: number | null;
	manipulationFlag?: boolean;
	benchFlags?: string[];
	benchLowConfidence?: boolean;
```

- [ ] **Step 5: Merge bench flags + downgrade confidence in `buildSmokeRow` body**

Change the flags initialization from `const flags = [...d.flags];` to:

```ts
		const flags = [...d.flags, ...(args.benchFlags ?? [])];
```

Then, just before the `return { ok: true, row: { … } }`, add:

```ts
		const decompConfidence = args.benchLowConfidence ? 'low' : (args.decompConfidence ?? null);
```

In the returned `row`, replace `decompConfidence: args.decompConfidence ?? null,` with `decompConfidence,` and, after `settlementEventSeen, normalizeFlags: flags,`, add:

```ts
				chainlinkPrice: args.chainlinkPrice ?? null,
				chainlinkDevBps: args.chainlinkDevBps ?? null,
				poolDivergenceBps: args.poolDivergenceBps ?? null,
				manipulationFlag: args.manipulationFlag ?? false,
```

- [ ] **Step 6: Capture the full bench result in the async wrapper**

In `normalizeSmokeTrade`, replace `const { marketMid } = await getBenchmarkMid({ rpcUrl, blockNumber: receipt.blockNumber });` with:

```ts
		const bench = await getBenchmarkMid({ rpcUrl, blockNumber: receipt.blockNumber });
		const marketMid = bench.marketMid;
```

(The `probe` call to `buildSmokeRow` keeps using `marketMid` unchanged.) In the FINAL `buildSmokeRow` call (the one with `decomposition: routeResult`), after `decompConfidence: routeResult.confidence,` add:

```ts
				chainlinkPrice: bench.chainlinkPrice,
				chainlinkDevBps: bench.chainlinkDevBps,
				poolDivergenceBps: bench.poolDivergenceBps,
				manipulationFlag: bench.manipulationSuspect,
				benchFlags: bench.flags,
				benchLowConfidence: bench.lowConfidence,
```

- [ ] **Step 7: Persist the four columns in the loader (values + upsert set)**

In `packages/ingest/src/load-smoke-trades.ts`, in the `.values({ … })` object, after `settlementEventSeen: row.settlementEventSeen, normalizeFlags: row.normalizeFlags,` add:

```ts
				chainlinkPrice: row.chainlinkPrice == null ? null : String(row.chainlinkPrice),
				chainlinkDevBps: row.chainlinkDevBps == null ? null : String(row.chainlinkDevBps),
				poolDivergenceBps: row.poolDivergenceBps == null ? null : String(row.poolDivergenceBps),
				manipulationFlag: row.manipulationFlag,
```

In the `.onConflictDoUpdate({ target: …, set: { … } })` `set` object, after `decompConfidence: row.decompConfidence,` add `marketMid` (currently MISSING from the update set, so re-runs never refresh the median) AND the four new columns:

```ts
					marketMid: String(row.marketMid),
					chainlinkPrice: row.chainlinkPrice == null ? null : String(row.chainlinkPrice),
					chainlinkDevBps: row.chainlinkDevBps == null ? null : String(row.chainlinkDevBps),
					poolDivergenceBps: row.poolDivergenceBps == null ? null : String(row.poolDivergenceBps),
					manipulationFlag: row.manipulationFlag,
```

- [ ] **Step 8: Run the test green**

Run: `npx vitest run packages/ingest/src/normalizeSmokeTrade.test.ts`
Expected: PASS (existing case + the new downgrade case).

- [ ] **Step 9: Typecheck**

Run: `npm run build --workspace packages/ingest 2>&1 | grep -E "normalizeSmokeTrade|load-smoke-trades" || echo "CLEAN: neither file has errors"`
Expected: `CLEAN: neither file has errors` (the package exits 1 from 6 PRE-EXISTING unrelated errors — not these files).

- [ ] **Step 10: Commit** (stage exactly these three files; do NOT `git add -A`)

```bash
git add packages/ingest/src/normalizeSmokeTrade.ts packages/ingest/src/load-smoke-trades.ts packages/ingest/src/normalizeSmokeTrade.test.ts
git commit -m "feat(ingest): persist benchmark validation through smoke loader"
```

---

### Task 8: Repopulate the 15 smoke rows

**Files:** none committed (throwaway dump script + a live loader run).

The transient `/tmp/smoke_candidates.json` may be gone, so regenerate a candidate file from the 15 stored rows and feed it back through the existing loader (reuses its upsert — now updating `market_mid` + the validation columns). `smoke_trades` bypasses the ±100 gate, so no rows are dropped.

- [ ] **Step 1: Dump current smoke rows to a candidate file**

Create throwaway `packages/ingest/src/_dump-smoke-candidates.ts`:

```ts
import 'dotenv/config';
import { writeFileSync } from 'fs';
import postgres from 'postgres';
const sql = postgres(process.env.TCA_DATABASE_URL!);
const rows = await sql`
  SELECT tx_hash, aggregator, trader, experiment_slug, run_id, v1_status,
         v1_quote_amount_usd, v1_realized_amount_usd FROM smoke_trades`;
const candidates = rows.map((r: any) => ({
  txHash: r.tx_hash, aggregator: r.aggregator, trader: r.trader,
  experimentSlug: r.experiment_slug, runId: r.run_id, v1Status: r.v1_status,
  v1QuoteAmountUsd: r.v1_quote_amount_usd == null ? null : Number(r.v1_quote_amount_usd),
  v1RealizedAmountUsd: r.v1_realized_amount_usd == null ? null : Number(r.v1_realized_amount_usd),
}));
writeFileSync('/tmp/smoke_candidates_backfill.json', JSON.stringify(candidates, null, 2));
console.log(`dumped ${candidates.length} candidates`);
await sql.end();
```

Run from repo root: `npx tsx packages/ingest/src/_dump-smoke-candidates.ts` → expect `dumped 15 candidates`. Then `rm packages/ingest/src/_dump-smoke-candidates.ts`.

- [ ] **Step 2: Re-run the loader over all 15 (upsert updates them)**

`load-smoke-trades.ts` reads env directly (no dotenv), so source `.env`. `PER_AGG_LIMIT` high so nothing is capped; `ONLY_SUCCESS=0` so none are filtered; `SKIP_LOADED` unset so existing rows are updated:

```bash
set -a && source .env && set +a && \
IN_PATH=/tmp/smoke_candidates_backfill.json PER_AGG_LIMIT=99 ONLY_SUCCESS=0 \
npx tsx packages/ingest/src/load-smoke-trades.ts
```
Expected: a per-aggregator load report and `smoke_trades now holds 15 rows.` (count unchanged — upserts, not inserts).

- [ ] **Step 3: Verify the 15 rows are populated; report flagged trades**

Run from repo root:
```bash
npx tsx -e "import('dotenv/config').then(async()=>{const p=(await import('postgres')).default;const s=p(process.env.TCA_DATABASE_URL);const r=await s\`SELECT count(*) AS total, count(*) FILTER (WHERE pool_divergence_bps IS NULL) AS unfilled, count(*) FILTER (WHERE manipulation_flag) AS manip, count(*) FILTER (WHERE decomp_confidence='low') AS low_conf FROM smoke_trades\`;console.log(r[0]);const f=await s\`SELECT tx_hash, chainlink_dev_bps, pool_divergence_bps, manipulation_flag, decomp_confidence FROM smoke_trades WHERE manipulation_flag OR pool_divergence_bps > 15 ORDER BY chainlink_dev_bps DESC NULLS LAST\`;console.table(f);await s.end()})"
```
Expected: `total = 15`, `unfilled = 0`. `manip`/`low_conf`/the flagged table are informational — note them in the report for review. Then `rm -f /tmp/smoke_candidates_backfill.json`.

- [ ] **Step 4: Commit** — nothing to commit (no tracked files changed). Record the verification numbers in the task report instead.

---

### Task 9: Dashboard — surface Chainlink Δ + manipulation badge

**Files:**
- Modify: `packages/dashboard/components/TradesTable.tsx` (the "Market Price" `DetailRow`)
- Modify: `packages/dashboard/components/TradesTable.test.tsx`

The dialog renders for `smoke_trades` rows (and `router_trades_gated`); both now carry the validation columns via `$inferSelect`. The `decomp_confidence` downgrade already renders through the existing `confidenceLabel(row.decompConfidence)`, so this task only adds the Chainlink deviation row + the manipulation badge.

- [ ] **Step 1: Write the failing test**

In `packages/dashboard/components/TradesTable.test.tsx`, add a test mirroring the existing render harness:

```ts
	it('renders a manipulation warning when manipulationFlag is set', async () => {
		const { TradesTable } = await import('./TradesTable');
		const html = renderToStaticMarkup(
			<TradesTable
				initialSort={{ column: 'block', direction: 'desc' }}
				rows={[
					{
						txHash: '0x1234567890abcdef1234567890abcdef12345678',
						blockNumber: 123,
						aggregator: 'kyberswap',
						direction: 'buy_weth',
						usdcAmount: '1000.00',
						realizedPrice: '3000',
						marketMid: '3000',
						allInCostBps: '-1',
						lpFeeBps: '1', aggFeeBps: '0', slippageBps: '-2', gasCostUsd: '0.001',
						hopCount: 1, routeShape: 'single', decompConfidence: 'low', routeLegs: [],
						chainlinkPrice: '2970', chainlinkDevBps: '101', poolDivergenceBps: '3', manipulationFlag: true,
					} as never,
				]}
			/>,
		);
		expect(html).toContain('Possible manipulation');
	});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/dashboard/components/TradesTable.test.tsx`
Expected: FAIL — `'Possible manipulation'` not in markup.

- [ ] **Step 3: Render the deviation row + badge**

In `packages/dashboard/components/TradesTable.tsx`, replace the existing Market Price `DetailRow` block:

```tsx
					<DetailRow label="Market Price" underscored>
						{formatExecutionPrice(row.marketMid)}
					</DetailRow>
```

with:

```tsx
					<DetailRow label="Market Price" underscored>
						{formatExecutionPrice(row.marketMid)}
						{row.manipulationFlag ? (
							<span className="ml-2 text-[var(--color-warning)]" title="Median pool mid deviates from Chainlink ETH/USD by more than 0.5% at N-1">
								⚠ Possible manipulation
							</span>
						) : null}
					</DetailRow>
					{row.chainlinkDevBps != null ? (
						<DetailRow label="Chainlink Δ">
							{`${Number(row.chainlinkDevBps).toFixed(1)} bps`}
						</DetailRow>
					) : null}
```

- [ ] **Step 4: Run the test green**

Run: `npx vitest run packages/dashboard/components/TradesTable.test.tsx`
Expected: PASS (new test + existing tests).

- [ ] **Step 5: Typecheck the dashboard**

Run: `npm run build --workspace packages/dashboard`
Expected: exit 0 (`row.manipulationFlag` / `row.chainlinkDevBps` resolve on the row type).

- [ ] **Step 6: Commit** (stage exactly these two files; do NOT `git add -A`)

```bash
git add packages/dashboard/components/TradesTable.tsx packages/dashboard/components/TradesTable.test.tsx
git commit -m "feat(dashboard): surface Chainlink deviation + manipulation warning in trade dialog"
```

---

## Final verification

- [ ] Run the test suite from root: `npx vitest run` — all pass, including `benchmarkPrice.test.ts`, `normalizeSmokeTrade.test.ts`, `TradesTable.test.tsx`.
- [ ] `grep -rn "POOL_5BPS" packages/ingest/src` → no matches.
- [ ] Confirm `smoke_trades` has all 15 rows with non-null `pool_divergence_bps` (Task 8 Step 3).
- [ ] Spot-open the dashboard trade dialog on a flagged smoke trade (if any) and confirm the badge + Chainlink Δ row render; confidence shows "low" for flagged rows.

## Earmarked follow-up (NOT in this plan)

TWAP-based manipulation detector — a short (2–5 min) Uniswap V3 `observe()` TWAP compared against the `slot0` median as a second, oracle-independent manipulation signal. Adds a signal; does not change the benchmark value. Tracked in the design spec's "Future upgrade" section.

> **Deferred:** Applying this benchmark + validation to the 165-row `router_trades_gated` set is intentionally out of scope — fresh data will be gathered later (per 2026-06-27 decision).
