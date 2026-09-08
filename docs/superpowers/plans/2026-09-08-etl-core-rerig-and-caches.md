# ETL Derived Layer v0.2b-1 — Determinism, Fact Caches, and the `analyzeTransaction` Re-rig

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the decode determinism baseline, then make `analyzeTransaction` cheap enough and reproducible enough to run over thousands of transactions — without changing a single receipt the dashboard produces today.

**Architecture:** Everything is additive and opt-in. Three new options on `analyzeTransaction` (`prefetched`, `includeWings`, `factCache`), each defaulting to today's behaviour. The `FactCache` is a **decorator over the existing reader factories**, injected through the `deps` seams `decomposeRoute` and `priceReceipt` already expose — no reader signature changes, no new parameter threaded through eight modules. The persistent store is Parquet in `packages/etl`, so `packages/core` gains no dependency on DuckDB.

**Tech Stack:** TypeScript (ESM, NodeNext), viem, `@duckdb/node-api` 1.5.5-r.4 (etl only), `vitest` 2.x.

**Spec:** `docs/superpowers/specs/2026-09-04-tca-etl-derived-layer-design.md` (§6 caches, §7 the re-rig, §9 determinism)

---

## Deviation from the spec's stated staging — read this first

Spec §8 orders v0.2b as: caches → re-rig → 535 run → **determinism harness (step 5)** → 13,511 run.

**This plan moves determinism to Task 1, before any code changes.** The reason is structural, not preference:

Every correctness gate in this plan is a **diff**. Task 5's gate is "prefetched output equals un-prefetched output". Task 6's is "cached output equals uncached output". Task 6's profiling gate is a before/after call count. If decodes of the same transaction are not already stable, none of those diffs can be interpreted — a real cache bug and ordinary RPC noise produce the identical signal.

`scripts/analysis/decodeGolden.mjs` says this in its own header, from a real 2026-08-10 incident on unmodified `main`: under concurrency the endpoint fails reads transiently, the decode swallows those failures as evidence (`catch → null` means "no such pool"), and receipts come back quietly degraded — `tier` full→estimated, a venue mislabelled, `allInCostBps` 101→5012.

So Task 1 measures the noise floor first, serially, on unmodified code. Everything after it is interpretable against that number.

## Global Constraints

- **Tabs, not spaces** in `packages/etl`. **`packages/core` uses tabs too** — match the file you are editing.
- **ESM with explicit `.js` extensions on relative imports**, even from `.ts` files. NodeNext resolution.
- **`noUncheckedIndexedAccess: true`** — `arr[0]` is `T | undefined`; indexed access needs `arr[0]!`. Test files ARE typechecked.
- **`exactOptionalPropertyTypes: true`** — an optional property cannot be explicitly assigned `undefined`. This bites when forwarding optional options; use conditional spread (`...(x ? { x } : {})`), which the codebase already does in `toPersistedLeg`.
- **Vitest runs from the REPO ROOT.** From a package subdirectory it silently reports roughly half the suite.
- **A worktree under `.claude/worktrees/` is INSIDE the repo**, and nothing excludes it from vitest. While one exists, a bare `npx vitest run` count is roughly doubled. Get the true number with `npx vitest run --exclude '**/.claude/**'`.
- **Full-suite runs with `TCA_RPC_URL` set need `--no-file-parallelism`**, or the e2e files trip genuine QuickNode 429s.
- **`packages/core` must NOT gain a dependency on `@duckdb/node-api`.** It ships a native binary that must stay out of the dashboard's Railway/Nixpacks build. The `FactCache` interface lives in core; its Parquet implementation lives in etl.
- **`source .env` does not export.** Use `set -a && source .env && set +a`, or rely on the scripts' own `_env.mjs`, which reads the repo-root `.env` directly.
- **Every decode in this plan runs SERIALLY.** Concurrency is the documented cause of false differences.

### The behavioural contract that governs every task

> With no new options passed, `analyzeTransaction` must produce a **byte-identical** receipt to today's. The dashboard calls it with `{ rpcUrl }` and nothing else, and this plan must be invisible to it.

Each of Tasks 4, 5 and 6 pins that with its own back-compat test.

### Baseline measurements (2026-09-04, `packages/core` unchanged)

Profiled `0x602a6c5e9ff9f0aad0965e5414a21bc4a8c0fa99dd7b07bdebfeb91259660cab` (KyberSwap, block 50842671, 9 legs) via `scripts/analysis/decodeProfile.mjs`:

```
wall: 10,045ms   RPC calls: 175   distinct: 131   repeats: 44
79.3% of wall-clock had exactly ONE request in flight
```

| Bucket | calls | Addressed by |
|---|---|---|
| v4 poolId → currencies bisection (`extsload`) | 51 | Task 6 (persistent cache) |
| `@latest` metadata (`getPool`, `decimals`, `symbol`, `token0/1`) | 39 | Task 6 |
| ruler-block state reads (N−1) | 41 | irreducible |
| "after" wing (N+1) | 28 | Task 4 |
| "before" wing (N−2) | 6 | Task 4 |
| `receipt` + `tx` + `debug_traceTransaction` | 3 | Task 5 |
| misc | 7 | — |

⚠️ The 44 repeats are **not explained**. `rpcMemo` looks correct and all 14 client constructions use `sessionHttp`, so retries of failing calls are the leading hypothesis — nothing is proven. Task 1 is expected to shed light on this; if it does not, it stays open.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/analysis/decodeGolden.mjs` | Gains a `--hashes-from=<parquet>` source and a `determinism` mode. Modified. |
| `packages/core/src/factCache.ts` | The `FactCache` interface and an in-memory implementation. New. |
| `packages/core/src/factCache.test.ts` | Tests for the above. New. |
| `packages/core/src/cachedReaders.ts` | Decorators wrapping the existing reader factories with a `FactCache`. New. |
| `packages/core/src/cachedReaders.test.ts` | Tests for the above. New. |
| `packages/core/src/pricing.ts` | `includeWings` option. Modified. |
| `packages/core/src/analyzeTransaction.ts` | `prefetched`, `includeWings`, `factCache` options. Modified. |
| `packages/core/src/prefetched.ts` | Seed-JSON → viem-shaped `receipt`/`tx` translation. New. |
| `packages/core/src/prefetched.test.ts` | Tests for the above. New. |
| `packages/core/src/index.ts` | Re-export the new surface. Modified. |
| `packages/etl/src/factCacheStore.ts` | Parquet load/save for the three caches, as plain entries. Type-only import from core. New. |
| `packages/etl/src/factCacheStore.test.ts` | Tests for the above. New. |
| `packages/etl/src/index.ts` | Re-export. Modified. |

---

### Task 1: Determinism baseline over the 535

**Files:**
- Modify: `scripts/analysis/decodeGolden.mjs`
- Produce: a recorded measurement (no committed data file)

**Interfaces:**
- Consumes: `data/derived/2026-09-04a/candidates.base.0050842630-0050842929.parquet` (already on disk, gitignored)
- Produces: `decodeGolden.mjs determinism <parquet> [--limit=N]` — captures twice serially and diffs

**Context you need:** Read `scripts/analysis/decodeGolden.mjs` in full first. It already has `capture(outFile)` and `diff(before, after)`, and its header carries the serial-only warning that is the whole reason this task exists. You are adding a third mode and a second hash source — **not** writing a new script.

`capture` currently gets its hashes from `loadCases()` (`docs/qa/cases.json`, 68 entries). You are adding `--hashes-from=<parquet>`, which reads `tx_hash` from a candidates Parquet. Restrict to the router-selected subset with `WHERE selected_via = 'both'` — that is the 535.

`@duckdb/node-api` is hoisted to the repo-root `node_modules`, so a script under `scripts/` can `import` it directly. Verified.

- [ ] **Step 1: Add the Parquet hash source**

In `scripts/analysis/decodeGolden.mjs`, add above `capture`:

```js
/**
 * Hashes from a candidates Parquet instead of docs/qa/cases.json.
 *
 * `selected_via = 'both'` is the router-selected subset that actually swaps —
 * 535 rows on the 2026-09-04a pilot build. 'router' (130) emits no Swap log and
 * 'swap_log' (12,976) is the full population, which is a different run.
 */
async function hashesFromParquet(parquetPath) {
	const { DuckDBInstance } = await import('@duckdb/node-api');
	const instance = await DuckDBInstance.create(':memory:');
	const connection = await instance.connect();
	try {
		const reader = await connection.runAndReadAll(
			`SELECT tx_hash, chain_id FROM read_parquet('${parquetPath.replace(/'/g, "''")}')
			 WHERE selected_via = 'both' ORDER BY block_number, block_position`,
		);
		return reader.getRowObjects().map((r) => ({
			hash: String(r.tx_hash),
			chainId: Number(r.chain_id),
		}));
	} finally {
		connection.closeSync();
		instance.closeSync();
	}
}
```

Then in `capture`, replace the `rows` assignment with:

```js
	const hashesFrom = flag('hashes-from', null);
	const rows = hashesFrom
		? (await hashesFromParquet(String(hashesFrom))).slice(0, limit)
		: loadCases().slice(0, limit).map((c) => ({ hash: c.hash, chainId: c.chainId ?? 8453 }));
```

⚠️ `flag()` in this file coerces with a numeric default; confirm it returns the raw string for `--hashes-from=...` and adjust the call if not. Read its definition before assuming.

- [ ] **Step 2: Add the `determinism` mode**

Add above the mode dispatch at the bottom:

```js
/**
 * Determinism: capture the SAME code twice, serially, and diff.
 *
 * A clean result means a receipt is reproducible. A dirty one means the decode
 * is absorbing transient RPC failures as evidence — the open
 * `transient-rpc-silently-degrades-receipts` hazard — and every before/after
 * diff in the enrichment work is uninterpretable until it is understood.
 *
 * Both passes run at concurrency 1. That is not a default to override here:
 * a concurrent pass manufactures exactly the differences this mode exists to
 * detect.
 */
async function determinism(parquetPath) {
	if (!parquetPath) throw new Error('usage: decodeGolden.mjs determinism <candidates.parquet>');
	const a = `/tmp/determinism-pass1.${process.pid}.json`;
	const b = `/tmp/determinism-pass2.${process.pid}.json`;
	process.argv.push(`--hashes-from=${parquetPath}`, '--concurrency=1');
	console.log('pass 1 of 2...');
	await capture(a);
	console.log('pass 2 of 2...');
	await capture(b);
	console.log('\n=== determinism diff (same code, two serial passes) ===');
	diff(a, b);
}
```

Wire it into the dispatch:

```js
if (mode === 'capture') await capture(rest[0]);
else if (mode === 'diff') diff(rest[0], rest[1]);
else if (mode === 'determinism') await determinism(rest[0]);
else {
	console.error('usage: decodeGolden.mjs capture <out.json> [--hashes-from=<parquet>] [--concurrency=1] [--limit=N]');
	console.error('       decodeGolden.mjs diff <before.json> <after.json>');
	console.error('       decodeGolden.mjs determinism <candidates.parquet> [--limit=N]');
	process.exit(1);
}
```

⚠️ Mutating `process.argv` so `capture`'s own `flag()` reads work is a deliberate shortcut inside one script. If `flag()` caches its parse at module load, this will silently do nothing — read `flag()` first and pass options explicitly instead if so.

- [ ] **Step 3: Smoke-test on a small slice**

Run:

```bash
set -a && source .env && set +a
node scripts/analysis/decodeGolden.mjs determinism \
  'data/derived/2026-09-04a/candidates.base.0050842630-0050842929.parquet' --limit=10
```

Expected: two passes of 10, then a diff line. This is a wiring check, not the measurement. If the parquet path does not exist, list `data/derived/` and use whichever build tag is present.

- [ ] **Step 4: Run the real measurement**

Run the full 535, serially. **This takes roughly 30 minutes** (~3.4s/receipt measured on the corpus). Run it in the background and do not poll it aggressively.

```bash
set -a && source .env && set +a
node scripts/analysis/decodeGolden.mjs determinism \
  'data/derived/2026-09-04a/candidates.base.0050842630-0050842929.parquet' \
  2>&1 | tee /tmp/determinism-535.log
```

- [ ] **Step 5: Record the result**

The diff prints `compared N hashes: X identical, Y differing`, then per-hash field changes.

Write the findings into your report, and specifically:
- **Y = 0** → decodes are reproducible at this sample size. Say so plainly; every later diff in this plan is trustworthy.
- **Y > 0** → for each differing hash, list which FIELDS moved. The ones that matter most are `tier`, `pricing_status`, `all_in_cost_bps`, `market_mid`, and per-leg `venue`. Report the count and the field histogram. **Do not attempt a fix** — this task measures; the fix is its own decision.

Either way, report whether the differing set overlaps the transactions with the most `extsload` traffic (v4-heavy routes), since that is where the bisection retries concentrate.

- [ ] **Step 6: Commit**

```bash
git add scripts/analysis/decodeGolden.mjs
git commit -m "feat(analysis): determinism mode and a candidates-parquet hash source

Captures the same code twice, serially, and diffs — the baseline every
before/after gate in the enrichment work is measured against."
```

---

### Task 2: The `FactCache` interface and in-memory implementation

**Files:**
- Create: `packages/core/src/factCache.ts`
- Test: `packages/core/src/factCache.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface PoolKeyFact { currency0: string; currency1: string }`
  - `interface TokenFact { decimals: number; symbol: string | null }`
  - `interface PoolFact { token0?: string; token1?: string; feeBps?: number; factory?: string }`
  - `interface FactCache` with `getPoolKey/setPoolKey`, `getToken/setToken`, `getPool/setPool`, and `entries()`
  - `createMemoryFactCache(seed?): FactCache`

**Context you need:** Read `packages/core/src/rpcMemo.ts` first, especially its header warning. The distinction it draws is the one this file must not blur:

> ⚠️ The memo MUST be per-decode, never process-global. Pool discovery reads `getPool` at the `latest` block tag, so a process-global memo would pin a factory's answer for the lifetime of the server and never observe a newly-deployed fee tier.

`FactCache` is the opposite kind of thing: it holds only facts that are **immutable on-chain**, so it is deliberately process-global and cross-run. The safety of that rests entirely on nothing wrong getting in. Three rules make it hold, and all three are testable:

1. **`getPool` is NOT a fact.** It is a factory lookup at `latest` whose answer changes when a new fee tier is deployed. It must have no place in this interface.
2. **A null is never a fact.** `makeV4PoolKeyReader` caches nulls in-memory on purpose (so one failed read is not retried per leg), but a null there can mean "transport failed" as easily as "no such pool" — the open `v4-poolkey-reader-swallows-errors` hazard, which already corrupted 11 receipts. Persisting a null would make one blip permanent. **Only positive results are ever stored.**
3. **A dynamic fee is not a fact.** See Task 6 for the venue allowlist and why `hydrex`/`quickswapv4` are excluded.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/factCache.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createMemoryFactCache } from './factCache.js';

describe('createMemoryFactCache', () => {
	it('round-trips a pool key, lowercasing the id', () => {
		const cache = createMemoryFactCache();
		cache.setPoolKey('0xABC', { currency0: '0x11', currency1: '0x22' });
		expect(cache.getPoolKey('0xabc')).toEqual({ currency0: '0x11', currency1: '0x22' });
		expect(cache.getPoolKey('0xABC')).toEqual({ currency0: '0x11', currency1: '0x22' });
	});

	it('returns undefined for an unknown key, distinct from a stored value', () => {
		const cache = createMemoryFactCache();
		expect(cache.getPoolKey('0xmissing')).toBeUndefined();
		expect(cache.getToken('0xmissing')).toBeUndefined();
		expect(cache.getPool('0xmissing')).toBeUndefined();
	});

	it('round-trips token metadata including a null symbol', () => {
		const cache = createMemoryFactCache();
		cache.setToken('0xTok', { decimals: 6, symbol: null });
		expect(cache.getToken('0xtok')).toEqual({ decimals: 6, symbol: null });
	});

	it('merges pool facts rather than replacing them', () => {
		// factory and fee are learned by two different readers at different times.
		const cache = createMemoryFactCache();
		cache.setPool('0xP', { factory: '0xf' });
		cache.setPool('0xP', { feeBps: 30 });
		expect(cache.getPool('0xp')).toEqual({ factory: '0xf', feeBps: 30 });
	});

	it('seeds from existing entries', () => {
		const cache = createMemoryFactCache({
			poolKeys: [['0xa', { currency0: '0x1', currency1: '0x2' }]],
			tokens: [['0xb', { decimals: 18, symbol: 'WETH' }]],
			pools: [['0xc', { factory: '0xf' }]],
		});
		expect(cache.getPoolKey('0xa')).toEqual({ currency0: '0x1', currency1: '0x2' });
		expect(cache.getToken('0xb')?.symbol).toBe('WETH');
		expect(cache.getPool('0xc')?.factory).toBe('0xf');
	});

	it('exposes its entries for persistence, lowercased', () => {
		const cache = createMemoryFactCache();
		cache.setPoolKey('0xA', { currency0: '0x1', currency1: '0x2' });
		cache.setToken('0xB', { decimals: 18, symbol: 'W' });
		cache.setPool('0xC', { factory: '0xf' });
		const e = cache.entries();
		expect(e.poolKeys.map(([k]) => k)).toEqual(['0xa']);
		expect(e.tokens.map(([k]) => k)).toEqual(['0xb']);
		expect(e.pools.map(([k]) => k)).toEqual(['0xc']);
	});

	it('stores a token fact whole, decimals and symbol together', () => {
		// ⚠️ Nothing in v0.2b-1 writes this family — see the module docstring for
		// why a decimals-only writer would be actively wrong. This test pins the
		// shape v0.2b-2 must supply: both fields, from one resolution.
		const cache = createMemoryFactCache();
		cache.setToken('0xa', { decimals: 6, symbol: 'USDC' });
		expect(cache.getToken('0xa')).toEqual({ decimals: 6, symbol: 'USDC' });
	});

	it('has no way to store a getPool factory lookup', () => {
		// getPool reads a factory at the `latest` tag and its answer CHANGES when a
		// new fee tier is deployed (rpcMemo.ts's header warning). If this ever
		// compiles, the cache has grown a way to make a mutable answer permanent.
		const cache = createMemoryFactCache() as unknown as Record<string, unknown>;
		expect(cache.setGetPool).toBeUndefined();
		expect(cache.getGetPool).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/factCache.test.ts`
Expected: FAIL — `Failed to resolve import "./factCache.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/factCache.ts`:

```ts
/**
 * factCache.ts — facts about the chain that cannot change, cached across decodes.
 *
 * ⚠️ Read rpcMemo.ts's header before touching this file. The two caches look
 * similar and are opposites:
 *
 *   rpcMemo   per-decode, dies with the request, may hold ANY read.
 *   FactCache process-global, survives runs, may hold ONLY immutable facts.
 *
 * The whole safety argument is that nothing mutable gets in. Three rules:
 *
 * 1. `getPool` is NOT here, deliberately. It is a factory lookup at the `latest`
 *    tag whose answer changes when a new fee tier is deployed — the exact thing
 *    rpcMemo's warning forbids pinning. There is no setter for it, and adding
 *    one is the single change that would make this cache unsafe.
 *
 * 2. A NULL IS NEVER A FACT. A failed read and a nonexistent pool are
 *    indistinguishable at every reader in this codebase (`catch → null`), and
 *    that ambiguity has already corrupted receipts once. Only positive results
 *    are stored, so a transport blip costs a re-read, never a wrong answer.
 *
 * 3. A dynamic fee is not a fact — see cachedReaders.ts for the venue allowlist.
 *
 * Keys are lowercased on the way in and out, because callers get addresses from
 * a mix of RPC responses, config files and trace payloads.
 *
 * ⚠️ THE TOKEN FAMILY IS DEFINED HERE BUT DELIBERATELY NOT WIRED TO A READER IN
 * THIS PLAN, and that is not an oversight to "fix" by adding a decimals-only
 * decorator. `TokenFact` carries decimals AND symbol, which two different
 * readers resolve (`decimalsReader`, and `resolveLegSymbols`'s `readSymbol`). A
 * decorator that wrote `{ decimals, symbol: null }` from the decimals path
 * would make a later symbol lookup a cache HIT on a symbol nobody ever read —
 * turning "unknown" into "this token has no symbol", permanently and across
 * runs. The family is populated in v0.2b-2, where both readers are touched
 * together and a complete TokenFact can be written at once.
 */

/** A v4/Infinity poolId's two currencies. Fixed at Initialize, forever. */
export interface PoolKeyFact {
	currency0: string;
	currency1: string;
}

/** ERC-20 metadata, set at deploy. `symbol: null` means the token has none we could read. */
export interface TokenFact {
	decimals: number;
	symbol: string | null;
}

/**
 * Immutable pool metadata, learned piecemeal by different readers — hence every
 * field optional and `setPool` merging rather than replacing.
 */
export interface PoolFact {
	token0?: string;
	token1?: string;
	/** ONLY ever set for a static-tier venue. See cachedReaders.ts. */
	feeBps?: number;
	factory?: string;
}

export interface FactCacheEntries {
	poolKeys: [string, PoolKeyFact][];
	tokens: [string, TokenFact][];
	pools: [string, PoolFact][];
}

export interface FactCache {
	getPoolKey(poolId: string): PoolKeyFact | undefined;
	setPoolKey(poolId: string, fact: PoolKeyFact): void;
	getToken(address: string): TokenFact | undefined;
	setToken(address: string, fact: TokenFact): void;
	getPool(address: string): PoolFact | undefined;
	/** Merges into any existing record for this address. */
	setPool(address: string, fact: PoolFact): void;
	/** Everything held, for persistence. Keys are lowercased. */
	entries(): FactCacheEntries;
}

export function createMemoryFactCache(seed?: Partial<FactCacheEntries>): FactCache {
	const poolKeys = new Map<string, PoolKeyFact>(seed?.poolKeys?.map(([k, v]) => [k.toLowerCase(), v]));
	const tokens = new Map<string, TokenFact>(seed?.tokens?.map(([k, v]) => [k.toLowerCase(), v]));
	const pools = new Map<string, PoolFact>(seed?.pools?.map(([k, v]) => [k.toLowerCase(), v]));

	return {
		getPoolKey: (poolId) => poolKeys.get(poolId.toLowerCase()),
		setPoolKey: (poolId, fact) => void poolKeys.set(poolId.toLowerCase(), fact),
		getToken: (address) => tokens.get(address.toLowerCase()),
		setToken: (address, fact) => void tokens.set(address.toLowerCase(), fact),
		getPool: (address) => pools.get(address.toLowerCase()),
		setPool: (address, fact) => {
			const key = address.toLowerCase();
			pools.set(key, { ...pools.get(key), ...fact });
		},
		entries: () => ({
			poolKeys: [...poolKeys.entries()],
			tokens: [...tokens.entries()],
			pools: [...pools.entries()],
		}),
	};
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/factCache.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean. `tsc --build` does NOT lint, and lint is what fails the Railway deploy — run both.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/factCache.ts packages/core/src/factCache.test.ts
git commit -m "feat(core): FactCache for immutable chain facts"
```

---

### Task 3: Parquet-backed `FactCache` store

**Files:**
- Create: `packages/etl/src/factCacheStore.ts`
- Test: `packages/etl/src/factCacheStore.test.ts`
- Modify: `packages/etl/src/index.ts`

**Interfaces:**
- Consumes: `createMemoryFactCache`, `FactCache`, `FactCacheEntries` from `@fabric-tca/core`; `cacheFilePath` from `./derivedPath.js`; `writeRowsToParquet` from `./writeParquet.js`
- Produces:
  - `loadFactCacheEntries(opts: { dataDir: string; chain: string }): Promise<FactCacheEntries>`
  - `saveFactCacheEntries(entries: FactCacheEntries, opts: { dataDir: string; chain: string }): Promise<{ poolKeys: number; tokens: number; pools: number }>`

⚠️⚠️ **This module must import from `@fabric-tca/core` with `import type` ONLY — never a runtime value.** Measured in this worktree before the plan was executed: `packages/core`'s `package.json` sets `"main": "./src/index.ts"`, so a value import from etl typechecks, compiles, and passes vitest (which transpiles), then fails at runtime with `ERR_UNKNOWN_FILE_EXTENSION` the moment compiled etl code under `dist/` tries to load a `.ts` file. `packages/etl` has never imported `packages/core` before, so nothing has hit this yet.

That is why the store trades in plain `FactCacheEntries` rather than constructing a `FactCache`: serialization is its whole job, and the caller composes `createMemoryFactCache(await loadFactCacheEntries(...))`. `import type` is erased at compile time, so no cross-package runtime edge exists.

**Context you need:** `derivedPath.ts` already provides `cacheFilePath({ dataDir, name, chain })` for `name` in `'pools' | 'tokens' | 'v4_poolkeys'`, placing files at `data/cache/<name>.<chain>.parquet` — deliberately **outside** any build directory, because a cache holds facts about the chain rather than about a build.

`writeRowsToParquet(rows, { outPath, columnSpec, orderBy })` writes atomically. Missing cache files are normal on a first run and must load as empty, not throw.

⚠️ `packages/etl` may import TYPES from `packages/core`; the reverse is what must not happen, and a runtime value import in either direction breaks (see the interfaces note above). Add `"@fabric-tca/core": "*"` to `packages/etl/package.json` dependencies — note the dashboard does not declare it either and relies on workspace hoisting, but declaring it is correct and costs nothing.

- [ ] **Step 1: Write the failing test**

Create `packages/etl/src/factCacheStore.test.ts`:

```ts
import type { FactCacheEntries } from '@fabric-tca/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFactCacheEntries, saveFactCacheEntries } from './factCacheStore.js';

const EMPTY: FactCacheEntries = { poolKeys: [], tokens: [], pools: [] };

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'factCacheStore-'));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('loadFactCacheEntries', () => {
	it('returns empty families when no files exist yet', async () => {
		expect(await loadFactCacheEntries({ dataDir: dir, chain: 'base' })).toEqual(EMPTY);
	});
});

describe('saveFactCacheEntries / loadFactCacheEntries', () => {
	it('round-trips all three families', async () => {
		const counts = await saveFactCacheEntries(
			{
				poolKeys: [['0xpoolid', { currency0: '0x11', currency1: '0x22' }]],
				tokens: [['0xtok', { decimals: 6, symbol: 'USDC' }]],
				pools: [['0xpool', { token0: '0x11', token1: '0x22', feeBps: 30, factory: '0xfac' }]],
			},
			{ dataDir: dir, chain: 'base' },
		);
		expect(counts).toEqual({ poolKeys: 1, tokens: 1, pools: 1 });

		const back = await loadFactCacheEntries({ dataDir: dir, chain: 'base' });
		expect(back.poolKeys).toEqual([['0xpoolid', { currency0: '0x11', currency1: '0x22' }]]);
		expect(back.tokens).toEqual([['0xtok', { decimals: 6, symbol: 'USDC' }]]);
		expect(back.pools).toEqual([['0xpool', { token0: '0x11', token1: '0x22', feeBps: 30, factory: '0xfac' }]]);
	});

	it('preserves a null symbol through the round trip', async () => {
		await saveFactCacheEntries(
			{ ...EMPTY, tokens: [['0xa', { decimals: 18, symbol: null }]] },
			{ dataDir: dir, chain: 'base' },
		);
		const back = await loadFactCacheEntries({ dataDir: dir, chain: 'base' });
		expect(back.tokens).toEqual([['0xa', { decimals: 18, symbol: null }]]);
	});

	it('preserves partial pool facts without inventing fields', async () => {
		// An absent token0 must come back ABSENT, not as null — the same
		// "absent is not measured" rule the fee work already established.
		await saveFactCacheEntries(
			{ ...EMPTY, pools: [['0xa', { factory: '0xf' }]] },
			{ dataDir: dir, chain: 'base' },
		);
		const back = await loadFactCacheEntries({ dataDir: dir, chain: 'base' });
		expect(back.pools).toEqual([['0xa', { factory: '0xf' }]]);
	});

	it('a second save replaces the files rather than appending', async () => {
		await saveFactCacheEntries(
			{ ...EMPTY, tokens: [['0xa', { decimals: 18, symbol: 'A' }]] },
			{ dataDir: dir, chain: 'base' },
		);
		await saveFactCacheEntries(
			{ ...EMPTY, tokens: [['0xb', { decimals: 6, symbol: 'B' }]] },
			{ dataDir: dir, chain: 'base' },
		);
		const back = await loadFactCacheEntries({ dataDir: dir, chain: 'base' });
		expect(back.tokens.map(([k]) => k)).toEqual(['0xb']);
	});

	it('writes no file for an empty family, and still loads', async () => {
		const counts = await saveFactCacheEntries(
			{ ...EMPTY, tokens: [['0xa', { decimals: 18, symbol: 'A' }]] },
			{ dataDir: dir, chain: 'base' },
		);
		expect(counts).toEqual({ poolKeys: 0, tokens: 1, pools: 0 });
		const back = await loadFactCacheEntries({ dataDir: dir, chain: 'base' });
		expect(back.tokens).toHaveLength(1);
		expect(back.poolKeys).toEqual([]);
	});

	it('imports only TYPES from @fabric-tca/core', async () => {
		// packages/core's package.json main is ./src/index.ts, so a VALUE import
		// here compiles and passes vitest, then dies at runtime under dist/ with
		// ERR_UNKNOWN_FILE_EXTENSION. Verified in-repo before this plan ran.
		const { readFileSync } = await import('node:fs');
		const src = readFileSync(new URL('./factCacheStore.ts', import.meta.url), 'utf8');
		const coreImports = src.split('\n').filter((l) => l.includes('@fabric-tca/core'));
		expect(coreImports.length).toBeGreaterThan(0);
		for (const line of coreImports) expect(line).toMatch(/^import type /);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/etl/src/factCacheStore.test.ts`
Expected: FAIL — `Failed to resolve import "./factCacheStore.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/etl/src/factCacheStore.ts`:

```ts
import { DuckDBInstance } from '@duckdb/node-api';
import type { FactCacheEntries } from '@fabric-tca/core';
import { existsSync } from 'node:fs';
import { cacheFilePath } from './derivedPath.js';
import { sqlLiteral, writeRowsToParquet } from './writeParquet.js';

/**
 * factCacheStore.ts — the FactCache on disk.
 *
 * Three Parquet files under `data/cache/`, deliberately OUTSIDE any build
 * directory: a cache holds facts about the chain, not about a build, and
 * discarding it with a bad build would throw away work that is still correct.
 *
 * ⚠️ `packages/core` must never import this file. It owns the FactCache
 * INTERFACE; DuckDB ships a native binary that must stay out of the dashboard's
 * Railway build, so the Parquet implementation lives here.
 *
 * ⚠️⚠️ EVERY import from `@fabric-tca/core` in this file is `import type`, and
 * that is load-bearing, not style. core's package.json sets
 * `"main": "./src/index.ts"`, so a VALUE import from etl typechecks, compiles,
 * and passes vitest (which transpiles) — then dies at runtime under `dist/`
 * with ERR_UNKNOWN_FILE_EXTENSION, because node cannot load a .ts file. A test
 * in factCacheStore.test.ts pins this.
 *
 * That is also why this module trades in plain FactCacheEntries rather than
 * building a FactCache: `createMemoryFactCache` is a runtime value. Callers
 * compose `createMemoryFactCache(await loadFactCacheEntries(...))`.
 *
 * A missing file is a first run, not an error.
 */

const POOL_KEY_COLUMNS = "{'pool_id': 'VARCHAR', 'currency0': 'VARCHAR', 'currency1': 'VARCHAR'}";
const TOKEN_COLUMNS = "{'address': 'VARCHAR', 'decimals': 'INTEGER', 'symbol': 'VARCHAR'}";
const POOL_COLUMNS =
	"{'address': 'VARCHAR', 'token0': 'VARCHAR', 'token1': 'VARCHAR', 'fee_bps': 'DOUBLE', 'factory': 'VARCHAR'}";

async function readRows(path: string): Promise<Record<string, unknown>[]> {
	if (!existsSync(path)) return [];
	const instance = await DuckDBInstance.create(':memory:');
	const connection = await instance.connect();
	try {
		const reader = await connection.runAndReadAll(`SELECT * FROM read_parquet(${sqlLiteral(path)})`);
		return reader.getRowObjects() as Record<string, unknown>[];
	} finally {
		connection.closeSync();
		instance.closeSync();
	}
}

/** `undefined` for an absent optional field — never `null`, which would be a stored fact. */
function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export async function loadFactCacheEntries(opts: {
	dataDir: string;
	chain: string;
}): Promise<FactCacheEntries> {
	const [poolKeyRows, tokenRows, poolRows] = await Promise.all([
		readRows(cacheFilePath({ dataDir: opts.dataDir, name: 'v4_poolkeys', chain: opts.chain })),
		readRows(cacheFilePath({ dataDir: opts.dataDir, name: 'tokens', chain: opts.chain })),
		readRows(cacheFilePath({ dataDir: opts.dataDir, name: 'pools', chain: opts.chain })),
	]);

	const entries: FactCacheEntries = {
		poolKeys: poolKeyRows.map((r) => [
			String(r.pool_id),
			{ currency0: String(r.currency0), currency1: String(r.currency1) },
		]),
		tokens: tokenRows.map((r) => [
			String(r.address),
			{ decimals: Number(r.decimals), symbol: optionalString(r.symbol) ?? null },
		]),
		pools: poolRows.map((r) => [
			String(r.address),
			{
				...(optionalString(r.token0) ? { token0: String(r.token0) } : {}),
				...(optionalString(r.token1) ? { token1: String(r.token1) } : {}),
				...(r.fee_bps == null ? {} : { feeBps: Number(r.fee_bps) }),
				...(optionalString(r.factory) ? { factory: String(r.factory) } : {}),
			},
		]),
	};
	return entries;
}

export async function saveFactCacheEntries(
	entries: FactCacheEntries,
	opts: { dataDir: string; chain: string },
): Promise<{ poolKeys: number; tokens: number; pools: number }> {
	const e = entries;

	// writeRowsToParquet refuses an empty row set (an empty file is never
	// correct), so an empty family is simply not written. Its absence loads as
	// empty on the next run, which is the same thing.
	if (e.poolKeys.length > 0) {
		await writeRowsToParquet(
			e.poolKeys.map(([pool_id, f]) => ({ pool_id, currency0: f.currency0, currency1: f.currency1 })),
			{
				outPath: cacheFilePath({ dataDir: opts.dataDir, name: 'v4_poolkeys', chain: opts.chain }),
				columnSpec: POOL_KEY_COLUMNS,
				orderBy: 'pool_id',
			},
		);
	}
	if (e.tokens.length > 0) {
		await writeRowsToParquet(
			e.tokens.map(([address, f]) => ({ address, decimals: f.decimals, symbol: f.symbol })),
			{
				outPath: cacheFilePath({ dataDir: opts.dataDir, name: 'tokens', chain: opts.chain }),
				columnSpec: TOKEN_COLUMNS,
				orderBy: 'address',
			},
		);
	}
	if (e.pools.length > 0) {
		await writeRowsToParquet(
			e.pools.map(([address, f]) => ({
				address,
				token0: f.token0 ?? null,
				token1: f.token1 ?? null,
				fee_bps: f.feeBps ?? null,
				factory: f.factory ?? null,
			})),
			{
				outPath: cacheFilePath({ dataDir: opts.dataDir, name: 'pools', chain: opts.chain }),
				columnSpec: POOL_COLUMNS,
				orderBy: 'address',
			},
		);
	}

	return { poolKeys: e.poolKeys.length, tokens: e.tokens.length, pools: e.pools.length };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/etl/src/factCacheStore.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Export from the package index**

Append to `packages/etl/src/index.ts`:

```ts
export { loadFactCacheEntries, saveFactCacheEntries } from './factCacheStore.js';
```

And add the core re-exports to `packages/core/src/index.ts`:

```ts
export {
	createMemoryFactCache,
	type FactCache,
	type FactCacheEntries,
	type PoolFact,
	type PoolKeyFact,
	type TokenFact,
} from './factCache.js';
```

- [ ] **Step 6: Typecheck, lint, full suite**

Run: `npm run typecheck && npm run lint && npx vitest run --exclude '**/.claude/**'`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add packages/etl/src/factCacheStore.ts packages/etl/src/factCacheStore.test.ts \
        packages/etl/src/index.ts packages/core/src/index.ts packages/etl/package.json
git commit -m "feat(etl): Parquet-backed FactCache store"
```

---

### Task 4: `includeWings` — stop computing the two adjacent-block mids

**Files:**
- Modify: `packages/core/src/pricing.ts`
- Modify: `packages/core/src/analyzeTransaction.ts`
- Test: `packages/core/src/pricing.test.ts` (add cases)

**Interfaces:**
- Consumes: nothing new.
- Produces: `priceReceipt(args & { includeWings?: boolean }, depsOverride?)`, and `analyzeTransaction(hash, chainId, { rpcUrl, includeWings? })`. Both default to `true`.

**Context you need:** `packages/core/src/pricing.ts` around line 699 runs the market-price apparatus **three times**:

```ts
const [mp, marketMidBefore, marketMidAfter] = await Promise.all([
  deps.getMarketPrice(inputToken, outputToken, refBlock),
  deps.getMarketPrice(inputToken, outputToken, refBlock - 1n).then((r) => r.marketMid).catch(() => null),
  deps.getMarketPrice(inputToken, outputToken, refBlock + 1n).then((r) => r.marketMid).catch(() => null),
]);
```

Measured cost of the two wings: **34 of 175 calls (19%)** in the baseline profile.

⚠️ **The centre call's missing `.catch` is deliberate and must stay.** The comment above it says so: a failed ruler must degrade the WHOLE receipt to partial, and there is a test named "never throws: a throwing getMarketPrice" that pins it. Each *wing* catches independently. Do not add a catch to the centre while you are in this code.

⚠️ Both wing fields must become `null` when wings are off — not omitted, not `undefined`. `Receipt.marketMidBefore` is typed `number | null`, and `exactOptionalPropertyTypes` makes an explicit `undefined` a type error.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/pricing.test.ts`, inside the existing `describe('priceReceipt', …)`.

These use the file's REAL fixtures — `baseArgs` (line 60), `makeDeps(over)` (line 28) and the `EXOTIC_A`/`EXOTIC_B` constants (lines 24-25) — and are modelled on the existing test `'general path: calls getMarketPrice at exactly refBlock-1n, refBlock, refBlock+1n (3 calls, not 4)'`, which is the one your change must not break. `EXOTIC_A`/`EXOTIC_B` matter: a USDC/WETH pair takes the benchmark fast path and never reaches the wings at all.

```ts
	// includeWings: false skips the two adjacent-block mids. The ETL path passes
	// it — with no UI there is no consumer for the adjacent-block table, and each
	// wing is one more independent chance for a transient read to degrade a row.
	it('general path: includeWings false calls getMarketPrice ONCE, at the ruler block', async () => {
		const seenBlocks: bigint[] = [];
		await priceReceipt(
			{ ...baseArgs, inputToken: EXOTIC_A, outputToken: EXOTIC_B, includeWings: false },
			makeDeps({
				getMarketPrice: async (_i, _o, blockNumber) => {
					seenBlocks.push(blockNumber);
					return { tier: 'full', marketMid: 200, corroboratedBy: ['direct'], flags: [], referenceDepthUsd: null, referencePoolAddress: null };
				},
			}),
		);
		// refBlock is blockNumber - 1n: the mid samples the block BEFORE the trade.
		expect(seenBlocks).toEqual([baseArgs.blockNumber - 1n]);
	});

	it('general path: includeWings false nulls both wings and keeps the ruler', async () => {
		const r = await priceReceipt(
			{ ...baseArgs, inputToken: EXOTIC_A, outputToken: EXOTIC_B, includeWings: false },
			makeDeps({
				getMarketPrice: async () => ({ tier: 'full', marketMid: 200, corroboratedBy: ['direct'], flags: [], referenceDepthUsd: null, referencePoolAddress: null }),
			}),
		);
		expect(r.marketMid).toBeCloseTo(200, 10);
		expect(r.marketMidBefore).toBeNull();
		expect(r.marketMidAfter).toBeNull();
	});

	it('general path: omitting includeWings still calls getMarketPrice three times', async () => {
		// The dashboard passes nothing. Defaulting to anything but "wings on"
		// would silently change every receipt it renders.
		const seenBlocks: bigint[] = [];
		await priceReceipt(
			{ ...baseArgs, inputToken: EXOTIC_A, outputToken: EXOTIC_B },
			makeDeps({
				getMarketPrice: async (_i, _o, blockNumber) => {
					seenBlocks.push(blockNumber);
					return { tier: 'full', marketMid: 200, corroboratedBy: ['direct'], flags: [], referenceDepthUsd: null, referencePoolAddress: null };
				},
			}),
		);
		expect(seenBlocks).toHaveLength(3);
	});

	it('general path: a throwing RULER still degrades the whole receipt, wings off', async () => {
		// The centre call is deliberately NOT caught (see the "never throws"
		// test). Turning wings off must not make a ruler failure survivable.
		const r = await priceReceipt(
			{ ...baseArgs, inputToken: EXOTIC_A, outputToken: EXOTIC_B, includeWings: false },
			makeDeps({
				getMarketPrice: async () => { throw new Error('ruler down'); },
			}),
		);
		expect(r.status).toBe('partial');
		expect(r.marketMid).toBeNull();
	});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/src/pricing.test.ts -t includeWings`
Expected: FAIL — the first passes incidentally, the rest fail because `includeWings` is not read.

- [ ] **Step 3: Implement in `pricing.ts`**

Add `includeWings?: boolean` to `priceReceipt`'s `args` type, then replace the three-call block:

```ts
    // Option D (2026-08-05 addendum, spec §11.2): the wings are the SAME
    // composition function as the ruler (`getMarketPrice`), evaluated at the
    // adjacent blocks — not a single-pool direct read. This is what guarantees
    // the centre and wings share provenance.
    //
    // `includeWings: false` skips both, at a measured saving of ~19% of a
    // decode's RPC calls. The ETL path passes it: with no UI there is no
    // consumer for the adjacent-block table, and each wing is one more
    // independent chance for a transient read failure to degrade a row.
    //
    // ⚠️ The centre call is intentionally NOT caught — a failed ruler must
    // degrade the WHOLE receipt to partial (see the "never throws: a throwing
    // getMarketPrice" test). Each wing degrades independently via its own
    // `.catch`. Turning wings off changes neither of those properties.
    const wings = args.includeWings !== false;
    const [mp, marketMidBefore, marketMidAfter] = await Promise.all([
      deps.getMarketPrice(inputToken, outputToken, refBlock),
      wings
        ? deps.getMarketPrice(inputToken, outputToken, refBlock - 1n)
            .then((r) => r.marketMid)
            .catch(() => null)
        : Promise.resolve(null),
      wings
        ? deps.getMarketPrice(inputToken, outputToken, refBlock + 1n)
            .then((r) => r.marketMid)
            .catch(() => null)
        : Promise.resolve(null),
    ]);
```

- [ ] **Step 4: Thread it through `analyzeTransaction`**

In `packages/core/src/analyzeTransaction.ts`, widen both signatures:

```ts
export function analyzeTransaction(
	hash: string,
	chainId: number,
	opts: { rpcUrl: string; includeWings?: boolean },
): Promise<Receipt | null> {
	return runInDecodeSession(() => analyzeTransactionInSession(hash, chainId, opts));
}

async function analyzeTransactionInSession(
	hash: string,
	chainId: number,
	opts: { rpcUrl: string; includeWings?: boolean },
): Promise<Receipt | null> {
```

and at the `priceReceipt` call, forward it with a conditional spread (`exactOptionalPropertyTypes` forbids passing an explicit `undefined`):

```ts
		const pricing = await priceReceipt({
			rpcUrl,
			blockNumber,
			chainId,
			inputToken: endpoints.inputToken,
			outputToken: endpoints.outputToken,
			inputAmountRaw: endpoints.inputAmountRaw,
			outputAmountRaw: endpoints.outputAmountRaw,
			...(opts.includeWings === undefined ? {} : { includeWings: opts.includeWings }),
		});
```

- [ ] **Step 5: Confirm the default survives the forward**

The wing behaviour is already pinned at the `pricing.ts` level by Step 1's four tests. What Step 4's conditional spread must additionally guarantee is that omitting the option forwards **nothing at all**, not `undefined`.

`analyzeTransaction` has no injection seam for `priceReceipt`, so do not invent a mocking framework to observe it. Instead assert the property directly, in `packages/core/src/analyzeTransaction.test.ts`:

```ts
it('forwards includeWings only when the caller set it', () => {
	// exactOptionalPropertyTypes makes `{ includeWings: undefined }` a type
	// error at the priceReceipt call, so this is enforced by the compiler.
	// This test pins the SHAPE so a later refactor to `includeWings: opts.includeWings`
	// is caught by review rather than by a changed receipt in production.
	const forward = (o: { includeWings?: boolean }) =>
		({ ...(o.includeWings === undefined ? {} : { includeWings: o.includeWings }) });
	expect(forward({})).toEqual({});
	expect(Object.hasOwn(forward({}), 'includeWings')).toBe(false);
	expect(forward({ includeWings: false })).toEqual({ includeWings: false });
	expect(forward({ includeWings: true })).toEqual({ includeWings: true });
});
```

⚠️ This test duplicates the spread expression rather than importing it. That is deliberate and it is the weaker kind of test — it pins intent, not the production code path. The real guarantee is the compiler plus Step 6's live-chain equivalence check. If you can see a way to export the forwarding without contorting `analyzeTransaction`, do that instead and say so.

- [ ] **Step 6: Verify against the live chain**

Run:

```bash
set -a && source .env && set +a
node -e "
const { analyzeTransaction } = await import('./packages/core/dist/index.js');
const h = '0x602a6c5e9ff9f0aad0965e5414a21bc4a8c0fa99dd7b07bdebfeb91259660cab';
const a = await analyzeTransaction(h, 8453, { rpcUrl: process.env.TCA_RPC_URL });
const b = await analyzeTransaction(h, 8453, { rpcUrl: process.env.TCA_RPC_URL, includeWings: false });
const drop = k => { const { marketMidBefore, marketMidAfter, ...r } = k; return r; };
console.log('wings on  :', a.marketMidBefore, a.marketMidAfter);
console.log('wings off :', b.marketMidBefore, b.marketMidAfter);
console.log('everything else identical:', JSON.stringify(drop(a)) === JSON.stringify(drop(b)));
" --input-type=module
```

Run `npm run typecheck` first so `dist/` is current.

Expected: wings-on shows two numbers, wings-off shows `null null`, and **everything else identical: true**.

⚠️ If the last line is `false`, compare the differing fields against Task 1's determinism findings before concluding the flag is at fault — a field Task 1 already flagged as unstable is noise, not a regression. Say which in your report.

- [ ] **Step 7: Full suite, typecheck, lint**

Run: `npm run typecheck && npm run lint && npx vitest run --exclude '**/.claude/**'`
Expected: all clean, no test edited to accommodate the change.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/pricing.ts packages/core/src/pricing.test.ts \
        packages/core/src/analyzeTransaction.ts packages/core/src/analyzeTransaction.test.ts
git commit -m "feat(core): includeWings option to skip the adjacent-block mids

~19% of a decode's RPC calls, and two fewer chances for a transient read
to degrade a row. Defaults to true; the dashboard is unaffected."
```

---

### Task 5: `prefetched` — feed the decoder from the Seed

**Files:**
- Create: `packages/core/src/prefetched.ts`
- Test: `packages/core/src/prefetched.test.ts`
- Modify: `packages/core/src/analyzeTransaction.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `interface PrefetchedTx { receipt: PrefetchedReceipt; tx: PrefetchedTransaction; trace: unknown }`
  - `fromSeedJson(args: { receiptJson: string; txJson: string; traceJson: string }): PrefetchedTx`
  - `analyzeTransaction(hash, chainId, { rpcUrl, includeWings?, prefetched? })`

**Context you need:** `analyzeTransaction.ts:336-344` issues three calls whose results the Seed layer already holds:

```ts
const [receipt, tx, rawTrace] = await Promise.all([
	rpc.getTransactionReceipt({ hash: txHash }),
	rpc.getTransaction({ hash: txHash }),
	rpc.request({ method: 'debug_traceTransaction', params: [txHash, { tracer: 'callTracer', … }] }),
]);
```

**This is worth only 3 of 175 calls (1.7%).** Its value is reproducibility, not speed: with it, a derived build reads the trace from disk and needs no archive node for that step.

**The translation layer is the whole task.** The Seed stores raw RPC JSON (hex strings); viem returns parsed types (bigints, lowercased addresses). The decoder's actual usage of these two objects is small and enumerable — grep confirmed it is exactly:

| Field | Used at | Type viem returns |
|---|---|---|
| `receipt.logs[].address` | `analyzeTransaction.ts:346` | `string` |
| `receipt.logs[].topics` | `analyzeTransaction.ts:346` | `string[]` |
| `receipt.blockNumber` | `:365` | `bigint` |
| `receipt.gasUsed` | `:414` | `bigint` |
| `receipt.effectiveGasPrice` | `:414` | `bigint \| undefined` |
| `tx.from` | `:357, :454, :539` | `string` |
| `tx.to` | `:425, :486, :537` | `string \| null` |

That table IS the contract. Define narrow types for exactly those fields rather than importing viem's full `TransactionReceipt`.

⚠️ `debug_traceTransaction`'s result is passed through as `TraceNode` with no transformation, so `trace` needs no translation — `JSON.parse(traceJson)` is the whole thing.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/prefetched.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fromSeedJson } from './prefetched.js';

const RECEIPT_JSON = JSON.stringify({
	blockNumber: '0x307cc2f',
	gasUsed: '0x5208',
	effectiveGasPrice: '0x3b9aca00',
	logs: [
		{ address: '0xAAA', topics: ['0x11', '0x22'], data: '0x' },
		{ address: '0xbbb', topics: ['0x33'], data: '0x' },
	],
});
const TX_JSON = JSON.stringify({ from: '0xFROM', to: '0xTO', value: '0x0' });
const TRACE_JSON = JSON.stringify({ type: 'CALL', from: '0xa', to: '0xb', calls: [] });

describe('fromSeedJson', () => {
	it('parses hex quantities into the bigints the decoder expects', () => {
		const p = fromSeedJson({ receiptJson: RECEIPT_JSON, txJson: TX_JSON, traceJson: TRACE_JSON });
		expect(p.receipt.blockNumber).toBe(50842671n);
		expect(p.receipt.gasUsed).toBe(21000n);
		expect(p.receipt.effectiveGasPrice).toBe(1000000000n);
	});

	it('preserves log order, address and topics', () => {
		const p = fromSeedJson({ receiptJson: RECEIPT_JSON, txJson: TX_JSON, traceJson: TRACE_JSON });
		expect(p.receipt.logs).toHaveLength(2);
		expect(p.receipt.logs[0]!.address).toBe('0xAAA');
		expect(p.receipt.logs[0]!.topics).toEqual(['0x11', '0x22']);
		expect(p.receipt.logs[1]!.topics).toEqual(['0x33']);
	});

	it('passes tx.from and tx.to through untouched', () => {
		// Casing is NOT normalized here: every consumer lowercases at its own
		// call site, and normalizing early would diverge from what viem returns.
		const p = fromSeedJson({ receiptJson: RECEIPT_JSON, txJson: TX_JSON, traceJson: TRACE_JSON });
		expect(p.tx.from).toBe('0xFROM');
		expect(p.tx.to).toBe('0xTO');
	});

	it('yields null for a contract-creation tx.to', () => {
		const p = fromSeedJson({
			receiptJson: RECEIPT_JSON,
			txJson: JSON.stringify({ from: '0xa', to: null }),
			traceJson: TRACE_JSON,
		});
		expect(p.tx.to).toBeNull();
	});

	it('yields undefined effectiveGasPrice when the receipt omits it', () => {
		// Absent must not become 0n: gasCostUsd multiplies by it, and 0 would
		// silently report a free transaction.
		const p = fromSeedJson({
			receiptJson: JSON.stringify({ blockNumber: '0x1', gasUsed: '0x1', logs: [] }),
			txJson: TX_JSON,
			traceJson: TRACE_JSON,
		});
		expect(p.receipt.effectiveGasPrice).toBeUndefined();
	});

	it('parses the trace with no transformation at all', () => {
		const p = fromSeedJson({ receiptJson: RECEIPT_JSON, txJson: TX_JSON, traceJson: TRACE_JSON });
		expect(p.trace).toEqual(JSON.parse(TRACE_JSON));
	});

	it('refuses a receipt missing blockNumber rather than yielding NaN', () => {
		expect(() =>
			fromSeedJson({
				receiptJson: JSON.stringify({ gasUsed: '0x1', logs: [] }),
				txJson: TX_JSON,
				traceJson: TRACE_JSON,
			}),
		).toThrow(/blockNumber/);
	});

	it('refuses malformed JSON with a message naming which payload', () => {
		expect(() =>
			fromSeedJson({ receiptJson: 'not json', txJson: TX_JSON, traceJson: TRACE_JSON }),
		).toThrow(/receipt/i);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/prefetched.test.ts`
Expected: FAIL — `Failed to resolve import "./prefetched.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/prefetched.ts`:

```ts
/**
 * prefetched.ts — Seed JSON in, the shapes analyzeTransaction expects out.
 *
 * The ETL Seed layer already holds every transaction's receipt, envelope and
 * callTracer trace as raw RPC JSON. Feeding those straight to the decoder saves
 * only 3 of ~175 RPC calls, but it removes the archive-node dependency for that
 * step and makes a derived build reproducible from disk.
 *
 * ⚠️ THE FIELD LIST BELOW IS THE CONTRACT. The decoder touches a small,
 * enumerable slice of viem's TransactionReceipt and Transaction:
 *
 *   receipt.logs[].address, receipt.logs[].topics, receipt.blockNumber,
 *   receipt.gasUsed, receipt.effectiveGasPrice, tx.from, tx.to
 *
 * These types are deliberately narrow rather than viem's full ones, so that a
 * decoder change reaching for an eighth field fails to COMPILE here instead of
 * reading `undefined` at runtime.
 *
 * Casing is NOT normalized: every consumer lowercases at its own call site, and
 * normalizing early would make prefetched input differ from live input.
 */

export interface PrefetchedLog {
	address: string;
	topics: string[];
}

export interface PrefetchedReceipt {
	logs: PrefetchedLog[];
	blockNumber: bigint;
	gasUsed: bigint;
	/** Absent on some chains/clients. MUST stay undefined rather than 0n — the
	 *  gas-cost math multiplies by it, and 0n reports a free transaction. */
	effectiveGasPrice?: bigint;
}

export interface PrefetchedTransaction {
	from: string;
	/** NULL for a contract creation. */
	to: string | null;
}

export interface PrefetchedTx {
	receipt: PrefetchedReceipt;
	tx: PrefetchedTransaction;
	/** Passed through to the decoder as a TraceNode with no transformation. */
	trace: unknown;
}

function parseJson(text: string, what: string): Record<string, unknown> {
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch (err) {
		throw new Error(`Prefetched ${what} is not valid JSON: ${(err as Error).message}`);
	}
}

/** Required hex quantity → bigint. Throws rather than yielding NaN or 0n. */
function requiredHex(value: unknown, field: string): bigint {
	if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
		throw new Error(`Prefetched receipt has no usable ${field} (got ${JSON.stringify(value)})`);
	}
	return BigInt(value);
}

function optionalHex(value: unknown): bigint | undefined {
	return typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value) ? BigInt(value) : undefined;
}

export function fromSeedJson(args: {
	receiptJson: string;
	txJson: string;
	traceJson: string;
}): PrefetchedTx {
	const receipt = parseJson(args.receiptJson, 'receipt');
	const tx = parseJson(args.txJson, 'transaction');
	const trace = parseJson(args.traceJson, 'trace');

	const rawLogs = Array.isArray(receipt.logs) ? (receipt.logs as Record<string, unknown>[]) : [];
	const logs: PrefetchedLog[] = rawLogs.map((l) => ({
		address: String(l.address),
		topics: Array.isArray(l.topics) ? (l.topics as unknown[]).map(String) : [],
	}));

	const effectiveGasPrice = optionalHex(receipt.effectiveGasPrice);

	return {
		receipt: {
			logs,
			blockNumber: requiredHex(receipt.blockNumber, 'blockNumber'),
			gasUsed: requiredHex(receipt.gasUsed, 'gasUsed'),
			...(effectiveGasPrice === undefined ? {} : { effectiveGasPrice }),
		},
		tx: {
			from: String(tx.from),
			to: typeof tx.to === 'string' ? tx.to : null,
		},
		trace,
	};
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/prefetched.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Wire it into `analyzeTransaction`**

Widen both signatures to accept `prefetched?: PrefetchedTx`, and replace the three-call `Promise.all` with:

```ts
		// The Seed layer already holds all three. Injecting them removes the
		// archive-node dependency for this step and makes a derived build
		// reproducible from disk. See prefetched.ts for the field contract.
		const { receipt, tx, rawTrace } = opts.prefetched
			? { receipt: opts.prefetched.receipt, tx: opts.prefetched.tx, rawTrace: opts.prefetched.trace }
			: await (async () => {
					const [receipt, tx, rawTrace] = await Promise.all([
						rpc.getTransactionReceipt({ hash: txHash }),
						rpc.getTransaction({ hash: txHash }),
						(rpc.request as unknown as (r: { method: string; params: unknown[] }) => Promise<unknown>)({
							method: 'debug_traceTransaction',
							params: [txHash, { tracer: 'callTracer', tracerConfig: { withLog: true, onlyTopCall: false } }],
						}),
					]);
					return { receipt, tx, rawTrace };
				})();
```

⚠️ TypeScript will need the two branches to unify. If viem's `TransactionReceipt` does not structurally satisfy `PrefetchedReceipt`, **widen the local binding to the narrow type** rather than casting viem's away — the narrow type is the contract, and a compile error here is the contract doing its job. Report exactly what you had to do.

Export from `packages/core/src/index.ts`:

```ts
export { fromSeedJson, type PrefetchedTx, type PrefetchedReceipt, type PrefetchedTransaction } from './prefetched.js';
```

- [ ] **Step 6: Prove equivalence against the live chain**

This is the task's real gate. Run `npm run typecheck` first, then:

```bash
set -a && source .env && set +a
node -e "
const { analyzeTransaction, fromSeedJson } = await import('./packages/core/dist/index.js');
const { DuckDBInstance } = await import('@duckdb/node-api');
const h = '0x602a6c5e9ff9f0aad0965e5414a21bc4a8c0fa99dd7b07bdebfeb91259660cab';
const i = await DuckDBInstance.create(':memory:'); const c = await i.connect();
const rows = (await c.runAndReadAll(\`
  SELECT receipt_json, tx_json, trace_json
  FROM read_parquet('data/seeds/traces.base.0050842630-0050842929.parquet')
  WHERE tx_hash = '\${h}'\`)).getRowObjects();
c.closeSync(); i.closeSync();
const p = fromSeedJson({
  receiptJson: String(rows[0].receipt_json),
  txJson: String(rows[0].tx_json),
  traceJson: String(rows[0].trace_json),
});
const live = await analyzeTransaction(h, 8453, { rpcUrl: process.env.TCA_RPC_URL });
const fed  = await analyzeTransaction(h, 8453, { rpcUrl: process.env.TCA_RPC_URL, prefetched: p });
console.log('identical:', JSON.stringify(live) === JSON.stringify(fed));
if (JSON.stringify(live) !== JSON.stringify(fed)) {
  for (const k of new Set([...Object.keys(live), ...Object.keys(fed)])) {
    if (JSON.stringify(live[k]) !== JSON.stringify(fed[k]))
      console.log('  ', k, JSON.stringify(live[k])?.slice(0,60), '=>', JSON.stringify(fed[k])?.slice(0,60));
  }
}
" --input-type=module
```

Expected: `identical: true`.

⚠️ If false, check each differing field against Task 1's determinism findings before concluding the translation is wrong. A field Task 1 already listed as unstable is noise. Report which.

- [ ] **Step 7: Full suite, typecheck, lint**

Run: `npm run typecheck && npm run lint && npx vitest run --exclude '**/.claude/**'`
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/prefetched.ts packages/core/src/prefetched.test.ts \
        packages/core/src/analyzeTransaction.ts packages/core/src/index.ts
git commit -m "feat(core): prefetched receipt/tx/trace from the Seed layer

Removes the archive-node dependency for the three payloads the Seed
already holds, and makes a derived build reproducible from disk."
```

---

### Task 6: Wire the `FactCache` into the readers, and re-profile

**Files:**
- Create: `packages/core/src/cachedReaders.ts`
- Test: `packages/core/src/cachedReaders.test.ts`
- Modify: `packages/core/src/analyzeTransaction.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `FactCache` (Task 2); `V4PoolKeyReader`, `createDefaultV4PoolKeyReader`, `createDefaultInfinityPoolKeyReader`, `createDefaultV3FactoryReader`, `createDefaultFeeReader` from `./routeReaders.js`; `VenueType` from `./routeGraph.js`
- Produces:
  - `CACHEABLE_FEE_VENUES: ReadonlySet<VenueType>`
  - `cachedPoolKeyReader(inner, cache): V4PoolKeyReader`
  - `cachedV3FactoryReader(inner, cache)`
  - `cachedFeeReader(inner, cache)`
  - `analyzeTransaction(hash, chainId, { rpcUrl, includeWings?, prefetched?, factCache? })`

**Context you need — the fee allowlist, which is the subtle part.**

Read `createDefaultFeeReader` at `packages/core/src/routeReaders.ts:196`. Its switch groups these together:

```ts
case 'univ3': case 'sushiv3': case 'baseswapv3': case 'pancakev3':
// Hydrex and QuickSwap v4 are Algebra Integral: fee() returns the
// currently effective fee (including any plugin override) …
case 'hydrex': case 'quickswapv4': {
```

**`hydrex` and `quickswapv4` return the CURRENTLY EFFECTIVE fee, including a plugin override. That is not immutable and must never be cached.** Neither may `univ4` or `pancake_infinity`, whose fees are hook-driven. The allowlist is exactly the four static-tier v3 forks:

```
univ3, sushiv3, baseswapv3, pancakev3
```

A v3 pool's `fee()` is set at creation and never changes, so those four are safe.

**The second rule: never cache a null.** Every reader here returns `null`/a default on failure, and a failed read is indistinguishable from a nonexistent pool (`v4-poolkey-reader-swallows-errors`, which already corrupted 11 receipts). Persisting one would make a transient blip permanent. Only positive results are stored — and for the fee reader, only when `defaulted === false`.

**The third rule: `getPool` stays uncached.** It is a `latest`-tag factory lookup whose answer changes when a new fee tier is deployed. `FactCache` has no setter for it (Task 2 pins that); do not add one.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/cachedReaders.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createMemoryFactCache } from './factCache.js';
import { CACHEABLE_FEE_VENUES, cachedFeeReader, cachedPoolKeyReader, cachedV3FactoryReader } from './cachedReaders.js';

describe('cachedPoolKeyReader', () => {
	it('calls the inner reader once, then serves from cache', async () => {
		let calls = 0;
		const inner = async () => { calls++; return { currency0: '0x1', currency1: '0x2' }; };
		const cache = createMemoryFactCache();
		const reader = cachedPoolKeyReader(inner, cache);
		expect(await reader('0xPOOL')).toEqual({ currency0: '0x1', currency1: '0x2' });
		expect(await reader('0xpool')).toEqual({ currency0: '0x1', currency1: '0x2' });
		expect(calls).toBe(1);
	});

	it('serves a pre-seeded fact without calling the inner reader at all', async () => {
		// This is the win: ~25 serial extsload probes per poolId become zero.
		let calls = 0;
		const inner = async () => { calls++; return null; };
		const cache = createMemoryFactCache({ poolKeys: [['0xa', { currency0: '0x1', currency1: '0x2' }]] });
		expect(await cachedPoolKeyReader(inner, cache)('0xA')).toEqual({ currency0: '0x1', currency1: '0x2' });
		expect(calls).toBe(0);
	});

	it('NEVER caches a null, and retries on the next call', async () => {
		// A null means "no such pool" OR "the read failed" — indistinguishable.
		// Persisting one would make a transport blip permanent.
		let calls = 0;
		const inner = async () => { calls++; return null; };
		const cache = createMemoryFactCache();
		const reader = cachedPoolKeyReader(inner, cache);
		expect(await reader('0xa')).toBeNull();
		expect(await reader('0xa')).toBeNull();
		expect(calls).toBe(2);
		expect(cache.entries().poolKeys).toEqual([]);
	});
});

describe('cachedV3FactoryReader', () => {
	it('caches a positive factory answer', async () => {
		let calls = 0;
		const inner = async () => { calls++; return '0xfac'; };
		const cache = createMemoryFactCache();
		const reader = cachedV3FactoryReader(inner, cache);
		expect(await reader('0xP')).toBe('0xfac');
		expect(await reader('0xp')).toBe('0xfac');
		expect(calls).toBe(1);
		expect(cache.getPool('0xp')?.factory).toBe('0xfac');
	});

	it('never caches a null factory', async () => {
		let calls = 0;
		const inner = async () => { calls++; return null; };
		const cache = createMemoryFactCache();
		const reader = cachedV3FactoryReader(inner, cache);
		await reader('0xa');
		await reader('0xa');
		expect(calls).toBe(2);
		expect(cache.getPool('0xa')).toBeUndefined();
	});
});

describe('cachedFeeReader', () => {
	it('caches a resolved fee for a static-tier v3 venue', async () => {
		let calls = 0;
		const inner = async () => { calls++; return { bps: 30, defaulted: false }; };
		const cache = createMemoryFactCache();
		const reader = cachedFeeReader(inner, cache);
		expect(await reader('0xP', 'univ3')).toEqual({ bps: 30, defaulted: false });
		expect(await reader('0xp', 'univ3')).toEqual({ bps: 30, defaulted: false });
		expect(calls).toBe(1);
	});

	it('NEVER caches a dynamic-fee venue, even when the read succeeds', async () => {
		// hydrex and quickswapv4 are Algebra Integral: fee() returns the
		// CURRENTLY EFFECTIVE fee including a plugin override, so yesterday's
		// answer is not today's.
		for (const venue of ['hydrex', 'quickswapv4', 'univ4', 'pancake_infinity'] as const) {
			let calls = 0;
			const inner = async () => { calls++; return { bps: 30, defaulted: false }; };
			const cache = createMemoryFactCache();
			const reader = cachedFeeReader(inner, cache);
			await reader('0xp', venue);
			await reader('0xp', venue);
			expect(calls, `${venue} must not be cached`).toBe(2);
			expect(cache.getPool('0xp')?.feeBps, `${venue} must not be stored`).toBeUndefined();
		}
	});

	it('never caches a DEFAULTED fee', async () => {
		// defaulted:true means the read failed and a fallback was substituted —
		// exactly the "absent is not measured" trap the fee work already fixed once.
		let calls = 0;
		const inner = async () => { calls++; return { bps: 30, defaulted: true }; };
		const cache = createMemoryFactCache();
		const reader = cachedFeeReader(inner, cache);
		await reader('0xp', 'univ3');
		await reader('0xp', 'univ3');
		expect(calls).toBe(2);
		expect(cache.getPool('0xp')?.feeBps).toBeUndefined();
	});

	it('pins the allowlist to exactly the four static-tier v3 forks', () => {
		expect([...CACHEABLE_FEE_VENUES].sort()).toEqual(['baseswapv3', 'pancakev3', 'sushiv3', 'univ3']);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/cachedReaders.test.ts`
Expected: FAIL — `Failed to resolve import "./cachedReaders.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/cachedReaders.ts`:

```ts
import type { FactCache } from './factCache.js';
import type { VenueType } from './routeGraph.js';
import type { V4PoolKeyReader } from './routeReaders.js';

/**
 * cachedReaders.ts — decorators that let a FactCache short-circuit a reader.
 *
 * Deliberately decorators rather than a `factCache` parameter threaded through
 * routeReaders.ts: the seven reader factories keep their signatures, and
 * decomposeRoute's existing `deps` seam is how these reach the decode.
 *
 * ⚠️ TWO RULES GOVERN EVERY DECORATOR HERE.
 *
 * 1. NEVER CACHE A NULL OR A DEFAULT. Every reader in routeReaders.ts turns a
 *    failed read into `null` or a defaulted value, and a failed read is
 *    indistinguishable from a nonexistent pool. That ambiguity has already
 *    corrupted receipts once. Caching one would make a transient blip
 *    permanent, across runs. Only positive results are stored.
 *
 * 2. ONLY IMMUTABLE FACTS. A v3 pool's fee() is fixed at creation. Hydrex and
 *    QuickSwap v4 are Algebra Integral — fee() returns the CURRENTLY EFFECTIVE
 *    fee including any plugin override — and v4/Infinity fees are hook-driven.
 *    Those are excluded by CACHEABLE_FEE_VENUES below, which is the whole
 *    safety argument for caching fees at all.
 *
 * `getPool` is not decorated here and must not be: it is a `latest`-tag factory
 * lookup whose answer changes when a new fee tier is deployed (rpcMemo.ts).
 *
 * `decimalsReader` is not decorated here either, deliberately. Decimals and
 * symbol are resolved by two separate readers, and writing a decimals-only
 * TokenFact would make a later symbol lookup a cache hit on a symbol nobody
 * read. Both are wired together in v0.2b-2. See factCache.ts's docstring.
 */

/**
 * Venues whose `fee()` is immutable per pool — the static-tier v3 forks, and
 * nothing else. Adding a venue here without confirming its fee cannot change is
 * how this cache starts serving wrong answers.
 */
export const CACHEABLE_FEE_VENUES: ReadonlySet<VenueType> = new Set<VenueType>([
	'univ3',
	'sushiv3',
	'baseswapv3',
	'pancakev3',
]);

/** poolId → currencies. The big win: ~25 serial `extsload` probes become zero. */
export function cachedPoolKeyReader(inner: V4PoolKeyReader, cache: FactCache): V4PoolKeyReader {
	return async (poolId: string) => {
		const hit = cache.getPoolKey(poolId);
		if (hit) return hit;
		const fresh = await inner(poolId);
		if (fresh) cache.setPoolKey(poolId, fresh);
		return fresh;
	};
}

type V3FactoryReader = (addr: string) => Promise<string | null> | string | null;

export function cachedV3FactoryReader(inner: V3FactoryReader, cache: FactCache): V3FactoryReader {
	return async (addr: string) => {
		const hit = cache.getPool(addr)?.factory;
		if (hit) return hit;
		const fresh = await inner(addr);
		if (fresh) cache.setPool(addr, { factory: fresh });
		return fresh;
	};
}

type FeeResult = { bps: number; defaulted: boolean };
type FeeReader = (addr: string, type: VenueType, feeRawPips?: number) => Promise<FeeResult> | FeeResult;

export function cachedFeeReader(inner: FeeReader, cache: FactCache): FeeReader {
	return async (addr: string, type: VenueType, feeRawPips?: number) => {
		if (!CACHEABLE_FEE_VENUES.has(type)) return inner(addr, type, feeRawPips);
		const hit = cache.getPool(addr)?.feeBps;
		if (hit !== undefined) return { bps: hit, defaulted: false };
		const fresh = await inner(addr, type, feeRawPips);
		// `defaulted` means the read FAILED and a fallback was substituted.
		if (!fresh.defaulted) cache.setPool(addr, { feeBps: fresh.bps });
		return fresh;
	};
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/cachedReaders.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Wire into `analyzeTransaction`**

Add `factCache?: FactCache` to both signatures. At the `decomposeRoute` call (~line 447), build the cache-wrapped readers and add them to the existing `deps` object:

```ts
		const { midReader, decimalsReader } = createDefaultMidReader(rpcUrl, blockNumber);
		// Cache-wrapped readers go through decomposeRoute's existing `deps` seam,
		// so routeReaders.ts keeps its signatures. With no factCache, `deps` is
		// exactly what it was before and decomposeRoute builds its own defaults.
		const cache = opts.factCache;
		const cachedDeps = cache
			? {
					v4PoolKeyReader: cachedPoolKeyReader(createDefaultV4PoolKeyReader(rpcUrl, blockNumber), cache),
					infinityPoolKeyReader: cachedPoolKeyReader(
						createDefaultInfinityPoolKeyReader(rpcUrl, blockNumber),
						cache,
					),
					v3FactoryReader: cachedV3FactoryReader(createDefaultV3FactoryReader(rpcUrl, blockNumber), cache),
					feeReader: cachedFeeReader(createDefaultFeeReader(rpcUrl, blockNumber), cache),
				}
			: {};
		const route = await decomposeRoute(
			{ /* …unchanged input… */ },
			{ midReader, decimalsReader, ...cachedDeps },
		);
```

Import the four `createDefault*` factories and the three decorators at the top of the file.

Export from `packages/core/src/index.ts`:

```ts
export { CACHEABLE_FEE_VENUES, cachedFeeReader, cachedPoolKeyReader, cachedV3FactoryReader } from './cachedReaders.js';
```

- [ ] **Step 6: Back-compat check — no factCache changes nothing**

Run `npm run typecheck`, then:

```bash
set -a && source .env && set +a
node -e "
const { analyzeTransaction, createMemoryFactCache } = await import('./packages/core/dist/index.js');
const h = '0x602a6c5e9ff9f0aad0965e5414a21bc4a8c0fa99dd7b07bdebfeb91259660cab';
const url = process.env.TCA_RPC_URL;
const plain = await analyzeTransaction(h, 8453, { rpcUrl: url });
const cache = createMemoryFactCache();
const warm  = await analyzeTransaction(h, 8453, { rpcUrl: url, factCache: cache });
const again = await analyzeTransaction(h, 8453, { rpcUrl: url, factCache: cache });
console.log('cold cache identical to no cache:', JSON.stringify(plain) === JSON.stringify(warm));
console.log('warm cache identical to cold    :', JSON.stringify(warm)  === JSON.stringify(again));
const e = cache.entries();
console.log('cached:', e.poolKeys.length, 'poolKeys,', e.pools.length, 'pools');
" --input-type=module
```

Expected: both `true`, and a non-zero poolKeys count (this transaction has two v4 poolIds).

⚠️ If either is false, diff the fields and check them against Task 1's determinism findings before concluding the cache is at fault.

- [ ] **Step 7: The profiling gate — measure the saving**

This is the task's deliverable. Re-profile the same transaction the baseline used:

```bash
set -a && source .env && set +a
node scripts/analysis/decodeProfile.mjs \
  0x602a6c5e9ff9f0aad0965e5414a21bc4a8c0fa99dd7b07bdebfeb91259660cab
```

That measures the **uncached** path, which should still be ~175 calls — the baseline must not have regressed.

Then measure the cached, wings-off path. `decodeProfile.mjs` calls `analyzeTransaction` with no options, so add an options passthrough to it (a `--no-wings` and `--fact-cache` flag), or write the equivalent inline probe against its proxy. **Read the script first and take whichever route is smaller.**

Report a table:

| Configuration | RPC calls | wall (ms) |
|---|---|---|
| baseline (2026-09-04, recorded) | 175 | 10,045 |
| this branch, no options | ? | ? |
| `includeWings: false` | ? | ? |
| `includeWings: false` + warm `factCache` | ? | ? |

**Expected direction, not a target:** wings-off should drop roughly 34 calls; a warm cache should additionally remove the ~51 `extsload` bisection calls and most of the 39 `@latest` metadata reads. If the warm-cache number is not dramatically lower, the wiring is not reaching the readers — investigate before reporting DONE.

- [ ] **Step 8: Full suite, typecheck, lint**

Run: `npm run typecheck && npm run lint && npx vitest run --exclude '**/.claude/**'`
Expected: all clean, no existing test edited.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/cachedReaders.ts packages/core/src/cachedReaders.test.ts \
        packages/core/src/analyzeTransaction.ts packages/core/src/index.ts \
        scripts/analysis/decodeProfile.mjs
git commit -m "feat(core): wire the FactCache into the pool-key, factory and fee readers

Only immutable facts, only positive results. Dynamic-fee venues (Algebra
Integral, v4, Infinity) are excluded by an explicit allowlist."
```

---

## What this plan does NOT cover

v0.2b's second half is a separate plan, written after this one lands. It is the part that produces files:

**v0.2b-2 — `receipts` and `legs`**

1. `RECEIPT_COLUMNS` / `LEG_COLUMNS` in `derivedSchema.ts`, plus their version tripwires. Bumps `DERIVED_SCHEMA_VERSION`.
2. Raw leg amounts on `toPersistedLeg` — `routeGraph.Leg` carries `amountInRaw`/`amountOutRaw` as bigints and `toPersistedLeg` drops them. They must be added as **decimal strings**, since `Receipt.routeLegs` is JSON-serialized and bigint is not. Additive: the dashboard's `RouteLeg` is a structural interface read through a cast, so extra fields are inert there.
3. **Wire the token FactCache family** — `decimalsReader` and `resolveLegSymbols`'s `readSymbol` together, so a complete `TokenFact` is written in one go. Defined in v0.2b-1, populated here, for the reason in `factCache.ts`'s docstring.
4. Pure `Receipt` → receipt-row and `Receipt` → leg-rows transforms.
5. The serial enrichment runner and its `etl-derive receipts` CLI command, loading and saving the FactCache around the run.
6. Ruler-coverage instrumentation — record which pool the market-price ruler binds to, and what fraction have in-window Swap-log coverage. **This is the measurement that decides whether v0.3's `pool_state` file is worth building.**
7. The 535 run, then the 13,511 run.

**Two clean-ups deferred from v0.2a**, to be done as that plan's first task:
- Collapse `seedColumnSpec` into `derivedColumnSpec(SEED_COLUMNS)`, or rename the renderer to something layer-neutral — the Seed layer calling something named `derived*` is the wrong shape.
- Move `sqlLiteral` out of `writeParquet.ts` into a `sql.ts` leaf. Two non-writer modules already import it from the Parquet writer, and v0.2b-2's modules will want it too.

Splitting here is deliberate: everything above changes `packages/core`, which the dashboard depends on, and each gate in it is a **diff against a live chain**. Those diffs are only interpretable once Task 1 has established the noise floor — and they should not be entangled with new file formats at the same time.
