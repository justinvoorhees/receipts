# Benchmark v2 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the WETH/USDC benchmark flag robust to the outlier the median already rejects, add Chainlink-staleness handling plus a second (Dune) oracle with a consensus manipulation check, and route every WETH→USD valuation in a trade through the single validated benchmark mid.

**Architecture:** All benchmark logic stays in `packages/ingest/src/benchmarkPrice.ts`. The pure `computeBenchmark` function does math + flags (unit-tested, no I/O); `getBenchmarkMid` does all RPC/oracle/Dune I/O at the edge and injects results into the pure core. The Dune oracle is a single injected `OffChainOracle` function with one adapter behind it. Section C changes are independent edits to valuation call-sites and `tokenPricing.ts`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), viem, vitest, Drizzle ORM (postgres), Dune Analytics API.

## Global Constraints

- All intra-package imports use `.js` specifiers (ESM). Copy this convention verbatim.
- The benchmark **value** never changes: `marketMid = median(validPoolPrices)` from `slot0` at block N−1. This work only touches flags/confidence and valuation references.
- `DIVERGENCE_TOL_BPS = 15`, `MANIPULATION_TOL_BPS = 50`, `MIN_VALID_POOLS = 2` keep their current numeric values.
- New columns are **nullable**; no backfill of existing rows.
- `computeBenchmark` stays a pure function — no network, no `Date.now()`, no env reads.
- Existing flag strings already in use (`POOL_DIVERGENCE`, `MANIPULATION_SUSPECT`, `LOW_POOL_COVERAGE`, `CHAINLINK_UNAVAILABLE`) keep their exact spelling.

---

## File Structure

- `packages/ingest/src/benchmarkPrice.ts` — MODIFY: median-relative divergence (Task 1), consensus combiner + staleness in `computeBenchmark` (Task 2), Dune wiring + block-timestamp read in `getBenchmarkMid` (Task 3).
- `packages/ingest/src/benchmarkPrice.test.ts` — MODIFY: divergence + combiner unit tests (Tasks 1, 2).
- `packages/ingest/src/duneOracle.ts` — CREATE: Dune ETH/USD adapter + `OffChainOracle` type (Task 3).
- `packages/ingest/src/duneOracle.test.ts` — CREATE: adapter parse/unavailable tests (Task 3).
- `packages/db/src/schema.ts` — MODIFY: 3 new nullable columns on `router_trades_gated` and `smoke_trades` (Task 4).
- `packages/db/drizzle/0010_benchmark_v2_oracle.sql` — CREATE: migration (Task 4).
- `packages/ingest/src/normalizeSmokeTrade.ts` — MODIFY: persist new bench fields (Task 4) + gas-via-mid (Task 5).
- `packages/ingest/src/decompose-gated.ts` — MODIFY: gas-via-mid (Task 5).
- `packages/ingest/src/tokenPricing.ts` — MODIFY: `precomputedWethUsd` override (Task 6).
- `packages/ingest/src/tokenPricing.test.ts` — MODIFY: override test (Task 6).

## Execution / parallelism note

Tasks 1→2→3→4 are **sequential** (all touch `benchmarkPrice.ts` / its consumers). Task 5 touches `normalizeSmokeTrade.ts`, also edited in Task 4 — run **Task 5 after Task 4**. Task 6 touches only `tokenPricing.ts(.test)` and is **independent** — it may run in parallel with the whole 1→5 chain.

---

### Task 1: Median-relative pool divergence (Section A)

**Files:**
- Modify: `packages/ingest/src/benchmarkPrice.ts` (function `computeBenchmark`)
- Test: `packages/ingest/src/benchmarkPrice.test.ts`

**Interfaces:**
- Consumes: existing `computeBenchmark(perPool, chainlinkPrice)` signature (unchanged in this task).
- Produces: `poolDivergenceBps` now means `max(|price − median|)/median × 1e4`. Same field name/type (`number`).

- [ ] **Step 1: Update the two affected existing tests to the new metric**

In `benchmarkPrice.test.ts`, change the divergence assertion in the first test (line ~16) and confirm the second still trips:

```ts
  it('3 agreeing pools + close oracle → high confidence, no flags', () => {
    const r = computeBenchmark([P('a', 3000), P('b', 3001), P('c', 2999)], 3000);
    expect(r.marketMid).toBe(3000);
    // median-relative: max(|3001-3000|,|2999-3000|)/3000 × 1e4 = 3.33
    expect(r.poolDivergenceBps).toBeCloseTo(3.33, 1);
    expect(r.manipulationSuspect).toBe(false);
    expect(r.lowConfidence).toBe(false);
    expect(r.flags).toEqual([]);
  });
```

- [ ] **Step 2: Add the exactly-2-pool divergence test (closes follow-up #3)**

Add inside `describe('computeBenchmark', ...)`:

```ts
  it('exactly 2 valid pools → half-spread divergence, no LOW_POOL_COVERAGE', () => {
    // median([3000,3030]) = 3015; |3000-3015|/3015 × 1e4 = 49.75
    const r = computeBenchmark([P('a', 3000), P('b', 3030), P('c', null)], 3015);
    expect(r.marketMid).toBe(3015);
    expect(r.poolDivergenceBps).toBeCloseTo(49.75, 1);
    expect(r.flags).not.toContain('LOW_POOL_COVERAGE');
    expect(r.flags).toContain('POOL_DIVERGENCE');
  });
```

- [ ] **Step 3: Run the tests to verify the new expectations fail**

Run: `npm run test --workspace packages/ingest -- benchmarkPrice`
Expected: FAIL — `poolDivergenceBps` is still the old `(max−min)/median` value (6.67 and 19.9), not the new median-relative value.

- [ ] **Step 4: Change the divergence formula**

In `computeBenchmark`, replace the divergence computation (currently `((Math.max(...prices) - Math.min(...prices)) / marketMid) * 10_000`):

```ts
  } else {
    const maxDevFromMedian = Math.max(...prices.map((p) => Math.abs(p - marketMid)));
    poolDivergenceBps = (maxDevFromMedian / marketMid) * 10_000;
    if (poolDivergenceBps > DIVERGENCE_TOL_BPS) {
      flags.push('POOL_DIVERGENCE');
      lowConfidence = true;
    }
  }
```

- [ ] **Step 5: Update the doc comment on `DIVERGENCE_TOL_BPS`**

Change its comment to: `// Max single-pool deviation from the median (NOT full spread). ~half the old metric.`

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run test --workspace packages/ingest -- benchmarkPrice`
Expected: PASS (all cases).

- [ ] **Step 7: Commit**

```bash
git add packages/ingest/src/benchmarkPrice.ts packages/ingest/src/benchmarkPrice.test.ts
git commit -m "feat(tca): median-relative pool divergence flag"
```

---

### Task 2: Consensus combiner + staleness in computeBenchmark (Section B1/B3)

**Files:**
- Modify: `packages/ingest/src/benchmarkPrice.ts` (`BenchmarkResult`, `computeBenchmark`)
- Test: `packages/ingest/src/benchmarkPrice.test.ts`

**Interfaces:**
- Produces (new pure signature — Task 3 consumes this):
```ts
interface OracleInput { price: number; stale: boolean }
function computeBenchmark(
  perPool: { label: string; price: number | null }[],
  oracles: { chainlink: OracleInput | null; offChain: OracleInput | null },
): BenchmarkResult
```
- `BenchmarkResult` gains: `offchainPrice: number | null`, `offchainDevBps: number | null`. (`chainlinkStalenessSecs`/`offchainAsOfSecs` are attached later by `getBenchmarkMid`, not by the pure fn.)
- New flags produced: `CHAINLINK_STALE`, `OFFCHAIN_UNAVAILABLE`, `ORACLE_DISAGREE`, `ORACLE_UNAVAILABLE`. Retained: `CHAINLINK_UNAVAILABLE`.

- [ ] **Step 1: Rewrite the oracle test cases for the new signature**

Replace the three oracle-related tests (the `MANIPULATION_SUSPECT`, `chainlink unavailable`, and add new ones). Use a helper:

```ts
const OK = (price: number, stale = false) => ({ price, stale });

  it('both oracles agree, median far from consensus → MANIPULATION_SUSPECT', () => {
    const r = computeBenchmark([P('a', 3000), P('b', 3001), P('c', 2999)],
      { chainlink: OK(2970), offChain: OK(2971) });
    expect(r.manipulationSuspect).toBe(true);
    expect(r.flags).toContain('MANIPULATION_SUSPECT');
    expect(r.lowConfidence).toBe(true);
  });

  it('both oracles agree, median close → no manipulation', () => {
    const r = computeBenchmark([P('a', 3000), P('b', 3001), P('c', 2999)],
      { chainlink: OK(3002), offChain: OK(3003) });
    expect(r.manipulationSuspect).toBe(false);
    expect(r.flags).not.toContain('MANIPULATION_SUSPECT');
    expect(r.lowConfidence).toBe(false);
  });

  it('oracles disagree with each other → ORACLE_DISAGREE, no manipulation', () => {
    const r = computeBenchmark([P('a', 3000), P('b', 3001), P('c', 2999)],
      { chainlink: OK(3000), offChain: OK(2950) });
    expect(r.flags).toContain('ORACLE_DISAGREE');
    expect(r.manipulationSuspect).toBe(false);
    expect(r.lowConfidence).toBe(true);
  });

  it('stale chainlink + usable offchain → CHAINLINK_STALE, manipulation judged on offchain only', () => {
    const r = computeBenchmark([P('a', 3000), P('b', 3001), P('c', 2999)],
      { chainlink: OK(2970, true), offChain: OK(3001) });
    expect(r.flags).toContain('CHAINLINK_STALE');
    expect(r.manipulationSuspect).toBe(false); // stale chainlink can't assert manipulation
    expect(r.lowConfidence).toBe(true);        // staleness alone downgrades
  });

  it('chainlink only (offchain null) → single-oracle path', () => {
    const r = computeBenchmark([P('a', 3000), P('b', 3001), P('c', 2999)],
      { chainlink: OK(2970), offChain: null });
    expect(r.flags).toContain('OFFCHAIN_UNAVAILABLE');
    expect(r.manipulationSuspect).toBe(true);
    expect(r.chainlinkDevBps).toBeCloseTo(101.01, 1);
  });

  it('both oracles null → ORACLE_UNAVAILABLE, no manipulation, confidence untouched by oracle step', () => {
    const r = computeBenchmark([P('a', 3000), P('b', 3001), P('c', 2999)],
      { chainlink: null, offChain: null });
    expect(r.flags).toContain('CHAINLINK_UNAVAILABLE');
    expect(r.flags).toContain('OFFCHAIN_UNAVAILABLE');
    expect(r.flags).toContain('ORACLE_UNAVAILABLE');
    expect(r.manipulationSuspect).toBe(false);
    expect(r.lowConfidence).toBe(false);
  });
```

Also update the pool-only tests from Task 1 to pass `{ chainlink: OK(<n>), offChain: OK(<n>) }` (or `{ chainlink: null, offChain: null }` where the oracle is irrelevant) instead of a bare number.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --workspace packages/ingest -- benchmarkPrice`
Expected: FAIL — `computeBenchmark` still takes `(perPool, chainlinkPrice: number | null)`; new signature/flags don't exist.

- [ ] **Step 3: Extend `BenchmarkResult` and add the `OracleInput` type**

In `benchmarkPrice.ts`, add above `BenchmarkResult`:

```ts
export interface OracleInput { price: number; stale: boolean }
```

Add to `BenchmarkResult`:

```ts
  offchainPrice: number | null;
  offchainDevBps: number | null;
```

- [ ] **Step 4: Rewrite the oracle block of `computeBenchmark`**

Replace the current `chainlinkPrice` parameter and the whole Chainlink block (from `let chainlinkDevBps` through the end of the manipulation `if`) with:

```ts
export function computeBenchmark(
  perPool: { label: string; price: number | null }[],
  oracles: { chainlink: OracleInput | null; offChain: OracleInput | null },
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
    const maxDevFromMedian = Math.max(...prices.map((p) => Math.abs(p - marketMid)));
    poolDivergenceBps = (maxDevFromMedian / marketMid) * 10_000;
    if (poolDivergenceBps > DIVERGENCE_TOL_BPS) {
      flags.push('POOL_DIVERGENCE');
      lowConfidence = true;
    }
  }

  const devBps = (oracle: number) => (Math.abs(marketMid - oracle) / oracle) * 10_000;

  // Record raw deviations (vs. each oracle's own price) for audit, regardless of usability.
  const chainlinkPrice = oracles.chainlink?.price ?? null;
  const offchainPrice = oracles.offChain?.price ?? null;
  const chainlinkDevBps = chainlinkPrice != null ? devBps(chainlinkPrice) : null;
  const offchainDevBps = offchainPrice != null ? devBps(offchainPrice) : null;

  // Availability flags.
  if (oracles.chainlink == null) flags.push('CHAINLINK_UNAVAILABLE');
  if (oracles.offChain == null) flags.push('OFFCHAIN_UNAVAILABLE');

  // Staleness flags (oracle present but stale → downgrade, not usable for manipulation).
  if (oracles.chainlink?.stale) { flags.push('CHAINLINK_STALE'); lowConfidence = true; }
  if (oracles.offChain?.stale) { flags.push('OFFCHAIN_STALE'); lowConfidence = true; }

  const usable: number[] = [];
  if (oracles.chainlink && !oracles.chainlink.stale) usable.push(oracles.chainlink.price);
  if (oracles.offChain && !oracles.offChain.stale) usable.push(oracles.offChain.price);

  let manipulationSuspect = false;
  if (usable.length === 0) {
    flags.push('ORACLE_UNAVAILABLE'); // cannot assert manipulation
  } else if (usable.length === 1) {
    if (devBps(usable[0]!) > MANIPULATION_TOL_BPS) {
      manipulationSuspect = true; flags.push('MANIPULATION_SUSPECT'); lowConfidence = true;
    }
  } else {
    const [c, o] = usable as [number, number];
    const mutualDevBps = (Math.abs(c - o) / ((c + o) / 2)) * 10_000;
    if (mutualDevBps > MANIPULATION_TOL_BPS) {
      flags.push('ORACLE_DISAGREE'); lowConfidence = true; // can't tell which is right
    } else {
      const consensus = (c + o) / 2;
      if ((Math.abs(marketMid - consensus) / consensus) * 10_000 > MANIPULATION_TOL_BPS) {
        manipulationSuspect = true; flags.push('MANIPULATION_SUSPECT'); lowConfidence = true;
      }
    }
  }

  return {
    marketMid, perPool, poolDivergenceBps,
    chainlinkPrice, chainlinkDevBps,
    offchainPrice, offchainDevBps,
    manipulationSuspect, flags, lowConfidence,
  };
}
```

(Add `OFFCHAIN_STALE` to the documented flag set; it mirrors `CHAINLINK_STALE`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test --workspace packages/ingest -- benchmarkPrice`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ingest/src/benchmarkPrice.ts packages/ingest/src/benchmarkPrice.test.ts
git commit -m "feat(tca): two-oracle consensus manipulation check + staleness flags"
```

---

### Task 3: Dune oracle adapter + getBenchmarkMid wiring (Section B2)

**Files:**
- Create: `packages/ingest/src/duneOracle.ts`
- Create: `packages/ingest/src/duneOracle.test.ts`
- Modify: `packages/ingest/src/benchmarkPrice.ts` (`getBenchmarkMid`, `BenchmarkResult`)

**Interfaces:**
- Consumes: `computeBenchmark(perPool, { chainlink, offChain })` from Task 2.
- Produces:
```ts
type OffChainPrice = { price: number; asOfSecs: number } | null;
type OffChainOracle = (unixSecs: number) => Promise<OffChainPrice>;
function makeDuneEthUsdOracle(apiKey: string): OffChainOracle;
```
- `getBenchmarkMid(args: { rpcUrl; blockNumber; offChainOracle?: OffChainOracle })` — `offChainOracle` optional so existing callers compile; defaults to a Dune oracle built from `process.env.DUNE_API_KEY`, or a no-op (`async () => null`) when the key is absent.
- `BenchmarkResult` additionally carries `chainlinkStalenessSecs: number | null` (attached by `getBenchmarkMid`, not the pure fn).

- [ ] **Step 1: Write the Dune adapter parse test**

Create `packages/ingest/src/duneOracle.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { parseDuneEthUsd, makeDuneEthUsdOracle } from './duneOracle.js';

describe('parseDuneEthUsd', () => {
  it('extracts price + asOf from a result row', () => {
    const out = parseDuneEthUsd({ result: { rows: [{ price: 3001.5, minute: '2026-06-29T12:00:00Z' }] } });
    expect(out).toEqual({ price: 3001.5, asOfSecs: Math.floor(Date.parse('2026-06-29T12:00:00Z') / 1000) });
  });
  it('returns null on empty rows', () => {
    expect(parseDuneEthUsd({ result: { rows: [] } })).toBeNull();
  });
  it('returns null on malformed payload', () => {
    expect(parseDuneEthUsd({})).toBeNull();
  });
});

describe('makeDuneEthUsdOracle', () => {
  it('returns null (never throws) when fetch rejects', async () => {
    const oracle = makeDuneEthUsdOracle('key', vi.fn().mockRejectedValue(new Error('network')));
    expect(await oracle(1_700_000_000)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test --workspace packages/ingest -- duneOracle`
Expected: FAIL — module `./duneOracle.js` does not exist.

- [ ] **Step 3: Implement the Dune adapter**

Create `packages/ingest/src/duneOracle.ts`:

```ts
/**
 * duneOracle.ts — minute-granular ETH/USD from Dune, as a second oracle for the
 * benchmark manipulation cross-check. Block-precise (≤ ~30s vs a 12s block),
 * unlike CoinGecko's hourly free history. Never throws — returns null on any
 * failure so the benchmark degrades to single-oracle.
 */
export type OffChainPrice = { price: number; asOfSecs: number } | null;
export type OffChainOracle = (unixSecs: number) => Promise<OffChainPrice>;

/** Dune query id returning columns `minute` (timestamptz) and `price` (eth/usd),
 *  parameterized by a `ts` (unix seconds) bind that selects the latest minute ≤ ts. */
export const DUNE_ETH_USD_QUERY_ID = 0; // TODO-OWNER: set to the saved Dune query id before enabling

export function parseDuneEthUsd(payload: unknown): OffChainPrice {
  const rows = (payload as { result?: { rows?: { price?: number; minute?: string }[] } })?.result?.rows;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows[0]!;
  if (typeof row.price !== 'number' || typeof row.minute !== 'string') return null;
  const asOfSecs = Math.floor(Date.parse(row.minute) / 1000);
  if (!Number.isFinite(asOfSecs)) return null;
  return { price: row.price, asOfSecs };
}

export function makeDuneEthUsdOracle(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): OffChainOracle {
  return async (unixSecs: number): Promise<OffChainPrice> => {
    try {
      const res = await fetchImpl(
        `https://api.dune.com/api/v1/query/${DUNE_ETH_USD_QUERY_ID}/results?limit=1`,
        { headers: { 'X-Dune-API-Key': apiKey, 'x-query-parameters': JSON.stringify({ ts: unixSecs }) } },
      );
      if (!res.ok) return null;
      return parseDuneEthUsd(await res.json());
    } catch {
      return null;
    }
  };
}
```

Note for the implementer: `DUNE_ETH_USD_QUERY_ID` must be set to the real saved-query id (a Dune query selecting the latest `prices.minute` ETH/USD row at-or-before the `ts` bind) before the live path is enabled. Until then the adapter still parses correctly and tests pass; the live oracle simply returns whatever that query yields.

- [ ] **Step 4: Run the adapter tests to verify they pass**

Run: `npm run test --workspace packages/ingest -- duneOracle`
Expected: PASS.

- [ ] **Step 5: Wire staleness + Dune into `getBenchmarkMid`**

In `benchmarkPrice.ts`: add `chainlinkStalenessSecs: number | null` to `BenchmarkResult`. Add the staleness constants near the existing tolerances:

```ts
export const MAX_CHAINLINK_STALENESS_SECS = 1200; // 20 min
export const MAX_OFFCHAIN_STALENESS_SECS = 1200;  // 20 min
```

Replace `getBenchmarkMid` with:

```ts
export async function getBenchmarkMid(args: {
  rpcUrl: string;
  blockNumber: bigint;
  offChainOracle?: OffChainOracle;
}): Promise<BenchmarkResult> {
  const client = createPublicClient({ chain: base, transport: http(args.rpcUrl) });
  const at = args.blockNumber - 1n;

  const offChainOracle: OffChainOracle = args.offChainOracle
    ?? (process.env.DUNE_API_KEY ? makeDuneEthUsdOracle(process.env.DUNE_API_KEY) : async () => null);

  const [perPool, block] = await Promise.all([
    Promise.all(
      BENCHMARK_POOLS.map(async (pool) => {
        const sqrtPriceX96 = await readSlot0Sqrt(client as PublicClient, pool.address, at);
        return { label: pool.label, price: sqrtPriceX96 === null ? null : sqrtPriceX96ToUsdcPerWeth(sqrtPriceX96) };
      }),
    ),
    client.getBlock({ blockNumber: at }),
  ]);
  const blockTs = Number(block.timestamp);

  // Chainlink
  let chainlink: OracleInput | null = null;
  let chainlinkStalenessSecs: number | null = null;
  try {
    const round = await client.readContract({
      address: CHAINLINK_ETH_USD, abi: CHAINLINK_ABI, functionName: 'latestRoundData', blockNumber: at,
    });
    const price = Number(round[1]) / 1e8;
    chainlinkStalenessSecs = blockTs - Number(round[3]); // updatedAt is field index 3
    chainlink = { price, stale: chainlinkStalenessSecs > MAX_CHAINLINK_STALENESS_SECS };
  } catch {
    chainlink = null;
  }

  // Off-chain (Dune)
  let offChain: OracleInput | null = null;
  try {
    const off = await offChainOracle(blockTs);
    if (off) offChain = { price: off.price, stale: blockTs - off.asOfSecs > MAX_OFFCHAIN_STALENESS_SECS };
  } catch {
    offChain = null;
  }

  return { ...computeBenchmark(perPool, { chainlink, offChain }), chainlinkStalenessSecs };
}
```

Add `import { makeDuneEthUsdOracle, type OffChainOracle } from './duneOracle.js';` at the top. Replace the earlier `client as never` cast with `client as PublicClient` (closes follow-up #2).

- [ ] **Step 6: Run the full ingest test suite to verify nothing regressed**

Run: `npm run test --workspace packages/ingest -- benchmarkPrice duneOracle`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/ingest/src/duneOracle.ts packages/ingest/src/duneOracle.test.ts packages/ingest/src/benchmarkPrice.ts
git commit -m "feat(tca): Dune second oracle + block-timestamp staleness wiring"
```

---

### Task 4: Persist new benchmark fields (Section B persistence)

**Files:**
- Modify: `packages/db/src/schema.ts` (`router_trades_gated` ~line 179-182, `smoke_trades` ~line 230-233)
- Create: `packages/db/drizzle/0010_benchmark_v2_oracle.sql`
- Modify: `packages/ingest/src/normalizeSmokeTrade.ts` (the `getBenchmarkMid` result handling + the smoke row write)

**Interfaces:**
- Consumes: `BenchmarkResult.offchainPrice`, `.offchainDevBps`, `.chainlinkStalenessSecs` from Task 3.
- Produces: 3 nullable columns `offchain_price`, `offchain_dev_bps`, `chainlink_staleness_secs` on both tables.

- [ ] **Step 1: Add columns to the schema**

In `packages/db/src/schema.ts`, after `manipulationFlag: boolean('manipulation_flag'),` in **both** `router_trades_gated` and `smoke_trades`:

```ts
		offchainPrice: numeric('offchain_price'),
		offchainDevBps: numeric('offchain_dev_bps'),
		chainlinkStalenessSecs: numeric('chainlink_staleness_secs'),
```

- [ ] **Step 2: Write the migration**

Create `packages/db/drizzle/0010_benchmark_v2_oracle.sql`:

```sql
ALTER TABLE "router_trades_gated" ADD COLUMN "offchain_price" numeric;--> statement-breakpoint
ALTER TABLE "router_trades_gated" ADD COLUMN "offchain_dev_bps" numeric;--> statement-breakpoint
ALTER TABLE "router_trades_gated" ADD COLUMN "chainlink_staleness_secs" numeric;--> statement-breakpoint
ALTER TABLE "smoke_trades" ADD COLUMN "offchain_price" numeric;--> statement-breakpoint
ALTER TABLE "smoke_trades" ADD COLUMN "offchain_dev_bps" numeric;--> statement-breakpoint
ALTER TABLE "smoke_trades" ADD COLUMN "chainlink_staleness_secs" numeric;
```

- [ ] **Step 3: Persist the fields where the smoke row is built**

In `normalizeSmokeTrade.ts`, the `bench` result already flows in via `getBenchmarkMid` (line ~178). Find where `chainlinkPrice`/`chainlinkDevBps`/`poolDivergenceBps`/`manipulationFlag` are passed into `buildSmokeRow` (search `benchFlags`/`bench.` usages) and add alongside them:

```ts
			offchainPrice: bench.offchainPrice,
			offchainDevBps: bench.offchainDevBps,
			chainlinkStalenessSecs: bench.chainlinkStalenessSecs,
```

Thread these through `buildSmokeRow`'s args/row object the same way the existing `chainlinkPrice` etc. are threaded (mirror those exact field names; they are stored as strings via Drizzle `numeric`, so apply the same `String(...)`/null handling the existing bench fields use).

- [ ] **Step 4: Build the DB + ingest packages to typecheck the new columns**

Run: `npm run build --workspace packages/db && npm run test --workspace packages/ingest -- normalizeSmokeTrade`
Expected: db build clean; normalizeSmokeTrade tests PASS (pre-existing unrelated tsc errors in other ingest scripts, per follow-up #7, are not introduced by this task).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle/0010_benchmark_v2_oracle.sql packages/ingest/src/normalizeSmokeTrade.ts
git commit -m "feat(db): persist offchain oracle + chainlink staleness columns"
```

---

### Task 5: Gas valuation through the benchmark mid (Section C1)

**Files:**
- Modify: `packages/ingest/src/normalizeSmokeTrade.ts:122-123`
- Modify: `packages/ingest/src/decompose-gated.ts:89-92`
- Test: `packages/ingest/src/normalizeSmokeTrade.test.ts`

**Interfaces:**
- Consumes: `args.marketMid` (already in `buildSmokeRow` args) / the gated path's `marketMid`.
- Produces: `gasCostUsd = gasCostEth × marketMid` (was `× realizedPrice`).

- [ ] **Step 1: Add a failing test asserting gas uses marketMid, not realizedPrice**

In `normalizeSmokeTrade.test.ts`, add a case to whichever `describe` exercises `buildSmokeRow` with a fixture where `marketMid ≠ realizedPrice`. Assert:

```ts
    // gasCostUsd must use the benchmark mid, not the trade's realized price
    const gasCostEth = (Number(gasUsed) * Number(effectiveGasPriceWei)) / 1e18;
    expect(row.gasCostUsd).toBeCloseTo(gasCostEth * marketMid, 6);
    expect(row.gasCostUsd).not.toBeCloseTo(gasCostEth * realizedPrice, 6);
```

(Pick fixture numbers so `marketMid` and `realizedPrice` differ by > the assertion precision — e.g. `marketMid = 3000`, a trade whose `realizedPrice ≈ 3015`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test --workspace packages/ingest -- normalizeSmokeTrade`
Expected: FAIL — `gasCostUsd` currently equals `gasCostEth × realizedPrice`.

- [ ] **Step 3: Change the smoke-path gas valuation**

In `normalizeSmokeTrade.ts` line ~123:

```ts
	const gasCostEth = (Number(args.gasUsed) * Number(args.effectiveGasPriceWei)) / 1e18;
	const gasCostUsd = gasCostEth * args.marketMid;
```

- [ ] **Step 4: Change the gated-path gas valuation**

In `decompose-gated.ts` line ~92, replace `const gasCostUsd = gasCostEth * realizedPrice;` with `const gasCostUsd = gasCostEth * marketMid;` (the gated path's benchmark mid variable; confirm its in-scope name — it is the `marketMid`/`market_mid` already read for `allInCostBps` in that function).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test --workspace packages/ingest -- normalizeSmokeTrade`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ingest/src/normalizeSmokeTrade.ts packages/ingest/src/decompose-gated.ts packages/ingest/src/normalizeSmokeTrade.test.ts
git commit -m "fix(tca): value gas at benchmark mid, not realized price"
```

---

### Task 6: tokenPricing precomputed WETH price override (Section C2)

**Files:**
- Modify: `packages/ingest/src/tokenPricing.ts` (`getPairMidAtBlock`, `getTokenUsdcValue`)
- Test: `packages/ingest/src/tokenPricing.test.ts`

**Interfaces:**
- Produces: optional trailing param `precomputedWethUsd?: number` on both `getPairMidAtBlock` and `getTokenUsdcValue`. When the token is WETH and the value is provided, use it and perform **no** pool read.

- [ ] **Step 1: Write the failing test (no pool read when override provided)**

In `tokenPricing.test.ts`, add:

```ts
  it('getTokenUsdcValue uses precomputedWethUsd for WETH without any pool read', async () => {
    const client = { readContract: vi.fn() } as unknown as PublicClient; // throws if used
    const decimalsOf = async () => 18;
    const WETH = '0x4200000000000000000000000000000000000006';
    const oneWeth = 10n ** 18n;
    const val = await getTokenUsdcValue(client, WETH, oneWeth, 100n, decimalsOf, 3000);
    expect(val).toBeCloseTo(3000, 6);
    expect((client.readContract as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
```

(Import `vi` and `PublicClient` if not already imported in the test file.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test --workspace packages/ingest -- tokenPricing`
Expected: FAIL — `getTokenUsdcValue` has no 6th parameter; the WETH branch calls `getPairMidAtBlock` (a pool read).

- [ ] **Step 3: Add the override to `getPairMidAtBlock`**

Add a trailing optional param and short-circuit the WETH/USDC case. In `getPairMidAtBlock`'s signature add `precomputedWethUsd?: number,` after `fallbackPool?`. At the top of the body, after `sortTokens`, add:

```ts
  // Caller-supplied WETH/USD (e.g. the validated benchmark mid) wins over a pool read.
  if (precomputedWethUsd != null) {
    const aIsWeth = tokenA.toLowerCase() === WETH && tokenB.toLowerCase() === USDC;
    const bIsWeth = tokenB.toLowerCase() === WETH && tokenA.toLowerCase() === USDC;
    if (aIsWeth) return { price: precomputedWethUsd, poolAddress: 'precomputed', poolKind: 'precomputed' };
    if (bIsWeth) return { price: precomputedWethUsd > 0 ? 1 / precomputedWethUsd : 0, poolAddress: 'precomputed', poolKind: 'precomputed' };
  }
```

- [ ] **Step 4: Add the override to `getTokenUsdcValue`**

Add `precomputedWethUsd?: number,` to its signature (after `decimalsOf`). In the `tokenLc === WETH` branch, replace the body with:

```ts
  if (tokenLc === WETH) {
    if (precomputedWethUsd != null) return humanAmount * precomputedWethUsd;
    const mid = await getPairMidAtBlock(client, WETH, USDC, blockNumber, decimalsOf);
    if (mid === null) return null;
    return humanAmount * mid.price;
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test --workspace packages/ingest -- tokenPricing`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ingest/src/tokenPricing.ts packages/ingest/src/tokenPricing.test.ts
git commit -m "feat(tca): optional precomputed WETH/USD override in tokenPricing"
```

---

## Plan self-review

- **Spec coverage:** Section A → Task 1. Section B1 (staleness) → Tasks 2+3. B2 (Dune adapter) → Task 3. B3 (consensus) → Task 2. B persistence → Task 4. Section C1 → Task 5. C2 → Task 6. Out-of-scope items (TWAP, CoinGecko, ±100 gate, 165 backfill, processSwap) are untouched. ✓
- **Type consistency:** `OracleInput` (Task 2) is consumed by `getBenchmarkMid` (Task 3); `OffChainOracle`/`OffChainPrice` defined in Task 3 and imported into `benchmarkPrice.ts`; `BenchmarkResult` additions (`offchainPrice`, `offchainDevBps` in Task 2; `chainlinkStalenessSecs` in Task 3) are persisted by matching column names in Task 4. ✓
- **No backfill:** all new columns nullable; existing rows untouched (Global Constraints). ✓
- **Known caveat:** `DUNE_ETH_USD_QUERY_ID = 0` is a real placeholder the owner must set to the saved Dune query id before enabling the live oracle — flagged inline in Task 3, not silently omitted. Tests pass regardless since the adapter is fetch-injected/mocked.
```
