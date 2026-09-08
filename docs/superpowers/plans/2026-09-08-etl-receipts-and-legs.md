# ETL Derived Layer v0.2b-2 — `receipts` and `legs`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn decoded receipts into two queryable Parquet files — one row per trade, one row per leg — and run them over the pilot Seed's router-selected and full swap populations.

**Architecture:** A serial enrichment runner in `packages/etl` reads work from `candidates`, feeds `analyzeTransaction` from the Seed via `prefetched`, carries a `FactCache` across the whole run, and writes `receipts` + `legs` through the existing atomic Parquet writer. `packages/core` gains only what the row transforms need: raw leg amounts on the persisted leg, and the token cache family wired.

**Tech Stack:** TypeScript (ESM, NodeNext), `@duckdb/node-api` 1.5.5-r.4, viem, `vitest` 2.x.

**Spec:** `docs/superpowers/specs/2026-09-04-tca-etl-derived-layer-design.md` (§4 receipts, §5 legs, §8 staging)

---

## What is already measured — this plan is designed around these numbers, not hoping for them

All measured 2026-09-08 against the pilot Seed and the `2026-09-04a` candidates build.

**Decode yield and pricing tier.** The `/methodology` vocabulary is Verified (`tier: 'full'`) / Estimated (`'estimated'`) / Unavailable (`'none'`), defined at `packages/dashboard/components/receipt/priceFormat.ts:122`.

| | router-selected (535) | `swap_log` sample (199) |
|---|---|---|
| decoded | 340 (63.6%) | 79 (39.7%) |
| Verified | 50 — 14.7% of decoded | 5 — 6.3% |
| Estimated | 72 — 21.2% | 25 — 31.6% |
| Unavailable | 218 — 64.1% | 49 — 62.0% |
| route reconstructed | 180/340 — 53% | 71/79 — 90% |

**The Unavailable rate is the same in both populations**, so it is a property of what trades on Base, not of the router filter. Design the schema for a table that is ~62% Unavailable rather than being surprised by it.

**Projected full run:** ~5,500 receipts from 13,511 candidates, of which roughly **375 are Verified** (wide error bars — the sample's Verified cell is n=5).

**Runtime:** 581 ms/tx measured with `includeWings: false` + a warm `FactCache`, so **13,511 ≈ 2.2 hours** serial. Serial is not negotiable (see Global Constraints).

**Ruler coverage — the v0.3 gate, now answered.** 29 of 67 distinct market-price ruler pools (**43.3%**) traded inside the pilot window. So v0.3's `pool_state` idea — recovering pool state from Swap logs with no RPC — could serve at most ~43% of rulers. **This plan therefore does NOT include the ruler-coverage instrumentation the spec's §8 called for; it has been measured.** Record the result, do not re-derive it.

**`tier` and `pricing_status` disagree on real data.** Exactly 1 of 340 router receipts: `tier='full'`, `pricing_status='estimated'` (MAMO→cbBTC — a corroborated mid on a pair with no USD anchor). `pricing_status='full'` requires `tier==='full'` **and** a USD anchor (`pricing.ts`). Both columns are stored, and the label is derived from `pricing_status` to match the receipt page (Task 4).

## Global Constraints

- **Indentation: match the file being edited.** `packages/core` and `packages/etl` are tab-indented; `pricing.ts` is space-indented. Check, never assume.
- **ESM with explicit `.js` extensions on relative imports.** NodeNext resolution.
- **`noUncheckedIndexedAccess: true`** — `arr[0]` is `T | undefined`; indexed access needs `arr[0]!`. Test files ARE typechecked.
- **`exactOptionalPropertyTypes: true`** — an optional property cannot be explicitly assigned `undefined`; use a conditional spread.
- **`packages/etl` may import TYPES from `packages/core` freely, but a runtime VALUE import only through the subpath Task 2 adds.** core's `exports["."]` is `./src/index.ts`, so a value import from compiled ETL code dies at runtime with `ERR_UNKNOWN_FILE_EXTENSION`. `factCacheStore.ts` has a test pinning its own type-only discipline; do not weaken it.
- **`packages/core` must NOT gain a dependency on `@duckdb/node-api`.** It ships a native binary that must stay out of the dashboard's Railway build.
- **Every decode is SERIAL.** Concurrency makes the endpoint fail reads transiently, the decoder swallows those as evidence (`catch → null` = "no such pool"), and receipts come back quietly degraded. Determinism was measured at **535/535 identical over two serial passes**; that guarantee is serial-only. Never add a concurrency option to the runner.
- **Vitest runs from the REPO ROOT.** A worktree lives inside the repo and nothing excludes it, so a true count needs `npx vitest run --exclude '**/.claude/**'`; with `TCA_RPC_URL` set add `--no-file-parallelism`.
- **Expected full-suite baseline at the start of this plan: 1260 passed / 4 skipped.** Each task adds to it; **nothing existing may change.** If an existing test needs editing to pass, stop and report BLOCKED.
- `source .env` is blocked under the sandbox; parse `.env` inline in node probes.
- **Run long commands in the FOREGROUND.** Agents in the previous plan were stranded by backgrounding a suite and stopping while waiting on it.

### Verified DuckDB facts (tested 2026-09-08, do not re-derive)

- `read_json`'s `columns` spec accepts `'STRUCT(address VARCHAR, fee_bps DOUBLE, source VARCHAR, name VARCHAR)[]'` and `'VARCHAR[]'`, and round-trips empty arrays correctly. So `fee_sinks` is a real nested column queryable with `UNNEST`, not a JSON blob.
- `@duckdb/node-api` is hoisted to the repo-root `node_modules`, so scripts outside `packages/etl` can import it.

## File Structure

| File | Responsibility |
|---|---|
| `packages/etl/src/sql.ts` | `sqlLiteral`, moved out of the Parquet writer. New. |
| `packages/etl/src/writeParquet.ts` | Re-exports `sqlLiteral` from `./sql.js`; `seedColumnSpec` collapse. Modified. |
| `packages/core/package.json` | Adds a `./runtime` export subpath pointing at `dist`. Modified. |
| `packages/core/src/factCache.ts` | `chainId` and `protocol` discriminators. Modified. |
| `packages/etl/src/factCacheStore.ts` | Same two columns. Modified. |
| `packages/etl/src/derivedSchema.ts` | `RECEIPT_COLUMNS`, `LEG_COLUMNS`, version bump. Modified. |
| `packages/core/src/analyzeTransaction.ts` | Raw leg amounts on `toPersistedLeg`; token cache wiring. Modified. |
| `packages/core/src/cachedReaders.ts` | `cachedTokenReader`. Modified. |
| `packages/etl/src/receiptRows.ts` | Pure `Receipt` → receipt row and leg rows. New. |
| `packages/etl/src/buildReceipts.ts` | The serial enrichment runner. New. |
| `packages/etl/src/cliDerive.ts` | `etl-derive receipts` command. Modified. |

---

### Task 1: Two housekeeping refactors, batched

**Files:**
- Create: `packages/etl/src/sql.ts`
- Modify: `packages/etl/src/writeParquet.ts`, `packages/etl/src/schema.ts`, `packages/etl/src/index.ts`
- Test: `packages/etl/src/sql.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `sqlLiteral(value: string): string` from `./sql.js`, still re-exported from `./writeParquet.js` for existing callers.

**Context you need:** Both items are deferred cleanups from v0.2a's review, and both are pure moves with no behaviour change.

1. `sqlLiteral` lives in `writeParquet.ts` but is imported by `routerRegistry.ts` and `candidatesSql.ts` — a config loader and a SQL builder both reaching into the Parquet writer for string escaping. Task 8 adds a third consumer. Move it to a leaf.
2. `derivedColumnSpec(columns)` in `derivedSchema.ts` is `seedColumnSpec()` in `schema.ts` verbatim plus an empty-set guard. The Seed layer calling something named `derived*` is the wrong shape, so make `seedColumnSpec()` delegate: `seedColumnSpec()` becomes `derivedColumnSpec(SEED_COLUMNS)`.

⚠️ `schema.test.ts` asserts `seedColumnSpec()`'s exact output. It must pass **unmodified** — that is the proof the delegation is behaviour-preserving. If it needs editing, stop and report BLOCKED.

- [ ] **Step 1: Write the failing test**

Create `packages/etl/src/sql.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { sqlLiteral } from './sql.js';

describe('sqlLiteral', () => {
	it('wraps a plain value in single quotes', () => {
		expect(sqlLiteral('base')).toBe("'base'");
	});

	it('doubles an embedded single quote rather than emitting broken SQL', () => {
		expect(sqlLiteral("O'Router")).toBe("'O''Router'");
	});

	it('doubles every occurrence, not just the first', () => {
		expect(sqlLiteral("a'b'c")).toBe("'a''b''c'");
	});

	it('handles an empty string', () => {
		expect(sqlLiteral('')).toBe("''");
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/etl/src/sql.test.ts`
Expected: FAIL — `Failed to resolve import "./sql.js"`.

- [ ] **Step 3: Create the leaf**

Create `packages/etl/src/sql.ts`:

```ts
/**
 * sql.ts — SQL string helpers, with no dependency on anything else.
 *
 * `sqlLiteral` began life inside writeParquet.ts, but a config loader
 * (routerRegistry.ts) and two SQL builders import it, none of which has any
 * business reaching into the Parquet writer for string escaping. It lives here
 * so those callers depend on a leaf instead.
 */

/** SQL string literal escaping — inputs are ours, but a stray quote must not build broken SQL. */
export function sqlLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}
```

- [ ] **Step 4: Re-export from `writeParquet.ts` and delete its copy**

In `packages/etl/src/writeParquet.ts`, delete the local `sqlLiteral` function and add near the top:

```ts
import { sqlLiteral } from './sql.js';

// Re-exported so existing importers (routerRegistry.ts, candidatesSql.ts) keep
// working unchanged; new callers should import from './sql.js' directly.
export { sqlLiteral };
```

- [ ] **Step 5: Collapse the column-spec renderer**

In `packages/etl/src/schema.ts`, replace `seedColumnSpec`'s body with a delegation:

```ts
/**
 * Render SEED_COLUMNS as a DuckDB `read_json(columns := …)` struct literal.
 *
 * Delegates to derivedColumnSpec, which is the same renderer plus an empty-set
 * guard. Passing the types explicitly rather than letting DuckDB sniff them is
 * what makes the written Parquet deterministic: sniffing infers from the first
 * rows, so a chunk where every `tx_to` happened to be NULL could otherwise land
 * a different type than a chunk where one was set.
 */
export function seedColumnSpec(): string {
	return derivedColumnSpec(SEED_COLUMNS);
}
```

with `import { derivedColumnSpec } from './derivedSchema.js';` at the top.

⚠️ Check for an import cycle: `derivedSchema.ts` must not import from `schema.ts`. Read it first. If it does, move `derivedColumnSpec` into `sql.ts` instead and have both schema modules import it from there — say which you did and why.

- [ ] **Step 6: Export the leaf and run everything**

Add to `packages/etl/src/index.ts`:

```ts
export { sqlLiteral } from './sql.js';
```

Run: `npm run typecheck && npm run lint && npx vitest run --exclude '**/.claude/**' --no-file-parallelism`
Expected: 1260 + 4 new = 1264 passed / 4 skipped. **`schema.test.ts` and `writeParquet.test.ts` must pass unmodified.**

- [ ] **Step 7: Commit**

```bash
git add packages/etl/src/sql.ts packages/etl/src/sql.test.ts packages/etl/src/writeParquet.ts \
        packages/etl/src/schema.ts packages/etl/src/index.ts
git commit -m "refactor(etl): move sqlLiteral to a leaf, collapse the column-spec renderer"
```

---

### Task 2: A `./runtime` export subpath so compiled ETL can value-import core

**Files:**
- Modify: `packages/core/package.json`
- Test: `packages/etl/src/coreRuntimeImport.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: `@fabric-tca/core/runtime` → `./dist/index.js`, importable at runtime from compiled code.

**Context you need — and why this shape, not the obvious one.**

`packages/core/package.json` currently has:

```json
"exports": {
  ".": "./src/index.ts",
  "./pure": "./src/receiptPure.ts",
  "./log": "./src/log.ts"
}
```

Task 7's runner must **value**-import `analyzeTransaction` from compiled ETL code under `dist/`, and node cannot load a `.ts` file.

**The obvious fix — a conditional `"import"`/`"node"` condition on `"."` pointing at `./dist/index.js` — is wrong here, and I checked why.** `packages/dashboard/next.config.mjs` sets `transpilePackages: ['@fabric-tca/core']`, so Next compiles core's TypeScript source itself. Redirecting the default export to `dist` would make that setting inert, and would require `dist` to exist and be current for `next dev`, which does not run `tsc --build`. This repo has a documented history of silently broken deploys; do not touch the default.

So: **add a new subpath and leave every existing one alone.** Nothing that resolves today changes.

- [ ] **Step 1: Write the failing test**

Create `packages/etl/src/coreRuntimeImport.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

/**
 * The runtime bridge from compiled ETL code to core.
 *
 * `packages/core`'s default export is `./src/index.ts`, so a value import from
 * ETL compiles and passes vitest (which transpiles) then dies under `dist/`
 * with ERR_UNKNOWN_FILE_EXTENSION. `@fabric-tca/core/runtime` is the one path
 * that resolves to real JavaScript, and Task 7's runner depends on it.
 */
describe('@fabric-tca/core/runtime', () => {
	it('resolves to compiled JavaScript and exports analyzeTransaction', async () => {
		const mod = await import('@fabric-tca/core/runtime');
		expect(typeof mod.analyzeTransaction).toBe('function');
		expect(typeof mod.createMemoryFactCache).toBe('function');
		expect(typeof mod.fromSeedJson).toBe('function');
	});

	it('resolves to a .js file, not TypeScript source', async () => {
		const { createRequire } = await import('node:module');
		const require = createRequire(import.meta.url);
		const resolved = require.resolve('@fabric-tca/core/runtime');
		expect(resolved.endsWith('.js')).toBe(true);
		expect(resolved).toContain('dist');
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/etl/src/coreRuntimeImport.test.ts`
Expected: FAIL — the subpath is not exported.

- [ ] **Step 3: Add the subpath**

In `packages/core/package.json`, add ONE line to `exports`, changing nothing else:

```json
	"exports": {
		".": "./src/index.ts",
		"./runtime": "./dist/index.js",
		"./pure": "./src/receiptPure.ts",
		"./log": "./src/log.ts"
	},
```

⚠️ `./dist/index.js` only exists after `tsc --build`. Run `npm run typecheck` before the test.

- [ ] **Step 4: Run it to verify it passes**

Run: `npm run typecheck && npx vitest run packages/etl/src/coreRuntimeImport.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Prove the dashboard is unaffected**

This is the step that matters. Run each and paste the output:

```bash
npm run typecheck
npm run lint
npx vitest run --exclude '**/.claude/**' --no-file-parallelism
npm --workspace packages/dashboard run build
```

Expected: all clean, suite at 1264 + 2 = 1266 passed / 4 skipped, and **the dashboard build succeeds**.

⚠️ Read the memory note in `docs/` or ask before running a dashboard build if a dev server is live — a root build writes into the same `.next` directory `next dev` owns, producing an unstyled app that looks like a CSS bug. If a dev server is running, stop and report rather than guessing.

- [ ] **Step 6: Commit**

```bash
git add packages/core/package.json packages/etl/src/coreRuntimeImport.test.ts
git commit -m "feat(core): add a ./runtime export subpath for compiled consumers

The default export stays ./src/index.ts because the dashboard sets
transpilePackages and next dev does not run tsc --build. Nothing that
resolves today changes."
```

---

### Task 3: Chain and protocol discriminators on the `FactCache`

**Files:**
- Modify: `packages/core/src/factCache.ts`, `packages/core/src/factCache.test.ts`
- Modify: `packages/etl/src/factCacheStore.ts`, `packages/etl/src/factCacheStore.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `PoolKeyFact` gains `protocol: 'v4' | 'infinity'`; every `FactCache` accessor takes a `chainId`.

**Context you need.** Both gaps were raised by the v0.2b-1 branch review and deferred to this plan **on the explicit ground that no cache file exists on disk yet**, so adding a field costs nothing. That is still true — verify with `ls data/cache/` before starting. If files exist, stop and report: this becomes a migration, not an addition.

1. **No chain discriminator.** Chain scoping lives only in `cacheFilePath`'s filename. Pool addresses are not unique across chains, so the moment a second chain lands, one process holding a shared `FactCache` is silently wrong. The fix is a `chainId` on every key.
2. **v4 and Infinity share one `poolKeys` keyspace** with no protocol column. Collision is not the worry; provenance is — the table cannot answer "which protocol produced this row". `createDefaultV4PoolKeyReader` and `createDefaultInfinityPoolKeyReader` both produce `PoolKeyFact`s today and both write to the same map.

**Key shape:** make the composite explicit — `${chainId}:${poolId.toLowerCase()}` — rather than nesting maps. One map, one string key, and the persistence layer stores `chain_id` as its own column.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/factCache.test.ts`:

```ts
describe('FactCache chain scoping', () => {
	it('keeps the same pool address separate per chain', () => {
		// Pool addresses are NOT unique across chains. Without this, one process
		// serving two chains would serve Base's answer for a mainnet pool.
		const cache = createMemoryFactCache();
		cache.setPool(8453, '0xP', { factory: '0xbase' });
		cache.setPool(1, '0xP', { factory: '0xmainnet' });
		expect(cache.getPool(8453, '0xp')?.factory).toBe('0xbase');
		expect(cache.getPool(1, '0xp')?.factory).toBe('0xmainnet');
	});

	it('keeps pool keys and tokens separate per chain too', () => {
		const cache = createMemoryFactCache();
		cache.setPoolKey(8453, '0xID', { currency0: '0x1', currency1: '0x2', protocol: 'v4' });
		expect(cache.getPoolKey(1, '0xID')).toBeUndefined();
		cache.setToken(8453, '0xT', { decimals: 6, symbol: 'USDC' });
		expect(cache.getToken(1, '0xT')).toBeUndefined();
	});

	it('records which protocol produced a pool key', () => {
		// v4 and Infinity share one keyspace; without this the table cannot say
		// which reader wrote a row.
		const cache = createMemoryFactCache();
		cache.setPoolKey(8453, '0xa', { currency0: '0x1', currency1: '0x2', protocol: 'v4' });
		cache.setPoolKey(8453, '0xb', { currency0: '0x3', currency1: '0x4', protocol: 'infinity' });
		expect(cache.getPoolKey(8453, '0xa')?.protocol).toBe('v4');
		expect(cache.getPoolKey(8453, '0xb')?.protocol).toBe('infinity');
	});

	it('carries chainId through entries() for persistence', () => {
		const cache = createMemoryFactCache();
		cache.setPool(8453, '0xP', { factory: '0xf' });
		expect(cache.entries().pools).toEqual([[8453, '0xp', { factory: '0xf' }]]);
	});
});
```

Add to `packages/etl/src/factCacheStore.test.ts`:

```ts
describe('chain and protocol columns', () => {
	it('round-trips chain_id and protocol', async () => {
		await saveFactCacheEntries(
			{
				poolKeys: [[8453, '0xid', { currency0: '0x1', currency1: '0x2', protocol: 'infinity' }]],
				tokens: [[8453, '0xt', { decimals: 6, symbol: 'USDC' }]],
				pools: [[8453, '0xp', { factory: '0xf' }]],
			},
			{ dataDir: dir, chain: 'base' },
		);
		const back = await loadFactCacheEntries({ dataDir: dir, chain: 'base' });
		expect(back.poolKeys).toEqual([[8453, '0xid', { currency0: '0x1', currency1: '0x2', protocol: 'infinity' }]]);
		expect(back.pools).toEqual([[8453, '0xp', { factory: '0xf' }]]);
		expect(back.tokens).toEqual([[8453, '0xt', { decimals: 6, symbol: 'USDC' }]]);
	});

	it('refuses a pool key row with an unknown protocol rather than guessing', async () => {
		// A protocol we cannot name is a provenance hole, and this table is
		// supposed to close one.
		await expect(
			saveFactCacheEntries(
				{ poolKeys: [[8453, '0xid', { currency0: '0x1', currency1: '0x2', protocol: 'nope' as never }]], tokens: [], pools: [] },
				{ dataDir: dir, chain: 'base' },
			),
		).rejects.toThrow(/protocol/);
	});
});
```

⚠️ The existing tests in both files use the old signatures and **will fail to compile**. That is expected for this task and is the one place in this plan where changing existing tests is correct — they are being migrated, not weakened. Update them mechanically to the new signature; do not change what any of them asserts.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/core/src/factCache.test.ts packages/etl/src/factCacheStore.test.ts`
Expected: FAIL — signature mismatches.

- [ ] **Step 3: Update the core interface**

In `packages/core/src/factCache.ts`:

```ts
/** Which singleton protocol produced this pool key. v4 and Infinity share one keyspace. */
export type PoolProtocol = 'v4' | 'infinity';

export interface PoolKeyFact {
	currency0: string;
	currency1: string;
	protocol: PoolProtocol;
}

export interface FactCacheEntries {
	poolKeys: [number, string, PoolKeyFact][];
	tokens: [number, string, TokenFact][];
	pools: [number, string, PoolFact][];
}

export interface FactCache {
	getPoolKey(chainId: number, poolId: string): PoolKeyFact | undefined;
	setPoolKey(chainId: number, poolId: string, fact: PoolKeyFact): void;
	getToken(chainId: number, address: string): TokenFact | undefined;
	setToken(chainId: number, address: string, fact: TokenFact): void;
	getPool(chainId: number, address: string): PoolFact | undefined;
	setPool(chainId: number, address: string, fact: PoolFact): void;
	entries(): FactCacheEntries;
}
```

Add to the module docstring, above the existing three rules:

```
 * ⚠️ EVERY KEY IS SCOPED BY chainId. Pool and token addresses are NOT unique
 * across chains, so a process-global cache without this would serve one
 * chain's answer for another's address — silently, and permanently once
 * persisted. The composite key is `${chainId}:${address.toLowerCase()}`.
```

Implement with a single map per family keyed on the composite string, and have `entries()` split it back into `[chainId, key, fact]` triples. Keep the existing lowercase-on-the-way-in-and-out behaviour.

- [ ] **Step 4: Update the store**

In `packages/etl/src/factCacheStore.ts`, add `chain_id` to all three column specs and `protocol` to the pool-key spec:

```ts
const POOL_KEY_COLUMNS =
	"{'chain_id': 'INTEGER', 'pool_id': 'VARCHAR', 'currency0': 'VARCHAR', 'currency1': 'VARCHAR', 'protocol': 'VARCHAR'}";
const TOKEN_COLUMNS = "{'chain_id': 'INTEGER', 'address': 'VARCHAR', 'decimals': 'INTEGER', 'symbol': 'VARCHAR'}";
const POOL_COLUMNS =
	"{'chain_id': 'INTEGER', 'address': 'VARCHAR', 'token0': 'VARCHAR', 'token1': 'VARCHAR', 'fee_bps': 'DOUBLE', 'factory': 'VARCHAR'}";
```

Validate `protocol` on the way in AND out against `['v4', 'infinity']`, throwing with the offending value — follow the `requiredString` pattern already in that file. Order pool keys by `chain_id, pool_id` and the others by `chain_id, address`.

- [ ] **Step 5: Update the call sites**

`packages/core/src/cachedReaders.ts`'s three decorators now need a `chainId`. Take it as a parameter on each decorator factory — `cachedPoolKeyReader(inner, cache, chainId, protocol)` — rather than threading it through the reader signatures, which must stay compatible with `decomposeRoute`'s `deps`.

`analyzeTransaction.ts` already has `chainId` in scope; pass it, plus `'v4'` for the V4 reader and `'infinity'` for the Infinity one.

- [ ] **Step 6: Run everything**

Run: `npm run typecheck && npm run lint && npx vitest run --exclude '**/.claude/**' --no-file-parallelism`
Expected: clean. Existing assertions unchanged, only signatures migrated.

- [ ] **Step 7: Prove the decode is still identical**

The cache is on the decode path, so re-run the equivalence gate. `npm run typecheck` first, then:

```bash
node -e "
const fs = await import('node:fs');
const env = Object.fromEntries(fs.readFileSync('.env','utf8').split('\n').filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(), l.slice(i+1).trim()];}));
const { analyzeTransaction, createMemoryFactCache } = await import('./packages/core/dist/index.js');
const h = '0x602a6c5e9ff9f0aad0965e5414a21bc4a8c0fa99dd7b07bdebfeb91259660cab';
const url = env.TCA_RPC_URL;
const plain = await analyzeTransaction(h, 8453, { rpcUrl: url });
const cache = createMemoryFactCache();
const cold  = await analyzeTransaction(h, 8453, { rpcUrl: url, factCache: cache });
const warm  = await analyzeTransaction(h, 8453, { rpcUrl: url, factCache: cache });
console.log('cold identical to no-cache:', JSON.stringify(plain) === JSON.stringify(cold));
console.log('warm identical to cold    :', JSON.stringify(cold)  === JSON.stringify(warm));
const e = cache.entries();
console.log('cached:', e.poolKeys.length, 'poolKeys,', e.pools.length, 'pools');
console.log('poolKey rows carry chainId + protocol:', JSON.stringify(e.poolKeys[0] ?? null));
" --input-type=module
```

Expected: both `true`, and the sample row shows `[8453, '0x…', { …, protocol: 'v4' }]`.

⚠️ Determinism over 535 transactions was measured at 535/535 identical, so a `false` here is a real defect in your change, not RPC noise.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/factCache.ts packages/core/src/factCache.test.ts \
        packages/core/src/cachedReaders.ts packages/core/src/analyzeTransaction.ts \
        packages/etl/src/factCacheStore.ts packages/etl/src/factCacheStore.test.ts
git commit -m "feat(core,etl): scope FactCache keys by chain, record pool-key protocol"
```

---

### Task 4: `RECEIPT_COLUMNS` and `LEG_COLUMNS`

**Files:**
- Modify: `packages/etl/src/derivedSchema.ts`, `packages/etl/src/derivedSchema.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `RECEIPT_COLUMNS`, `LEG_COLUMNS`, `ReceiptRow`, `LegRow`, `priceConfidenceLabel(pricingStatus)`, and `DERIVED_SCHEMA_VERSION` bumped to 2.

**Context you need.** Read `packages/etl/src/derivedSchema.ts` first — this mirrors `CANDIDATE_COLUMNS`'s conventions exactly: insertion order IS Parquet column order, wei-scale quantities are VARCHAR decimal strings, and the tripwire is a VERSION tripwire (bump `DERIVED_SCHEMA_VERSION`), not a freeze.

**Five decisions this schema encodes, each measured or verified:**

1. **`price_confidence` is a stored column.** It carries the `/methodology` vocabulary — `Verified` | `Estimated` | `Unavailable` — derived from `pricing_status` to match the receipt page, whose `fallbackMethodology` at `packages/dashboard/components/receipt/priceFormat.ts:122` maps `'full'`→Verified, `'estimated'`→Estimated, anything else→Unavailable.
2. **`tier` is stored alongside it.** The two disagree on real data — 1 of 340 router receipts has `tier='full'` with `pricing_status='estimated'` (a corroborated mid on a pair with no USD anchor). Storing only one silently disagrees with the receipt page; storing both makes "corroborated but unanchored" queryable.
3. **`failure_reason` means failures get rows.** ~36% of router-selected and ~60% of `swap_log` candidates produce no receipt. A research table that omitted them could not compute its own coverage.
4. **`legs` carries raw amounts only, no decimals-scaled DOUBLEs.** The spec sketched both, but `toLegRows` is a pure function over a `Receipt` and token decimals are not on it — synthesising them would mean an RPC read inside a pure transform. Join to `data/cache/tokens.base.parquet` (Task 3/5) when a human-scaled amount is wanted; that table exists precisely so the scaling is a join rather than a re-read.
5. **`fee_sinks` is a real nested column**, `STRUCT(address VARCHAR, fee_bps DOUBLE, source VARCHAR, name VARCHAR)[]` — verified to work in a `read_json` columns spec, including empty arrays. Query it with `UNNEST`.

**Deliberately NOT included**, and do not add them: `market_mid_before`/`market_mid_after` (the wings — dropped in v0.2b-1), the Chainlink/offchain benchmark block (populated on 4 of 82 corpus receipts, and the oracle is inert), and `decode_stable`/`decode_unstable_fields` — determinism is a branch-level property measured at 535/535 over two serial passes, re-measurable any time with `decodeGolden.mjs determinism`, not a per-row column worth doubling a 2.2-hour run for.

- [ ] **Step 1: Write the failing test**

Add to `packages/etl/src/derivedSchema.test.ts`:

```ts
const RECEIPTS_V2: ReadonlyArray<readonly [string, string]> = [
	['tx_hash', 'VARCHAR'],
	['chain_id', 'INTEGER'],
	['block_number', 'BIGINT'],
	['block_position', 'INTEGER'],
	['block_timestamp', 'TIMESTAMP'],
	['aggregator', 'VARCHAR'],
	['router_address', 'VARCHAR'],
	['trader', 'VARCHAR'],
	['filler_address', 'VARCHAR'],
	['direction', 'VARCHAR'],
	['input_token', 'VARCHAR'],
	['output_token', 'VARCHAR'],
	['input_symbol', 'VARCHAR'],
	['output_symbol', 'VARCHAR'],
	['input_amount', 'DOUBLE'],
	['output_amount', 'DOUBLE'],
	['notional_usd', 'DOUBLE'],
	['realized_price', 'DOUBLE'],
	['market_mid', 'DOUBLE'],
	['all_in_cost_bps', 'DOUBLE'],
	['price_confidence', 'VARCHAR'],
	['pricing_status', 'VARCHAR'],
	['tier', 'VARCHAR'],
	['methodology', 'VARCHAR'],
	['market_price_flags', 'VARCHAR[]'],
	['reference_depth_usd', 'DOUBLE'],
	['reference_pool_address', 'VARCHAR'],
	['execution_bps', 'DOUBLE'],
	['lp_fee_bps', 'DOUBLE'],
	['agg_fee_bps', 'DOUBLE'],
	['slippage_bps', 'DOUBLE'],
	['gas_cost_usd', 'DOUBLE'],
	['route_pure', 'BOOLEAN'],
	['route_shape', 'VARCHAR'],
	['hop_count', 'INTEGER'],
	['route_reconstructed', 'BOOLEAN'],
	['recon_residual_bps', 'DOUBLE'],
	['decomp_confidence', 'VARCHAR'],
	['fee_recipient', 'VARCHAR'],
	['fee_sink_source', 'VARCHAR'],
	['fee_sinks', 'STRUCT(address VARCHAR, fee_bps DOUBLE, source VARCHAR, name VARCHAR)[]'],
	['integrator_fee_bps', 'DOUBLE'],
	['fabric_fee_bps', 'DOUBLE'],
	['settlement_event_name', 'VARCHAR'],
	['settlement_event_topic0', 'VARCHAR'],
	['settlement_event_seen', 'BOOLEAN'],
	['normalize_flags', 'VARCHAR[]'],
	['failure_reason', 'VARCHAR'],
	['core_git_sha', 'VARCHAR'],
	['rpc_source', 'VARCHAR'],
	['seed_file', 'VARCHAR'],
	['derived_at', 'TIMESTAMP'],
	['derived_schema_version', 'INTEGER'],
];

const LEGS_V2: ReadonlyArray<readonly [string, string]> = [
	['tx_hash', 'VARCHAR'],
	['leg_index', 'INTEGER'],
	['venue', 'VARCHAR'],
	['v4_emitter', 'VARCHAR'],
	['type', 'VARCHAR'],
	['token_in', 'VARCHAR'],
	['token_out', 'VARCHAR'],
	['symbol_in', 'VARCHAR'],
	['symbol_out', 'VARCHAR'],
	['amount_in_raw', 'VARCHAR'],
	['amount_out_raw', 'VARCHAR'],
	['fee_tier_bps', 'DOUBLE'],
	['lp_fee_bps', 'DOUBLE'],
	['fee_resolved', 'BOOLEAN'],
	['price_impact_bps', 'DOUBLE'],
	['notional_usdc', 'DOUBLE'],
	['notional_approx', 'BOOLEAN'],
	['frame_chain', 'VARCHAR[]'],
	['derived_schema_version', 'INTEGER'],
];

describe('receipts schema', () => {
	it('has these exact columns, in this order, with these types', () => {
		expect(Object.entries(RECEIPT_COLUMNS)).toEqual(RECEIPTS_V2.map(([n, t]) => [n, t]));
	});

	it('stores BOTH tier and pricing_status, because they disagree on real data', () => {
		// 1 of 340 router receipts: tier='full', pricing_status='estimated'
		// (a corroborated mid on a pair with no USD anchor). Storing one alone
		// silently disagrees with the receipt page.
		expect(RECEIPT_COLUMNS.tier).toBe('VARCHAR');
		expect(RECEIPT_COLUMNS.pricing_status).toBe('VARCHAR');
		expect(RECEIPT_COLUMNS.price_confidence).toBe('VARCHAR');
	});

	it('carries failure_reason so failures get rows and coverage is computable', () => {
		expect(RECEIPT_COLUMNS.failure_reason).toBe('VARCHAR');
	});

	it('does not carry the dropped wing or benchmark columns', () => {
		for (const dropped of [
			'market_mid_before', 'market_mid_after', 'chainlink_price', 'chainlink_dev_bps',
			'offchain_price', 'pool_divergence_bps', 'manipulation_flag', 'decode_stable',
		]) {
			expect(RECEIPT_COLUMNS[dropped as keyof typeof RECEIPT_COLUMNS]).toBeUndefined();
		}
	});
});

describe('legs schema', () => {
	it('has these exact columns, in this order, with these types', () => {
		expect(Object.entries(LEG_COLUMNS)).toEqual(LEGS_V2.map(([n, t]) => [n, t]));
	});

	it('stores raw leg amounts as VARCHAR, never a numeric type', () => {
		// Token amounts genuinely exceed 2^128 for high-supply 18-decimal
		// tokens, so DuckDB's widest integer cannot hold them. These come from
		// JS bigint via String(), which has no ceiling.
		expect(LEG_COLUMNS.amount_in_raw).toBe('VARCHAR');
		expect(LEG_COLUMNS.amount_out_raw).toBe('VARCHAR');
	});
});

describe('priceConfidenceLabel', () => {
	it('maps pricing_status to the /methodology vocabulary', () => {
		expect(priceConfidenceLabel('full')).toBe('Verified');
		expect(priceConfidenceLabel('estimated')).toBe('Estimated');
		expect(priceConfidenceLabel('partial')).toBe('Unavailable');
	});

	it('treats an unknown status as Unavailable rather than inventing a label', () => {
		expect(priceConfidenceLabel('something-new')).toBe('Unavailable');
	});
});

describe('DERIVED_SCHEMA_VERSION', () => {
	it('is at version 2 now that receipts and legs exist', () => {
		expect(DERIVED_SCHEMA_VERSION).toBe(2);
	});
});
```

Update the existing `it('is at version 1', …)` to expect 2 — this is the version tripwire firing as designed, and the file's own docstring says a bump is the correct response.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/etl/src/derivedSchema.test.ts`
Expected: FAIL — `RECEIPT_COLUMNS` is not exported.

- [ ] **Step 3: Implement**

Add to `packages/etl/src/derivedSchema.ts`, bumping `DERIVED_SCHEMA_VERSION` to 2 and adding the two column maps in exactly the order the test pins, plus:

```ts
/**
 * The /methodology vocabulary, derived from `pricing_status` so the table and
 * the receipt page agree. Mirrors fallbackMethodology in
 * packages/dashboard/components/receipt/priceFormat.ts.
 *
 * ⚠️ Derived from `pricing_status`, NOT `tier`. They disagree on real data —
 * 1 of 340 router receipts had tier='full' with pricing_status='estimated', a
 * corroborated mid on a pair with no USD anchor. Both columns are stored so
 * that case is queryable rather than erased; this label follows the UI.
 */
export function priceConfidenceLabel(pricingStatus: string): string {
	if (pricingStatus === 'full') return 'Verified';
	if (pricingStatus === 'estimated') return 'Estimated';
	return 'Unavailable';
}
```

Write `ReceiptRow` and `LegRow` interfaces mirroring the maps exactly, following `CandidateRow`'s conventions. Document on `RECEIPT_COLUMNS` that ~62% of rows are Unavailable in both measured populations, so the cost columns are mostly NULL by nature rather than by defect.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/etl/src/derivedSchema.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite, typecheck, lint, commit**

```bash
npm run typecheck && npm run lint && npx vitest run --exclude '**/.claude/**' --no-file-parallelism
git add packages/etl/src/derivedSchema.ts packages/etl/src/derivedSchema.test.ts
git commit -m "feat(etl): receipts and legs schemas, DERIVED_SCHEMA_VERSION 2"
```

---

### Task 5: Raw leg amounts, and the token cache wired

**Files:**
- Modify: `packages/core/src/analyzeTransaction.ts`, `packages/core/src/analyzeTransaction.test.ts`
- Modify: `packages/core/src/cachedReaders.ts`, `packages/core/src/cachedReaders.test.ts`

**Interfaces:**
- Consumes: `FactCache` with chain-scoped accessors (Task 3).
- Produces: `toPersistedLeg` output gains `amountInRaw`/`amountOutRaw` (decimal strings) and `notionalApprox`; `cachedTokenReader(inner, cache, chainId)`.

**Context — two independent changes, both small, both on the decode path.**

**(a) Raw leg amounts.** `routeGraph.Leg` carries `amountInRaw`/`amountOutRaw` as `bigint` (`routeGraph.ts:19-20`), and `LegFeeInput.leg` is a full `Leg`, so `toPersistedLeg` already receives them — its parameter type just narrows them away. Widen the parameter and emit them.

⚠️ **They must be emitted as decimal STRINGS, not bigints.** `Receipt.routeLegs` is JSON-serialized, and `JSON.stringify` throws on a bigint. `String(bigint)` is exact and unbounded, which is what the VARCHAR column in Task 4 expects.

This is additive and safe for the dashboard: its `RouteLeg` (`packages/dashboard/lib/legRouterEnrichment.ts:4`) is a structural interface read through a cast, so extra fields are inert there.

Also emit `notionalApprox` from `LegFeeInput` — it says whether the leg's notional is trustworthy, and a research table wants that beside the number.

**(b) The token cache.** `TokenFact` carries decimals AND symbol, resolved by two different readers, and v0.2b-1 deliberately left the family unwired because a decimals-only write would make a later symbol lookup a cache hit on a symbol nobody read — turning "unknown" into "has no symbol", permanently. Wire it correctly now: `createDefaultMidReader`'s `decimalsReader` (`(token: string) => Promise<number>`) and `resolveLegSymbols`'s `readSymbol` together.

⚠️ **`decimalsReader` THROWS on failure and must keep throwing** — that is what makes a successful read unambiguous and safe to cache. Do not catch it in the decorator.

⚠️ **Write a `TokenFact` only when you have both fields.** If only decimals is known, do not write a partial fact. Simplest correct approach: cache decimals under a hit only when a symbol is also present, or store the two independently — pick one and explain it in the docstring.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/analyzeTransaction.test.ts`:

```ts
describe('toPersistedLeg raw amounts', () => {
	const base = {
		leg: {
			venue: '0xpool', type: 'univ3', tokenIn: '0xa', tokenOut: '0xb',
			amountInRaw: 1_000_000_000_000_000_000n, amountOutRaw: 1_800_000_000n,
		},
		feeTierBps: 30, notionalUsdc: 1800, notionalApprox: false,
		lpFeeBps: 5, priceImpactBps: 2,
	};

	it('emits raw amounts as exact decimal strings', () => {
		const out = toPersistedLeg(base, undefined);
		expect(out.amountInRaw).toBe('1000000000000000000');
		expect(out.amountOutRaw).toBe('1800000000');
	});

	it('emits a value larger than 2^128 without loss', () => {
		// Token amounts genuinely exceed what DuckDB's widest integer holds, so
		// a numeric round-trip would silently truncate.
		const huge = 2n ** 200n;
		const out = toPersistedLeg({ ...base, leg: { ...base.leg, amountInRaw: huge } }, undefined);
		expect(out.amountInRaw).toBe(huge.toString());
	});

	it('survives JSON.stringify, which a bigint would not', () => {
		expect(() => JSON.stringify(toPersistedLeg(base, undefined))).not.toThrow();
	});

	it('carries notionalApprox through', () => {
		expect(toPersistedLeg({ ...base, notionalApprox: true }, undefined).notionalApprox).toBe(true);
	});
});
```

Add to `packages/core/src/cachedReaders.test.ts`:

```ts
describe('cachedTokenReader', () => {
	it('serves a complete cached fact without calling through', async () => {
		let calls = 0;
		const inner = async () => { calls++; return 18; };
		const cache = createMemoryFactCache();
		cache.setToken(8453, '0xa', { decimals: 6, symbol: 'USDC' });
		expect(await cachedTokenReader(inner, cache, 8453)('0xA')).toBe(6);
		expect(calls).toBe(0);
	});

	it('lets a THROWN read propagate and caches nothing', async () => {
		// decimalsReader throwing is what makes a successful read unambiguous.
		// Swallowing it here would turn a transport failure into a cached fact.
		let calls = 0;
		const inner = async () => { calls++; throw new Error('read failed'); };
		const cache = createMemoryFactCache();
		const reader = cachedTokenReader(inner, cache, 8453);
		await expect(reader('0xa')).rejects.toThrow(/read failed/);
		await expect(reader('0xa')).rejects.toThrow(/read failed/);
		expect(calls).toBe(2);
		expect(cache.entries().tokens).toEqual([]);
	});

	it('scopes by chain', async () => {
		const cache = createMemoryFactCache();
		cache.setToken(8453, '0xa', { decimals: 6, symbol: 'USDC' });
		let calls = 0;
		const inner = async () => { calls++; return 18; };
		expect(await cachedTokenReader(inner, cache, 1)('0xa')).toBe(18);
		expect(calls).toBe(1);
	});
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/core/src/analyzeTransaction.test.ts packages/core/src/cachedReaders.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Widen `toPersistedLeg`**

In `packages/core/src/analyzeTransaction.ts`, add `amountInRaw: bigint; amountOutRaw: bigint` to the `leg` shape in the parameter type and `notionalApprox: boolean` alongside `notionalUsdc`, then emit:

```ts
		// Exact decimal strings, never bigints: Receipt.routeLegs is
		// JSON-serialized and JSON.stringify throws on a bigint. String(bigint)
		// is exact and unbounded, which is what the VARCHAR column expects —
		// token amounts genuinely exceed what any Parquet integer type holds.
		amountInRaw: String(l.leg.amountInRaw),
		amountOutRaw: String(l.leg.amountOutRaw),
		notionalApprox: l.notionalApprox,
```

- [ ] **Step 4: Add `cachedTokenReader` and wire it**

In `packages/core/src/cachedReaders.ts`, add the decorator. Document clearly which of the two approaches you took for the partial-fact problem and why.

Wire it in `analyzeTransaction.ts` alongside the existing cached readers, wrapping `decimalsReader` from `createDefaultMidReader`.

- [ ] **Step 5: Run everything, then re-prove the decode**

```bash
npm run typecheck && npm run lint && npx vitest run --exclude '**/.claude/**' --no-file-parallelism
```

Then re-run the Task 3 Step 7 equivalence probe verbatim. Expected: both `true`, and this time the cache reports a non-zero token count.

⚠️ A `false` is a real defect — determinism is 535/535.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/analyzeTransaction.ts packages/core/src/analyzeTransaction.test.ts \
        packages/core/src/cachedReaders.ts packages/core/src/cachedReaders.test.ts
git commit -m "feat(core): raw leg amounts on the persisted leg, token cache wired"
```

---

### Task 6: Pure `Receipt` → row transforms

**Files:**
- Create: `packages/etl/src/receiptRows.ts`, `packages/etl/src/receiptRows.test.ts`
- Modify: `packages/etl/src/index.ts`

**Interfaces:**
- Consumes: `RECEIPT_COLUMNS`, `LEG_COLUMNS`, `priceConfidenceLabel`, `DERIVED_SCHEMA_VERSION` (Task 4); `Receipt` as a TYPE ONLY from `@fabric-tca/core`.
- Produces:
  - `toReceiptRow(receipt, tx: TxContext, run: RunContext): ReceiptRow`
  - `toFailureRow(args, tx: TxContext, run: RunContext): ReceiptRow`
  - `toLegRows(receipt): LegRow[]`
  - `interface RunContext { coreGitSha: string; rpcSource: string; seedFile: string; derivedAt: string }` — constant for a whole run
  - `interface TxContext { blockPosition: number; blockTimestamp: string }` — varies per transaction, read from `candidates`

⚠️ These are deliberately two objects. `blockPosition` and `blockTimestamp` differ for every transaction and come from the `candidates` row; the other four are fixed for the run. Folding them into one bag invites passing one transaction's position to another's row — the failure `buildSeedRows` guards against by joining on `transactionHash` rather than array index.

**Context you need.** These are pure functions over a `Receipt` — no RPC, no DuckDB, no I/O — which is what makes them unit-testable and what keeps the runner thin.

⚠️ **Type-only import from core.** `import type { Receipt } from '@fabric-tca/core'`. A value import here would compile and pass vitest then die under `dist/`. `factCacheStore.ts` has a test pinning this discipline for itself; do the same here.

⚠️ **`toFailureRow` is not an afterthought.** ~36% of router-selected and ~60% of `swap_log` candidates decode to `null`. Those rows carry identity, `failure_reason`, `price_confidence: 'Unavailable'`, and provenance; everything else is NULL. Without them the table cannot compute its own coverage.

⚠️ `routeLegs` on a `Receipt` is typed `unknown[] | null`. Cast it to the persisted-leg shape at the boundary and validate defensively — an absent field must become NULL, never `String(undefined)`.

- [ ] **Step 1: Write the failing test**

Create `packages/etl/src/receiptRows.test.ts` covering, at minimum:

```ts
import type { Receipt } from '@fabric-tca/core';
import { describe, expect, it } from 'vitest';
import { RECEIPT_COLUMNS, LEG_COLUMNS } from './derivedSchema.js';
import { toFailureRow, toLegRows, toReceiptRow } from './receiptRows.js';

const RUN = {
	coreGitSha: 'abc1234',
	rpcSource: 'quicknode-base-mainnet',
	seedFile: 'traces.base.0050842630-0050842929.parquet',
	derivedAt: '2026-09-08T12:00:00.000Z',
};
const TX = { blockPosition: 6, blockTimestamp: '2026-09-03T22:30:07.000Z' };

function receipt(over: Partial<Receipt> = {}): Receipt {
	return {
		txHash: '0xa', chainId: 8453, blockNumber: 50842671,
		aggregator: 'kyberswap', routerAddress: '0xr', trader: '0xt', fillerAddress: null,
		direction: 'sell', inputToken: '0xin', outputToken: '0xout',
		inputSymbol: 'A', outputSymbol: 'B', inputAmount: 1, outputAmount: 2,
		notionalUsd: 100, realizedPrice: 2, marketMid: 2.1,
		marketMidBefore: null, marketMidAfter: null,
		allInCostBps: 47, pricingStatus: 'estimated', tier: 'estimated',
		methodology: 'Estimated: …', marketPriceFlags: ['X'],
		referenceDepthUsd: 1234, referencePoolAddress: '0xp',
		executionBps: 40, lpFeeBps: 5, aggFeeBps: 2, slippageBps: 0, gasCostUsd: 0.01,
		routePure: true, routeShape: 'single', hopCount: 1, routeLegs: [],
		routeReconstructed: true, reconResidualBps: 0, decompConfidence: 'high',
		feeRecipient: null, feeSinkSource: null, feeSinks: [],
		integratorFeeBps: null, fabricFeeBps: null,
		settlementEventName: null, settlementEventTopic0: null, settlementEventSeen: false,
		normalizeFlags: [], chainlinkPrice: null, chainlinkDevBps: null,
		poolDivergenceBps: null, manipulationFlag: false, offchainPrice: null,
		offchainDevBps: null, chainlinkStalenessSecs: null,
		...over,
	} as Receipt;
}

describe('toReceiptRow', () => {
	it('emits exactly the declared columns, in declared order', () => {
		expect(Object.keys(toReceiptRow(receipt(), TX, RUN))).toEqual(Object.keys(RECEIPT_COLUMNS));
	});

	it('labels price_confidence from pricing_status, matching the receipt page', () => {
		expect(toReceiptRow(receipt({ pricingStatus: 'full' }), TX, RUN).price_confidence).toBe('Verified');
		expect(toReceiptRow(receipt({ pricingStatus: 'estimated' }), TX, RUN).price_confidence).toBe('Estimated');
		expect(toReceiptRow(receipt({ pricingStatus: 'partial' }), TX, RUN).price_confidence).toBe('Unavailable');
	});

	it('keeps tier and pricing_status independent when they disagree', () => {
		// The real case: MAMO->cbBTC, a corroborated mid with no USD anchor.
		const row = toReceiptRow(receipt({ tier: 'full', pricingStatus: 'estimated' }), TX, RUN);
		expect(row.tier).toBe('full');
		expect(row.pricing_status).toBe('estimated');
		expect(row.price_confidence).toBe('Estimated');
	});

	it('leaves failure_reason null on a successful decode', () => {
		expect(toReceiptRow(receipt(), TX, RUN).failure_reason).toBeNull();
	});
});

describe('toFailureRow', () => {
	it('emits exactly the declared columns, in declared order', () => {
		const row = toFailureRow({ txHash: '0xa', chainId: 8453, blockNumber: 1, failureReason: 'no receipt' }, TX, RUN);
		expect(Object.keys(row)).toEqual(Object.keys(RECEIPT_COLUMNS));
	});

	it('is Unavailable with the reason recorded and the cost columns null', () => {
		const row = toFailureRow({ txHash: '0xa', chainId: 8453, blockNumber: 1, failureReason: 'not a clean 2-token swap' }, TX, RUN);
		expect(row.price_confidence).toBe('Unavailable');
		expect(row.failure_reason).toBe('not a clean 2-token swap');
		expect(row.all_in_cost_bps).toBeNull();
		expect(row.tier).toBeNull();
	});
});

describe('toLegRows', () => {
	it('emits exactly the declared columns, in declared order', () => {
		const rows = toLegRows(receipt({ routeLegs: [{
			venue: '0xp', type: 'univ3', tokenIn: '0xa', tokenOut: '0xb',
			feeTierBps: 30, notionalUsdc: 100, notionalApprox: false,
			lpFeeBps: 5, priceImpactBps: 2, amountInRaw: '1', amountOutRaw: '2',
		}] }));
		expect(rows).toHaveLength(1);
		expect(Object.keys(rows[0]!)).toEqual(Object.keys(LEG_COLUMNS));
	});

	it('numbers legs in route order', () => {
		const leg = (v: string) => ({ venue: v, type: 'univ3', tokenIn: '0xa', tokenOut: '0xb',
			feeTierBps: 30, notionalUsdc: 1, notionalApprox: false, lpFeeBps: null,
			priceImpactBps: null, amountInRaw: '1', amountOutRaw: '2' });
		const rows = toLegRows(receipt({ routeLegs: [leg('0x1'), leg('0x2')] }));
		expect(rows.map((r) => [r.leg_index, r.venue])).toEqual([[0, '0x1'], [1, '0x2']]);
	});

	it('returns no rows when routeLegs is null', () => {
		expect(toLegRows(receipt({ routeLegs: null }))).toEqual([]);
	});

	it('nulls an absent optional rather than stringifying undefined', () => {
		// fee_resolved and frame_chain are OMITTED by core when they do not
		// apply. String(undefined) would write the literal "undefined".
		const rows = toLegRows(receipt({ routeLegs: [{
			venue: '0xp', type: 'univ3', tokenIn: '0xa', tokenOut: '0xb',
			feeTierBps: 30, notionalUsdc: 1, notionalApprox: false,
			lpFeeBps: null, priceImpactBps: null, amountInRaw: '1', amountOutRaw: '2',
		}] }));
		expect(rows[0]!.fee_resolved).toBeNull();
		expect(rows[0]!.frame_chain).toBeNull();
		expect(rows[0]!.v4_emitter).toBeNull();
	});
});

describe('module discipline', () => {
	it('imports only TYPES from @fabric-tca/core', async () => {
		const { readFileSync } = await import('node:fs');
		const src = readFileSync(new URL('./receiptRows.ts', import.meta.url), 'utf8');
		expect(src.match(/import\s+(?!type\b)[\s\S]*?from\s*['"]@fabric-tca\/core['"]/g)).toBeNull();
		expect(src).toMatch(/import type .*@fabric-tca\/core/);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/etl/src/receiptRows.test.ts`
Expected: FAIL — `Failed to resolve import "./receiptRows.js"`.

- [ ] **Step 3: Implement**

Create `packages/etl/src/receiptRows.ts`. Column order must match `RECEIPT_COLUMNS` and `LEG_COLUMNS` exactly — the tests assert it, and Task 7's writer depends on it.

- [ ] **Step 4: Run, export, verify, commit**

```bash
npx vitest run packages/etl/src/receiptRows.test.ts
# add: export { toFailureRow, toLegRows, toReceiptRow, type RowContext } from './receiptRows.js';
npm run typecheck && npm run lint && npx vitest run --exclude '**/.claude/**' --no-file-parallelism
git add packages/etl/src/receiptRows.ts packages/etl/src/receiptRows.test.ts packages/etl/src/index.ts
git commit -m "feat(etl): pure Receipt -> receipts/legs row transforms"
```

---

### Task 7: The serial enrichment runner and its CLI

**Files:**
- Create: `packages/etl/src/buildReceipts.ts`, `packages/etl/src/buildReceipts.test.ts`
- Modify: `packages/etl/src/cliDerive.ts`, `packages/etl/src/index.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces:
  - `interface BuildReceiptsOptions { seedGlob: string; seedFile: string; candidatesGlob: string; selectedVia: string[]; dataDir: string; build: string; chain: string; chainId: number; fromBlock: number; toBlock: number; rpcUrl: string; rpcSource: string; coreGitSha: string; limit?: number; onProgress?: (done: number, total: number) => void; now?: () => Date }`
  - `buildReceipts(opts): Promise<{ receiptsPath: string; legsPath: string; attempted: number; decoded: number; failed: number; legRows: number }>`

**Context — the runner's shape, and the three things that make it correct.**

1. **Serial, always.** Decode one transaction at a time. There is no concurrency option and there must not be: determinism was measured at 535/535 identical over two serial passes, and that guarantee is serial-only. A concurrent runner manufactures the exact degradation this whole layer exists to avoid.
2. **Fed from the Seed.** Use `prefetched` (`fromSeedJson`) so the run needs no archive node for the three payloads, and `includeWings: false` since no consumer wants the adjacent-block mids.
3. **One `FactCache` for the whole run**, loaded from disk at the start and saved at the end. That is where the saving compounds.

**Payload fetching must be chunked.** The Seed's `trace_json` averages ~17 KB and the full candidate set is 13,511 rows, so joining all payloads at once would hold hundreds of MB. Fetch payloads for a chunk of ~100 transactions, decode them, accumulate the (small) output rows, then fetch the next chunk.

**The runtime is ~2.2 hours for the full population** (581 ms/tx measured). Report progress; do not make the caller guess.

⚠️ **The runtime value import.** This module value-imports `analyzeTransaction`, `fromSeedJson` and `createMemoryFactCache`, so it must import them from **`@fabric-tca/core/runtime`** (Task 2), not `@fabric-tca/core`. Types may come from either. There is a test for this.

⚠️ `analyzeTransaction` returns `null` for anything that is not a clean two-token swap — that is the majority. Every `null` becomes a `toFailureRow`, never a skipped row.

- [ ] **Step 1: Write the failing test**

The runner must be testable without RPC, so `decode` is injectable — the CLI passes the real `analyzeTransaction`, tests pass a stub. Add to `BuildReceiptsOptions`:

```ts
	/** Injected so the runner is testable without a live endpoint. Defaults to
	 *  the real analyzeTransaction from '@fabric-tca/core/runtime'. */
	decode?: (hash: string, chainId: number, opts: Record<string, unknown>) => Promise<unknown>;
```

Create `packages/etl/src/buildReceipts.test.ts`:

```ts
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildReceipts } from './buildReceipts.js';
import { candidatesSelectSql, candidatesSetupSql, SWAP_TOPICS } from './candidatesSql.js';
import { LEG_COLUMNS, RECEIPT_COLUMNS } from './derivedSchema.js';
import { routerValuesSql } from './routerRegistry.js';
import type { SeedRow } from './schema.js';
import { copyQueryToParquet } from './writeParquet.js';
import { writeSeedParquet } from './writeSeedParquet.js';

const ROUTER = '0x1111111254eeb25477b68fb85ed929f73a960582';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'buildReceipts-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function seedRow(txHash: string, position: number, txTo: string): SeedRow {
	return {
		chain_id: 8453, block_number: 50842630 + position, block_position: position,
		tx_hash: txHash, block_timestamp: '2026-09-03T22:30:07.000Z',
		tx_from: '0xfrom', tx_to: txTo, tx_status: true, block_hash: '0xblock',
		trace_json: JSON.stringify({ type: 'CALL', from: '0xa', to: '0xb', calls: [] }),
		receipt_json: JSON.stringify({
			blockNumber: '0x' + (50842630 + position).toString(16), gasUsed: '0x5208',
			effectiveGasPrice: '0x3b9aca00',
			logs: [{ address: '0xpool', topics: [SWAP_TOPICS.v3], data: '0x' }],
		}),
		tx_json: JSON.stringify({ from: '0xfrom', to: txTo, value: '0x0' }),
		block_json: '{}', finality: 'finalized', ingested_at: '2026-09-03T22:45:00.000Z',
		source: 'test', schema_version: 1,
	} as SeedRow;
}

/** A Seed and a candidates file built from it, the same way the real pipeline does. */
async function fixtures(hashes: string[]) {
	const seedPath = join(dir, 'traces.base.0050842630-0050842929.parquet');
	await writeSeedParquet(hashes.map((h, i) => seedRow(h, i, ROUTER)), seedPath);
	const candidatesPath = join(dir, 'candidates.base.0050842630-0050842929.parquet');
	await copyQueryToParquet({
		outPath: candidatesPath,
		setupSql: candidatesSetupSql({
			seedGlob: seedPath,
			routerValues: routerValuesSql([{ address: ROUTER, name: '1inch', version: 'V5' }]),
		}),
		selectSql: candidatesSelectSql({
			seedFile: 'seed.parquet', derivedAt: '2026-09-08T12:00:00.000Z', schemaVersion: 2,
		}),
	});
	return { seedPath, candidatesPath };
}

const RECEIPT = {
	txHash: '0xa', chainId: 8453, blockNumber: 50842630,
	aggregator: '1inch', routerAddress: ROUTER, trader: '0xt', fillerAddress: null,
	direction: 'sell', inputToken: '0xin', outputToken: '0xout',
	inputSymbol: 'A', outputSymbol: 'B', inputAmount: 1, outputAmount: 2,
	notionalUsd: 100, realizedPrice: 2, marketMid: 2.1, marketMidBefore: null, marketMidAfter: null,
	allInCostBps: 47, pricingStatus: 'estimated', tier: 'estimated',
	methodology: 'Estimated: …', marketPriceFlags: [], referenceDepthUsd: null,
	referencePoolAddress: null, executionBps: 40, lpFeeBps: 5, aggFeeBps: 2,
	slippageBps: 0, gasCostUsd: 0.01, routePure: true, routeShape: 'single', hopCount: 1,
	routeLegs: [{
		venue: '0xpool', type: 'univ3', tokenIn: '0xin', tokenOut: '0xout',
		feeTierBps: 30, notionalUsdc: 100, notionalApprox: false, lpFeeBps: 5,
		priceImpactBps: 2, amountInRaw: '1000000000000000000', amountOutRaw: '2000000',
	}],
	routeReconstructed: true, reconResidualBps: 0, decompConfidence: 'high',
	feeRecipient: null, feeSinkSource: null, feeSinks: [],
	integratorFeeBps: null, fabricFeeBps: null, settlementEventName: null,
	settlementEventTopic0: null, settlementEventSeen: false, normalizeFlags: [],
	chainlinkPrice: null, chainlinkDevBps: null, poolDivergenceBps: null,
	manipulationFlag: false, offchainPrice: null, offchainDevBps: null,
	chainlinkStalenessSecs: null,
};

async function readParquet(path: string): Promise<Record<string, unknown>[]> {
	const instance = await DuckDBInstance.create(':memory:');
	const connection = await instance.connect();
	try {
		const reader = await connection.runAndReadAll(`SELECT * FROM read_parquet('${path}')`);
		return reader.getRowObjects() as Record<string, unknown>[];
	} finally { connection.closeSync(); instance.closeSync(); }
}

function opts(seedPath: string, candidatesPath: string, decode: BuildReceiptsOptions['decode']) {
	return {
		seedGlob: seedPath, seedFile: 'seed.parquet', candidatesGlob: candidatesPath,
		selectedVia: ['both'], dataDir: dir, build: 'testbuild', chain: 'base', chainId: 8453,
		fromBlock: 50842630, toBlock: 50842929, rpcUrl: 'http://stub',
		rpcSource: 'test-provider', coreGitSha: 'abc1234',
		now: () => new Date('2026-09-08T12:00:00.000Z'), decode,
	};
}

describe('buildReceipts', () => {
	it('writes both files with exactly the declared columns, in declared order', async () => {
		const { seedPath, candidatesPath } = await fixtures(['0xa']);
		const r = await buildReceipts(opts(seedPath, candidatesPath, async () => RECEIPT));
		expect(Object.keys((await readParquet(r.receiptsPath))[0]!)).toEqual(Object.keys(RECEIPT_COLUMNS));
		expect(Object.keys((await readParquet(r.legsPath))[0]!)).toEqual(Object.keys(LEG_COLUMNS));
	});

	it('records a null decode as a failure ROW, never a skipped row', async () => {
		// ~36% of router candidates and ~60% of swap_log candidates decode to
		// null. Dropping them would make the table unable to state its own
		// coverage.
		const { seedPath, candidatesPath } = await fixtures(['0xa', '0xb']);
		const r = await buildReceipts(opts(seedPath, candidatesPath,
			async (hash) => (hash === '0xa' ? RECEIPT : null)));
		expect(r.attempted).toBe(2);
		expect(r.decoded).toBe(1);
		expect(r.failed).toBe(1);
		const rows = await readParquet(r.receiptsPath);
		expect(rows).toHaveLength(2);
		const failure = rows.find((x) => x.tx_hash === '0xb')!;
		expect(failure.failure_reason).not.toBeNull();
		expect(failure.price_confidence).toBe('Unavailable');
		expect(failure.all_in_cost_bps).toBeNull();
	});

	it('emits no leg rows for a failed decode, and joins legs to receipts on tx_hash', async () => {
		const { seedPath, candidatesPath } = await fixtures(['0xa', '0xb']);
		const r = await buildReceipts(opts(seedPath, candidatesPath,
			async (hash) => (hash === '0xa' ? RECEIPT : null)));
		const legs = await readParquet(r.legsPath);
		expect(legs.map((l) => l.tx_hash)).toEqual(['0xa']);
		expect(Number(legs[0]!.leg_index)).toBe(0);
	});

	it('carries per-transaction block_position and block_timestamp from candidates', async () => {
		// These vary per row; a run-level constant here would stamp one
		// transaction's position onto another's receipt.
		const { seedPath, candidatesPath } = await fixtures(['0xa', '0xb']);
		const r = await buildReceipts(opts(seedPath, candidatesPath, async () => RECEIPT));
		const rows = await readParquet(r.receiptsPath);
		const positions = rows.map((x) => Number(x.block_position)).sort();
		expect(positions).toEqual([0, 1]);
	});

	it('honours the selectedVia filter', async () => {
		const { seedPath, candidatesPath } = await fixtures(['0xa']);
		const r = await buildReceipts({
			...opts(seedPath, candidatesPath, async () => RECEIPT), selectedVia: ['router'],
		});
		// The fixture rows are router-called AND emit a Swap log, so they are
		// 'both'; filtering on 'router' alone must select none.
		expect(r.attempted).toBe(0);
	});

	it('honours limit', async () => {
		const { seedPath, candidatesPath } = await fixtures(['0xa', '0xb', '0xc']);
		const r = await buildReceipts({ ...opts(seedPath, candidatesPath, async () => RECEIPT), limit: 2 });
		expect(r.attempted).toBe(2);
	});

	it('passes prefetched, includeWings:false and a factCache to the decoder', async () => {
		// The three v0.2b-1 options are the whole reason this runner is cheap
		// and reproducible. A regression that silently stopped passing them
		// would cost an archive dependency and ~40% more RPC calls, with no
		// test failing anywhere else.
		const seen: Record<string, unknown>[] = [];
		const { seedPath, candidatesPath } = await fixtures(['0xa']);
		await buildReceipts(opts(seedPath, candidatesPath, async (_h, _c, o) => { seen.push(o); return RECEIPT; }));
		expect(seen).toHaveLength(1);
		expect(seen[0]!.includeWings).toBe(false);
		expect(seen[0]!.factCache).toBeDefined();
		expect(seen[0]!.prefetched).toBeDefined();
	});

	it('imports its runtime values from @fabric-tca/core/runtime, not @fabric-tca/core', async () => {
		// A value import from the default subpath resolves to src/index.ts and
		// dies under dist/ with ERR_UNKNOWN_FILE_EXTENSION.
		const { readFileSync } = await import('node:fs');
		const src = readFileSync(new URL('./buildReceipts.ts', import.meta.url), 'utf8');
		expect(src.match(/import\s+(?!type\b)[\s\S]*?from\s*['"]@fabric-tca\/core['"]/g)).toBeNull();
	});
});
```

⚠️ Import `BuildReceiptsOptions` as a type in the test for the `opts` helper's return type.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/etl/src/buildReceipts.test.ts`
Expected: FAIL — `Failed to resolve import "./buildReceipts.js"`.

- [ ] **Step 3: Implement the runner**

Create `packages/etl/src/buildReceipts.ts` with this structure:

```ts
import { DuckDBInstance } from '@duckdb/node-api';
import type { Receipt } from '@fabric-tca/core';
import {
	analyzeTransaction as realAnalyze,
	createMemoryFactCache,
	fromSeedJson,
} from '@fabric-tca/core/runtime';
import { derivedFilePath } from './derivedPath.js';
import { DERIVED_SCHEMA_VERSION, derivedColumnSpec, LEG_COLUMNS, RECEIPT_COLUMNS } from './derivedSchema.js';
import { loadFactCacheEntries, saveFactCacheEntries } from './factCacheStore.js';
import { toFailureRow, toLegRows, toReceiptRow } from './receiptRows.js';
import { sqlLiteral } from './sql.js';
import { writeRowsToParquet } from './writeParquet.js';

/**
 * buildReceipts.ts — the serial enrichment runner.
 *
 * ⚠️ SERIAL, ALWAYS. There is no concurrency option and there must never be
 * one. Determinism was measured at 535/535 identical over two serial passes,
 * and that guarantee is serial-only: under concurrent load the endpoint fails
 * reads transiently, the decoder swallows those as evidence (`catch → null`
 * means "no such pool"), and receipts come back quietly degraded.
 *
 * ⚠️ Runtime values come from '@fabric-tca/core/runtime', NOT
 * '@fabric-tca/core'. The default subpath resolves to src/index.ts, which node
 * cannot load from compiled code. Types may come from either.
 *
 * Payloads are fetched in chunks: trace_json averages ~17 KB and the full
 * candidate set is 13,511 rows, so joining every payload at once would hold
 * hundreds of MB for no reason. Output rows are small enough to accumulate.
 */

/** Seed payloads are fetched this many transactions at a time. */
const PAYLOAD_CHUNK = 100;
```

Then: resolve both output paths via `derivedFilePath` → `loadFactCacheEntries` into a `createMemoryFactCache` → query the work list from `candidates` (`tx_hash`, `chain_id`, `block_position`, `block_timestamp`, filtered by `selected_via IN (…)`, ordered by `block_number, block_position`, `LIMIT` when given) → loop in chunks of `PAYLOAD_CHUNK` joining the Seed for `receipt_json`/`tx_json`/`trace_json` → decode each serially with `{ rpcUrl, prefetched, includeWings: false, factCache }` → `toReceiptRow` or `toFailureRow`, plus `toLegRows` → `writeRowsToParquet` for each family, ordered `tx_hash` and `tx_hash, leg_index` → `saveFactCacheEntries` → return the counts.

⚠️ Wrap each decode in try/catch: `analyzeTransaction` is documented never to throw, but a throw must become a failure row rather than losing the run's accumulated work.

⚠️ `writeRowsToParquet` refuses an empty row set. A run with zero legs (every candidate failed) must not abort — skip the legs write and return `legsPath` anyway, or write nothing and say so in the result. Pick one and cover it with a test.

- [ ] **Step 4: Add the CLI command**

In `packages/etl/src/cliDerive.ts`, add a `receipts` command alongside `candidates`, with `--seed`, `--candidates`, `--from`, `--to`, `--build`, `--chain`, `--chain-id`, `--data-dir`, `--selected-via` (repeatable, default `both`), `--limit`, and `--rpc-source`. Read `TCA_RPC_URL` from the environment and fail fast with a named error when absent, mirroring `cli.ts`. Resolve `coreGitSha` from `git rev-parse --short HEAD`.

- [ ] **Step 5: Verify, then commit**

```bash
npm run typecheck && npm run lint && npx vitest run --exclude '**/.claude/**' --no-file-parallelism
git add packages/etl/src/buildReceipts.ts packages/etl/src/buildReceipts.test.ts \
        packages/etl/src/cliDerive.ts packages/etl/src/index.ts
git commit -m "feat(etl): serial enrichment runner and etl-derive receipts"
```

---

### Task 8: The two runs

**Files:** none. This task produces measurements and two Parquet files.

**Context.** This is where the plan's value lands. Both runs are read-only against the chain and write only into `data/derived/`, which is gitignored.

- [ ] **Step 1: The 535 run**

```bash
npm run etl:derive -- receipts \
  --seed 'data/seeds/traces.base.0050842630-0050842929.parquet' \
  --candidates 'data/derived/2026-09-04a/candidates.base.0050842630-0050842929.parquet' \
  --from 50842630 --to 50842929 --build 2026-09-08a --selected-via both
```

Expect ~5 minutes. **Verify against the measured baseline** — these came from decoding the same 535 transactions on 2026-09-08:

| Check | Expected |
|---|---|
| attempted | 535 |
| decoded | ~340 |
| Verified (`price_confidence`) | ~50 |
| Estimated | ~72 |
| Unavailable | ~218 |
| `route_reconstructed = true` | ~180 |

```bash
duckdb -c "
SELECT price_confidence, count(*) FROM read_parquet('data/derived/2026-09-08a/receipts.base.*.parquet')
WHERE failure_reason IS NULL GROUP BY 1 ORDER BY 2 DESC;
SELECT count(*) AS total, count(*) FILTER (failure_reason IS NOT NULL) AS failures
FROM read_parquet('data/derived/2026-09-08a/receipts.base.*.parquet');
SELECT count(*) AS leg_rows, count(DISTINCT tx_hash) AS txs
FROM read_parquet('data/derived/2026-09-08a/legs.base.*.parquet');"
```

⚠️ These are approximate — the baseline was measured with `includeWings: false` + a warm cache, matching the runner, but the chain is live and a token's `symbol()` can change availability. A tier count off by a few is fine; **off by tens means investigate before proceeding to the full run.**

- [ ] **Step 2: The full run**

Only after Step 1's numbers check out. **~2.2 hours** — run it in the foreground with a long timeout, or with `nohup`, and do not poll it aggressively.

```bash
npm run etl:derive -- receipts \
  --seed 'data/seeds/traces.base.0050842630-0050842929.parquet' \
  --candidates 'data/derived/2026-09-04a/candidates.base.0050842630-0050842929.parquet' \
  --from 50842630 --to 50842929 --build 2026-09-08b \
  --selected-via both --selected-via swap_log
```

Expected shape, projected from the 199-transaction sample: ~13,511 attempted, ~5,500 decoded, **~375 Verified**, ~1,700 Estimated, ~3,400 Unavailable. The Verified projection has wide error bars (the sample's Verified cell was n=5); anything from ~150 to ~500 is consistent.

- [ ] **Step 3: Report the real distribution**

Run the same three queries against the `2026-09-08b` build, plus:

```bash
duckdb -c "
-- Does the table disagree with the receipt page anywhere?
SELECT count(*) AS tier_status_disagreements
FROM read_parquet('data/derived/2026-09-08b/receipts.base.*.parquet')
WHERE failure_reason IS NULL
  AND ((tier = 'full' AND pricing_status <> 'full') OR (tier = 'none' AND pricing_status <> 'partial'));
-- Venue mix, now that legs are queryable without unnesting a blob
SELECT type, count(*) AS legs, count(DISTINCT tx_hash) AS txs
FROM read_parquet('data/derived/2026-09-08b/legs.base.*.parquet') GROUP BY 1 ORDER BY 2 DESC LIMIT 15;
-- The fee-sink question the old jsonb column could not answer
SELECT s.name, count(*) AS n, round(avg(s.fee_bps), 2) AS avg_bps
FROM read_parquet('data/derived/2026-09-08b/receipts.base.*.parquet') r, UNNEST(r.fee_sinks) AS t(s)
GROUP BY 1 ORDER BY 2 DESC LIMIT 15;"
```

Report all of it. The last two queries are the point of the whole layer — they are the questions the old `routeLegs`/`feeSinks` jsonb blobs could not answer.

- [ ] **Step 4: Record the cache state**

```bash
duckdb -c "
SELECT 'v4_poolkeys' AS f, count(*) FROM read_parquet('data/cache/v4_poolkeys.base.parquet')
UNION ALL SELECT 'tokens', count(*) FROM read_parquet('data/cache/tokens.base.parquet')
UNION ALL SELECT 'pools', count(*) FROM read_parquet('data/cache/pools.base.parquet');
SELECT protocol, count(*) FROM read_parquet('data/cache/v4_poolkeys.base.parquet') GROUP BY 1;"
```

- [ ] **Step 5: Confirm nothing derived is staged**

Run: `git status --short`
Expected: no `data/` entries. Then commit nothing — this task changes no tracked file.

---

## What this plan does NOT cover

- **`pool_state` (v0.3).** The gating measurement is done: **43.3%** of ruler pools (29 of 67) traded in-window, so recovering pool state from Swap logs serves under half of rulers and cannot replace RPC for the market-price ruler. Per-leg price impact should fare better — a leg's own pool traded by definition — but the post-swap-versus-pre-swap boundary problem applies there too. Decide v0.3 with that number in hand.
- **Resumability.** A 2.2-hour run is all-or-nothing, matching the Seed ingest's convention. If that proves painful in practice, `--limit` plus an `--offset` is the cheap fix.
- **Multicall3.** Still deferred; the spec's §6 reasoning stands, and the measured per-decode profile it should be judged against now exists.
- **Multi-chain.** Task 3 makes the cache *safe* for a second chain; nothing else in the layer is chain-general yet.
- **Backfilling `candidates` with a `price_confidence` summary.** Tempting, but it would make a zero-RPC file depend on an RPC one.
