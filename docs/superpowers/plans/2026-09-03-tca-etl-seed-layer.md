# TCA ETL Pipeline v0.1 — Seed Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `packages/etl`, which ingests a finalized Base block range into a single immutable Seed Parquet file that DuckDB can query directly.

**Architecture:** Three RPC calls per block (`debug_traceBlockByNumber`, `eth_getBlockReceipts`, `eth_getBlockByNumber`) are joined *by transaction hash* into one self-sufficient row per transaction. Rows stream to a temp NDJSON file; DuckDB's `COPY … TO … (FORMAT PARQUET)` writes the Parquet; the result is renamed into place atomically. No blockchain analysis happens anywhere in this package — it is a faithful cache, and every interpretation is deferred to Derived files in v0.2.

**Tech Stack:** TypeScript (ES2022, NodeNext), Node 20, viem (already in repo), `@duckdb/node-api@1.5.5-r.4`, commander (already in repo), vitest.

**Spec:** `docs/superpowers/specs/2026-09-03-tca-etl-seed-schema-design.md` — read it before Task 1. The plan implements it; the spec explains why.

## Global Constraints

- **Indentation is TABS.** Every file in this repo uses tabs. Match it.
- **Vitest runs from the repo root only.** `npx vitest run` from inside a package silently reports about half the suite. Always `cd` to the repo root first.
- **Never resolve a runtime data path from `import.meta.url`.** Seed and data-directory paths come from a CLI argument or environment variable at runtime. (Test *fixtures* are exempt — they are source-adjacent and never deployed, so Task 3's test resolves its fixture that way deliberately.) The six existing `configs/*.json` paths bake the build machine's absolute path and work only because Nixpacks builds in-container; do not repeat that here.
- **`packages/dashboard` must never depend on `packages/etl`.** `@duckdb/node-api` ships a native binary that must stay out of the Railway build.
- **`atomicWriteJson` (`packages/core/src/atomicWrite.ts`) is NOT reusable here.** It calls `JSON.stringify` internally and only writes JSON. Task 4 implements its own rename.
- **`source` is a provider label** (`"quicknode-base-mainnet"`), never a URL. `TCA_RPC_URL` contains an API key and must never reach a data file, a log line, or a test snapshot.
- **`SCHEMA_VERSION` is `1`** and bumps only on a breaking column change.
- **The 17 Seed columns are frozen.** Task 1 installs a tripwire test that fails on any addition, removal, rename or retype.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/etl/package.json` | workspace package, owns the `@duckdb/node-api` dependency |
| `packages/etl/tsconfig.json` | extends `tsconfig.base.json`, matches `packages/core` |
| `packages/etl/src/schema.ts` | **single source of truth** — 17 columns, their DuckDB types, `SeedRow`, `SCHEMA_VERSION` |
| `packages/etl/src/schema.test.ts` | frozen-schema tripwire |
| `packages/etl/src/seedPath.ts` | filename convention + finalized/provisional routing |
| `packages/etl/src/seedPath.test.ts` | padding, ordering, routing |
| `packages/etl/src/rpcTypes.ts` | shapes of the three raw RPC payloads |
| `packages/etl/src/buildSeedRows.ts` | **pure** `(payloads, meta) → SeedRow[]`; the alignment guarantee lives here |
| `packages/etl/src/buildSeedRows.test.ts` | alignment, NULL `tx_to`, header stripping, payload standard |
| `packages/etl/src/__fixtures__/block-50795977.json` | trimmed real block, 3 transactions |
| `packages/etl/src/writeSeedParquet.ts` | NDJSON → DuckDB `COPY` → atomic rename |
| `packages/etl/src/writeSeedParquet.test.ts` | DuckDB round-trip |
| `packages/etl/src/finality.ts` | finalized-head lookup + admission rule |
| `packages/etl/src/finality.test.ts` | gate behaviour |
| `packages/etl/src/fetchBlock.ts` | the three RPC calls for one block |
| `packages/etl/src/ingest.ts` | orchestration across a range |
| `packages/etl/src/cli.ts` | commander entry point |
| `packages/etl/src/ingest.e2e.test.ts` | live, `TCA_RPC_URL`-gated |
| `tsconfig.json` | add the `packages/etl` project reference |
| `.gitignore` | ignore `data/` |

---

### Task 1: Package scaffold, frozen schema, and the tripwire

**Files:**
- Create: `packages/etl/package.json`, `packages/etl/tsconfig.json`, `packages/etl/src/schema.ts`
- Test: `packages/etl/src/schema.test.ts`
- Modify: `tsconfig.json` (root), `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: `SCHEMA_VERSION: number`, `type Finality = 'finalized' | 'safe' | 'unsafe'`, `type SeedRow`, `SEED_COLUMNS: Readonly<Record<string, string>>` (insertion-ordered), `seedColumnSpec(): string`.

- [ ] **Step 1: Create the package scaffold**

`packages/etl/package.json`:

```json
{
	"name": "@fabric-tca/etl",
	"version": "0.0.0",
	"private": true,
	"type": "module",
	"main": "./src/index.ts",
	"types": "./src/index.ts",
	"scripts": {
		"build": "tsc --build"
	},
	"dependencies": {
		"@duckdb/node-api": "1.5.5-r.4",
		"commander": "^12.0.0",
		"viem": "^2.21.0"
	}
}
```

`packages/etl/tsconfig.json`:

```json
{
	"extends": "../../tsconfig.base.json",
	"compilerOptions": {
		"outDir": "./dist",
		"rootDir": "./src"
	},
	"include": ["src/**/*"]
}
```

Add to the root `tsconfig.json` `references` array: `{ "path": "./packages/etl" }`

Append to `.gitignore`:

```
data/
```

Then install from the repo root: `npm install`

- [ ] **Step 2: Write the failing tripwire test**

`packages/etl/src/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, SEED_COLUMNS, seedColumnSpec } from './schema.js';

/**
 * The Seed layer is immutable by design: Derived files rebuild from Seeds in
 * seconds, but rebuilding a Seed means re-fetching from an endpoint that may no
 * longer agree with what it said before.
 *
 * If this test fails you are changing the data model. That is allowed, but it is
 * a deliberate act, not a refactor. Before editing this list, apply the
 * promotion rule from the spec (§4): a field becomes a column only if it is used
 * for PRUNING (deciding which rows to read), IDENTITY, or INTEGRITY. Anything
 * used for COMPUTATION stays inside a JSON payload, because computation is what
 * Derived files are for.
 */
const FROZEN: ReadonlyArray<readonly [string, string]> = [
	['chain_id', 'INTEGER'],
	['block_number', 'BIGINT'],
	['block_position', 'INTEGER'],
	['tx_hash', 'VARCHAR'],
	['block_timestamp', 'TIMESTAMP'],
	['tx_from', 'VARCHAR'],
	['tx_to', 'VARCHAR'],
	['tx_status', 'BOOLEAN'],
	['block_hash', 'VARCHAR'],
	['trace_json', 'VARCHAR'],
	['receipt_json', 'VARCHAR'],
	['tx_json', 'VARCHAR'],
	['block_json', 'VARCHAR'],
	['finality', 'VARCHAR'],
	['ingested_at', 'TIMESTAMP'],
	['source', 'VARCHAR'],
	['schema_version', 'INTEGER'],
];

describe('Seed schema', () => {
	it('is frozen: 17 columns, in order, with these exact types', () => {
		expect(Object.entries(SEED_COLUMNS)).toEqual(FROZEN.map(([n, t]) => [n, t]));
	});

	it('is at version 1', () => {
		expect(SCHEMA_VERSION).toBe(1);
	});

	it('renders a DuckDB read_json column spec', () => {
		const spec = seedColumnSpec();
		expect(spec.startsWith("{'chain_id': 'INTEGER'")).toBe(true);
		expect(spec.endsWith("'schema_version': 'INTEGER'}")).toBe(true);
		expect(spec.split(',').length).toBe(17);
	});
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run from the repo root: `npx vitest run packages/etl/src/schema.test.ts`
Expected: FAIL — cannot resolve `./schema.js`.

- [ ] **Step 4: Write the schema module**

`packages/etl/src/schema.ts`:

```ts
/**
 * schema.ts — the single source of truth for the Seed layer's shape.
 *
 * A Seed row is one transaction, self-sufficient: trace, receipt, transaction
 * envelope and block header are all reachable without a join. Four columns hold
 * JSON payloads; the rest exist only so DuckDB can prune row groups without
 * decompressing those payloads.
 *
 * Timestamps are ISO 8601 UTC STRINGS in TypeScript, not Date objects, because
 * a SeedRow's serialized form is a line of NDJSON. DuckDB parses them into
 * TIMESTAMP on the way into Parquet.
 */

export const SCHEMA_VERSION = 1;

/** Whether the chain had permanently committed to this block when we read it. */
export type Finality = 'finalized' | 'safe' | 'unsafe';

/**
 * Column name → DuckDB type. Insertion order IS the Parquet column order, and
 * `schema.test.ts` freezes both. See that test before changing anything here.
 */
export const SEED_COLUMNS = {
	chain_id: 'INTEGER',
	block_number: 'BIGINT',
	block_position: 'INTEGER',
	tx_hash: 'VARCHAR',
	block_timestamp: 'TIMESTAMP',
	tx_from: 'VARCHAR',
	tx_to: 'VARCHAR',
	tx_status: 'BOOLEAN',
	block_hash: 'VARCHAR',
	trace_json: 'VARCHAR',
	receipt_json: 'VARCHAR',
	tx_json: 'VARCHAR',
	block_json: 'VARCHAR',
	finality: 'VARCHAR',
	ingested_at: 'TIMESTAMP',
	source: 'VARCHAR',
	schema_version: 'INTEGER',
} as const satisfies Readonly<Record<string, string>>;

export interface SeedRow {
	chain_id: number;
	/**
	 * Safe as a JS number: Base is near 5.1e7, and 2^53 is ~9.0e15. Stored as
	 * BIGINT in Parquet, which reads back as a `bigint` on the JS side.
	 */
	block_number: number;
	block_position: number;
	tx_hash: string;
	block_timestamp: string;
	tx_from: string;
	/** NULL for a contract-creation transaction. */
	tx_to: string | null;
	tx_status: boolean;
	block_hash: string;
	trace_json: string;
	receipt_json: string;
	tx_json: string;
	block_json: string;
	finality: Finality;
	ingested_at: string;
	source: string;
	schema_version: number;
}

/**
 * Render SEED_COLUMNS as a DuckDB `read_json(columns := …)` struct literal.
 *
 * Passing the types explicitly rather than letting DuckDB sniff them is what
 * makes the written Parquet deterministic: sniffing infers from the first rows,
 * so a chunk where every `tx_to` happened to be NULL could otherwise land a
 * different type than a chunk where one was set.
 */
export function seedColumnSpec(): string {
	const entries = Object.entries(SEED_COLUMNS).map(([name, type]) => `'${name}': '${type}'`);
	return `{${entries.join(', ')}}`;
}
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run from the repo root: `npx vitest run packages/etl/src/schema.test.ts`
Expected: PASS, 3 tests.

Then confirm the package compiles and lints: `npm run typecheck && npm run lint`

- [ ] **Step 6: Commit**

```bash
git add packages/etl tsconfig.json .gitignore package.json package-lock.json
git commit -m "feat(etl): scaffold packages/etl with the frozen Seed schema"
```

---

### Task 2: Seed file naming and finalized/provisional routing

**Files:**
- Create: `packages/etl/src/seedPath.ts`
- Test: `packages/etl/src/seedPath.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `seedFileName(chain: string, fromBlock: number, toBlock: number): string`, `seedFilePath(opts: { dataDir: string; chain: string; fromBlock: number; toBlock: number; finalized: boolean }): string`.

- [ ] **Step 1: Write the failing test**

`packages/etl/src/seedPath.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { seedFileName, seedFilePath } from './seedPath.js';

describe('seedFileName', () => {
	it('zero-pads both bounds to ten digits', () => {
		expect(seedFileName('base', 50830910, 50831209)).toBe(
			'traces.base.0050830910-0050831209.parquet',
		);
	});

	it('sorts lexically in the same order as numerically', () => {
		const names = [
			seedFileName('base', 9_000_000, 9_000_299),
			seedFileName('base', 500, 799),
			seedFileName('base', 50_831_209, 50_831_508),
		];
		expect([...names].sort()).toEqual([names[1], names[0], names[2]]);
	});

	it('rejects a range it cannot pad without truncating', () => {
		expect(() => seedFileName('base', 1, 10_000_000_000)).toThrow(/exceeds ten digits/);
	});

	it('rejects an inverted range', () => {
		expect(() => seedFileName('base', 500, 499)).toThrow(/inverted/);
	});
});

describe('seedFilePath', () => {
	const base = { dataDir: '/repo/data', chain: 'base', fromBlock: 100, toBlock: 399 };

	it('puts finalized files in the canonical archive', () => {
		expect(seedFilePath({ ...base, finalized: true })).toBe(
			'/repo/data/seeds/traces.base.0000000100-0000000399.parquet',
		);
	});

	it('quarantines unfinalized files one directory deeper', () => {
		expect(seedFilePath({ ...base, finalized: false })).toBe(
			'/repo/data/seeds/provisional/traces.base.0000000100-0000000399.parquet',
		);
	});
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run from the repo root: `npx vitest run packages/etl/src/seedPath.test.ts`
Expected: FAIL — cannot resolve `./seedPath.js`.

- [ ] **Step 3: Write the implementation**

`packages/etl/src/seedPath.ts`:

```ts
import { join } from 'node:path';

/**
 * seedPath.ts — where a Seed file lives, and what it is called.
 *
 * Two conventions are enforced here, both load-bearing:
 *
 * 1. Block bounds are zero-padded to ten digits, so LEXICAL sort equals
 *    NUMERIC sort. A DuckDB glob then returns files in block order for free.
 *    Ten digits reaches block 9,999,999,999 — about 630 years of Base at 2s.
 *
 * 2. Finalized and unfinalized files are separated PHYSICALLY, not by a flag
 *    someone has to remember to check. `data/seeds/*.parquet` is by
 *    construction the canonical archive, because the non-recursive glob cannot
 *    see into `provisional/`.
 */

const PAD = 10;

function pad(block: number): string {
	if (!Number.isInteger(block) || block < 0) {
		throw new Error(`Block number must be a non-negative integer, got ${block}`);
	}
	const text = String(block);
	if (text.length > PAD) {
		throw new Error(`Block ${block} exceeds ten digits; the naming convention needs widening`);
	}
	return text.padStart(PAD, '0');
}

/** `traces.base.0050830910-0050831209.parquet` — bounds inclusive. */
export function seedFileName(chain: string, fromBlock: number, toBlock: number): string {
	if (toBlock < fromBlock) {
		throw new Error(`Range is inverted: ${fromBlock} > ${toBlock}`);
	}
	return `traces.${chain}.${pad(fromBlock)}-${pad(toBlock)}.parquet`;
}

/**
 * Absolute path for a Seed file. `finalized: false` routes into `provisional/`,
 * which is the entire enforcement mechanism for the spec's admission rule.
 */
export function seedFilePath(opts: {
	dataDir: string;
	chain: string;
	fromBlock: number;
	toBlock: number;
	finalized: boolean;
}): string {
	const name = seedFileName(opts.chain, opts.fromBlock, opts.toBlock);
	const dir = opts.finalized
		? join(opts.dataDir, 'seeds')
		: join(opts.dataDir, 'seeds', 'provisional');
	return join(dir, name);
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run from the repo root: `npx vitest run packages/etl/src/seedPath.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/etl/src/seedPath.ts packages/etl/src/seedPath.test.ts
git commit -m "feat(etl): Seed file naming with finalized/provisional routing"
```

---

### Task 3: Build Seed rows from raw payloads (the pure core)

This is the task that carries the correctness of the whole layer. A row that pairs one transaction's trace with another transaction's receipt is the worst thing this package can produce, because everything downstream would trust it completely.

**Files:**
- Create: `packages/etl/src/rpcTypes.ts`, `packages/etl/src/buildSeedRows.ts`, `packages/etl/src/__fixtures__/block-50795977.json`
- Test: `packages/etl/src/buildSeedRows.test.ts`

**Interfaces:**
- Consumes: `SeedRow`, `Finality`, `SCHEMA_VERSION` from `./schema.js`.
- Produces: `interface BlockPayloads { traceBlock: TraceEntry[]; receipts: RawReceipt[]; block: RawBlock }`, `interface IngestMeta { chainId: number; finality: Finality; ingestedAt: string; source: string }`, `buildSeedRows(payloads: BlockPayloads, meta: IngestMeta): SeedRow[]`.

- [ ] **Step 1: Capture the fixture**

Run from the repo root. This trims a real block to its first three transactions so the committed fixture stays small:

```bash
set -a && source .env && set +a
mkdir -p packages/etl/src/__fixtures__
node -e '
const url = process.env.TCA_RPC_URL;
const B = "0x30715c9"; // block 50795977
const call = async (method, params) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(method + ": " + JSON.stringify(j.error));
  return j.result;
};
const [traceBlock, receipts, block] = await Promise.all([
  call("debug_traceBlockByNumber", [B, { tracer: "callTracer", tracerConfig: { withLog: true, onlyTopCall: false } }]),
  call("eth_getBlockReceipts", [B]),
  call("eth_getBlockByNumber", [B, true]),
]);
const keep = new Set(traceBlock.slice(0, 3).map((e) => e.txHash.toLowerCase()));
const fixture = {
  traceBlock: traceBlock.filter((e) => keep.has(e.txHash.toLowerCase())),
  receipts: receipts.filter((r) => keep.has(r.transactionHash.toLowerCase())),
  block: { ...block, transactions: block.transactions.filter((t) => keep.has(t.hash.toLowerCase())) },
};
require("node:fs").writeFileSync("packages/etl/src/__fixtures__/block-50795977.json",
  JSON.stringify(fixture, null, 2) + "\n");
console.log("txs:", fixture.traceBlock.length, "bytes:", JSON.stringify(fixture).length);
' --input-type=module
```

Expected: `txs: 3` and a fixture under ~120 KB.

- [ ] **Step 2: Write the failing test**

`packages/etl/src/buildSeedRows.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildSeedRows, type BlockPayloads, type IngestMeta } from './buildSeedRows.js';

// Read rather than `import ... with { type: 'json' }`: under NodeNext ESM the
// import attribute is required at runtime but handled differently by vitest's
// transform, and reading sidesteps the question entirely. It also gives every
// test a fresh deep copy for free.
// `import.meta.url` is correct here and nowhere else in this package: a test
// fixture is source-adjacent and never built or deployed, so there is no build
// machine whose absolute path could get baked in. Runtime DATA paths still come
// from a CLI argument — see Global Constraints.
const RAW = readFileSync(
	fileURLToPath(new URL('./__fixtures__/block-50795977.json', import.meta.url)),
	'utf8',
);

const META: IngestMeta = {
	chainId: 8453,
	finality: 'finalized',
	ingestedAt: '2026-09-03T12:00:00.000Z',
	source: 'quicknode-base-mainnet',
};

const payloads = (): BlockPayloads => JSON.parse(RAW) as BlockPayloads;

describe('buildSeedRows', () => {
	it('emits one row per transaction', () => {
		const rows = buildSeedRows(payloads(), META);
		expect(rows).toHaveLength(3);
	});

	it('stamps identity, provenance and the block header on every row', () => {
		const [row] = buildSeedRows(payloads(), META);
		expect(row!.chain_id).toBe(8453);
		expect(row!.block_number).toBe(50795977);
		expect(row!.finality).toBe('finalized');
		expect(row!.source).toBe('quicknode-base-mainnet');
		expect(row!.schema_version).toBe(1);
		expect(row!.block_timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});

	it('pairs each trace with the receipt and tx of the SAME hash, not the same index', () => {
		const p = payloads();
		// Reverse ONE payload's ordering. Index-based assembly would now
		// mis-pair every row; hash-based assembly is unaffected.
		p.receipts.reverse();
		const rows = buildSeedRows(p, META);
		for (const row of rows) {
			expect(JSON.parse(row.receipt_json).transactionHash.toLowerCase()).toBe(row.tx_hash);
			expect(JSON.parse(row.tx_json).hash.toLowerCase()).toBe(row.tx_hash);
			expect(JSON.parse(row.trace_json)).toBeTypeOf('object');
		}
	});

	it('takes block_position from the receipt, not from array order', () => {
		const p = payloads();
		p.receipts.reverse();
		const rows = buildSeedRows(p, META);
		expect(rows.map((r) => r.block_position)).toEqual([0, 1, 2]);
	});

	it('returns no rows for an empty block without treating it as an error', () => {
		const p = payloads();
		p.traceBlock = [];
		p.receipts = [];
		p.block.transactions = [];
		expect(buildSeedRows(p, META)).toEqual([]);
	});

	it('aborts the block when the payloads disagree on transaction count', () => {
		const p = payloads();
		p.receipts.pop();
		expect(() => buildSeedRows(p, META)).toThrow(/transaction count/i);
	});

	it('aborts the block when a trace has no matching receipt', () => {
		const p = payloads();
		p.receipts[0]!.transactionHash = '0x' + 'de'.repeat(32);
		expect(() => buildSeedRows(p, META)).toThrow(/no receipt/i);
	});

	it('strips the transaction list out of block_json and keeps the rest', () => {
		const [row] = buildSeedRows(payloads(), META);
		const header = JSON.parse(row!.block_json);
		expect(header.transactions).toBeUndefined();
		expect(header.baseFeePerGas).toBeDefined();
		expect(header.hash).toBe(row!.block_hash);
	});

	it('records tx_to as NULL for a contract creation', () => {
		const p = payloads();
		delete (p.block.transactions[0] as Record<string, unknown>).to;
		p.receipts[0]!.to = null;
		const [row] = buildSeedRows(p, META);
		expect(row!.tx_to).toBeNull();
	});

	it('lowercases the promoted address and hash columns', () => {
		const p = payloads();
		p.receipts[0]!.transactionHash = p.receipts[0]!.transactionHash.toUpperCase().replace('0X', '0x');
		const [row] = buildSeedRows(p, META);
		expect(row!.tx_hash).toBe(row!.tx_hash.toLowerCase());
		expect(row!.tx_from).toBe(row!.tx_from.toLowerCase());
	});

	it('maps receipt status 0x1 to true and 0x0 to false', () => {
		const p = payloads();
		p.receipts[0]!.status = '0x0';
		const rows = buildSeedRows(p, META);
		expect(rows[0]!.tx_status).toBe(false);
	});

	/**
	 * Pins the spec's payload standard (§3). Semantic losslessness is only
	 * equivalent to byte preservation because every scalar in these payloads is
	 * a hex string, boolean or null — there is no JSON number to round-trip
	 * through an IEEE-754 double. If a client upgrade ever emits a bare number,
	 * this fails and the standard must be revisited rather than silently broken.
	 */
	it('contains no JSON numbers anywhere in any payload', () => {
		const offenders: string[] = [];
		const walk = (node: unknown, path: string): void => {
			if (typeof node === 'number') offenders.push(`${path} = ${node}`);
			else if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${path}[${i}]`));
			else if (node && typeof node === 'object') {
				for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
			}
		};
		walk(JSON.parse(RAW), '$');
		expect(offenders).toEqual([]);
	});

	it('preserves payload content exactly, adding and removing nothing', () => {
		const p = payloads();
		const [row] = buildSeedRows(p, META);
		const original = payloads();
		const hash = row!.tx_hash;
		const srcReceipt = original.receipts.find((r) => r.transactionHash.toLowerCase() === hash);
		expect(JSON.parse(row!.receipt_json)).toEqual(srcReceipt);
	});
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run from the repo root: `npx vitest run packages/etl/src/buildSeedRows.test.ts`
Expected: FAIL — cannot resolve `./buildSeedRows.js`.

- [ ] **Step 4: Write the raw payload types**

`packages/etl/src/rpcTypes.ts`:

```ts
/**
 * rpcTypes.ts — the shapes of the three raw RPC payloads, as returned.
 *
 * These are deliberately LOOSE. Only the fields this package actually promotes
 * to a column are named; everything else rides along in an index signature and
 * reaches Parquet untouched inside a JSON payload. Naming a field here would
 * imply we understand it, and understanding is a Derived-file concern.
 */

export interface TraceEntry {
	txHash: string;
	result: unknown;
}

export interface RawReceipt {
	transactionHash: string;
	transactionIndex: string;
	from: string;
	to: string | null;
	status: string;
	[key: string]: unknown;
}

export interface RawTx {
	hash: string;
	from: string;
	to?: string | null;
	[key: string]: unknown;
}

export interface RawBlock {
	number: string;
	hash: string;
	timestamp: string;
	transactions: RawTx[];
	[key: string]: unknown;
}
```

- [ ] **Step 5: Write the implementation**

`packages/etl/src/buildSeedRows.ts`:

```ts
import { SCHEMA_VERSION, type Finality, type SeedRow } from './schema.js';
import type { RawBlock, RawReceipt, RawTx, TraceEntry } from './rpcTypes.js';

/**
 * buildSeedRows.ts — the pure core of the Seed layer.
 *
 * Three RPC responses describe the same block in three independent orderings.
 * This module joins them into one row per transaction and does NOTHING else:
 * no decoding, no classification, no arithmetic. Every value it writes is
 * either copied verbatim from a payload or is provenance supplied by the
 * caller.
 *
 * The assembly is keyed on TRANSACTION HASH, never on array index. A row that
 * paired one transaction's trace with another's receipt would be undetectable
 * downstream and trusted completely, so a disagreement between the payloads
 * aborts the whole block rather than emitting a plausible-looking row.
 */

export interface BlockPayloads {
	traceBlock: TraceEntry[];
	receipts: RawReceipt[];
	block: RawBlock;
}

export interface IngestMeta {
	chainId: number;
	finality: Finality;
	/** ISO 8601 UTC. */
	ingestedAt: string;
	/** Provider label, never a URL — TCA_RPC_URL carries an API key. */
	source: string;
}

const lower = (value: string): string => value.toLowerCase();

/** Hex quantity → number. Used only for values known to be small (index, block, timestamp). */
function hexToNumber(hex: string): number {
	return Number.parseInt(hex, 16);
}

export function buildSeedRows(payloads: BlockPayloads, meta: IngestMeta): SeedRow[] {
	const { traceBlock, receipts, block } = payloads;
	const txs = block.transactions;

	if (traceBlock.length !== receipts.length || traceBlock.length !== txs.length) {
		throw new Error(
			`Payloads disagree on transaction count for block ${block.number}: ` +
				`trace=${traceBlock.length} receipts=${receipts.length} txs=${txs.length}`,
		);
	}

	const receiptByHash = new Map<string, RawReceipt>(
		receipts.map((r) => [lower(r.transactionHash), r]),
	);
	const txByHash = new Map<string, RawTx>(txs.map((t) => [lower(t.hash), t]));

	// The header travels on every row so a single row is self-sufficient. Its
	// `transactions` key is dropped because those transactions ARE the rows —
	// this is the only field-level transformation anywhere in the Seed layer.
	const { transactions: _dropped, ...header } = block;
	const blockJson = JSON.stringify(header);
	const blockHash = lower(block.hash);
	const blockNumber = hexToNumber(block.number);
	const blockTimestamp = new Date(hexToNumber(block.timestamp) * 1000).toISOString();

	const rows: SeedRow[] = [];
	for (const entry of traceBlock) {
		const hash = lower(entry.txHash);
		const receipt = receiptByHash.get(hash);
		if (!receipt) throw new Error(`Trace for ${hash} has no receipt in block ${block.number}`);
		const tx = txByHash.get(hash);
		if (!tx) throw new Error(`Trace for ${hash} has no transaction in block ${block.number}`);

		rows.push({
			chain_id: meta.chainId,
			block_number: blockNumber,
			block_position: hexToNumber(receipt.transactionIndex),
			tx_hash: hash,
			block_timestamp: blockTimestamp,
			tx_from: lower(receipt.from),
			tx_to: receipt.to ? lower(receipt.to) : null,
			tx_status: receipt.status === '0x1',
			block_hash: blockHash,
			trace_json: JSON.stringify(entry.result),
			receipt_json: JSON.stringify(receipt),
			tx_json: JSON.stringify(tx),
			block_json: blockJson,
			finality: meta.finality,
			ingested_at: meta.ingestedAt,
			source: meta.source,
			schema_version: SCHEMA_VERSION,
		});
	}

	rows.sort((a, b) => a.block_position - b.block_position);
	return rows;
}
```

- [ ] **Step 6: Run the tests and make sure they pass**

Run from the repo root: `npx vitest run packages/etl/src/buildSeedRows.test.ts`
Expected: PASS, 14 tests.

If the `lowercases` test fails because the fixture's hashes were already lowercase, that is fine — the test uppercases them itself before asserting.

- [ ] **Step 7: Commit**

```bash
git add packages/etl/src/rpcTypes.ts packages/etl/src/buildSeedRows.ts \
        packages/etl/src/buildSeedRows.test.ts packages/etl/src/__fixtures__
git commit -m "feat(etl): assemble Seed rows by transaction hash, never by index"
```

---

### Task 4: Write the Parquet through DuckDB

**Files:**
- Create: `packages/etl/src/writeSeedParquet.ts`
- Test: `packages/etl/src/writeSeedParquet.test.ts`

**Interfaces:**
- Consumes: `SeedRow`, `seedColumnSpec` from `./schema.js`.
- Produces: `writeSeedParquet(rows: SeedRow[], outPath: string): Promise<number>` — returns the row count written.

**Type note that will bite you:** reading a Parquet back through `getRowObjectsJS()` returns `BIGINT` as a JavaScript **`bigint`** (`50795977n`) and `TIMESTAMP` as a **`Date`**. Through `getRowObjectsJson()` a `BIGINT` comes back as a **string**. The test below asserts the `JS` variants.

- [ ] **Step 1: Write the failing test**

`packages/etl/src/writeSeedParquet.test.ts`:

```ts
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type SeedRow } from './schema.js';
import { writeSeedParquet } from './writeSeedParquet.js';

const dir = mkdtempSync(join(tmpdir(), 'etl-parquet-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const row = (position: number, overrides: Partial<SeedRow> = {}): SeedRow => ({
	chain_id: 8453,
	block_number: 50795977,
	block_position: position,
	tx_hash: `0x${String(position).padStart(64, '0')}`,
	block_timestamp: '2026-09-02T10:00:00.000Z',
	tx_from: '0xf1',
	tx_to: '0xd4',
	tx_status: true,
	block_hash: '0xbb',
	trace_json: '{"from":"0xf1","calls":[{"to":"0xc2"}]}',
	receipt_json: '{"status":"0x1"}',
	tx_json: '{"nonce":"0x1"}',
	block_json: '{"baseFeePerGas":"0x7"}',
	finality: 'finalized',
	ingested_at: '2026-09-03T01:02:03.000Z',
	source: 'quicknode-base-mainnet',
	schema_version: SCHEMA_VERSION,
	...overrides,
});

async function read(path: string, sql: string): Promise<Record<string, unknown>[]> {
	const instance = await DuckDBInstance.create(':memory:');
	const connection = await instance.connect();
	const reader = await connection.runAndReadAll(sql.replace('$PATH', path));
	return reader.getRowObjectsJS() as Record<string, unknown>[];
}

describe('writeSeedParquet', () => {
	it('writes a DuckDB-readable Parquet with the exact 17 columns in order', async () => {
		const path = join(dir, 'cols.parquet');
		await writeSeedParquet([row(0)], path);
		const rows = await read(path, `SELECT * FROM read_parquet('$PATH')`);
		expect(Object.keys(rows[0]!)).toEqual([
			'chain_id', 'block_number', 'block_position', 'tx_hash', 'block_timestamp',
			'tx_from', 'tx_to', 'tx_status', 'block_hash', 'trace_json', 'receipt_json',
			'tx_json', 'block_json', 'finality', 'ingested_at', 'source', 'schema_version',
		]);
	});

	it('round-trips every column with the right JS type', async () => {
		const path = join(dir, 'types.parquet');
		await writeSeedParquet([row(0)], path);
		const [out] = await read(path, `SELECT * FROM read_parquet('$PATH')`);
		expect(out!.chain_id).toBe(8453);
		expect(out!.block_number).toBe(50795977n); // BIGINT reads back as bigint
		expect(out!.block_position).toBe(0);
		expect(out!.tx_status).toBe(true);
		expect(out!.block_timestamp).toBeInstanceOf(Date);
		expect((out!.block_timestamp as Date).toISOString()).toBe('2026-09-02T10:00:00.000Z');
		expect(out!.source).toBe('quicknode-base-mainnet');
		expect(out!.schema_version).toBe(1);
	});

	it('preserves a NULL tx_to rather than coercing it to a string', async () => {
		const path = join(dir, 'null.parquet');
		await writeSeedParquet([row(0, { tx_to: null })], path);
		const [out] = await read(path, `SELECT * FROM read_parquet('$PATH')`);
		expect(out!.tx_to).toBeNull();
	});

	it('leaves the JSON payloads queryable as nested JSON', async () => {
		const path = join(dir, 'json.parquet');
		await writeSeedParquet([row(0)], path);
		const [out] = await read(
			path,
			`SELECT json_extract_string(trace_json, '$.calls[0].to') AS nested FROM read_parquet('$PATH')`,
		);
		expect(out!.nested).toBe('0xc2');
	});

	it('sorts rows by (block_number, block_position) regardless of input order', async () => {
		const path = join(dir, 'sorted.parquet');
		await writeSeedParquet([row(2), row(0), row(1)], path);
		const rows = await read(path, `SELECT block_position FROM read_parquet('$PATH')`);
		expect(rows.map((r) => r.block_position)).toEqual([0, 1, 2]);
	});

	it('returns the number of rows written', async () => {
		const path = join(dir, 'count.parquet');
		await expect(writeSeedParquet([row(0), row(1)], path)).resolves.toBe(2);
	});

	it('refuses to write an empty Seed file', async () => {
		await expect(writeSeedParquet([], join(dir, 'empty.parquet'))).rejects.toThrow(/no rows/i);
	});

	it('replaces an existing file so re-ingesting a range is idempotent', async () => {
		const path = join(dir, 'idempotent.parquet');
		await writeSeedParquet([row(0), row(1), row(2)], path);
		await writeSeedParquet([row(0)], path);
		const rows = await read(path, `SELECT block_position FROM read_parquet('$PATH')`);
		expect(rows).toHaveLength(1);
	});

	it('leaves no temp files beside the output', async () => {
		const path = join(dir, 'clean.parquet');
		await writeSeedParquet([row(0)], path);
		expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
	});
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run from the repo root: `npx vitest run packages/etl/src/writeSeedParquet.test.ts`
Expected: FAIL — cannot resolve `./writeSeedParquet.js`.

- [ ] **Step 3: Write the implementation**

`packages/etl/src/writeSeedParquet.ts`:

```ts
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { seedColumnSpec, type SeedRow } from './schema.js';

/**
 * writeSeedParquet.ts — rows in, Parquet on disk.
 *
 * DuckDB does the writing, deliberately. It is the engine every Derived file
 * will read with, so having it also do the writing removes an entire class of
 * bug: a library emitting Parquet that DuckDB cannot read, or writing row-group
 * statistics that silently do not match the data.
 *
 * `core`'s atomicWriteJson cannot be reused here — it JSON.stringifies its
 * input and only writes JSON — so the temp-then-rename dance is repeated.
 */

/**
 * Rows are ordered by (block_number, block_position) AT WRITE TIME, which is
 * what makes row-group min/max statistics useful. Without it, a block-range
 * filter has to decompress every row group in the file.
 */
const ROW_GROUP_SIZE = 4096;

/** SQL string literal escaping — paths are ours, but a stray quote must not build broken SQL. */
function sqlLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

export async function writeSeedParquet(rows: SeedRow[], outPath: string): Promise<number> {
	if (rows.length === 0) {
		throw new Error(`Refusing to write ${outPath}: no rows. An empty Seed file is never correct.`);
	}

	const dir = dirname(outPath);
	mkdirSync(dir, { recursive: true });

	// Both temps live beside the target: rename is only atomic within one
	// filesystem, and the OS temp directory is frequently a different mount.
	const stamp = `${process.pid}.${Date.now()}`;
	const ndjsonPath = join(dir, `.${stamp}.ndjson.tmp`);
	const parquetTmp = join(dir, `.${stamp}.parquet.tmp`);

	try {
		writeFileSync(ndjsonPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

		const instance = await DuckDBInstance.create(':memory:');
		const connection = await instance.connect();
		await connection.run(
			`COPY (
				SELECT * FROM read_json(${sqlLiteral(ndjsonPath)},
				                        columns := ${seedColumnSpec()},
				                        format := 'newline_delimited')
				ORDER BY block_number, block_position
			) TO ${sqlLiteral(parquetTmp)}
			  (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE ${ROW_GROUP_SIZE})`,
		);

		renameSync(parquetTmp, outPath);
		return rows.length;
	} finally {
		// A failure must not litter one temp pair per attempt beside the archive.
		rmSync(ndjsonPath, { force: true });
		rmSync(parquetTmp, { force: true });
	}
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run from the repo root: `npx vitest run packages/etl/src/writeSeedParquet.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/etl/src/writeSeedParquet.ts packages/etl/src/writeSeedParquet.test.ts
git commit -m "feat(etl): write Seed Parquet via DuckDB COPY with atomic rename"
```

---

### Task 5: Finality lookup and the admission gate

**Files:**
- Create: `packages/etl/src/finality.ts`, `packages/etl/src/fetchBlock.ts`
- Test: `packages/etl/src/finality.test.ts`

**Interfaces:**
- Consumes: `BlockPayloads` from `./buildSeedRows.js`, `Finality` from `./schema.js`.
- Produces: `rpcCall<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T>`, `finalizedHead(rpcUrl: string): Promise<number>`, `classifyRange(toBlock: number, finalizedHead: number, allowUnfinalized: boolean): Finality`, `fetchBlockPayloads(rpcUrl: string, blockNumber: number): Promise<BlockPayloads>`.

- [ ] **Step 1: Write the failing test**

`packages/etl/src/finality.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { classifyRange } from './finality.js';

describe('classifyRange', () => {
	it('admits a range entirely at or below the finalized head', () => {
		expect(classifyRange(50831209, 50831209, false)).toBe('finalized');
		expect(classifyRange(50831000, 50831209, false)).toBe('finalized');
	});

	it('refuses a range above the finalized head by default', () => {
		expect(() => classifyRange(50831210, 50831209, false)).toThrow(/--allow-unfinalized/);
	});

	it('names the exact overshoot so the caller can just move the range back', () => {
		expect(() => classifyRange(50831500, 50831209, false)).toThrow(/291 block/);
	});

	it('permits an unfinalized range only when explicitly allowed, and marks it', () => {
		expect(classifyRange(50831210, 50831209, true)).toBe('unsafe');
	});
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run from the repo root: `npx vitest run packages/etl/src/finality.test.ts`
Expected: FAIL — cannot resolve `./finality.js`.

- [ ] **Step 3: Write the finality module**

`packages/etl/src/finality.ts`:

```ts
import type { Finality } from './schema.js';

/**
 * finality.ts — the admission rule for the permanent Seed layer.
 *
 * An immutable archive of blocks that might be reorged away is a contradiction,
 * so a block may enter `data/seeds/` only once the chain has permanently
 * committed to it. The bar is the OP Stack's own `finalized` tag — an
 * L1-derived guarantee — rather than a chosen confirmation count.
 *
 * Measured on Base 2026-09-03: `finalized` trailed `latest` by ~570 blocks
 * (~19 minutes). Any range anchored to the chain head is therefore entirely
 * unfinalized, which is exactly the mistake this gate exists to refuse.
 */

export async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
	const response = await fetch(rpcUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
	if (!response.ok) {
		// The URL carries an API key, so it must never reach an error message.
		throw new Error(`RPC ${method} failed: HTTP ${response.status}`);
	}
	const body = (await response.json()) as { result?: T; error?: { message?: string } };
	if (body.error) throw new Error(`RPC ${method} failed: ${body.error.message ?? 'unknown error'}`);
	if (body.result === undefined) throw new Error(`RPC ${method} returned no result`);
	return body.result;
}

/** The highest block the chain has permanently committed to. */
export async function finalizedHead(rpcUrl: string): Promise<number> {
	const block = await rpcCall<{ number: string } | null>(rpcUrl, 'eth_getBlockByNumber', [
		'finalized',
		false,
	]);
	if (!block) throw new Error('Chain reported no finalized block');
	return Number.parseInt(block.number, 16);
}

/**
 * Decide whether a range may be written, and how it must be labelled.
 * Throws unless the range is finalized or the caller has explicitly opted out.
 */
export function classifyRange(
	toBlock: number,
	head: number,
	allowUnfinalized: boolean,
): Finality {
	if (toBlock <= head) return 'finalized';
	const overshoot = toBlock - head;
	if (!allowUnfinalized) {
		throw new Error(
			`Range ends at block ${toBlock}, which is ${overshoot} block(s) past the finalized ` +
				`head (${head}). A Seed file in the permanent archive must contain only finalized ` +
				`blocks. Move the range back, or pass --allow-unfinalized to write it into ` +
				`seeds/provisional/ instead.`,
		);
	}
	return 'unsafe';
}
```

- [ ] **Step 4: Write the block fetcher**

`packages/etl/src/fetchBlock.ts`:

```ts
import type { BlockPayloads } from './buildSeedRows.js';
import type { RawBlock, RawReceipt, TraceEntry } from './rpcTypes.js';
import { rpcCall } from './finality.js';

/**
 * fetchBlock.ts — the three calls that describe one block.
 *
 * They are issued in parallel because they are independent, and they are kept
 * in one function so that a Seed row can never be built from a partial fetch.
 */
export async function fetchBlockPayloads(
	rpcUrl: string,
	blockNumber: number,
): Promise<BlockPayloads> {
	const tag = `0x${blockNumber.toString(16)}`;
	const [traceBlock, receipts, block] = await Promise.all([
		rpcCall<TraceEntry[]>(rpcUrl, 'debug_traceBlockByNumber', [
			tag,
			{ tracer: 'callTracer', tracerConfig: { withLog: true, onlyTopCall: false } },
		]),
		rpcCall<RawReceipt[]>(rpcUrl, 'eth_getBlockReceipts', [tag]),
		rpcCall<RawBlock>(rpcUrl, 'eth_getBlockByNumber', [tag, true]),
	]);
	return { traceBlock, receipts, block };
}
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run from the repo root: `npx vitest run packages/etl/src/finality.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/etl/src/finality.ts packages/etl/src/finality.test.ts packages/etl/src/fetchBlock.ts
git commit -m "feat(etl): finalized-head admission gate and per-block fetcher"
```

---

### Task 6: Ingest orchestration and CLI

**Files:**
- Create: `packages/etl/src/ingest.ts`, `packages/etl/src/cli.ts`, `packages/etl/src/index.ts`
- Modify: root `package.json` (add the `etl:ingest` script)

**Interfaces:**
- Consumes: `fetchBlockPayloads`, `buildSeedRows`, `writeSeedParquet`, `seedFilePath`, `finalizedHead`, `classifyRange`.
- Produces: `ingestRange(opts: IngestOptions): Promise<IngestResult>` where `IngestResult = { outPath: string; rowCount: number; fromBlock: number; toBlock: number; finality: Finality }`.

- [ ] **Step 1: Write the orchestrator**

`packages/etl/src/ingest.ts`:

```ts
import { buildSeedRows, type IngestMeta } from './buildSeedRows.js';
import { classifyRange, finalizedHead } from './finality.js';
import { fetchBlockPayloads } from './fetchBlock.js';
import type { Finality, SeedRow } from './schema.js';
import { seedFilePath } from './seedPath.js';
import { writeSeedParquet } from './writeSeedParquet.js';

/**
 * ingest.ts — one range in, one Seed file out.
 *
 * Deliberately NOT resumable and NOT incremental in v0.1: a partial Seed file
 * is worse than no Seed file, because a later reader cannot tell the difference
 * between "this range had no swaps" and "ingest died halfway". The whole range
 * is assembled in memory and written once, or nothing is written at all.
 *
 * At the pilot's scale that is fine: ~34,000 rows and ~580 MB of JSON. A range
 * large enough to strain memory is the trigger to add chunking, and the
 * filename convention already accommodates splitting.
 */

export interface IngestOptions {
	rpcUrl: string;
	chain: string;
	chainId: number;
	fromBlock: number;
	toBlock: number;
	dataDir: string;
	source: string;
	allowUnfinalized: boolean;
	concurrency: number;
	onProgress?: (done: number, total: number) => void;
}

export interface IngestResult {
	outPath: string;
	rowCount: number;
	fromBlock: number;
	toBlock: number;
	finality: Finality;
}

/** Resolve `[F - span + 1, F]` where F is the current finalized head. */
export async function finalizedWindow(
	rpcUrl: string,
	span: number,
): Promise<{ fromBlock: number; toBlock: number }> {
	const head = await finalizedHead(rpcUrl);
	return { fromBlock: head - span + 1, toBlock: head };
}

async function mapWithConcurrency<T>(
	items: number[],
	limit: number,
	worker: (item: number) => Promise<T>,
	onDone?: (done: number, total: number) => void,
): Promise<T[]> {
	const results = new Array<T>(items.length);
	let next = 0;
	let done = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await worker(items[index]!);
			onDone?.(++done, items.length);
		}
	});
	await Promise.all(runners);
	return results;
}

export async function ingestRange(opts: IngestOptions): Promise<IngestResult> {
	if (opts.toBlock < opts.fromBlock) {
		throw new Error(`Range is inverted: ${opts.fromBlock} > ${opts.toBlock}`);
	}

	const head = await finalizedHead(opts.rpcUrl);
	const finality = classifyRange(opts.toBlock, head, opts.allowUnfinalized);
	const ingestedAt = new Date().toISOString();
	const meta: IngestMeta = {
		chainId: opts.chainId,
		finality,
		ingestedAt,
		source: opts.source,
	};

	const blocks = Array.from(
		{ length: opts.toBlock - opts.fromBlock + 1 },
		(_, i) => opts.fromBlock + i,
	);

	const perBlock = await mapWithConcurrency(
		blocks,
		opts.concurrency,
		async (blockNumber) => buildSeedRows(await fetchBlockPayloads(opts.rpcUrl, blockNumber), meta),
		opts.onProgress,
	);

	const rows: SeedRow[] = perBlock.flat();
	const outPath = seedFilePath({
		dataDir: opts.dataDir,
		chain: opts.chain,
		fromBlock: opts.fromBlock,
		toBlock: opts.toBlock,
		finalized: finality === 'finalized',
	});

	const rowCount = await writeSeedParquet(rows, outPath);
	return { outPath, rowCount, fromBlock: opts.fromBlock, toBlock: opts.toBlock, finality };
}
```

- [ ] **Step 2: Write the package entry point**

`packages/etl/src/index.ts`:

```ts
export { buildSeedRows, type BlockPayloads, type IngestMeta } from './buildSeedRows.js';
export { classifyRange, finalizedHead } from './finality.js';
export { fetchBlockPayloads } from './fetchBlock.js';
export { finalizedWindow, ingestRange, type IngestOptions, type IngestResult } from './ingest.js';
export { SCHEMA_VERSION, SEED_COLUMNS, seedColumnSpec, type Finality, type SeedRow } from './schema.js';
export { seedFileName, seedFilePath } from './seedPath.js';
export { writeSeedParquet } from './writeSeedParquet.js';
```

- [ ] **Step 3: Write the CLI**

`packages/etl/src/cli.ts`:

```ts
import { config } from 'dotenv';
import { Command } from 'commander';
import { resolve } from 'node:path';
import { finalizedWindow, ingestRange } from './ingest.js';

/**
 * cli.ts — the ingest entry point.
 *
 * The data directory is resolved from an argument or the process CWD at
 * RUNTIME, never from import.meta.url. The repo's six configs/*.json paths bake
 * the build machine's absolute path and work only because Nixpacks builds
 * in-container; nothing here may repeat that.
 */

config();

const program = new Command();

program
	.name('etl-ingest')
	.description('Ingest a Base block range into an immutable Seed Parquet file')
	.option('--from <block>', 'first block, inclusive')
	.option('--to <block>', 'last block, inclusive')
	.option('--span <count>', 'ingest the N blocks ending at the finalized head', '300')
	.option('--chain <name>', 'chain slug used in the filename', 'base')
	.option('--chain-id <id>', 'numeric chain id', '8453')
	.option('--data-dir <path>', 'root of the data directory', 'data')
	.option('--source <label>', 'provenance label; never a URL', 'quicknode-base-mainnet')
	.option('--concurrency <n>', 'blocks fetched in parallel', '8')
	.option('--allow-unfinalized', 'write past the finalized head, into seeds/provisional/', false)
	.action(async (options) => {
		const rpcUrl = process.env.TCA_RPC_URL;
		if (!rpcUrl) throw new Error('TCA_RPC_URL is not set (export it or put it in .env)');

		const explicit = options.from !== undefined && options.to !== undefined;
		const { fromBlock, toBlock } = explicit
			? { fromBlock: Number(options.from), toBlock: Number(options.to) }
			: await finalizedWindow(rpcUrl, Number(options.span));

		if (!explicit) {
			console.log(
				`No --from/--to given: ingesting the ${options.span} blocks ending at the ` +
					`finalized head. This range moves every run — pass --from/--to to reproduce it.`,
			);
		}

		const started = Date.now();
		const result = await ingestRange({
			rpcUrl,
			chain: options.chain,
			chainId: Number(options.chainId),
			fromBlock,
			toBlock,
			dataDir: resolve(process.cwd(), options.dataDir),
			source: options.source,
			allowUnfinalized: Boolean(options.allowUnfinalized),
			concurrency: Number(options.concurrency),
			onProgress: (done, total) => {
				if (done % 25 === 0 || done === total) console.log(`  blocks ${done}/${total}`);
			},
		});

		const seconds = ((Date.now() - started) / 1000).toFixed(1);
		console.log(
			`\n${result.rowCount} rows from blocks ${result.fromBlock}-${result.toBlock} ` +
				`(${result.finality}) in ${seconds}s\n  → ${result.outPath}`,
		);
	});

await program.parseAsync(process.argv);
```

- [ ] **Step 4: Add dotenv to the package and wire the root script**

Add `"dotenv": "^16.4.5"` to `packages/etl/package.json` dependencies, then add to the root `package.json` scripts:

```json
"etl:ingest": "tsc --build && node packages/etl/dist/cli.js"
```

Run `npm install` from the repo root.

- [ ] **Step 5: Verify it builds and the gate refuses an unfinalized range**

```bash
npm run typecheck && npm run lint
set -a && source .env && set +a
npm run etl:ingest -- --from 99999999 --to 99999999
```

Expected: exits with the `classifyRange` error naming the overshoot and suggesting `--allow-unfinalized`. **No file is written.**

- [ ] **Step 6: Commit**

```bash
git add packages/etl package.json package-lock.json
git commit -m "feat(etl): range ingest orchestration and CLI"
```

---

### Task 7: Live pilot — 300 finalized blocks into data/seeds/

**Files:**
- Create: `packages/etl/src/ingest.e2e.test.ts`
- Modify: `docs/superpowers/specs/2026-09-03-tca-etl-seed-schema-design.md` (pin the pilot's concrete range)

**Interfaces:**
- Consumes: everything above.
- Produces: the first Seed file, and a live test proving the pipeline against the real chain.

- [ ] **Step 1: Write the RPC-gated e2e test**

`packages/etl/src/ingest.e2e.test.ts`:

```ts
import { config } from 'dotenv';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { finalizedWindow, ingestRange } from './ingest.js';

config();
const RPC = process.env.TCA_RPC_URL;

const dir = mkdtempSync(join(tmpdir(), 'etl-e2e-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Live pipeline test against Base. Skips SILENTLY without TCA_RPC_URL, which is
 * the repo's established pattern — and its established trap. If you changed
 * ingest and this "passed", check that it actually RAN.
 */
describe.skipIf(!RPC)('ingestRange (live)', () => {
	it('ingests a small finalized range into the canonical archive', async () => {
		const { toBlock } = await finalizedWindow(RPC!, 1);
		const result = await ingestRange({
			rpcUrl: RPC!,
			chain: 'base',
			chainId: 8453,
			fromBlock: toBlock - 2,
			toBlock,
			dataDir: dir,
			source: 'quicknode-base-mainnet',
			allowUnfinalized: false,
			concurrency: 3,
		});

		expect(result.finality).toBe('finalized');
		expect(result.rowCount).toBeGreaterThan(0);
		// The canonical archive is a NON-recursive glob, so a finalized file must
		// land directly in seeds/, not in seeds/provisional/.
		expect(result.outPath).toContain(join('seeds', 'traces.base.'));
		expect(result.outPath).not.toContain('provisional');

		const instance = await DuckDBInstance.create(':memory:');
		const connection = await instance.connect();
		const reader = await connection.runAndReadAll(
			`SELECT count(*) AS rows,
			        count(DISTINCT block_number) AS blocks,
			        count(DISTINCT finality) AS finalities,
			        min(finality) AS finality,
			        sum(CASE WHEN json_valid(trace_json)
			                  AND json_valid(receipt_json)
			                  AND json_valid(tx_json)
			                  AND json_valid(block_json) THEN 0 ELSE 1 END) AS bad_json
			   FROM read_parquet('${join(dir, 'seeds', '*.parquet')}')`,
		);
		const [row] = reader.getRowObjectsJS() as Record<string, unknown>[];
		expect(Number(row!.rows)).toBe(result.rowCount);
		expect(Number(row!.blocks)).toBe(3);
		expect(Number(row!.bad_json)).toBe(0);
		expect(row!.finality).toBe('finalized');
	}, 120_000);

	it('never emits a row whose payloads disagree about the transaction', async () => {
		const { toBlock } = await finalizedWindow(RPC!, 1);
		const result = await ingestRange({
			rpcUrl: RPC!,
			chain: 'base',
			chainId: 8453,
			fromBlock: toBlock,
			toBlock,
			dataDir: join(dir, 'align'),
			source: 'quicknode-base-mainnet',
			allowUnfinalized: false,
			concurrency: 1,
		});

		const instance = await DuckDBInstance.create(':memory:');
		const connection = await instance.connect();
		const reader = await connection.runAndReadAll(
			`SELECT count(*) AS mismatched FROM read_parquet('${result.outPath}')
			  WHERE lower(json_extract_string(receipt_json, '$.transactionHash')) <> tx_hash
			     OR lower(json_extract_string(tx_json, '$.hash')) <> tx_hash`,
		);
		const [row] = reader.getRowObjectsJS() as Record<string, unknown>[];
		expect(Number(row!.mismatched)).toBe(0);
	}, 120_000);
});
```

- [ ] **Step 2: Run the e2e test and confirm it actually ran**

```bash
cd "$(git rev-parse --show-toplevel)"
set -a && source .env && set +a
npx vitest run packages/etl/src/ingest.e2e.test.ts
```

Expected: PASS, 2 tests. **If it reports 2 skipped, `TCA_RPC_URL` did not reach the process — fix that and re-run.** A silent skip here proves nothing.

- [ ] **Step 3: Run the full suite**

```bash
cd "$(git rev-parse --show-toplevel)"
npx vitest run
npm run typecheck && npm run lint
```

Expected: everything green, including the pre-existing suite.

- [ ] **Step 4: Commit the test**

```bash
git add packages/etl/src/ingest.e2e.test.ts
git commit -m "test(etl): live Base round-trip through the Seed pipeline"
```

- [ ] **Step 5: Run the pilot**

```bash
cd "$(git rev-parse --show-toplevel)"
set -a && source .env && set +a
npm run etl:ingest -- --span 300
```

Expected: ~34,000 rows, ~2–4 minutes, a file in `data/seeds/traces.base.<from>-<to>.parquet` of roughly 50–80 MB. Record the exact range, row count, wall time and file size from the output.

- [ ] **Step 6: Verify the pilot file in DuckDB**

```bash
cd "$(git rev-parse --show-toplevel)"
node -e '
import("@duckdb/node-api").then(async ({ DuckDBInstance }) => {
  const c = await (await DuckDBInstance.create(":memory:")).connect();
  const r = await c.runAndReadAll(`
    SELECT count(*) AS rows, count(DISTINCT block_number) AS blocks,
           min(block_number) AS from_block, max(block_number) AS to_block,
           min(block_timestamp) AS first_ts, max(block_timestamp) AS last_ts,
           count(DISTINCT finality) AS finality_kinds, min(finality) AS finality,
           sum(CASE WHEN tx_status THEN 1 ELSE 0 END) AS succeeded
      FROM read_parquet("data/seeds/*.parquet")`.replace(/"/g, "\x27"));
  console.log(r.getRowObjectsJson());
})'
```

Expected: `blocks` is 300, `finality_kinds` is 1, `finality` is `finalized`, and `to_block - from_block` is 299.

- [ ] **Step 7: Pin the pilot's range into the spec**

In §6 of `docs/superpowers/specs/2026-09-03-tca-etl-seed-schema-design.md`, replace the sentence "Once the pilot has run, pin its concrete range here." with the concrete result, for example:

```markdown
**Pilot range as actually run (2026-09-03):** blocks 50830910–50831209,
34,102 rows, 61 MB, ingested in 3m12s from `quicknode-base-mainnet`.
File: `data/seeds/traces.base.0050830910-0050831209.parquet`.
```

Use the real numbers from Step 5, not these.

- [ ] **Step 8: Confirm the data file is not tracked by git**

```bash
git status --porcelain data/ | head
```

Expected: **no output.** If the Parquet shows up, the `.gitignore` entry from Task 1 is wrong — fix it before committing.

- [ ] **Step 9: Commit**

```bash
git add docs/superpowers/specs/2026-09-03-tca-etl-seed-schema-design.md
git commit -m "docs(spec): pin the concrete pilot range from the first ingest"
```

---

## Done means

- `npx vitest run` from the repo root is green, and the e2e tests **ran** rather than skipped.
- `npm run typecheck && npm run lint` are clean.
- `data/seeds/traces.base.<from>-<to>.parquet` exists, holds 300 blocks of finalized Base, and is queryable by `read_parquet` with no extension or option.
- `data/` is untracked.
- The spec records the exact range the pilot ingested.
- `packages/dashboard` still builds and has gained no dependency on `packages/etl`.

## Explicitly NOT in this plan

Derived files (including the flattened `trace_address` frames), the reorg repair pass, promotion of `provisional/` files, a manifest, multi-chain support, and resumable ingest. All are v0.2. The first Derived file is what will validate this Seed layer by being the first thing to consume it.
