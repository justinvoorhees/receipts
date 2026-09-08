# ETL Derived Layer v0.2a — `candidates` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the zero-RPC `candidates` Derived file — one row per candidate swap transaction, produced from the Seed archive by DuckDB SQL alone — plus the file-naming, schema and Parquet-writing infrastructure the rest of the Derived layer will reuse.

**Architecture:** A new set of modules in the existing `packages/etl` workspace. `derivedPath.ts` owns naming and layout, `derivedSchema.ts` owns column definitions and their tripwires, `writeParquet.ts` generalizes the Seed layer's atomic temp-then-rename writer so both a JS row array and a SQL query can produce a Parquet file, `routerRegistry.ts` loads `configs/routers.json` at runtime, and `candidatesSql.ts` + `buildCandidates.ts` produce the file. No network access anywhere in this plan.

**Tech Stack:** TypeScript (ESM, NodeNext), `@duckdb/node-api` 1.5.5-r.4, `commander`, `vitest` 2.x.

**Spec:** `docs/superpowers/specs/2026-09-04-tca-etl-derived-layer-design.md`

## Global Constraints

- **Tabs, not spaces.** Every file in `packages/etl` is tab-indented. Match it.
- **ESM with explicit `.js` extensions on relative imports** (`./schema.js`), even from `.ts` files. This is NodeNext resolution; an extensionless import will not compile.
- **Paths resolve at RUNTIME from an argument or environment variable. Never `import.meta.url`.** The repo's six `configs/*.json` paths bake the build machine's absolute path and work only because Nixpacks builds in-container. Nothing in `packages/etl` may repeat that.
- **`source` / provider labels are never a URL.** `TCA_RPC_URL` carries an API key; a data file is the wrong place for it. (Not exercised in this plan — no RPC — but the rule holds for any provenance column.)
- **Vitest runs from the REPO ROOT.** `npx vitest run` from a package subdirectory silently reports roughly half the suite. Every `Run:` command below is written from the repo root.
- **Derived files are versioned, not frozen.** Unlike the Seed's schema tripwire, a Derived tripwire failure is a prompt to bump `DERIVED_SCHEMA_VERSION`, not a wall. Test failure messages must say so.
- **uint256 has no native Parquet type.** Wei quantities are stored as VARCHAR decimal strings via the `hex_to_dec` macro (Task 5), which is bounded at 2^128 by design.
- **`noUncheckedIndexedAccess: true`.** `arr[0]` is `T | undefined`, so indexed access needs a non-null assertion: `rows[0]!.column`. Test files ARE typechecked (`tsc --build` includes `src/**/*`), and the repo's existing tests already use `rows[0]!`.
- **`exactOptionalPropertyTypes: true`.** An optional property cannot be explicitly assigned `undefined`.
- **Indexing a literal-keyed `as const` object requires a literal key.** `CANDIDATE_COLUMNS[someString]` is a type error; iterate with `as const` so the key is a literal union.
- **A v4 pool's identity is its `poolId` (`topics[1]`), NOT the Swap log's emitter.** Every v4 leg in the pilot window is emitted by one of two singletons, so `count(DISTINCT emitter)` collapses 485 pools onto 2 rows. Always key on `CASE WHEN topic0 = <v4 Swap> THEN topic1 ELSE emitter END`.

### Event topic0 constants used throughout

| Name | topic0 |
|---|---|
| Swap (v3/CL) | `0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67` |
| Swap (v2) | `0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822` |
| Swap (v4) | `0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f` |
| Transfer | `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` |

### Expected results against the committed pilot Seed

`data/seeds/traces.base.0050842630-0050842929.parquet`, 155,732 rows, 300 blocks:

| Quantity | Value |
|---|---|
| `candidates` rows | 13,641 |
| `selected_via = 'swap_log'` | 12,976 |
| `selected_via = 'both'` | 535 |
| `selected_via = 'router'` | 130 |
| `sum(swap_log_count)` | 20,560 |
| `sum(v4_legs)` | 5,700 |
| build wall-clock | ~7s |

These were measured on 2026-09-04 by running the exact SQL in Task 5. Task 6 re-runs it and asserts them.

## File Structure

| File | Responsibility |
|---|---|
| `packages/etl/src/derivedPath.ts` | Derived and cache file names and locations. New. |
| `packages/etl/src/derivedPath.test.ts` | Tests for the above. New. |
| `packages/etl/src/derivedSchema.ts` | `CANDIDATE_COLUMNS`, `DERIVED_SCHEMA_VERSION`, `derivedColumnSpec`. New. |
| `packages/etl/src/derivedSchema.test.ts` | Tripwire. New. |
| `packages/etl/src/writeParquet.ts` | Generic atomic Parquet writing, from rows or from a query. New. |
| `packages/etl/src/writeParquet.test.ts` | Round-trip and cleanup tests. New. |
| `packages/etl/src/writeSeedParquet.ts` | Refactored to a thin caller of `writeParquet.ts`. Modified. |
| `packages/etl/src/routerRegistry.ts` | Load `configs/routers.json` at runtime; render it as SQL VALUES. New. |
| `packages/etl/src/routerRegistry.test.ts` | Tests for the above. New. |
| `packages/etl/src/candidatesSql.ts` | The SQL that builds `candidates` from a Seed glob. New. |
| `packages/etl/src/candidatesSql.test.ts` | Executes the SQL against a fixture Seed Parquet. New. |
| `packages/etl/src/buildCandidates.ts` | Orchestration: registry -> SQL -> Parquet. New. |
| `packages/etl/src/buildCandidates.test.ts` | End-to-end over a fixture Seed. New. |
| `packages/etl/src/cliDerive.ts` | `etl-derive candidates` command. New. |
| `packages/etl/src/index.ts` | Re-export the new public surface. Modified. |
| `packages/etl/package.json` | No change (no new dependencies). |
| `package.json` | Add the `etl:derive` script. Modified. |

---

### Task 1: Derived file naming and layout

**Files:**
- Create: `packages/etl/src/derivedPath.ts`
- Test: `packages/etl/src/derivedPath.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type DerivedFamily = 'candidates' | 'receipts' | 'legs' | 'pool_state'`
  - `type CacheName = 'pools' | 'tokens' | 'v4_poolkeys'`
  - `derivedFileName(family: DerivedFamily, chain: string, fromBlock: number, toBlock: number): string`
  - `derivedFilePath(opts: { dataDir: string; build: string; family: DerivedFamily; chain: string; fromBlock: number; toBlock: number }): string`
  - `cacheFilePath(opts: { dataDir: string; name: CacheName; chain: string }): string`

**Context you need:** Read `packages/etl/src/seedPath.ts` first. This task deliberately mirrors it — same ten-digit zero padding, same `[a-z0-9_-]+` name validation, same reason. The one rule that must not break: **nothing varying may precede the family name**, because lexical sort has to equal block order for a DuckDB glob.

- [ ] **Step 1: Write the failing test**

Create `packages/etl/src/derivedPath.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { cacheFilePath, derivedFileName, derivedFilePath } from './derivedPath.js';

describe('derivedFileName', () => {
	it('puts the family first and zero-pads both bounds to ten digits', () => {
		expect(derivedFileName('candidates', 'base', 50842630, 50842929)).toBe(
			'candidates.base.0050842630-0050842929.parquet',
		);
	});

	it('sorts lexically in the same order as numerically within a family', () => {
		const names = [
			derivedFileName('candidates', 'base', 9_000_000, 9_000_299),
			derivedFileName('candidates', 'base', 500, 799),
			derivedFileName('candidates', 'base', 50_842_630, 50_842_929),
		];
		expect([...names].sort()).toEqual([names[1], names[0], names[2]]);
	});

	it('rejects an inverted range', () => {
		expect(() => derivedFileName('candidates', 'base', 500, 499)).toThrow(/inverted/);
	});

	it('rejects a range it cannot pad without truncating', () => {
		expect(() => derivedFileName('legs', 'base', 1, 10_000_000_000)).toThrow(/ten digits/);
	});

	it('rejects a chain name containing path traversal', () => {
		expect(() => derivedFileName('legs', '../../etc', 1, 2)).toThrow(/Chain name must match/);
	});
});

describe('derivedFilePath', () => {
	it('nests the file under data/derived/<build>/', () => {
		expect(
			derivedFilePath({
				dataDir: '/repo/data',
				build: '2026-09-04a',
				family: 'candidates',
				chain: 'base',
				fromBlock: 50842630,
				toBlock: 50842929,
			}),
		).toBe('/repo/data/derived/2026-09-04a/candidates.base.0050842630-0050842929.parquet');
	});

	it('rejects a build tag containing path traversal', () => {
		expect(() =>
			derivedFilePath({
				dataDir: '/repo/data',
				build: '../seeds',
				family: 'candidates',
				chain: 'base',
				fromBlock: 1,
				toBlock: 2,
			}),
		).toThrow(/Build tag must match/);
	});
});

describe('cacheFilePath', () => {
	it('places caches OUTSIDE any build directory', () => {
		expect(cacheFilePath({ dataDir: '/repo/data', name: 'v4_poolkeys', chain: 'base' })).toBe(
			'/repo/data/cache/v4_poolkeys.base.parquet',
		);
	});

	it('rejects a chain name containing path traversal', () => {
		expect(() => cacheFilePath({ dataDir: '/repo/data', name: 'pools', chain: 'a/b' })).toThrow(
			/Chain name must match/,
		);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/etl/src/derivedPath.test.ts`
Expected: FAIL — `Failed to resolve import "./derivedPath.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/etl/src/derivedPath.ts`:

```ts
import { join } from 'node:path';

/**
 * derivedPath.ts — where a Derived file lives, and what it is called.
 *
 * Mirrors seedPath.ts deliberately, because one convention is load-bearing
 * across both layers: block bounds are zero-padded to ten digits so LEXICAL
 * sort equals NUMERIC sort, and a DuckDB glob therefore returns files in block
 * order for free.
 *
 * ⚠️ The family name comes FIRST, before anything that varies. A build tag or
 * timestamp placed ahead of it would sort files by build rather than by block
 * and interleave unrelated ranges.
 *
 * Two directories, with different lifetimes:
 *
 *   data/derived/<build>/   disposable. A bad build is one `rm -rf`.
 *   data/cache/             durable. Immutable chain facts whose entire value
 *                           is surviving rebuilds, so they are NOT under a
 *                           build directory.
 */

export type DerivedFamily = 'candidates' | 'receipts' | 'legs' | 'pool_state';
export type CacheName = 'pools' | 'tokens' | 'v4_poolkeys';

const PAD = 10;
const NAME_PATTERN = /^[a-z0-9_-]+$/;

function validateChain(chain: string): void {
	if (!NAME_PATTERN.test(chain)) {
		throw new Error(`Chain name must match [a-z0-9_-]+, got "${chain}"`);
	}
}

function validateBuild(build: string): void {
	if (!NAME_PATTERN.test(build)) {
		throw new Error(`Build tag must match [a-z0-9_-]+, got "${build}"`);
	}
}

function pad(block: number): string {
	if (!Number.isInteger(block) || block < 0) {
		throw new Error(`Block number must be a non-negative integer, got ${block}`);
	}
	const text = String(block);
	if (!/^\d+$/.test(text) || text.length > PAD) {
		throw new Error(`Block ${block} exceeds ten digits; the naming convention needs widening`);
	}
	return text.padStart(PAD, '0');
}

/** `candidates.base.0050842630-0050842929.parquet` — bounds inclusive. */
export function derivedFileName(
	family: DerivedFamily,
	chain: string,
	fromBlock: number,
	toBlock: number,
): string {
	validateChain(chain);
	if (toBlock < fromBlock) {
		throw new Error(`Range is inverted: ${fromBlock} > ${toBlock}`);
	}
	return `${family}.${chain}.${pad(fromBlock)}-${pad(toBlock)}.parquet`;
}

/** Absolute path for a Derived file, under its build directory. */
export function derivedFilePath(opts: {
	dataDir: string;
	build: string;
	family: DerivedFamily;
	chain: string;
	fromBlock: number;
	toBlock: number;
}): string {
	validateBuild(opts.build);
	const name = derivedFileName(opts.family, opts.chain, opts.fromBlock, opts.toBlock);
	return join(opts.dataDir, 'derived', opts.build, name);
}

/**
 * Absolute path for a cache file. Deliberately NOT under a build directory —
 * a cache holds facts about the chain, not about a build, and discarding it
 * with a bad build would throw away work that is still correct.
 */
export function cacheFilePath(opts: { dataDir: string; name: CacheName; chain: string }): string {
	validateChain(opts.chain);
	return join(opts.dataDir, 'cache', `${opts.name}.${opts.chain}.parquet`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/etl/src/derivedPath.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean. `tsc --build` does NOT lint, and lint is what fails the Railway deploy — run both.

- [ ] **Step 6: Commit**

```bash
git add packages/etl/src/derivedPath.ts packages/etl/src/derivedPath.test.ts
git commit -m "feat(etl): Derived and cache file naming"
```

---

### Task 2: Derived schema and its tripwire

**Files:**
- Create: `packages/etl/src/derivedSchema.ts`
- Test: `packages/etl/src/derivedSchema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `DERIVED_SCHEMA_VERSION: number` (= 1)
  - `CANDIDATE_COLUMNS: Readonly<Record<string, string>>` — insertion order IS Parquet column order
  - `derivedColumnSpec(columns: Readonly<Record<string, string>>): string`
  - `interface CandidateRow` — the TypeScript mirror of `CANDIDATE_COLUMNS`

**Context you need:** Read `packages/etl/src/schema.ts` and `packages/etl/src/schema.test.ts`. This mirrors them with one important difference: the Seed's tripwire says "do not change this"; the Derived tripwire says "bump `DERIVED_SCHEMA_VERSION` when you change this". Derived files are disposable by design.

- [ ] **Step 1: Write the failing test**

Create `packages/etl/src/derivedSchema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CANDIDATE_COLUMNS, DERIVED_SCHEMA_VERSION, derivedColumnSpec } from './derivedSchema.js';

/**
 * Unlike the Seed's schema test, this one is a VERSION tripwire, not a freeze.
 * A Derived file rebuilds from Seeds in seconds, so changing its shape is
 * allowed — but it must be deliberate. If this test fails: update the list
 * below AND bump DERIVED_SCHEMA_VERSION, so a file written by the old shape is
 * distinguishable from one written by the new shape after the fact.
 */
const CANDIDATES_V1: ReadonlyArray<readonly [string, string]> = [
	['chain_id', 'INTEGER'],
	['block_number', 'BIGINT'],
	['block_position', 'INTEGER'],
	['tx_hash', 'VARCHAR'],
	['block_timestamp', 'TIMESTAMP'],
	['tx_from', 'VARCHAR'],
	['tx_to', 'VARCHAR'],
	['tx_status', 'BOOLEAN'],
	['selected_via', 'VARCHAR'],
	['router_name', 'VARCHAR'],
	['router_version', 'VARCHAR'],
	['swap_log_count', 'INTEGER'],
	['v2_legs', 'INTEGER'],
	['v3_legs', 'INTEGER'],
	['v4_legs', 'INTEGER'],
	['distinct_pools', 'INTEGER'],
	['distinct_v4_poolids', 'INTEGER'],
	['log_count', 'INTEGER'],
	['erc20_transfer_count', 'INTEGER'],
	['gas_used', 'BIGINT'],
	['effective_gas_price', 'VARCHAR'],
	['l1_fee', 'VARCHAR'],
	['tx_value', 'VARCHAR'],
	['seed_file', 'VARCHAR'],
	['derived_at', 'TIMESTAMP'],
	['derived_schema_version', 'INTEGER'],
];

describe('candidates schema', () => {
	it('has these exact columns, in this order, with these types', () => {
		expect(Object.entries(CANDIDATE_COLUMNS)).toEqual(CANDIDATES_V1.map(([n, t]) => [n, t]));
	});

	it('is at version 1', () => {
		expect(DERIVED_SCHEMA_VERSION).toBe(1);
	});

	it('stores wei quantities as VARCHAR, never a numeric type', () => {
		// uint256 has no native Parquet type and DECIMAL(38,0) cannot hold the
		// range. Any of these becoming numeric is a silent precision loss.
		for (const col of ['effective_gas_price', 'l1_fee', 'tx_value'] as const) {
			expect(CANDIDATE_COLUMNS[col]).toBe('VARCHAR');
		}
	});
});

describe('derivedColumnSpec', () => {
	it('renders a DuckDB read_json column spec in declaration order', () => {
		const spec = derivedColumnSpec({ a: 'INTEGER', b: 'VARCHAR' });
		expect(spec).toBe("{'a': 'INTEGER', 'b': 'VARCHAR'}");
	});

	it('rejects an empty column set rather than emitting invalid SQL', () => {
		expect(() => derivedColumnSpec({})).toThrow(/at least one column/);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/etl/src/derivedSchema.test.ts`
Expected: FAIL — `Failed to resolve import "./derivedSchema.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/etl/src/derivedSchema.ts`:

```ts
/**
 * derivedSchema.ts — the shape of the Derived layer's files.
 *
 * The Seed layer's schema is FROZEN: rebuilding a Seed means re-fetching from
 * an endpoint that may no longer agree. A Derived file has no such problem —
 * it rebuilds from Seeds in seconds with no network — so this schema is
 * VERSIONED instead. Change it deliberately and bump DERIVED_SCHEMA_VERSION,
 * so a file on disk can be told apart from one written by a later shape.
 *
 * Insertion order IS the Parquet column order. `derivedSchema.test.ts` pins it.
 */

/** Bumped on ANY change to a Derived column list, including an addition. */
export const DERIVED_SCHEMA_VERSION = 1;

/**
 * One row per candidate swap transaction.
 *
 * `selected_via` records WHY the row is here:
 *   'swap_log' — emits at least one v2/v3/v4 Swap log, tx.to is not a known router
 *   'router'   — tx.to IS a known router, but no Swap log was emitted
 *   'both'     — both
 *
 * ⚠️ The 'router' rows are kept deliberately. They are the approvals, bridge
 * calls and reverts that a router-address filter sweeps up, and omitting them
 * would make their absence invisible. A research table needs its own
 * denominator.
 *
 * ⚠️ Wei quantities are VARCHAR decimal strings. uint256 has no native Parquet
 * type, and DECIMAL(38,0) cannot hold the range. `gas_used` is the exception:
 * gas is bounded by the block gas limit, so BIGINT is safe and far easier to
 * aggregate.
 */
export const CANDIDATE_COLUMNS = {
	chain_id: 'INTEGER',
	block_number: 'BIGINT',
	block_position: 'INTEGER',
	tx_hash: 'VARCHAR',
	block_timestamp: 'TIMESTAMP',
	tx_from: 'VARCHAR',
	tx_to: 'VARCHAR',
	tx_status: 'BOOLEAN',
	selected_via: 'VARCHAR',
	router_name: 'VARCHAR',
	router_version: 'VARCHAR',
	swap_log_count: 'INTEGER',
	v2_legs: 'INTEGER',
	v3_legs: 'INTEGER',
	v4_legs: 'INTEGER',
	/**
	 * ⚠️ Counted on the CORRECT pool identity: a v4 pool is its `poolId`
	 * (`topics[1]`), not the Swap log's emitter. All v4 legs in the pilot window
	 * come from two singletons, so counting emitters collapses 485 pools to 2.
	 */
	distinct_pools: 'INTEGER',
	distinct_v4_poolids: 'INTEGER',
	log_count: 'INTEGER',
	erc20_transfer_count: 'INTEGER',
	gas_used: 'BIGINT',
	effective_gas_price: 'VARCHAR',
	l1_fee: 'VARCHAR',
	tx_value: 'VARCHAR',
	seed_file: 'VARCHAR',
	derived_at: 'TIMESTAMP',
	derived_schema_version: 'INTEGER',
} as const satisfies Readonly<Record<string, string>>;

export interface CandidateRow {
	chain_id: number;
	block_number: number;
	block_position: number;
	tx_hash: string;
	block_timestamp: string;
	tx_from: string;
	tx_to: string | null;
	tx_status: boolean;
	selected_via: 'swap_log' | 'router' | 'both';
	router_name: string | null;
	router_version: string | null;
	swap_log_count: number;
	v2_legs: number;
	v3_legs: number;
	v4_legs: number;
	distinct_pools: number;
	distinct_v4_poolids: number;
	log_count: number;
	erc20_transfer_count: number;
	gas_used: number;
	/** Wei, decimal string. NULL when the payload exceeds 2^128 (see hexToDecMacro). */
	effective_gas_price: string | null;
	l1_fee: string | null;
	tx_value: string | null;
	seed_file: string;
	derived_at: string;
	derived_schema_version: number;
}

/**
 * Render a column map as a DuckDB `read_json(columns := …)` struct literal.
 * Passing types explicitly rather than letting DuckDB sniff them is what makes
 * the written Parquet deterministic: sniffing infers from the first rows, so a
 * chunk where a column happened to be all-NULL could land a different type.
 */
export function derivedColumnSpec(columns: Readonly<Record<string, string>>): string {
	const entries = Object.entries(columns);
	if (entries.length === 0) {
		throw new Error('A column spec needs at least one column; an empty struct is invalid SQL');
	}
	return `{${entries.map(([name, type]) => `'${name}': '${type}'`).join(', ')}}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/etl/src/derivedSchema.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add packages/etl/src/derivedSchema.ts packages/etl/src/derivedSchema.test.ts
git commit -m "feat(etl): candidates schema and version tripwire"
```

---

### Task 3: Generalize the Parquet writer

**Files:**
- Create: `packages/etl/src/writeParquet.ts`
- Test: `packages/etl/src/writeParquet.test.ts`
- Modify: `packages/etl/src/writeSeedParquet.ts` (becomes a thin caller)

**Interfaces:**
- Consumes: `derivedColumnSpec` from Task 2 (callers pass the rendered spec string).
- Produces:
  - `writeRowsToParquet(rows: readonly unknown[], opts: { outPath: string; columnSpec: string; orderBy: string; rowGroupSize?: number }): Promise<number>`
  - `copyQueryToParquet(opts: { outPath: string; setupSql?: readonly string[]; selectSql: string; rowGroupSize?: number }): Promise<number>`
  - `writeNdjsonLines(rows: readonly unknown[], sink: Writable): Promise<void>` (moved, unchanged behaviour)

**Context you need:** Read `packages/etl/src/writeSeedParquet.ts` in full. Everything in it is load-bearing and must survive the refactor:

1. **Both temp files live beside the target**, because `rename` is only atomic within one filesystem and the OS temp dir is frequently a different mount.
2. **Uniqueness does not depend on the clock** — `${process.pid}.${randomUUID()}`.
3. **Rows stream to NDJSON**; a single JS string is capped at 512 MiB and a full batch exceeded it on a real run.
4. **`ORDER BY` happens at write time**, which is what makes row-group min/max statistics useful.
5. **Nested try/catch on cleanup**, so a cleanup failure never replaces the error already in flight.

This task also fixes a recorded v0.2 hazard: `writeSeedParquet` **never closes the DuckDB instance or connection**. Harmless for a one-shot CLI, a native-memory leak the moment Derived builds call it in a loop. Both new functions must close both handles in a `finally`.

- [ ] **Step 1: Write the failing test**

Create `packages/etl/src/writeParquet.test.ts`:

```ts
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyQueryToParquet, writeRowsToParquet } from './writeParquet.js';

const SPEC = "{'n': 'INTEGER', 'label': 'VARCHAR'}";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'writeParquet-'));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

async function readBack(path: string): Promise<Record<string, unknown>[]> {
	const instance = await DuckDBInstance.create(':memory:');
	const connection = await instance.connect();
	try {
		const reader = await connection.runAndReadAll(`SELECT * FROM read_parquet('${path}')`);
		return reader.getRowObjects() as Record<string, unknown>[];
	} finally {
		connection.closeSync();
		instance.closeSync();
	}
}

describe('writeRowsToParquet', () => {
	it('writes rows and orders them at write time', async () => {
		const out = join(dir, 'out.parquet');
		const count = await writeRowsToParquet(
			[
				{ n: 3, label: 'c' },
				{ n: 1, label: 'a' },
				{ n: 2, label: 'b' },
			],
			{ outPath: out, columnSpec: SPEC, orderBy: 'n' },
		);
		expect(count).toBe(3);
		const rows = await readBack(out);
		expect(rows.map((r) => r.label)).toEqual(['a', 'b', 'c']);
	});

	it('refuses to write an empty file', async () => {
		await expect(
			writeRowsToParquet([], { outPath: join(dir, 'x.parquet'), columnSpec: SPEC, orderBy: 'n' }),
		).rejects.toThrow(/no rows/);
	});

	it('leaves no temp files behind on success', async () => {
		await writeRowsToParquet([{ n: 1, label: 'a' }], {
			outPath: join(dir, 'out.parquet'),
			columnSpec: SPEC,
			orderBy: 'n',
		});
		expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
	});

	it('leaves no temp files behind on failure', async () => {
		await expect(
			writeRowsToParquet([{ n: 1, label: 'a' }], {
				outPath: join(dir, 'out.parquet'),
				columnSpec: "{'n': 'NOT_A_TYPE'}",
				orderBy: 'n',
			}),
		).rejects.toThrow();
		expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
	});
});

describe('copyQueryToParquet', () => {
	it('writes the result of a query and returns its row count', async () => {
		const out = join(dir, 'q.parquet');
		const count = await copyQueryToParquet({
			outPath: out,
			setupSql: ['CREATE TABLE t (n INTEGER, label VARCHAR)', "INSERT INTO t VALUES (2,'b'),(1,'a')"],
			selectSql: 'SELECT * FROM t ORDER BY n',
		});
		expect(count).toBe(2);
		const rows = await readBack(out);
		expect(rows.map((r) => r.label)).toEqual(['a', 'b']);
	});

	it('refuses to write an empty result', async () => {
		await expect(
			copyQueryToParquet({
				outPath: join(dir, 'empty.parquet'),
				setupSql: ['CREATE TABLE t (n INTEGER)'],
				selectSql: 'SELECT * FROM t',
			}),
		).rejects.toThrow(/no rows/);
	});

	it('leaves no temp files behind when the query is invalid', async () => {
		await expect(
			copyQueryToParquet({ outPath: join(dir, 'bad.parquet'), selectSql: 'SELECT * FROM nope' }),
		).rejects.toThrow();
		expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/etl/src/writeParquet.test.ts`
Expected: FAIL — `Failed to resolve import "./writeParquet.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/etl/src/writeParquet.ts`:

```ts
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * writeParquet.ts — rows or a query in, Parquet on disk, atomically.
 *
 * DuckDB does the writing, deliberately. It is the engine every Derived file
 * is read with, so having it also do the writing removes an entire class of
 * bug: a library emitting Parquet DuckDB cannot read, or writing row-group
 * statistics that silently do not match the data.
 *
 * Generalized out of writeSeedParquet.ts, which is now a caller. The Derived
 * layer needs both entry points: `writeRowsToParquet` for a JS row array, and
 * `copyQueryToParquet` for a file that is produced by SQL over Seed Parquet
 * and never materializes in JS at all.
 *
 * ⚠️ Both entry points CLOSE the DuckDB connection and instance. The Seed
 * layer's original never did — harmless for a one-shot CLI, a native-memory
 * leak the moment a Derived build calls it in a loop.
 */

/**
 * Rows are ordered AT WRITE TIME, which is what makes row-group min/max
 * statistics useful. Without it, a block-range filter has to decompress every
 * row group in the file.
 *
 * ⚠️ 4096 was reasoned against an estimated ~17 KB/row; the pilot Seed measured
 * ~945 bytes/row, so the premise has already moved. It is a knob to revisit
 * with measurement against real Derived query patterns, not a settled number.
 */
const DEFAULT_ROW_GROUP_SIZE = 4096;

/** SQL string literal escaping — paths are ours, but a stray quote must not build broken SQL. */
export function sqlLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/** One NDJSON line per row, produced lazily so the whole batch is never held as one string. */
function* ndjsonLines(rows: readonly unknown[]): Generator<string> {
	for (const row of rows) {
		yield `${JSON.stringify(row)}\n`;
	}
}

/**
 * Stream rows into a writable sink one line at a time, instead of building one
 * monolithic `rows.map(...).join('\n')` string.
 *
 * A single JS string is capped at `buffer.constants.MAX_STRING_LENGTH` (512
 * MiB on Node 20), and a full ingest batch measures well past that — the
 * `join('\n')` approach threw `RangeError: Invalid string length` on a real
 * 300-block pilot before this fix. The row ARRAY itself is fine (it already
 * fit in memory to get here); only the serialization step needed to change.
 *
 * `pipeline` gets backpressure and error handling for free: it only pulls the
 * next line once the sink's buffer has drained, and it propagates the sink's
 * own error while destroying both ends.
 */
export function writeNdjsonLines(rows: readonly unknown[], sink: Writable): Promise<void> {
	return pipeline(Readable.from(ndjsonLines(rows)), sink);
}

/**
 * Run `body` against a fresh in-memory DuckDB, closing both handles afterwards
 * whatever happens. `closeSync` on an already-closed handle is not expected
 * here — each is closed exactly once — so failures are not swallowed.
 */
async function withDuckDb<T>(body: (connection: DuckDBConnection) => Promise<T>): Promise<T> {
	const instance = await DuckDBInstance.create(':memory:');
	const connection = await instance.connect();
	try {
		return await body(connection);
	} finally {
		connection.closeSync();
		instance.closeSync();
	}
}

/** Temp paths beside the target, unique without depending on the clock. */
function tempPaths(outPath: string): { dir: string; ndjson: string; parquet: string } {
	const dir = dirname(outPath);
	// Both temps live beside the target: rename is only atomic within one
	// filesystem, and the OS temp directory is frequently a different mount.
	// Uniqueness must not depend on the clock: two concurrent writes into the
	// same directory landing in the same millisecond would otherwise share a
	// stamp and clobber each other's temp files mid-flight.
	const stamp = `${process.pid}.${randomUUID()}`;
	return {
		dir,
		ndjson: join(dir, `.${stamp}.ndjson.tmp`),
		parquet: join(dir, `.${stamp}.parquet.tmp`),
	};
}

/**
 * A failure must not litter one temp pair per attempt beside the archive.
 * Nested try/catch, mirroring atomicWrite.ts: a cleanup failure (EACCES,
 * EBUSY — anything other than "already gone", which { force: true } absorbs)
 * must never replace whatever error is already in flight.
 */
function cleanup(...paths: string[]): void {
	for (const path of paths) {
		try {
			rmSync(path, { force: true });
		} catch {
			// Best-effort cleanup; the original error (or success) still wins.
		}
	}
}

function copySql(selectSql: string, parquetTmp: string, rowGroupSize: number): string {
	return `COPY (${selectSql}) TO ${sqlLiteral(parquetTmp)}
	  (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE ${rowGroupSize})`;
}

/** Write a JS row array to Parquet. `columnSpec` comes from `derivedColumnSpec`. */
export async function writeRowsToParquet(
	rows: readonly unknown[],
	opts: { outPath: string; columnSpec: string; orderBy: string; rowGroupSize?: number },
): Promise<number> {
	if (rows.length === 0) {
		throw new Error(`Refusing to write ${opts.outPath}: no rows. An empty file is never correct.`);
	}
	const { dir, ndjson, parquet } = tempPaths(opts.outPath);
	mkdirSync(dir, { recursive: true });

	try {
		await writeNdjsonLines(rows, createWriteStream(ndjson));
		await withDuckDb((connection) =>
			connection.run(
				copySql(
					`SELECT * FROM read_json(${sqlLiteral(ndjson)},
					                         columns := ${opts.columnSpec},
					                         format := 'newline_delimited')
					 ORDER BY ${opts.orderBy}`,
					parquet,
					opts.rowGroupSize ?? DEFAULT_ROW_GROUP_SIZE,
				),
			),
		);
		renameSync(parquet, opts.outPath);
		return rows.length;
	} finally {
		cleanup(ndjson, parquet);
	}
}

/**
 * Write the result of a SQL query to Parquet, without materializing it in JS.
 * `setupSql` statements run in order first (views, macros, lookup tables).
 *
 * Refuses to write an empty result for the same reason `writeRowsToParquet`
 * does: a Derived file with no rows is a build that silently did nothing.
 */
export async function copyQueryToParquet(opts: {
	outPath: string;
	setupSql?: readonly string[];
	selectSql: string;
	rowGroupSize?: number;
}): Promise<number> {
	const { dir, parquet } = tempPaths(opts.outPath);
	mkdirSync(dir, { recursive: true });

	try {
		const count = await withDuckDb(async (connection) => {
			for (const statement of opts.setupSql ?? []) {
				await connection.run(statement);
			}
			await connection.run(
				copySql(opts.selectSql, parquet, opts.rowGroupSize ?? DEFAULT_ROW_GROUP_SIZE),
			);
			const reader = await connection.runAndReadAll(
				`SELECT count(*) AS n FROM read_parquet(${sqlLiteral(parquet)})`,
			);
			// count(*) comes back as a JS bigint; the double cast is what the
			// package's DuckDBValue union requires.
			return Number(reader.getRowObjects()[0]!.n as unknown as bigint);
		});

		if (count === 0) {
			throw new Error(`Refusing to write ${opts.outPath}: no rows. An empty file is never correct.`);
		}
		renameSync(parquet, opts.outPath);
		return count;
	} finally {
		cleanup(parquet);
	}
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/etl/src/writeParquet.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Refactor `writeSeedParquet.ts` to call it**

Replace the entire body of `packages/etl/src/writeSeedParquet.ts` with:

```ts
import { seedColumnSpec, type SeedRow } from './schema.js';
import { writeNdjsonLines, writeRowsToParquet } from './writeParquet.js';

/**
 * writeSeedParquet.ts — Seed rows in, Parquet on disk.
 *
 * The atomic temp-then-rename dance, the NDJSON streaming and the DuckDB COPY
 * now live in writeParquet.ts, shared with the Derived layer. This file keeps
 * only what is specific to a Seed: its column spec and its sort order.
 *
 * ⚠️ `ORDER BY block_number, block_position` is load-bearing — it is what makes
 * row-group min/max statistics useful. Without it, block-range pruning does
 * nothing.
 */

/** Re-exported for the existing writeSeedParquet.test.ts, which pins its behaviour. */
export { writeNdjsonLines };

export function writeSeedParquet(rows: SeedRow[], outPath: string): Promise<number> {
	return writeRowsToParquet(rows, {
		outPath,
		columnSpec: seedColumnSpec(),
		orderBy: 'block_number, block_position',
	});
}
```

- [ ] **Step 6: Run the whole ETL suite to prove the refactor is behaviour-preserving**

Run: `npx vitest run packages/etl`
Expected: PASS. `writeSeedParquet.test.ts` must pass **unmodified** — that is the entire point of this step. If it needs editing, the refactor changed behaviour; revert and find out why.

- [ ] **Step 7: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add packages/etl/src/writeParquet.ts packages/etl/src/writeParquet.test.ts packages/etl/src/writeSeedParquet.ts
git commit -m "refactor(etl): share the Parquet writer, close DuckDB handles"
```

---

### Task 4: Router registry loader

**Files:**
- Create: `packages/etl/src/routerRegistry.ts`
- Test: `packages/etl/src/routerRegistry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface RouterEntry { address: string; name: string; version: string }`
  - `loadRouterRegistry(configPath: string): Promise<RouterEntry[]>`
  - `routerValuesSql(entries: readonly RouterEntry[]): string`

**Context you need:** `configs/routers.json` has the shape `{ "_comment": "...", "routers": [ { name, address, version, detection, active, _verified } ] }`. There are 20 entries, all `active: true`, all `detection: "to_address"`. Addresses in the file are **mixed case** and must be lowercased — the Seed's `tx_to` is whatever the RPC returned, so the join is on `lower(tx_to)`.

Only `active: true` entries are loaded. `detection` is not filtered on: `solver_eoa` is documented as "not yet implemented", and no entry currently uses it; if one appears, it will still be `to_address`-joined and simply match nothing, which is the correct degradation.

> ⚠️ `configs/routers.json` is curated for aggregator **identity**, not population selection. Uniswap's UniversalRouter is deliberately absent from it. This loader must not be "fixed" by adding routers to that file — `resolveAggregator` reads it too. Widening the population is an open question in the spec (§12).

- [ ] **Step 1: Write the failing test**

Create `packages/etl/src/routerRegistry.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRouterRegistry, routerValuesSql } from './routerRegistry.js';

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'routerRegistry-'));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeConfig(routers: unknown[]): string {
	const path = join(dir, 'routers.json');
	writeFileSync(path, JSON.stringify({ _comment: 'x', routers }));
	return path;
}

describe('loadRouterRegistry', () => {
	it('lowercases addresses so the join against tx_to works', async () => {
		const path = writeConfig([
			{ name: 'Odos', address: '0x19cEeAd7105607Cd444F5ad10dd51356436095a1', version: 'V2', active: true },
		]);
		expect(await loadRouterRegistry(path)).toEqual([
			{ address: '0x19ceead7105607cd444f5ad10dd51356436095a1', name: 'Odos', version: 'V2' },
		]);
	});

	it('skips inactive routers', async () => {
		const path = writeConfig([
			{ name: 'A', address: '0xaa', version: '1', active: true },
			{ name: 'B', address: '0xbb', version: '1', active: false },
		]);
		const entries = await loadRouterRegistry(path);
		expect(entries.map((e) => e.name)).toEqual(['A']);
	});

	it('throws when the file has no active routers, rather than building an empty filter', async () => {
		const path = writeConfig([{ name: 'B', address: '0xbb', version: '1', active: false }]);
		await expect(loadRouterRegistry(path)).rejects.toThrow(/no active routers/);
	});

	it('names the path it could not read', async () => {
		await expect(loadRouterRegistry(join(dir, 'missing.json'))).rejects.toThrow(/missing\.json/);
	});

	it('loads the real repo registry', async () => {
		const entries = await loadRouterRegistry('configs/routers.json');
		expect(entries.length).toBeGreaterThanOrEqual(20);
		expect(entries.every((e) => e.address === e.address.toLowerCase())).toBe(true);
		expect(entries.map((e) => e.name)).toContain('Odos');
	});
});

describe('routerValuesSql', () => {
	it('renders a VALUES list', () => {
		expect(
			routerValuesSql([
				{ address: '0xaa', name: 'A', version: 'V1' },
				{ address: '0xbb', name: 'B', version: 'V2' },
			]),
		).toBe("('0xaa','A','V1'),('0xbb','B','V2')");
	});

	it('escapes a single quote in a name rather than emitting broken SQL', () => {
		expect(routerValuesSql([{ address: '0xaa', name: "O'Router", version: 'V1' }])).toBe(
			"('0xaa','O''Router','V1')",
		);
	});

	it('refuses an empty list', () => {
		expect(() => routerValuesSql([])).toThrow(/at least one router/);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/etl/src/routerRegistry.test.ts`
Expected: FAIL — `Failed to resolve import "./routerRegistry.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/etl/src/routerRegistry.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { sqlLiteral } from './writeParquet.js';

/**
 * routerRegistry.ts — load `configs/routers.json` for the Derived layer.
 *
 * ⚠️ The path is a RUNTIME argument. The repo's six other `configs/*.json`
 * consumers bake the build machine's absolute path via `import.meta.url` and
 * work only because Nixpacks builds in-container. Nothing here repeats that.
 *
 * ⚠️ This registry is curated for aggregator IDENTITY, not for population
 * selection. Measured against the pilot Seed, `tx_to` membership catches 665
 * transactions — 4% of the 13,511 that emit a Swap log — and Uniswap's
 * UniversalRouter, the largest named router in that window, is absent from it.
 * Do not "fix" that by widening this file: `resolveAggregator` reads it too,
 * and a router added for population reasons would change aggregator labels.
 */

export interface RouterEntry {
	/** Lowercased. The Seed's `tx_to` is whatever the RPC returned, so joins use `lower(tx_to)`. */
	address: string;
	name: string;
	version: string;
}

interface RawRouter {
	name?: unknown;
	address?: unknown;
	version?: unknown;
	active?: unknown;
}

export async function loadRouterRegistry(configPath: string): Promise<RouterEntry[]> {
	let text: string;
	try {
		text = await readFile(configPath, 'utf8');
	} catch (err) {
		throw new Error(`Cannot read router registry at ${configPath}: ${(err as Error).message}`);
	}

	const parsed = JSON.parse(text) as { routers?: RawRouter[] };
	const raw = Array.isArray(parsed.routers) ? parsed.routers : [];

	const entries: RouterEntry[] = [];
	for (const router of raw) {
		if (router.active !== true) continue;
		if (typeof router.address !== 'string' || typeof router.name !== 'string') {
			throw new Error(`Router registry at ${configPath} has an entry with no address or name`);
		}
		entries.push({
			address: router.address.toLowerCase(),
			name: router.name,
			version: typeof router.version === 'string' ? router.version : '',
		});
	}

	if (entries.length === 0) {
		// An empty filter would silently reclassify every 'both' row as
		// 'swap_log' and drop the 'router' rows entirely — a wrong file, not an
		// empty one, which is far worse.
		throw new Error(`Router registry at ${configPath} has no active routers`);
	}
	return entries;
}

/** Render entries as a SQL VALUES list: `('0xaa','A','V1'),('0xbb','B','V2')`. */
export function routerValuesSql(entries: readonly RouterEntry[]): string {
	if (entries.length === 0) {
		throw new Error('A router VALUES list needs at least one router');
	}
	return entries
		.map((e) => `(${sqlLiteral(e.address)},${sqlLiteral(e.name)},${sqlLiteral(e.version)})`)
		.join(',');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/etl/src/routerRegistry.test.ts`
Expected: PASS, 8 tests. The "loads the real repo registry" test resolves `configs/routers.json` relative to the vitest CWD, which is the repo root.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add packages/etl/src/routerRegistry.ts packages/etl/src/routerRegistry.test.ts
git commit -m "feat(etl): router registry loader for the Derived layer"
```

---

### Task 5: The `candidates` SQL

**Files:**
- Create: `packages/etl/src/candidatesSql.ts`
- Test: `packages/etl/src/candidatesSql.test.ts`

**Interfaces:**
- Consumes: `routerValuesSql` (Task 4), `sqlLiteral` (Task 3).
- Produces:
  - `HEX_TO_DEC_MACRO: string`
  - `SWAP_TOPICS: { v2: string; v3: string; v4: string }` and `TRANSFER_TOPIC: string`
  - `candidatesSetupSql(opts: { seedGlob: string; routerValues: string }): string[]`
  - `candidatesSelectSql(opts: { seedFile: string; derivedAt: string; schemaVersion: number }): string`

**Context you need:** This SQL was written and executed against the real pilot Seed on 2026-09-04 and produced exactly the counts in the Global Constraints table. Do not restructure it speculatively.

Three details that are easy to get wrong:

1. **`hex_to_dec` is bounded at 2^128 on purpose.** DuckDB's widest integer is 128-bit; a full uint256 overflows it and **aborts the entire COPY**. Wei quantities cannot reach 2^128 (total ETH supply is ~1.2e26 wei; 2^127 is ~1.7e38), so a payload longer than 32 significant hex digits is not a wei quantity, and the macro yields NULL rather than killing the build.
2. **The v4 pool key.** `count(DISTINCT emitter)` is wrong for v4 — use `CASE WHEN topic0 = <v4> THEN topic1 ELSE emitter END`.
3. **`json_each(receipt_json, '$.logs')`** is how a Seed row's logs are unnested. A transaction with no logs contributes no rows to the CTE, so every aggregate must be `COALESCE`d to 0 in the outer select — otherwise a router transaction with zero logs gets NULL counts and fails the `NOT NULL` expectations of downstream queries.

- [ ] **Step 1: Write the failing test**

Create `packages/etl/src/candidatesSql.test.ts`:

```ts
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { candidatesSelectSql, candidatesSetupSql, HEX_TO_DEC_MACRO, SWAP_TOPICS, TRANSFER_TOPIC } from './candidatesSql.js';
import { routerValuesSql } from './routerRegistry.js';
import type { SeedRow } from './schema.js';
import { writeSeedParquet } from './writeSeedParquet.js';

const ROUTER = '0x1111111254eeb25477b68fb85ed929f73a960582';

function log(address: string, topics: string[]) {
	return { address, topics, data: '0x' };
}

function seedRow(over: Partial<SeedRow> & { tx_hash: string; block_position: number }): SeedRow {
	return {
		chain_id: 8453,
		block_number: 50842630,
		block_timestamp: '2026-09-03T22:30:07.000Z',
		tx_from: '0xfrom',
		tx_to: '0xdead',
		tx_status: true,
		block_hash: '0xblock',
		trace_json: '{}',
		receipt_json: JSON.stringify({ logs: [], gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00' }),
		tx_json: JSON.stringify({ value: '0x0' }),
		block_json: '{}',
		finality: 'finalized',
		ingested_at: '2026-09-03T22:45:00.000Z',
		source: 'test',
		schema_version: 1,
		...over,
	} as SeedRow;
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'candidatesSql-'));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

async function runCandidates(rows: SeedRow[]): Promise<Record<string, unknown>[]> {
	const seedPath = join(dir, 'traces.base.0050842630-0050842929.parquet');
	await writeSeedParquet(rows, seedPath);

	const instance = await DuckDBInstance.create(':memory:');
	const connection = await instance.connect();
	try {
		for (const statement of candidatesSetupSql({
			seedGlob: seedPath,
			routerValues: routerValuesSql([{ address: ROUTER, name: '1inch', version: 'V5' }]),
		})) {
			await connection.run(statement);
		}
		const reader = await connection.runAndReadAll(
			candidatesSelectSql({
				seedFile: 'traces.base.0050842630-0050842929.parquet',
				derivedAt: '2026-09-04T12:00:00.000Z',
				schemaVersion: 1,
			}),
		);
		return reader.getRowObjects() as Record<string, unknown>[];
	} finally {
		connection.closeSync();
		instance.closeSync();
	}
}

describe('hex_to_dec', () => {
	async function hexToDec(value: string | null): Promise<string | null> {
		const instance = await DuckDBInstance.create(':memory:');
		const connection = await instance.connect();
		try {
			await connection.run(HEX_TO_DEC_MACRO);
			const literal = value === null ? 'NULL' : `'${value}'`;
			const reader = await connection.runAndReadAll(`SELECT hex_to_dec(${literal}) AS v`);
			return reader.getRowObjects()[0]!.v as string | null;
		} finally {
			connection.closeSync();
			instance.closeSync();
		}
	}

	it('converts hex wei to a decimal string', async () => {
		expect(await hexToDec('0x0de0b6b3a7640000')).toBe('1000000000000000000');
	});

	it('handles zero in both spellings', async () => {
		expect(await hexToDec('0x0')).toBe('0');
		expect(await hexToDec('0x00')).toBe('0');
	});

	it('passes NULL through', async () => {
		expect(await hexToDec(null)).toBeNull();
	});

	it('yields NULL rather than overflowing on a value wider than 2^128', async () => {
		// A full uint256 would abort the entire COPY with an overflow error.
		expect(
			await hexToDec('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),
		).toBeNull();
	});

	it('still converts the largest genuine 128-bit value', async () => {
		expect(await hexToDec('0xffffffffffffffffffffffffffffffff')).toBe(
			'340282366920938463463374607431768211455',
		);
	});
});

describe('candidates selection', () => {
	it('selects a tx with a Swap log as swap_log', async () => {
		const rows = await runCandidates([
			seedRow({
				tx_hash: '0xa',
				block_position: 0,
				receipt_json: JSON.stringify({
					logs: [log('0xpool1', [SWAP_TOPICS.v3])],
					gasUsed: '0x5208',
					effectiveGasPrice: '0x3b9aca00',
				}),
			}),
		]);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.selected_via).toBe('swap_log');
		expect(Number(rows[0]!.swap_log_count)).toBe(1);
		expect(rows[0]!.router_name).toBeNull();
	});

	it('selects a router tx with no Swap log as router, and keeps it', async () => {
		const rows = await runCandidates([
			seedRow({ tx_hash: '0xb', block_position: 0, tx_to: ROUTER }),
		]);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.selected_via).toBe('router');
		expect(rows[0]!.router_name).toBe('1inch');
		expect(Number(rows[0]!.swap_log_count)).toBe(0);
		expect(Number(rows[0]!.distinct_pools)).toBe(0);
	});

	it('selects a router tx WITH a Swap log as both', async () => {
		const rows = await runCandidates([
			seedRow({
				tx_hash: '0xc',
				block_position: 0,
				tx_to: ROUTER.toUpperCase(),
				receipt_json: JSON.stringify({
					logs: [log('0xpool1', [SWAP_TOPICS.v2])],
					gasUsed: '0x5208',
					effectiveGasPrice: '0x3b9aca00',
				}),
			}),
		]);
		expect(rows[0]!.selected_via).toBe('both');
		expect(rows[0]!.router_name).toBe('1inch');
	});

	it('excludes a tx that is neither a router call nor a swap', async () => {
		const rows = await runCandidates([
			seedRow({
				tx_hash: '0xd',
				block_position: 0,
				receipt_json: JSON.stringify({
					logs: [log('0xtoken', [TRANSFER_TOPIC])],
					gasUsed: '0x5208',
					effectiveGasPrice: '0x3b9aca00',
				}),
			}),
			// A second row so the file is not empty when the first is excluded.
			seedRow({
				tx_hash: '0xe',
				block_position: 1,
				receipt_json: JSON.stringify({
					logs: [log('0xpool1', [SWAP_TOPICS.v3])],
					gasUsed: '0x5208',
					effectiveGasPrice: '0x3b9aca00',
				}),
			}),
		]);
		expect(rows.map((r) => r.tx_hash)).toEqual(['0xe']);
	});
});

describe('candidates pool counting', () => {
	it('counts a v4 pool by poolId, NOT by the emitting singleton', async () => {
		// Both legs come from ONE singleton but are TWO different pools. Counting
		// DISTINCT emitter would report 1 and understate the pool count — the
		// defect that made 485 pilot pools look like 2.
		const singleton = '0x498581ff718922c3f8e6a244956af099b2652b2b';
		const rows = await runCandidates([
			seedRow({
				tx_hash: '0xf',
				block_position: 0,
				receipt_json: JSON.stringify({
					logs: [
						log(singleton, [SWAP_TOPICS.v4, '0xpoolid1']),
						log(singleton, [SWAP_TOPICS.v4, '0xpoolid2']),
					],
					gasUsed: '0x5208',
					effectiveGasPrice: '0x3b9aca00',
				}),
			}),
		]);
		expect(Number(rows[0]!.v4_legs)).toBe(2);
		expect(Number(rows[0]!.distinct_v4_poolids)).toBe(2);
		expect(Number(rows[0]!.distinct_pools)).toBe(2);
	});

	it('counts repeated hits on one pool once', async () => {
		const rows = await runCandidates([
			seedRow({
				tx_hash: '0x10',
				block_position: 0,
				receipt_json: JSON.stringify({
					logs: [log('0xpool1', [SWAP_TOPICS.v3]), log('0xpool1', [SWAP_TOPICS.v3])],
					gasUsed: '0x5208',
					effectiveGasPrice: '0x3b9aca00',
				}),
			}),
		]);
		expect(Number(rows[0]!.v3_legs)).toBe(2);
		expect(Number(rows[0]!.distinct_pools)).toBe(1);
	});

	it('counts transfers and total logs separately from swaps', async () => {
		const rows = await runCandidates([
			seedRow({
				tx_hash: '0x11',
				block_position: 0,
				receipt_json: JSON.stringify({
					logs: [
						log('0xtoken', [TRANSFER_TOPIC]),
						log('0xtoken', [TRANSFER_TOPIC]),
						log('0xpool1', [SWAP_TOPICS.v2]),
					],
					gasUsed: '0x5208',
					effectiveGasPrice: '0x3b9aca00',
				}),
			}),
		]);
		expect(Number(rows[0]!.log_count)).toBe(3);
		expect(Number(rows[0]!.erc20_transfer_count)).toBe(2);
		expect(Number(rows[0]!.swap_log_count)).toBe(1);
	});
});

describe('candidates gas and value columns', () => {
	it('decodes gas and value, and tolerates an absent l1Fee', async () => {
		const rows = await runCandidates([
			seedRow({
				tx_hash: '0x12',
				block_position: 0,
				receipt_json: JSON.stringify({
					logs: [log('0xpool1', [SWAP_TOPICS.v3])],
					gasUsed: '0x5208',
					effectiveGasPrice: '0x5b8d80',
				}),
				tx_json: JSON.stringify({ value: '0x0de0b6b3a7640000' }),
			}),
		]);
		expect(Number(rows[0]!.gas_used)).toBe(21000);
		expect(rows[0]!.effective_gas_price).toBe('6000000');
		expect(rows[0]!.l1_fee).toBeNull();
		expect(rows[0]!.tx_value).toBe('1000000000000000000');
	});

	it('stamps provenance on every row', async () => {
		const rows = await runCandidates([
			seedRow({
				tx_hash: '0x13',
				block_position: 0,
				receipt_json: JSON.stringify({
					logs: [log('0xpool1', [SWAP_TOPICS.v3])],
					gasUsed: '0x5208',
					effectiveGasPrice: '0x3b9aca00',
				}),
			}),
		]);
		expect(rows[0]!.seed_file).toBe('traces.base.0050842630-0050842929.parquet');
		expect(Number(rows[0]!.derived_schema_version)).toBe(1);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/etl/src/candidatesSql.test.ts`
Expected: FAIL — `Failed to resolve import "./candidatesSql.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/etl/src/candidatesSql.ts`:

```ts
import { sqlLiteral } from './writeParquet.js';

/**
 * candidatesSql.ts — the SQL that turns a Seed glob into `candidates`.
 *
 * Zero RPC. Everything here is computed from `receipt_json` and `tx_json`,
 * which the Seed already holds. Measured against the pilot Seed (155,732 rows,
 * 300 blocks) on 2026-09-04: 13,641 rows out, ~7s.
 */

/** The Swap events that define a candidate. */
export const SWAP_TOPICS = {
	v2: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
	v3: '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
	v4: '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f',
} as const;

export const TRANSFER_TOPIC =
	'0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const ALL_SWAP_TOPICS = [SWAP_TOPICS.v2, SWAP_TOPICS.v3, SWAP_TOPICS.v4]
	.map(sqlLiteral)
	.join(', ');

/**
 * ⚠️ A v4 pool's identity is its poolId (`topics[1]`), NOT the log's emitter.
 * Every v4 Swap in the pilot window is emitted by one of two singletons, so
 * `count(DISTINCT emitter)` collapses 485 distinct pools onto 2 rows.
 */
const POOL_KEY = `CASE WHEN topic0 = ${sqlLiteral(SWAP_TOPICS.v4)} THEN topic1 ELSE emitter END`;

/**
 * Hex string -> decimal string, for wei quantities.
 *
 * ⚠️ Deliberately bounded at 2^128. DuckDB's widest integer is 128-bit, and a
 * full uint256 OVERFLOWS IT AND ABORTS THE ENTIRE COPY. Wei quantities cannot
 * reach that: total ETH supply is ~1.2e26 wei and 2^127 is ~1.7e38, twelve
 * orders of magnitude of headroom. A trimmed payload longer than 32 hex digits
 * is therefore not a wei quantity, and yields NULL rather than killing a build.
 *
 * ⚠️ This bound is safe for gas and value ONLY. Token amounts genuinely can
 * exceed 2^128 (a high-supply 18-decimal token), so leg amounts must never use
 * this macro — they come from JS `bigint` via `String()`, which has no ceiling.
 */
export const HEX_TO_DEC_MACRO = `CREATE OR REPLACE MACRO hex_to_dec(h) AS (
  CASE
    WHEN h IS NULL THEN NULL
    WHEN length(ltrim(lower(substr(h, 3)), '0')) > 32 THEN NULL
    ELSE CAST(
      COALESCE(
        list_reduce(
          [CAST(strpos('0123456789abcdef', c) - 1 AS UHUGEINT)
           FOR c IN string_split(ltrim(lower(substr(h, 3)), '0'), '')],
          lambda a, b: a * 16 + b),
        0::UHUGEINT)
    AS VARCHAR)
  END
)`;

/**
 * Statements to run before the select: the macro, the Seed view, the router
 * lookup table, and the per-transaction log aggregates.
 *
 * `seedGlob` is a path or glob passed straight to `read_parquet`. It is a
 * RUNTIME value — never derived from `import.meta.url`.
 */
export function candidatesSetupSql(opts: { seedGlob: string; routerValues: string }): string[] {
	return [
		HEX_TO_DEC_MACRO,
		`CREATE OR REPLACE VIEW seed AS SELECT * FROM read_parquet(${sqlLiteral(opts.seedGlob)})`,
		`CREATE OR REPLACE TABLE routers (address VARCHAR, name VARCHAR, version VARCHAR)`,
		`INSERT INTO routers VALUES ${opts.routerValues}`,
		// One row per receipt log. A transaction with no logs contributes none,
		// which is why every aggregate is COALESCEd in the select below.
		`CREATE OR REPLACE TEMP TABLE tx_logs AS
		 SELECT s.tx_hash,
		        json_extract_string(l.value, '$.address')   AS emitter,
		        json_extract_string(l.value, '$.topics[0]') AS topic0,
		        json_extract_string(l.value, '$.topics[1]') AS topic1
		 FROM seed s, json_each(s.receipt_json, '$.logs') l`,
		`CREATE OR REPLACE TEMP TABLE tx_agg AS
		 SELECT tx_hash,
		        count(*)                                                        AS log_count,
		        count(*) FILTER (topic0 = ${sqlLiteral(TRANSFER_TOPIC)})        AS erc20_transfer_count,
		        count(*) FILTER (topic0 = ${sqlLiteral(SWAP_TOPICS.v2)})        AS v2_legs,
		        count(*) FILTER (topic0 = ${sqlLiteral(SWAP_TOPICS.v3)})        AS v3_legs,
		        count(*) FILTER (topic0 = ${sqlLiteral(SWAP_TOPICS.v4)})        AS v4_legs,
		        count(DISTINCT ${POOL_KEY}) FILTER (topic0 IN (${ALL_SWAP_TOPICS})) AS distinct_pools,
		        count(DISTINCT topic1) FILTER (topic0 = ${sqlLiteral(SWAP_TOPICS.v4)}) AS distinct_v4_poolids
		 FROM tx_logs GROUP BY tx_hash`,
	];
}

/**
 * The select whose result IS the candidates file. Column order here must match
 * CANDIDATE_COLUMNS in derivedSchema.ts.
 *
 * ORDER BY block_number, block_position is load-bearing: it is what makes
 * row-group min/max statistics useful, exactly as in the Seed layer.
 */
export function candidatesSelectSql(opts: {
	seedFile: string;
	derivedAt: string;
	schemaVersion: number;
}): string {
	return `SELECT
	  s.chain_id,
	  s.block_number,
	  s.block_position,
	  s.tx_hash,
	  s.block_timestamp,
	  s.tx_from,
	  s.tx_to,
	  s.tx_status,
	  CASE
	    WHEN r.address IS NOT NULL AND COALESCE(a.v2_legs + a.v3_legs + a.v4_legs, 0) > 0 THEN 'both'
	    WHEN r.address IS NOT NULL THEN 'router'
	    ELSE 'swap_log'
	  END::VARCHAR                                              AS selected_via,
	  r.name                                                    AS router_name,
	  r.version                                                 AS router_version,
	  (COALESCE(a.v2_legs, 0) + COALESCE(a.v3_legs, 0) + COALESCE(a.v4_legs, 0))::INTEGER AS swap_log_count,
	  COALESCE(a.v2_legs, 0)::INTEGER                           AS v2_legs,
	  COALESCE(a.v3_legs, 0)::INTEGER                           AS v3_legs,
	  COALESCE(a.v4_legs, 0)::INTEGER                           AS v4_legs,
	  COALESCE(a.distinct_pools, 0)::INTEGER                    AS distinct_pools,
	  COALESCE(a.distinct_v4_poolids, 0)::INTEGER               AS distinct_v4_poolids,
	  COALESCE(a.log_count, 0)::INTEGER                         AS log_count,
	  COALESCE(a.erc20_transfer_count, 0)::INTEGER              AS erc20_transfer_count,
	  hex_to_dec(json_extract_string(s.receipt_json, '$.gasUsed'))::BIGINT AS gas_used,
	  hex_to_dec(json_extract_string(s.receipt_json, '$.effectiveGasPrice')) AS effective_gas_price,
	  hex_to_dec(json_extract_string(s.receipt_json, '$.l1Fee'))             AS l1_fee,
	  hex_to_dec(json_extract_string(s.tx_json, '$.value'))                  AS tx_value,
	  ${sqlLiteral(opts.seedFile)}                              AS seed_file,
	  ${sqlLiteral(opts.derivedAt)}::TIMESTAMP                  AS derived_at,
	  ${opts.schemaVersion}::INTEGER                            AS derived_schema_version
	FROM seed s
	LEFT JOIN tx_agg a ON a.tx_hash = s.tx_hash
	LEFT JOIN routers r ON lower(s.tx_to) = r.address
	WHERE r.address IS NOT NULL OR COALESCE(a.v2_legs + a.v3_legs + a.v4_legs, 0) > 0
	ORDER BY s.block_number, s.block_position`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/etl/src/candidatesSql.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add packages/etl/src/candidatesSql.ts packages/etl/src/candidatesSql.test.ts
git commit -m "feat(etl): candidates SQL over the Seed layer"
```

---

### Task 6: Build orchestration, CLI, and the real pilot run

**Files:**
- Create: `packages/etl/src/buildCandidates.ts`
- Test: `packages/etl/src/buildCandidates.test.ts`
- Create: `packages/etl/src/cliDerive.ts`
- Modify: `packages/etl/src/index.ts`
- Modify: `package.json` (root)

**Interfaces:**
- Consumes: `derivedFilePath` (Task 1), `CANDIDATE_COLUMNS` + `DERIVED_SCHEMA_VERSION` (Task 2), `copyQueryToParquet` (Task 3), `loadRouterRegistry` + `routerValuesSql` (Task 4), `candidatesSetupSql` + `candidatesSelectSql` (Task 5).
- Produces:
  - `interface BuildCandidatesOptions { seedGlob: string; seedFile: string; routersPath: string; dataDir: string; build: string; chain: string; fromBlock: number; toBlock: number; now?: () => Date }`
  - `interface BuildCandidatesResult { outPath: string; rowCount: number }`
  - `buildCandidates(opts: BuildCandidatesOptions): Promise<BuildCandidatesResult>`

**Context you need:** `now` is injected so `derived_at` is deterministic in tests. `seedGlob` is what DuckDB reads; `seedFile` is the human label stamped into the `seed_file` column — for a multi-file build, pass the glob itself.

Read `packages/etl/src/cli.ts` for the CLI style: `commander`, `dotenv`, explicit validation before doing any work, and `resolve(process.cwd(), ...)` for paths.

- [ ] **Step 1: Write the failing test**

Create `packages/etl/src/buildCandidates.test.ts`:

```ts
import { DuckDBInstance } from '@duckdb/node-api';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCandidates } from './buildCandidates.js';
import { CANDIDATE_COLUMNS } from './derivedSchema.js';
import { SWAP_TOPICS } from './candidatesSql.js';
import type { SeedRow } from './schema.js';
import { writeSeedParquet } from './writeSeedParquet.js';

const ROUTER = '0x1111111254eeb25477b68fb85ed929f73a960582';

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'buildCandidates-'));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function seedRow(txHash: string, position: number, logs: unknown[], txTo = '0xdead'): SeedRow {
	return {
		chain_id: 8453,
		block_number: 50842630 + position,
		block_position: position,
		tx_hash: txHash,
		block_timestamp: '2026-09-03T22:30:07.000Z',
		tx_from: '0xfrom',
		tx_to: txTo,
		tx_status: true,
		block_hash: '0xblock',
		trace_json: '{}',
		receipt_json: JSON.stringify({ logs, gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00' }),
		tx_json: JSON.stringify({ value: '0x0' }),
		block_json: '{}',
		finality: 'finalized',
		ingested_at: '2026-09-03T22:45:00.000Z',
		source: 'test',
		schema_version: 1,
	} as SeedRow;
}

async function setup(): Promise<{ seedPath: string; routersPath: string }> {
	const seedPath = join(dir, 'traces.base.0050842630-0050842929.parquet');
	await writeSeedParquet(
		[
			seedRow('0xa', 0, [{ address: '0xpool1', topics: [SWAP_TOPICS.v3], data: '0x' }]),
			seedRow('0xb', 1, [], ROUTER),
			seedRow('0xc', 2, [{ address: '0xtoken', topics: ['0xother'], data: '0x' }]),
		],
		seedPath,
	);
	const routersPath = join(dir, 'routers.json');
	writeFileSync(
		routersPath,
		JSON.stringify({ routers: [{ name: '1inch', address: ROUTER, version: 'V5', active: true }] }),
	);
	return { seedPath, routersPath };
}

describe('buildCandidates', () => {
	it('writes a candidates file at the derived path and excludes non-candidates', async () => {
		const { seedPath, routersPath } = await setup();
		const result = await buildCandidates({
			seedGlob: seedPath,
			seedFile: 'traces.base.0050842630-0050842929.parquet',
			routersPath,
			dataDir: dir,
			build: 'testbuild',
			chain: 'base',
			fromBlock: 50842630,
			toBlock: 50842929,
			now: () => new Date('2026-09-04T12:00:00.000Z'),
		});

		expect(result.rowCount).toBe(2); // 0xc is neither a router call nor a swap
		expect(result.outPath).toBe(
			join(dir, 'derived', 'testbuild', 'candidates.base.0050842630-0050842929.parquet'),
		);
		expect(existsSync(result.outPath)).toBe(true);
	});

	it('writes exactly the declared columns, in declared order', async () => {
		const { seedPath, routersPath } = await setup();
		const result = await buildCandidates({
			seedGlob: seedPath,
			seedFile: 'seed.parquet',
			routersPath,
			dataDir: dir,
			build: 'testbuild',
			chain: 'base',
			fromBlock: 50842630,
			toBlock: 50842929,
			now: () => new Date('2026-09-04T12:00:00.000Z'),
		});

		const instance = await DuckDBInstance.create(':memory:');
		const connection = await instance.connect();
		try {
			const reader = await connection.runAndReadAll(
				`SELECT * FROM read_parquet('${result.outPath}') LIMIT 1`,
			);
			expect(reader.columnNames()).toEqual(Object.keys(CANDIDATE_COLUMNS));
		} finally {
			connection.closeSync();
			instance.closeSync();
		}
	});

	it('is idempotent: a second build replaces the file at the same path', async () => {
		const { seedPath, routersPath } = await setup();
		const opts = {
			seedGlob: seedPath,
			seedFile: 'seed.parquet',
			routersPath,
			dataDir: dir,
			build: 'testbuild',
			chain: 'base',
			fromBlock: 50842630,
			toBlock: 50842929,
			now: () => new Date('2026-09-04T12:00:00.000Z'),
		};
		const first = await buildCandidates(opts);
		const second = await buildCandidates(opts);
		expect(second.outPath).toBe(first.outPath);
		expect(second.rowCount).toBe(first.rowCount);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/etl/src/buildCandidates.test.ts`
Expected: FAIL — `Failed to resolve import "./buildCandidates.js"`.

- [ ] **Step 3: Write `buildCandidates.ts`**

Create `packages/etl/src/buildCandidates.ts`:

```ts
import { candidatesSelectSql, candidatesSetupSql } from './candidatesSql.js';
import { derivedFilePath } from './derivedPath.js';
import { DERIVED_SCHEMA_VERSION } from './derivedSchema.js';
import { loadRouterRegistry, routerValuesSql } from './routerRegistry.js';
import { copyQueryToParquet } from './writeParquet.js';

/**
 * buildCandidates.ts — Seed glob in, `candidates` Parquet out. No network.
 *
 * The rows never materialize in JS: DuckDB reads the Seed Parquet, aggregates
 * the logs and COPYs straight to the output file. That is why this uses
 * copyQueryToParquet rather than writeRowsToParquet.
 */

export interface BuildCandidatesOptions {
	/** Path or glob handed to `read_parquet`. A RUNTIME value. */
	seedGlob: string;
	/** Human label stamped into every row's `seed_file`; pass the glob for a multi-file build. */
	seedFile: string;
	routersPath: string;
	dataDir: string;
	build: string;
	chain: string;
	fromBlock: number;
	toBlock: number;
	/** Injected so `derived_at` is deterministic under test. */
	now?: () => Date;
}

export interface BuildCandidatesResult {
	outPath: string;
	rowCount: number;
}

export async function buildCandidates(
	opts: BuildCandidatesOptions,
): Promise<BuildCandidatesResult> {
	const routers = await loadRouterRegistry(opts.routersPath);
	const outPath = derivedFilePath({
		dataDir: opts.dataDir,
		build: opts.build,
		family: 'candidates',
		chain: opts.chain,
		fromBlock: opts.fromBlock,
		toBlock: opts.toBlock,
	});

	const rowCount = await copyQueryToParquet({
		outPath,
		setupSql: candidatesSetupSql({
			seedGlob: opts.seedGlob,
			routerValues: routerValuesSql(routers),
		}),
		selectSql: candidatesSelectSql({
			seedFile: opts.seedFile,
			derivedAt: (opts.now?.() ?? new Date()).toISOString(),
			schemaVersion: DERIVED_SCHEMA_VERSION,
		}),
	});

	return { outPath, rowCount };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/etl/src/buildCandidates.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the CLI**

Create `packages/etl/src/cliDerive.ts`:

```ts
import { Command } from 'commander';
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { buildCandidates } from './buildCandidates.js';
import { parseNonNegativeInt } from './cliValidation.js';

/**
 * cliDerive.ts — the Derived-layer entry point.
 *
 * No RPC, no TCA_RPC_URL. Every path resolves from an argument against the
 * process CWD at RUNTIME, never from import.meta.url.
 */

config();

const program = new Command();

program
	.name('etl-derive')
	.description('Build Derived Parquet files from the Seed archive');

program
	.command('candidates')
	.description('One row per candidate swap transaction. Zero RPC.')
	.requiredOption('--seed <glob>', 'Seed Parquet path or glob')
	.requiredOption('--from <block>', 'first block of the range, for the filename')
	.requiredOption('--to <block>', 'last block of the range, for the filename')
	.requiredOption('--build <tag>', 'build directory under data/derived/')
	.option('--chain <name>', 'chain slug used in the filename', 'base')
	.option('--data-dir <path>', 'root of the data directory', 'data')
	.option('--routers <path>', 'router registry', 'configs/routers.json')
	.action(async (options) => {
		const fromBlock = parseNonNegativeInt(options.from, '--from');
		const toBlock = parseNonNegativeInt(options.to, '--to');

		const started = Date.now();
		const result = await buildCandidates({
			seedGlob: resolve(process.cwd(), options.seed),
			seedFile: options.seed,
			routersPath: resolve(process.cwd(), options.routers),
			dataDir: resolve(process.cwd(), options.dataDir),
			build: options.build,
			chain: options.chain,
			fromBlock,
			toBlock,
		});

		const seconds = ((Date.now() - started) / 1000).toFixed(1);
		console.log(`${result.rowCount} candidate rows in ${seconds}s\n  → ${result.outPath}`);
	});

await program.parseAsync(process.argv);
```

- [ ] **Step 6: Export the new surface and add the npm script**

Append to `packages/etl/src/index.ts`:

```ts
export { buildCandidates, type BuildCandidatesOptions, type BuildCandidatesResult } from './buildCandidates.js';
export { candidatesSelectSql, candidatesSetupSql, HEX_TO_DEC_MACRO, SWAP_TOPICS, TRANSFER_TOPIC } from './candidatesSql.js';
export { cacheFilePath, derivedFileName, derivedFilePath, type CacheName, type DerivedFamily } from './derivedPath.js';
export { CANDIDATE_COLUMNS, DERIVED_SCHEMA_VERSION, derivedColumnSpec, type CandidateRow } from './derivedSchema.js';
export { loadRouterRegistry, routerValuesSql, type RouterEntry } from './routerRegistry.js';
export { copyQueryToParquet, writeRowsToParquet } from './writeParquet.js';
```

In the root `package.json`, add to `scripts`, after `etl:ingest`:

```json
"etl:derive": "tsc --build && node packages/etl/dist/cliDerive.js",
```

- [ ] **Step 7: Run the full suite, typecheck and lint**

Run: `npm run typecheck && npm run lint && npx vitest run`
Expected: all clean. Run from the repo root — from a package subdirectory vitest silently reports roughly half the suite.

If `TCA_RPC_URL` is set in your environment, use `npx vitest run --no-file-parallelism` instead: four e2e files otherwise trip genuine QuickNode 429s.

- [ ] **Step 8: Build the real pilot candidates file and verify the counts**

Run:

```bash
npm run etl:derive -- candidates \
  --seed 'data/seeds/traces.base.0050842630-0050842929.parquet' \
  --from 50842630 --to 50842929 --build 2026-09-04a
```

Expected: `13641 candidate rows in ~7s`.

Then verify against the numbers this plan was written from:

```bash
duckdb -c "
SELECT count(*) AS rows FROM read_parquet('data/derived/2026-09-04a/candidates.base.0050842630-0050842929.parquet');
SELECT selected_via, count(*) AS n FROM read_parquet('data/derived/2026-09-04a/candidates.base.0050842630-0050842929.parquet') GROUP BY 1 ORDER BY 2 DESC;
SELECT sum(swap_log_count) AS legs, sum(v4_legs) AS v4 FROM read_parquet('data/derived/2026-09-04a/candidates.base.0050842630-0050842929.parquet');
"
```

Expected, exactly:

| Check | Value |
|---|---|
| rows | 13641 |
| `swap_log` | 12976 |
| `both` | 535 |
| `router` | 130 |
| legs | 20560 |
| v4 | 5700 |

**If any number differs, stop and investigate before committing.** These were measured from the same Seed file with the same SQL; a difference means the implementation diverged from the verified query, not that the numbers moved.

- [ ] **Step 9: Confirm the derived output is gitignored**

Run: `git status --short`
Expected: no `data/derived/` entries. If any appear, add `data/derived/` to `.gitignore` in the same commit — Derived Parquet is disposable and must never be committed.

- [ ] **Step 10: Commit**

```bash
git add packages/etl/src/buildCandidates.ts packages/etl/src/buildCandidates.test.ts \
        packages/etl/src/cliDerive.ts packages/etl/src/index.ts package.json
git commit -m "feat(etl): build the candidates Derived file

13,641 rows from the pilot Seed in ~7s: 12,976 swap_log, 535 both, 130 router."
```

---

## What this plan does NOT cover

The spec's v0.2 is two subsystems. This plan is the first — zero-RPC, no
network, and it ships a usable research table on its own. The second is a
separate plan, written after this one lands:

**v0.2b — enrichment (`receipts` + `legs`)**

1. `FactCache` interface and in-memory implementation in `packages/core`.
2. Parquet-backed `FactCache` store in `packages/etl` (`pools`, `tokens`, `v4_poolkeys`).
3. `analyzeTransaction` re-rig: `includeWings`, then `prefetched`, then `factCache` wiring through `routeReaders.ts`. Each is additive and separately reviewable.
4. Pure `Receipt` -> `receipts` row and `Receipt` -> `legs` rows transforms.
5. The serial enrichment runner and its CLI command.
6. The determinism harness, and the 535-transaction run it validates.
7. Ruler-coverage instrumentation, which gates the v0.3 `pool_state` decision.
8. The 13,511-transaction run.

Splitting here is deliberate: everything above needs a live archive endpoint,
carries the open `transient-rpc-silently-degrades-receipts` hazard, and touches
`packages/core`, which the dashboard also depends on. None of that should be
entangled with SQL that needs no network at all.
