# Basescan-Attributed Aggregator Fees Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every aggregator-fee line on a receipt links to its fee-recipient's Basescan address page, labeled by the contract's verified name (free Etherscan API) or a generic `[Aggregator] Fee`; multi-sink trades render one line per sink.

**Architecture:** Core surfaces the full `feeSinks[]` array (dominant-first, per-sink bps) it already computes but currently discards. A new core module resolves `address → verified ContractName` via the free Etherscan V2 API, cached, invoked only in the persist path (never in `analyzeTransaction`, keeping core RPC-pure). A new `fee_sinks` JSONB column persists the enriched array. The dashboard renders one fee line per sink; the hardcoded curated vault map is deleted.

**Tech Stack:** TypeScript monorepo (pnpm workspaces: `@fabric-tca/core`, `@fabric-tca/db`, dashboard = Next.js). Drizzle ORM + Postgres (Supabase pooler). Vitest. Node 20 (global `fetch`).

## Global Constraints

- Name source is the **free** Etherscan V2 `getsourcecode` → `ContractName` only. Chain id **8453** (Base). No Pro/name-tag endpoints, no HTML scraping.
- Empty/unverified `ContractName` → generic `"[Aggregator] Fee"` label (never blank).
- Core analysis (`analyzeTransaction` / `decomposeRoute`) stays **RPC-pure**: no Etherscan calls inside it.
- Name resolution degrades gracefully: no `ETHERSCAN_API_KEY`, or any fetch/parse failure → treat as unnamed. Never throw into the persist path.
- Truncated-address format is `shortTxHash` (`0x1234…abcd`) from `packages/dashboard/lib/formatters.ts`.
- Fabric integrator fee keeps the `"Integrator Fee"` label (sink-0 fallback), not `"Fabric Fee"`.
- Persisted receipts go stale silently on core changes — repopulation (Task 7) is mandatory and runs in the **background** (full set exceeds the 5-min tool timeout).
- DB URL env var is `TCA_DATABASE_URL`; RPC is `TCA_RPC_URL`; Etherscan key is `ETHERSCAN_API_KEY`. `.env` values are NOT auto-exported (`set -a && source .env && set +a`).

---

### Task 1: Core — surface the full fee-sink array with per-sink bps

**Files:**
- Modify: `packages/core/src/decomposeRoute.ts` (result type ~`80-89`; two return sites ~`685`, ~`723`; dominant-sink block ~`361-368`)
- Modify: `packages/core/src/analyzeTransaction.ts` (Receipt type ~`160`; output object ~`422`)
- Test: `packages/core/src/decomposeRoute.test.ts` (add a test) — if absent, create it.

**Interfaces:**
- Produces (from `decomposeRoute` result and `Receipt`): `feeSinks: FeeSinkOut[]` where
  ```ts
  export interface FeeSinkOut { address: string; feeBps: number; source: string }
  ```
  Sorted dominant-first (by underlying `totalUsdc` desc). Per-sink `feeBps` = proportional split of `aggFeeBps` by `totalUsdc` share; the array sums to `aggFeeBps` (±rounding). Empty array when no sinks. Existing `feeRecipient`/`feeSinkSource` remain (= `feeSinks[0]` / null).

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/decomposeRoute.test.ts`. This test drives the pure sink-mapping helper directly (no RPC). First, at the top of `decomposeRoute.ts`, we will export a pure helper `buildFeeSinks`; the test imports it.

```ts
import { describe, it, expect } from 'vitest';
import { buildFeeSinks } from './decomposeRoute.js';
import type { FeeSink } from './tradeFees.js';

describe('buildFeeSinks', () => {
  it('sorts dominant-first and splits aggFeeBps proportionally', () => {
    const sinks: FeeSink[] = [
      { address: '0xsmall', usdcRetained: 1, wethRetained: 0, totalUsdc: 1, source: 'retained_balance' },
      { address: '0xbig',   usdcRetained: 3, wethRetained: 0, totalUsdc: 3, source: 'retained_balance' },
    ];
    const out = buildFeeSinks(sinks, 20); // aggFeeBps = 20
    expect(out.map(s => s.address)).toEqual(['0xbig', '0xsmall']);
    expect(out[0].feeBps).toBeCloseTo(15, 6);
    expect(out[1].feeBps).toBeCloseTo(5, 6);
    expect(out.reduce((a, s) => a + s.feeBps, 0)).toBeCloseTo(20, 6);
    expect(out[0].source).toBe('retained_balance');
  });

  it('returns [] for no sinks', () => {
    expect(buildFeeSinks([], 0)).toEqual([]);
  });

  it('splits evenly when total retained is zero', () => {
    const sinks: FeeSink[] = [
      { address: '0xa', usdcRetained: 0, wethRetained: 0, totalUsdc: 0, source: 'vault_map' },
      { address: '0xb', usdcRetained: 0, wethRetained: 0, totalUsdc: 0, source: 'vault_map' },
    ];
    const out = buildFeeSinks(sinks, 10);
    expect(out).toHaveLength(2);
    expect(out[0].feeBps).toBeCloseTo(5, 6);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/core && npx vitest run src/decomposeRoute.test.ts -t buildFeeSinks`
Expected: FAIL — `buildFeeSinks` is not exported.

- [ ] **Step 3: Implement `buildFeeSinks` and the `FeeSinkOut` type in `decomposeRoute.ts`**

Add near the top of `packages/core/src/decomposeRoute.ts` (after the imports):

```ts
export interface FeeSinkOut {
  address: string;
  feeBps: number;
  source: string;
}

/**
 * Map the internal FeeSink[] to the persisted/output shape: dominant-first,
 * with aggFeeBps split across sinks proportionally to retained value. When the
 * total retained value is zero (e.g. vault_map sinks with no measured USDC),
 * split evenly. Pure — no RPC.
 */
export function buildFeeSinks(sinks: FeeSink[], aggFeeBps: number): FeeSinkOut[] {
  if (sinks.length === 0) return [];
  const sorted = [...sinks].sort((a, b) => b.totalUsdc - a.totalUsdc);
  const totalRetained = sorted.reduce((a, s) => a + s.totalUsdc, 0);
  return sorted.map((s) => ({
    address: s.address,
    feeBps: totalRetained > 0 ? aggFeeBps * (s.totalUsdc / totalRetained) : aggFeeBps / sorted.length,
    source: s.source,
  }));
}
```

Ensure `FeeSink` is imported in `decomposeRoute.ts`. It is re-exported from `tradeFees.js`; if not already imported here, add:
```ts
import type { FeeSink } from './tradeFees.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/core && npx vitest run src/decomposeRoute.test.ts -t buildFeeSinks`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire `feeSinks` into the `decomposeRoute` result**

In the result interface (~line 80-89), add after `feeSinkSource`:
```ts
  /** All detected fee sinks, dominant-first, each with its proportional share of aggFeeBps. Empty when none. */
  feeSinks: FeeSinkOut[];
```

Compute it once next to the dominant-sink block (~line 361-368), after `const feeSinkSource = ...`:
```ts
  const feeSinks = buildFeeSinks(base.feeSinks, base.aggFeeBps);
```

Add `feeSinks,` to BOTH return sites (the reconstructed return ~line 685 and the `!reconstructed` return ~line 723), alongside the existing `feeRecipient,` / `feeSinkSource,`.

- [ ] **Step 6: Plumb `feeSinks` through `analyzeTransaction`**

In `packages/core/src/analyzeTransaction.ts`:
- Import the type at the top (with the other `decomposeRoute` imports):
  ```ts
  import { ..., type FeeSinkOut } from './decomposeRoute.js';
  ```
  (If `decomposeRoute` is imported by relative path already, add `FeeSinkOut` to that import; otherwise add a new `import type { FeeSinkOut } from './decomposeRoute.js';`.)
- In the `Receipt` type (~line 160, after `feeSinkSource`):
  ```ts
  feeSinks: FeeSinkOut[];
  ```
- In the output object (~line 422, after `feeSinkSource: route.feeSinkSource,`):
  ```ts
  feeSinks: route.feeSinks,
  ```

- [ ] **Step 7: Build core + run the core suite**

Run: `cd packages/core && npx tsc --build && npx vitest run`
Expected: PASS (all core tests green; new `buildFeeSinks` tests included). Do NOT run `next build`.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/decomposeRoute.ts packages/core/src/decomposeRoute.test.ts packages/core/src/analyzeTransaction.ts
git commit -m "feat(core): surface full feeSinks[] with per-sink bps from decomposeRoute

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JBiQiG6uBGhpg1eJMAtnZ5"
```

---

### Task 2: Core — contract-name resolver + fee-sink enrichment

**Files:**
- Create: `packages/core/src/contractNames.ts`
- Create: `packages/core/src/contractNames.json` (seed `{}`)
- Modify: `packages/core/src/index.ts` (export the resolver)
- Test: `packages/core/src/contractNames.test.ts`

**Interfaces:**
- Consumes: `FeeSinkOut` from Task 1 (`{ address, feeBps, source }`).
- Produces:
  ```ts
  export interface FeeSinkNamed { address: string; feeBps: number; source: string; name: string | null }
  export function resolveContractName(address: string, deps?: NameResolverDeps): Promise<string | null>
  export function enrichFeeSinkNames(sinks: FeeSinkOut[], deps?: NameResolverDeps): Promise<FeeSinkNamed[]>
  export interface NameResolverDeps { fetchImpl?: typeof fetch; apiKey?: string | undefined; cache?: Record<string, string | null> }
  ```
  `resolveContractName` returns the verified `ContractName` (non-empty) or `null`. `enrichFeeSinkNames` maps each sink to add `name`, preserving order.

- [ ] **Step 1: Write the failing tests**

`packages/core/src/contractNames.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { resolveContractName, enrichFeeSinkNames } from './contractNames.js';

const okResp = (name: string) => ({
  ok: true,
  json: async () => ({ status: '1', message: 'OK', result: [{ ContractName: name }] }),
});

describe('resolveContractName', () => {
  it('returns the verified ContractName', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResp('AugustusFeeVault')) as unknown as typeof fetch;
    const cache: Record<string, string | null> = {};
    const name = await resolveContractName('0xAbC', { fetchImpl, apiKey: 'k', cache });
    expect(name).toBe('AugustusFeeVault');
    expect(cache['0xabc']).toBe('AugustusFeeVault');
  });

  it('returns null for empty ContractName and negative-caches it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResp('')) as unknown as typeof fetch;
    const cache: Record<string, string | null> = {};
    const name = await resolveContractName('0xDEF', { fetchImpl, apiKey: 'k', cache });
    expect(name).toBeNull();
    expect(cache['0xdef']).toBeNull();
  });

  it('uses the cache without fetching', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const cache = { '0xabc': 'Cached' };
    const name = await resolveContractName('0xABC', { fetchImpl, apiKey: 'k', cache });
    expect(name).toBe('Cached');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns null (no throw) when no api key', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const name = await resolveContractName('0x1', { fetchImpl, apiKey: undefined, cache: {} });
    expect(name).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns null (no throw) when fetch rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network')) as unknown as typeof fetch;
    const name = await resolveContractName('0x2', { fetchImpl, apiKey: 'k', cache: {} });
    expect(name).toBeNull();
  });
});

describe('enrichFeeSinkNames', () => {
  it('adds names preserving order and shape', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(okResp('Vault'))
      .mockResolvedValueOnce(okResp('')) as unknown as typeof fetch;
    const out = await enrichFeeSinkNames(
      [{ address: '0xA', feeBps: 10, source: 'retained_balance' }, { address: '0xB', feeBps: 5, source: 'retained_balance' }],
      { fetchImpl, apiKey: 'k', cache: {} },
    );
    expect(out).toEqual([
      { address: '0xA', feeBps: 10, source: 'retained_balance', name: 'Vault' },
      { address: '0xB', feeBps: 5, source: 'retained_balance', name: null },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx vitest run src/contractNames.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Seed the cache file**

Create `packages/core/src/contractNames.json` with exactly:
```json
{}
```

- [ ] **Step 4: Implement the resolver**

Create `packages/core/src/contractNames.ts`:
```ts
/**
 * contractNames — resolve a contract address to its verified Basescan
 * ContractName via the FREE Etherscan V2 getsourcecode API (chainid 8453).
 *
 * NEVER called inside analyzeTransaction/decomposeRoute (core analysis stays
 * RPC-pure). Invoked only in the persist path (dashboard API route +
 * repopulation script). Fails closed: no key / network / parse error → null.
 *
 * `MANUAL_OVERRIDES` is the last-resort curated map — starts empty; add an
 * entry only when the free API can't produce an acceptable name.
 */
import type { FeeSinkOut } from './decomposeRoute.js';
import cacheSeed from './contractNames.json' assert { type: 'json' };

export interface FeeSinkNamed { address: string; feeBps: number; source: string; name: string | null }

export interface NameResolverDeps {
  fetchImpl?: typeof fetch;
  apiKey?: string | undefined;
  /** address(lowercased) → name-or-null. Persists across calls within a process. */
  cache?: Record<string, string | null>;
}

// Curated last resort. Empty by design — see spec. Keyed by lowercased address.
const MANUAL_OVERRIDES: Record<string, string> = {};

// Process-lifetime cache, seeded from the committed JSON.
const processCache: Record<string, string | null> = { ...(cacheSeed as Record<string, string | null>) };

const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';
const BASE_CHAIN_ID = 8453;

export async function resolveContractName(address: string, deps: NameResolverDeps = {}): Promise<string | null> {
  const key = address.toLowerCase();
  const override = MANUAL_OVERRIDES[key];
  if (override) return override;

  const cache = deps.cache ?? processCache;
  if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];

  const apiKey = deps.apiKey ?? process.env.ETHERSCAN_API_KEY;
  const fetchImpl = deps.fetchImpl ?? fetch;
  if (!apiKey) return null;

  try {
    const url = `${ETHERSCAN_V2}?chainid=${BASE_CHAIN_ID}&module=contract&action=getsourcecode&address=${key}&apikey=${apiKey}`;
    const resp = await fetchImpl(url);
    if (!resp.ok) { cache[key] = null; return null; }
    const json = (await resp.json()) as { result?: Array<{ ContractName?: string }> };
    const raw = json?.result?.[0]?.ContractName ?? '';
    const name = raw.trim() === '' ? null : raw.trim();
    cache[key] = name;
    return name;
  } catch {
    return null; // fail closed; do NOT poison the cache on transient errors
  }
}

export async function enrichFeeSinkNames(sinks: FeeSinkOut[], deps: NameResolverDeps = {}): Promise<FeeSinkNamed[]> {
  const out: FeeSinkNamed[] = [];
  for (const s of sinks) {
    const name = await resolveContractName(s.address, deps);
    out.push({ address: s.address, feeBps: s.feeBps, source: s.source, name });
  }
  return out;
}
```

- [ ] **Step 5: Export from the core barrel**

In `packages/core/src/index.ts`, add:
```ts
export { resolveContractName, enrichFeeSinkNames, type FeeSinkNamed, type NameResolverDeps } from './contractNames.js';
export { buildFeeSinks, type FeeSinkOut } from './decomposeRoute.js';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/core && npx tsc --build && npx vitest run src/contractNames.test.ts`
Expected: PASS (6 tests). If `tsc` complains about the JSON import assertion, confirm `resolveJsonModule` is on in `tsconfig.base.json`; the `assert { type: 'json' }` syntax matches Node 20 ESM.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/contractNames.ts packages/core/src/contractNames.json packages/core/src/contractNames.test.ts packages/core/src/index.ts
git commit -m "feat(core): free-API contract-name resolver + fee-sink enrichment (fail-closed, cached)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JBiQiG6uBGhpg1eJMAtnZ5"
```

---

### Task 3: DB — `fee_sinks` JSONB column + migration

**Files:**
- Modify: `packages/db/src/schema.ts` (after `feeSinkSource`, ~line 79)
- Create: a Drizzle migration (generated)

**Interfaces:**
- Produces: `receipts.feeSinks` column, type `jsonb`, nullable. Row select type gains `feeSinks: FeeSinkNamed[] | null` (cast at the read boundary; Drizzle infers `unknown`).

- [ ] **Step 1: Add the column to the schema**

In `packages/db/src/schema.ts`, immediately after `feeSinkSource: text('fee_sink_source'),`:
```ts
    // Full dominant-first fee-sink array: [{ address, feeBps, source, name }].
    // `feeRecipient`/`feeSinkSource` above mirror feeSinks[0] for back-compat.
    feeSinks: jsonb('fee_sinks').$type<{ address: string; feeBps: number; source: string; name: string | null }[]>(),
```
Confirm `jsonb` is imported at the top of `schema.ts` (it is already used by `routeLegs`).

- [ ] **Step 2: Generate the migration**

Run: `npx drizzle-kit generate`
Expected: a new SQL file under the migrations dir adding `fee_sinks jsonb`. Inspect it — it should be a single additive `ALTER TABLE ... ADD COLUMN "fee_sinks" jsonb;` with no destructive statements.

- [ ] **Step 3: Apply the migration**

Run:
```bash
set -a && source .env && set +a && npx drizzle-kit migrate
```
Expected: migration applied, no errors. Verify:
```bash
set -a && source .env && set +a && node --input-type=module -e '
import { readFileSync } from "node:fs";
const env = readFileSync("./.env","utf8"); for (const l of env.split("\n")){const m=l.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/); if(m) process.env[m[1]]=m[2];}
const { createDb, schema } = await import("@fabric-tca/db");
const db = createDb(process.env.TCA_DATABASE_URL);
const r = await db.select().from(schema.receipts).limit(1);
console.log("feeSinks present:", Object.prototype.hasOwnProperty.call(r[0], "feeSinks"));
process.exit(0);'
```
Expected: `feeSinks present: true`.

- [ ] **Step 4: Build db + commit**

```bash
cd packages/db && npx tsc --build && cd ../..
git add packages/db/src/schema.ts drizzle
git commit -m "feat(db): add receipts.fee_sinks jsonb column

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JBiQiG6uBGhpg1eJMAtnZ5"
```
(Adjust the migration dir path in `git add` if `drizzle-kit` writes elsewhere — check `drizzle.config.ts` `out`.)

---

### Task 4: Persist path — enrich & write `feeSinks` (API route + repopulate script)

**Files:**
- Modify: `packages/dashboard/app/api/receipts/route.ts` (~line 103, after `analyzeTransaction`, and the insert/values object)
- Modify: `scripts/repopulateReceipts.mjs` (`toUpdate` ~line 34, the loop ~line 69-81)

**Interfaces:**
- Consumes: `analyzeTransaction` result's `feeSinks: FeeSinkOut[]` (Task 1); `enrichFeeSinkNames` (Task 2).
- Produces: persisted `feeSinks: FeeSinkNamed[]` on new + repopulated rows.

- [ ] **Step 1: Enrich in the API route's `toNewReceipt` mapper**

The route persists via `toNewReceipt(r: Receipt): NewReceipt` (declared line 23; the object maps the core receipt → DB insert shape, including `feeRecipient: r.feeRecipient` / `feeSinkSource: r.feeSinkSource`), then `insertReceipt(toNewReceipt(receipt))` at line 109.

In `packages/dashboard/app/api/receipts/route.ts`:
- Add `enrichFeeSinkNames` to the core import (line 2):
  ```ts
  import { analyzeTransaction, enrichFeeSinkNames, type Receipt } from '@fabric-tca/core';
  ```
- Make `toNewReceipt` async (line 23):
  ```ts
  async function toNewReceipt(r: Receipt): Promise<NewReceipt> {
  ```
- Inside the returned object, next to `feeSinkSource: r.feeSinkSource,` (line 59), add:
  ```ts
    feeSinks: await enrichFeeSinkNames(r.feeSinks),
  ```
- Update the call site (line 109):
  ```ts
  const inserted = await insertReceipt(await toNewReceipt(receipt));
  ```
- `NewReceipt` is `typeof schema.receipts.$inferInsert` (via `lib/queries.js`); once Task 3's column exists, `feeSinks` is a valid insert field.

- [ ] **Step 2: Enrich in the repopulation script**

In `scripts/repopulateReceipts.mjs`:
- Add to the core dynamic import (line 13 area). The script already does:
  ```js
  const { analyzeTransaction } = await import(new URL('../packages/core/dist/analyzeTransaction.js', import.meta.url));
  ```
  Add below it:
  ```js
  const { enrichFeeSinkNames } = await import(new URL('../packages/core/dist/contractNames.js', import.meta.url));
  ```
- Change `toUpdate(r)` to accept enriched sinks: signature `function toUpdate(r, feeSinks)` and add inside the returned object, next to `feeRecipient: r.feeRecipient, feeSinkSource: r.feeSinkSource,`:
  ```js
  feeSinks,
  ```
- In the loop (after the `if (!r) ...` guard, before `const upd = toUpdate(r);`):
  ```js
  const feeSinks = await enrichFeeSinkNames(r.feeSinks);
  const upd = toUpdate(r, feeSinks);
  ```
- Add a fee-sink line to the per-row report so the diff is visible. After the existing `console.log(... tag)` line (~line 78), add:
  ```js
  if (feeSinks.length) {
    const summary = feeSinks.map((s, i) => `${i === 0 ? (s.name ?? '[generic]') : s.address.slice(0, 6) + '…' + s.address.slice(-4)}=${s.feeBps.toFixed(2)}bps`).join(', ');
    console.log(`         feeSinks: ${summary}`);
  }
  ```

- [ ] **Step 3: Build core (so dist has contractNames.js) and typecheck the route**

Run: `cd packages/core && npx tsc --build && cd ../.. && cd packages/dashboard && npx tsc --noEmit && cd ../..`
Expected: no type errors. (`contractNames.js` must exist in `packages/core/dist/` for the script's dynamic import.)

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/app/api/receipts/route.ts scripts/repopulateReceipts.mjs
git commit -m "feat(persist): enrich + persist feeSinks names in API route and repopulate script

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JBiQiG6uBGhpg1eJMAtnZ5"
```

---

### Task 5: Dashboard — `getAggregatorFeeLines` builder (replaces `getAggregatorFeeAttribution`)

**Files:**
- Modify: `packages/dashboard/components/receipt/receiptDisplay.tsx` (replace `getAggregatorFeeAttribution` ~line 382-408, and its helper `aggregatorFeeLabel` if now unused; delete the `vaults` map)
- Test: `packages/dashboard/components/receipt/receiptDisplay.test.ts` (create if absent)

**Interfaces:**
- Consumes: a row with `{ aggregator: string; aggFeeBps: string | number | null; feeRecipient?: string | null; feeSinks?: FeeSinkNamed[] | null }`.
- Produces:
  ```ts
  export interface FeeLine { label: string; href?: string; bps: number }
  export function getAggregatorFeeLines(row): FeeLine[]
  ```
  One line per sink. `href` = `https://basescan.org/address/{address}`. Sink 0 label = `name || genericLabel`; sinks 1+ label = `shortTxHash(address)`. `genericLabel` = `"Integrator Fee"` when aggregator is `fabric` (and fee ≠ 0), else `"${formatProvider(aggregator)} Fee"`. Legacy fallback: when `feeSinks` is empty/absent but `feeRecipient` set, synth one sink `{ address: feeRecipient, feeBps: Number(aggFeeBps ?? 0), name: null }`. When neither present but `aggFeeBps ≠ 0`, one line `{ label: genericLabel, bps: aggFeeBps }` (no href). Returns `[]` when `aggFeeBps` is null/0.

- [ ] **Step 1: Write the failing tests**

`packages/dashboard/components/receipt/receiptDisplay.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { getAggregatorFeeLines } from './receiptDisplay';

const BASE = 'https://basescan.org/address/';

describe('getAggregatorFeeLines', () => {
  it('single named sink uses the verbatim name', () => {
    const lines = getAggregatorFeeLines({
      aggregator: 'Velora', aggFeeBps: 93.5, feeRecipient: '0x0847',
      feeSinks: [{ address: '0x0847', feeBps: 93.5, source: 'retained_balance', name: 'PoolFees' }],
    });
    expect(lines).toEqual([{ label: 'PoolFees', href: BASE + '0x0847', bps: 93.5 }]);
  });

  it('single unnamed sink falls back to generic [Aggregator] Fee', () => {
    const lines = getAggregatorFeeLines({
      aggregator: 'Nordstern', aggFeeBps: 19.02, feeRecipient: '0x3dbe',
      feeSinks: [{ address: '0x3dbe', feeBps: 19.02, source: 'retained_balance', name: null }],
    });
    expect(lines).toEqual([{ label: 'Nordstern Fee', href: BASE + '0x3dbe', bps: 19.02 }]);
  });

  it('multiple sinks: first follows the flow, rest are truncated addresses', () => {
    const lines = getAggregatorFeeLines({
      aggregator: 'Nordstern', aggFeeBps: 22,
      feeSinks: [
        { address: '0x3dbe077e7986657e95e1cc50089f17a5a4af0aae', feeBps: 19.02, source: 'retained_balance', name: null },
        { address: '0x5f6900000000000000000000000000000000d431', feeBps: 2.98, source: 'retained_balance', name: 'Vault' },
      ],
    });
    expect(lines[0].label).toBe('Nordstern Fee');
    expect(lines[1].label).toBe('0x5f69…d431'); // truncated, even though it has a name
    expect(lines[1].href).toBe(BASE + '0x5f6900000000000000000000000000000000d431');
  });

  it('fabric with a fee keeps the Integrator Fee label', () => {
    const lines = getAggregatorFeeLines({
      aggregator: 'fabric', aggFeeBps: 80.6, feeRecipient: '0x4035',
      feeSinks: [{ address: '0x4035', feeBps: 80.6, source: 'retained_balance', name: null }],
    });
    expect(lines[0].label).toBe('Integrator Fee');
  });

  it('legacy row (no feeSinks) falls back to feeRecipient link', () => {
    const lines = getAggregatorFeeLines({ aggregator: 'KyberSwap', aggFeeBps: 1.95, feeRecipient: '0x7d94' });
    expect(lines).toEqual([{ label: 'KyberSwap Fee', href: BASE + '0x7d94', bps: 1.95 }]);
  });

  it('returns [] when there is no fee', () => {
    expect(getAggregatorFeeLines({ aggregator: '0x', aggFeeBps: 0 })).toEqual([]);
    expect(getAggregatorFeeLines({ aggregator: '0x', aggFeeBps: null })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/dashboard && npx vitest run components/receipt/receiptDisplay.test.ts`
Expected: FAIL — `getAggregatorFeeLines` is not exported.

- [ ] **Step 3: Implement the builder; delete the curated map**

In `packages/dashboard/components/receipt/receiptDisplay.tsx`:
- Add the import for the truncation helper if not present:
  ```ts
  import { formatProvider, shortTxHash } from '../../lib/formatters';
  ```
  (`formatProvider` is already imported at line 14 — add `shortTxHash` to that import.)
- Delete the `vaults` map and the `getAggregatorFeeAttribution` function (lines ~382-408). Keep `FABRIC_AGGREGATOR_SLUG`. `aggregatorFeeLabel` can be removed if no other caller remains (grep first: `grep -rn aggregatorFeeLabel packages/dashboard`).
- Add:
```ts
export interface FeeLine { label: string; href?: string; bps: number }

interface FeeSinkNamed { address: string; feeBps: number; source: string; name: string | null }

function genericFeeLabel(aggregator: string): string {
  if (aggregator.toLowerCase() === FABRIC_AGGREGATOR_SLUG) return 'Integrator Fee';
  return `${formatProvider(aggregator.toLowerCase())} Fee`;
}

export function getAggregatorFeeLines(row: {
  aggregator: string;
  aggFeeBps: string | number | null;
  feeRecipient?: string | null;
  feeSinks?: FeeSinkNamed[] | null;
}): FeeLine[] {
  const totalBps = Number(row.aggFeeBps ?? 0);
  if (!Number.isFinite(totalBps) || totalBps === 0) return [];

  const sinks: FeeSinkNamed[] =
    row.feeSinks && row.feeSinks.length > 0
      ? row.feeSinks
      : row.feeRecipient
        ? [{ address: row.feeRecipient, feeBps: totalBps, source: 'retained_balance', name: null }]
        : [];

  if (sinks.length === 0) {
    // Fee detected but no recipient — show the generic label, unlinked.
    return [{ label: genericFeeLabel(row.aggregator), bps: totalBps }];
  }

  return sinks.map((s, i) => ({
    label: i === 0 ? (s.name ?? genericFeeLabel(row.aggregator)) : shortTxHash(s.address),
    href: `https://basescan.org/address/${s.address}`,
    bps: s.feeBps,
  }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/dashboard && npx vitest run components/receipt/receiptDisplay.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/components/receipt/receiptDisplay.tsx packages/dashboard/components/receipt/receiptDisplay.test.ts
git commit -m "feat(dashboard): per-sink aggregator fee lines (name/generic/truncated); drop curated vault map

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JBiQiG6uBGhpg1eJMAtnZ5"
```

---

### Task 6: Dashboard — render per-sink fee lines in `receiptView`

**Files:**
- Modify: `packages/dashboard/components/receiptView.tsx` (import ~line 15; `agg`/`hasAggFee`/`aggAttribution` ~line 88-90; render block ~line 297-310)
- Test: `packages/dashboard/components/receiptView.test.tsx` (add a rendering assertion)

**Interfaces:**
- Consumes: `getAggregatorFeeLines`, `FeeLine` (Task 5); `formatDialogBps` (existing, `receiptDisplay.tsx`).

- [ ] **Step 1: Write the failing test**

The test file builds rows by spreading a base object (e.g. `fullUsdcWethRow`, declared ~line 143) — there is no `makeRow` factory. Add this test, spreading that base and overriding the three fee fields:
```tsx
it('renders one aggregator fee line per sink: first named, rest truncated', () => {
  const row = {
    ...fullUsdcWethRow,
    aggregator: 'Nordstern',
    aggFeeBps: '22',
    feeRecipient: '0x3dbe077e7986657e95e1cc50089f17a5a4af0aae',
    feeSinks: [
      { address: '0x3dbe077e7986657e95e1cc50089f17a5a4af0aae', feeBps: 19.02, source: 'retained_balance', name: null },
      { address: '0x5f6900000000000000000000000000000000d431', feeBps: 2.98, source: 'retained_balance', name: null },
    ],
  };
  render(<ReceiptView row={row} />);
  expect(screen.getByText('Nordstern Fee')).toBeInTheDocument();
  expect(screen.getByText('0x5f69…d431')).toBeInTheDocument();
  const link = screen.getByText('Nordstern Fee').closest('a');
  expect(link).toHaveAttribute('href', 'https://basescan.org/address/0x3dbe077e7986657e95e1cc50089f17a5a4af0aae');
});
```
(Use the base row's actual identifier if it differs from `fullUsdcWethRow`; match how the surrounding tests render `ReceiptView`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/dashboard && npx vitest run components/receiptView.test.tsx -t "one aggregator fee line per sink"`
Expected: FAIL (no truncated line yet — still single-row render).

- [ ] **Step 3: Update the render**

In `packages/dashboard/components/receiptView.tsx`:
- Change the import (line 15) from `getAggregatorFeeAttribution` to `getAggregatorFeeLines`.
- Replace lines ~88-90:
  ```ts
  const feeLines = getAggregatorFeeLines(row);
  const hasAggFee = feeLines.length > 0;
  ```
  (Remove the old `const agg = ...`, `const hasAggFee = ...`, `const aggAttribution = ...` lines.)
- Replace the render block (~297-310):
  ```tsx
  {hasAggFee ? (
    <>
      <BkdHeading label="Aggregator Fee" plain />
      {feeLines.map((line, i) => {
        const d = formatDialogBps(-line.bps);
        return (
          <BkdRow
            key={`${line.href ?? line.label}-${i}`}
            label={line.label}
            href={line.href}
            value={d.text}
            color={d.color}
            secondary
          />
        );
      })}
    </>
  ) : (
    <BkdHeading label="Aggregator Fee" value="0.00bps" plain />
  )}
  ```
- Ensure `formatDialogBps` is imported in `receiptView.tsx` (it's exported from `receipt/receiptDisplay.tsx`). Add to the existing import from that module if not already present.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/dashboard && npx vitest run components/receiptView.test.tsx`
Expected: PASS (new test + existing receiptView tests green). If an existing test asserted the old single "Aggregator Fee" attribution label/href, update it to the new per-sink shape.

- [ ] **Step 5: Run the full dashboard suite + lint**

Run: `cd packages/dashboard && npx vitest run && npx eslint . --max-warnings=0 ; cd ../..`
Expected: all green. Do NOT run `next build` (it clobbers a running dev server's `.next`).

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/components/receiptView.tsx packages/dashboard/components/receiptView.test.tsx
git commit -m "feat(dashboard): receiptView renders one linked fee line per sink

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JBiQiG6uBGhpg1eJMAtnZ5"
```

---

### Task 7: Repopulate all receipts + verify the change

**Files:** none (data + verification).

- [ ] **Step 1: Dry-run the repopulation on the target row first**

Run:
```bash
node scripts/repopulateReceipts.mjs --ids=53
```
Expected: dry-run output for id 53 shows a `feeSinks:` line `Nordstern Fee=… ` — confirm the first-sink label resolves to `[generic]` (name null → UI shows "Nordstern Fee") and the recipient is `0x3dbe…`. No write yet.

- [ ] **Step 2: Dry-run the full set (report only)**

Run (background — exceeds 5-min tool timeout):
```bash
node scripts/repopulateReceipts.mjs
```
Expected: per-row `feeSinks:` summaries for all fee-bearing rows; no errors; `WOULD WRITE`. Review the summaries — spot-check that the three ex-curated aggregators (Velora id 173/208/210, KyberSwap id 36/118/215, and any Relay) now attribute to their real recipients.

- [ ] **Step 3: Commit the repopulation for real**

Run (background):
```bash
node scripts/repopulateReceipts.mjs --commit
```
Expected: `WROTE: … rows`, `errors=0`. RPC must be reachable (`TCA_RPC_URL` exported via `.env` autoload in the script).

- [ ] **Step 4: Verify persisted `feeSinks` for id 53 and the ex-curated set**

Run:
```bash
set -a && source .env && set +a && node --input-type=module -e '
import { readFileSync } from "node:fs";
const env = readFileSync("./.env","utf8"); for (const l of env.split("\n")){const m=l.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/); if(m) process.env[m[1]]=m[2];}
const { createDb, schema } = await import("@fabric-tca/db");
const db = createDb(process.env.TCA_DATABASE_URL);
const rows = await db.select().from(schema.receipts);
for (const id of [53, 173, 118, 326]) {
  const r = rows.find(x => x.id === id);
  console.log(id, r?.aggregator, JSON.stringify(r?.feeSinks));
}
process.exit(0);'
```
Expected: id 53 → `[{ address: "0x3dbe…", name: null, ... }]`; id 173 (Velora) → recipient `0x0847…` name `"PoolFees"`; id 118 (KyberSwap) → real recipient, name null; id 326 (Nordstern) → `0x238a…` name `"Vault"`.

- [ ] **Step 5: Report what changed**

Summarize for the user: which receipts gained a Basescan link, which resolved a real contract name vs. a generic label, and confirm the three curated entries were successfully broken out (curated map is empty). No commit.

---

## Notes for the executor

- Run `npx tsc --build` in `packages/core` (and `packages/db`) after editing them so `dist/` is fresh — the dashboard imports built core, and the repopulation script imports `packages/core/dist/*.js` directly.
- Never run `next build` against a live dev server; use `npx tsc --noEmit` in the dashboard to typecheck.
- The repopulation full-set runs exceed the 5-minute foreground tool timeout — run them in the background.
- If `drizzle-kit generate` produces anything beyond the additive `ADD COLUMN`, stop and inspect before applying.
