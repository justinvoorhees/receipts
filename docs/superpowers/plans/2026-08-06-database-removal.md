# Database Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the database. Receipts become ephemeral — every view recomputes from RPC — and the only thing the service writes is log lines.

**Architecture:** `lib/loadReceipt.ts` already exists as the seam between the route and the data layer; its body swaps from a database read to an `analyzeTransaction` call. The UI drops `ReceiptRow` (a lossy projection of core's `Receipt` with string numerics) and consumes `Receipt` directly. `/trades`, `/api/receipts`, and the entire login stack are deleted; a dev-only `/qa/tx/<chain>/<hashes>` replaces the comparison table.

**Tech Stack:** Next.js 15 App Router, TypeScript, vitest, viem. Postgres/Drizzle are being removed.

**Spec:** `docs/superpowers/specs/2026-08-06-database-removal-design.md`

## Global Constraints

- **Indentation is TABS** throughout this codebase. Match it.
- **`npm test` does NOT typecheck.** Every task's verification runs both `npx vitest run <path>` and `npx tsc --build`.
- **Lint is the Railway deploy gate.** Run `npm run lint` before every commit.
- **Never run `npm run build` while a dev server is up** — it writes into the same `.next` the dev server owns and the app renders unstyled. See `docs/superpowers/specs/` history and the detached-worktree recipe if a real build is needed.
- **Commit messages end with:**
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  ```
- **Task 1 must run while the database is still alive.** It is the only task that reads Postgres, and there is no second attempt after the Railway instance is deleted.
- **Do not delete the Railway Postgres instance** as part of this plan. That is a manual action for the user after Task 12 passes.
- **This plan assumes multichain Tasks 4–6 have landed** (`2465c00`, `8483458`, `c53b94a`). `/tx/[chain]/[hash]/page.tsx` exists, the index is search-only, and `receiptSearch.tsx` already navigates via `receiptPath(DEFAULT_CHAIN, …)`.
- **Files in `packages/dashboard/components/` may be under concurrent edit.** Re-read a file immediately before editing it; do not trust line numbers quoted here as anchors.

## File Structure

**Created:**
| File | Responsibility |
|---|---|
| `scripts/freezeCorpus.mjs` | One-time dump of `receipts` to static JSON |
| `docs/qa/corpus.json` | The frozen 62-receipt corpus |
| `scripts/corpus.test.mjs` | Asserts the corpus invariants |
| `packages/dashboard/lib/legRouterEnrichment.ts` | Per-leg router resolution (moved out of `queries.ts`) |
| `packages/dashboard/lib/receiptModel.ts` | `ReceiptModel` — the one receipt type the UI consumes |
| `packages/dashboard/app/qa/tx/[chain]/[hashes]/page.tsx` | Dev-only comparison table |
| `packages/dashboard/lib/log.ts` | Levelled JSON logger |

**Deleted:** `packages/db/`, `drizzle.config.ts`, `packages/dashboard/lib/{db,queries,pagination,auth,accessDecision}.ts`, `packages/dashboard/middleware.ts`, `packages/dashboard/app/{trades,api}/`, `packages/dashboard/components/{tradesTable,loginForm}.tsx`, and every corresponding test.

---

## Task 1: Freeze the corpus

**This task must run first and must run against the live database.**

**Files:**
- Create: `scripts/freezeCorpus.mjs`
- Create: `docs/qa/corpus.json` (generated)
- Create: `scripts/corpus.test.mjs`

**Interfaces:**
- Produces: `docs/qa/corpus.json` — a JSON array of raw Postgres rows in **snake_case** with `numeric` columns as **strings**, exactly as `postgres` returns them. Task 2 depends on this shape.

- [ ] **Step 1: Write the freeze script**

Create `scripts/freezeCorpus.mjs`:

```js
/**
 * freezeCorpus.mjs — one-time dump of the receipts table to a static JSON corpus.
 *
 * Run this ONCE, while the database still exists. After the database is gone
 * this file cannot be regenerated, and docs/qa/corpus.json is the only surviving
 * record of the analyzed history.
 *
 * Rows below $5 are dropped: they are dust trades whose bps figures are
 * dominated by rounding and gas, and they distort every aggregate the analysis
 * scripts compute. `notional_usd >= 5` also excludes NULLs by SQL's own rules
 * (NULL >= 5 is NULL, not true) — measured at zero such rows, but the behaviour
 * is stated here so a future reader does not have to rediscover it.
 *
 * Output is the raw postgres row shape: snake_case keys, `numeric` columns as
 * strings. That is deliberately identical to what the analysis scripts already
 * destructure, so retargeting them is a filter swap and not a rewrite.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { connect } from './analysis/_env.mjs';

const MIN_NOTIONAL_USD = 5;

const sql = await connect();
const rows = await sql`
	select * from receipts
	where notional_usd >= ${MIN_NOTIONAL_USD}
	order by id asc`;
await sql.end();

mkdirSync(new URL('../docs/qa/', import.meta.url), { recursive: true });
writeFileSync(
	new URL('../docs/qa/corpus.json', import.meta.url),
	`${JSON.stringify(rows, null, '\t')}\n`,
);

console.log(`froze ${rows.length} receipts (notional >= $${MIN_NOTIONAL_USD})`);
```

- [ ] **Step 2: Run it**

```bash
node scripts/freezeCorpus.mjs
```

Expected: `froze 62 receipts (notional >= $5)`

If the count is not 62, **stop and report it**. The table was measured at 83 rows / 21 under $5 on 2026-08-06; a different number means the table changed and the spec's figures need restating before proceeding.

- [ ] **Step 3: Write the corpus test**

Create `scripts/corpus.test.mjs`:

```js
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const corpus = JSON.parse(
	readFileSync(new URL('../docs/qa/corpus.json', import.meta.url), 'utf8'),
);

describe('the frozen QA corpus', () => {
	it('is not empty', () => {
		expect(corpus.length).toBeGreaterThan(0);
	});

	// The $5 floor is the whole reason this file is a curated corpus rather than
	// a table dump. A dust trade's bps figures are dominated by rounding and gas,
	// so one slipping back in would quietly skew every aggregate downstream.
	it('contains no receipt under $5', () => {
		const under = corpus.filter(
			(r) => r.notional_usd == null || Number(r.notional_usd) < 5,
		);
		expect(under.map((r) => r.tx_hash)).toEqual([]);
	});

	// Task 2's scripts destructure these by name. If the freeze ever changes
	// shape, this fails here rather than as a wall of NaN in an analysis run.
	it('preserves the raw snake_case postgres shape', () => {
		expect(corpus[0]).toHaveProperty('tx_hash');
		expect(corpus[0]).toHaveProperty('notional_usd');
		expect(corpus[0]).toHaveProperty('route_legs');
	});
});
```

- [ ] **Step 4: Run the test**

```bash
npx vitest run scripts/corpus.test.mjs
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add scripts/freezeCorpus.mjs scripts/corpus.test.mjs docs/qa/corpus.json
git commit -m "$(cat <<'EOF'
feat(qa): freeze the receipt corpus to static JSON

83 rows in, 62 out — everything under $5 dropped. This is the last read
of the database that will ever happen, so the file is the record now.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Retarget the analysis scripts

**Files:**
- Modify: `scripts/analysis/_env.mjs`
- Modify: all 8 of `scripts/analysis/{attributionCoverage,blastRadius,coverageEstimate,preTxRulerError,reconResidual,referencePoolInRoute,rpcProviderAB,unpricedCauses}.mjs`

**Interfaces:**
- Consumes: `docs/qa/corpus.json` from Task 1.
- Produces: `loadCorpus(): object[]` exported from `scripts/analysis/_env.mjs`. `connect()` no longer exists.

- [ ] **Step 1: Replace `connect()` with `loadCorpus()` in `_env.mjs`**

In `scripts/analysis/_env.mjs`, delete the `connect` export:

```js
export async function connect() {
	const { default: postgres } = await import('postgres');
	return postgres(env.TCA_DATABASE_URL, { ssl: 'require', max: 1 });
}
```

and replace it with:

```js
/**
 * The frozen receipt corpus (docs/qa/corpus.json), in the raw postgres row
 * shape: snake_case keys, `numeric` columns as strings. Identical to what
 * `connect()` used to hand back, so callers destructure exactly as before.
 *
 * Already ordered by id, so a `.filter()` preserves the old `order by id`.
 *
 * This is a FROZEN file, not a live table. It cannot tell you whether today's
 * code disagrees with today's chain — only whether today's code disagrees with
 * the code that produced this snapshot.
 */
export function loadCorpus() {
	return JSON.parse(
		readFileSync(new URL('../../docs/qa/corpus.json', import.meta.url), 'utf8'),
	);
}
```

`readFileSync` is already imported at the top of the file.

- [ ] **Step 2: Retarget each script**

In each script, delete its `const sql = await connect();` line and any `await sql.end();`, and replace its query expression with the filter below. Every script keeps its existing `import { … } from './_env.mjs'` line — swap `connect` for `loadCorpus` in the named imports.

| Script | Old query | New expression |
|---|---|---|
| `attributionCoverage.mjs` | `` await sql`… from receipts where route_legs is not null order by id` `` | `loadCorpus().filter((r) => r.route_legs != null)` |
| `blastRadius.mjs` | `` await sql`… from receipts where route_legs is not null order by id` `` | `loadCorpus().filter((r) => r.route_legs != null)` |
| `reconResidual.mjs` | `` await sql`… from receipts where route_legs is not null order by id` `` | `loadCorpus().filter((r) => r.route_legs != null)` |
| `unpricedCauses.mjs` | `` await sql`… from receipts where route_legs is not null order by id` `` | `loadCorpus().filter((r) => r.route_legs != null)` |
| `referencePoolInRoute.mjs` | `` await sql`… where route_legs is not null and block_number is not null` `` | `loadCorpus().filter((r) => r.route_legs != null && r.block_number != null)` |
| `coverageEstimate.mjs` | `` await sql`… from receipts order by id` `` | `loadCorpus()` |
| `preTxRulerError.mjs` | `` await sql`select tx_hash, block_number, slippage_bps from receipts` `` | `loadCorpus()` |
| `rpcProviderAB.mjs` | `` await sql`… from receipts order by id asc` `` | `loadCorpus()` |

The narrower `select` lists are not reproduced — `loadCorpus()` returns every column and the scripts read the ones they name.

- [ ] **Step 3: Restate the baselines in the script headers**

Three scripts quote baselines measured against a different row set. They now describe a corpus that no longer exists and would mislead a future reader into thinking a number moved when only the denominator did. Update each header comment:

- `blastRadius.mjs:18` — `Baseline 2026-07-30: 4 receipts / $2,913 can move…`
- `attributionCoverage.mjs:19-20` — `Baseline at 2026-07-30 (62 receipts): LP fee 76.6%, price impact 83.5%…`

Append to each: `Superseded 2026-08-06 — re-measure against the frozen 62-receipt corpus (docs/qa/corpus.json); the old figures describe a 62-row set that is NOT this one.`

- [ ] **Step 4: Verify every script still runs**

```bash
npm run build --workspace packages/core 2>/dev/null || npx tsc --build
for s in attributionCoverage blastRadius coverageEstimate preTxRulerError reconResidual referencePoolInRoute unpricedCauses; do
  echo "--- $s"; node scripts/analysis/$s.mjs >/dev/null && echo OK || echo FAIL;
done
```

Expected: seven `OK`. `rpcProviderAB.mjs` is excluded — it makes live RPC calls against two providers and is slow; run it manually only if two provider URLs are configured.

- [ ] **Step 5: Confirm no script still imports postgres**

```bash
grep -rn "connect()\|postgres\|TCA_DATABASE_URL" scripts/
```

Expected: no matches outside `scripts/freezeCorpus.mjs` (which is now historical and intentionally retains its import).

- [ ] **Step 6: Commit**

```bash
npm run lint && git add scripts/
git commit -m "$(cat <<'EOF'
refactor(qa): point the analysis scripts at the frozen corpus

Every query was `select … from receipts order by id` — a corpus read, not
a database one. The SQL becomes an array filter and the baselines in the
headers are marked superseded, since they describe a different 62 rows.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Delete `/trades` and the DELETE endpoint

Done before the retype in Task 5, because `tradesTable.tsx` sorts on string numerics and would have to be migrated only to be deleted.

**Files:**
- Delete: `packages/dashboard/app/trades/page.tsx`, `packages/dashboard/app/trades/page.test.tsx`
- Delete: `packages/dashboard/components/tradesTable.tsx`, `packages/dashboard/components/tradesTable.test.tsx`
- Delete: `packages/dashboard/lib/pagination.ts`, `packages/dashboard/lib/pagination.test.ts`
- Modify: `packages/dashboard/app/api/receipts/route.ts` — remove the `DELETE` handler
- Modify: `packages/dashboard/lib/queries.ts` — remove `deleteReceipt`, `listReceipts`, `countReceipts`, `TRADES_SORT_COLUMN_KEYS`, `TRADES_SORT_COLUMNS`, `TradesSortColumn`, `TradesSort`, `SortDirection`
- Modify: `packages/dashboard/components/header.tsx` — remove any `/trades` link

- [ ] **Step 1: Delete the files**

```bash
git rm packages/dashboard/app/trades/page.tsx \
       packages/dashboard/app/trades/page.test.tsx \
       packages/dashboard/components/tradesTable.tsx \
       packages/dashboard/components/tradesTable.test.tsx \
       packages/dashboard/lib/pagination.ts \
       packages/dashboard/lib/pagination.test.ts
```

- [ ] **Step 2: Remove the DELETE handler**

In `packages/dashboard/app/api/receipts/route.ts`, delete the entire `export async function DELETE(...)` block and the `sessionTokenFrom` helper above it (its only caller). Also drop `deleteReceipt` from the `../../../lib/queries.js` import and `SESSION_COOKIE, verifySession` from the `../../../lib/auth` import.

- [ ] **Step 3: Remove the now-unreferenced query exports**

In `packages/dashboard/lib/queries.ts`, delete `listReceipts`, `countReceipts`, `deleteReceipt`, and the whole `TRADES_SORT_*` / `TradesSort` / `SortDirection` block at the foot of the file. Keep `getReceiptByHash`, `insertReceipt`, `enrichLegRouters`, `RouteLeg`, `ReceiptRow`, `NewReceipt` — later tasks remove those.

- [ ] **Step 4: Remove the header link**

Re-read `packages/dashboard/components/header.tsx` and remove any `<Link href="/trades">`. If there is no such link, note that and move on.

- [ ] **Step 5: Verify**

```bash
grep -rn "/trades\|tradesTable\|listReceipts\|countReceipts\|deleteReceipt\|clampPagination" packages/dashboard --include='*.ts' --include='*.tsx' | grep -v node_modules | grep -v '\.next'
```

Expected: no matches. `scripts/smokeDeploy.mjs` still references `/trades` and `DELETE /api/receipts` — that is expected and is fixed in Task 12.

```bash
npx vitest run packages/dashboard && npx tsc --build && npm run lint
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add -A packages/dashboard
git commit -m "$(cat <<'EOF'
feat(trades): delete the history table and the DELETE endpoint

The table was a QA crutch; /qa replaces it. DELETE existed only to serve
its per-row control, so it goes with it — and it was the only destructive
endpoint in the app.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Move `enrichLegRouters` out of `queries.ts`

**Files:**
- Create: `packages/dashboard/lib/legRouterEnrichment.ts`
- Modify: `packages/dashboard/lib/legRouterEnrichment.test.ts` (already exists, currently imports from `./queries`)
- Modify: `packages/dashboard/lib/queries.ts` — remove `enrichLegRouters` and `RouteLeg`

**Interfaces:**
- Produces: `enrichLegRouters(legs: unknown[] | null, topLevelRouter: string | null, aggregator: string | null): RouteLeg[] | null` and `interface RouteLeg`, both from `lib/legRouterEnrichment.ts`.

The signature changes. Today it is `(row: ReceiptRow) => ReceiptRow` — it takes a whole row to reach one field and rebuilds the row to return it. Nothing about the logic needs a row; it needs the legs and the two values used to derive the top-level slug.

- [ ] **Step 1: Update the test to the new import and signature**

Re-read `packages/dashboard/lib/legRouterEnrichment.test.ts`. Change its import from `./queries` to `./legRouterEnrichment`, and change every call site from row-shaped to leg-shaped. A call that was:

```ts
const out = enrichLegRouters({ ...row, routeLegs: legs, routerAddress: '0xabc', aggregator: 'odos' });
expect((out.routeLegs as RouteLeg[])[0].router).toEqual(…);
```

becomes:

```ts
const out = enrichLegRouters(legs, '0xabc', 'odos');
expect(out![0].router).toEqual(…);
```

Add one test pinning the null passthrough, which the old row-shaped version expressed as "return the row unchanged":

```ts
it('returns null legs unchanged', () => {
	expect(enrichLegRouters(null, '0xabc', 'odos')).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run packages/dashboard/lib/legRouterEnrichment.test.ts
```

Expected: FAIL — `Failed to resolve import "./legRouterEnrichment"`.

- [ ] **Step 3: Create the module**

Create `packages/dashboard/lib/legRouterEnrichment.ts` by moving `RouteLeg` and `enrichLegRouters` verbatim out of `queries.ts`, with the signature change. Keep every existing comment — they document non-obvious decisions that are still true.

Move `interface RouteLeg` across **verbatim** — it currently sits at
`packages/dashboard/lib/queries.ts:65-99`. Cut and paste it rather than
retyping: two-thirds of it is comments recording why individual fields are
optional (`feeResolved` distinguishes an unreadable fee tier from a genuinely
free pool; `v4Emitter` is what a Basescan link must point at), and each one is
still true. Only the surrounding import line changes.

```ts
import { resolveAggregator, resolveLegRouter, type ResolvedLegRouter } from '@fabric-tca/core';

/** Per-leg shape produced by core's route decomposition. */
export interface RouteLeg {
	/* ← queries.ts:65-99, moved unchanged, comments included */
}

/**
 * Resolve each leg's `frameChain` into a named router, on read.
 *
 * Deliberately not done at analysis time: doing it here means adding an address
 * to configs/routers.json retroactively attributes every receipt, with no
 * repopulation. Runs server-side only — resolveLegRouter reads the registries
 * from disk and must never cross into a client bundle.
 *
 * Takes legs rather than a whole receipt. It only ever needed three values, and
 * a function that accepts a row is a function that cannot be called before a row
 * exists — which is precisely the situation once receipts stop being stored.
 */
export function enrichLegRouters(
	legs: unknown[] | null,
	topLevelRouter: string | null,
	aggregator: string | null,
): RouteLeg[] | null {
	if (!Array.isArray(legs)) return null;
	// Must resolve through the SAME registry snapshot that resolveLegRouter uses
	// for the leg side, not the label `aggregator` froze at analysis time. Those
	// two can diverge: an uncurated top-level address is recorded as its raw
	// lowercase string, but a later routers.json addition (or a rename) changes
	// what resolveAggregator returns for that same address today. If the top line
	// here stayed the stale label, the comparison in resolveLegRouter would stop
	// matching and a leg run by the SAME contract as the top line would get
	// wrongly tagged as a second aggregator the moment the registry grows —
	// turning a correct `null` into a false attribution.
	const topLevelSlug = topLevelRouter
		? resolveAggregator(topLevelRouter, []).slug
		: String(aggregator ?? '').toLowerCase();
	return (legs as RouteLeg[]).map((leg) => {
		const router = resolveLegRouter(leg.frameChain, topLevelSlug);
		return router ? { ...leg, router } : leg;
	});
}
```

- [ ] **Step 4: Remove both from `queries.ts` and fix its callers**

Delete `RouteLeg` and `enrichLegRouters` from `packages/dashboard/lib/queries.ts`. `getReceiptByHash` and `insertReceipt` currently apply `enrichLegRouters` to their return value — remove those calls; the enrichment now happens in `loadReceipt` (Task 6). `app/api/receipts/route.ts` imports `enrichLegRouters` from queries: point it at the new module and adapt the call to `enrichLegRouters(inserted.routeLegs, inserted.routerAddress, inserted.aggregator)`, assigning the result back onto the response object. This route is deleted in Task 9; the adaptation just keeps the tree compiling until then.

- [ ] **Step 5: Run the tests**

```bash
npx vitest run packages/dashboard && npx tsc --build && npm run lint
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add -A packages/dashboard
git commit -m "$(cat <<'EOF'
refactor(legs): give enrichLegRouters its own module and honest signature

It took a whole row to reach one field. It takes legs now, which is what
it always meant — and what it must take once there are no rows.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Delete `ReceiptRow`, adopt `ReceiptModel`

**Files:**
- Modify: `packages/core/src/receiptPure.ts` — re-export the `Receipt` type
- Create: `packages/dashboard/lib/receiptModel.ts`
- Modify: `packages/dashboard/components/receipt/{priceFormat.ts,qualityNotionals.ts,receiptDisplay.tsx,receiptRows.tsx}`
- Modify: `packages/dashboard/components/{receiptView.tsx,receiptView.test.tsx}`
- Modify: `packages/dashboard/lib/{loadReceipt.ts,alerts.ts}`

**Interfaces:**
- Produces: `ReceiptModel` from `lib/receiptModel.ts`. Every consumer that imported `type { ReceiptRow } from '../lib/queries'` imports `type { ReceiptModel } from '../lib/receiptModel'` instead.

This is a type-level change. **No runtime logic moves.** It is safe because the UI was already written to accept numbers — `receiptDisplay.tsx` declares `string | number | null` in four signatures, `priceFormat.ts` takes `unknown` in two, and every numeric read goes through `Number(x)`, which is identity on a number.

- [ ] **Step 1: Re-export `Receipt` from the pure leaf**

Add to the foot of `packages/core/src/receiptPure.ts`:

```ts
// Type-only re-export, erased at compile time — it adds no runtime edge from
// this leaf to the barrel. It lives here so the `'use client'` receipt tree can
// name the receipt type without importing from '@fabric-tca/core', which pulls
// analyzeTransaction → tagging → node:fs. A type-only import from the barrel
// would also erase, but the leaf-subpath rule is worth more without exceptions.
export type { Receipt } from './analyzeTransaction.js';
```

- [ ] **Step 2: Write the model**

Create `packages/dashboard/lib/receiptModel.ts`:

```ts
import type { FeeSinkNamed } from '@fabric-tca/core';
import type { Receipt } from '@fabric-tca/core/pure';
import type { RouteLeg } from './legRouterEnrichment';

/**
 * The one receipt shape the UI consumes.
 *
 * This is core's `Receipt` plus the two read-time enrichments applied in
 * loadReceipt: fee sinks gain a resolved `name`, legs gain a resolved `router`.
 *
 * It replaces `ReceiptRow`, which was a lossy projection of this same type —
 * the same fields, with `numeric` columns arriving as strings because Drizzle
 * returns them that way, plus id/createdAt/userId bookkeeping. With no database
 * there is no reason for numbers to travel as strings.
 */
export type ReceiptModel = Omit<Receipt, 'feeSinks' | 'routeLegs'> & {
	feeSinks: FeeSinkNamed[];
	routeLegs: RouteLeg[] | null;
};
```

- [ ] **Step 3: Update every consumer's import**

In each of these files, replace the `ReceiptRow` import and every `ReceiptRow` mention with `ReceiptModel`:

| File | Old import |
|---|---|
| `components/receipt/priceFormat.ts` | `import type { ReceiptRow } from '../../lib/queries';` |
| `components/receipt/qualityNotionals.ts` | `import type { ReceiptRow } from '../../lib/queries';` |
| `components/receipt/receiptDisplay.tsx` | find with `grep -n ReceiptRow` — under concurrent edit, so the line has moved |
| `components/receipt/receiptRows.tsx` | find with `grep -n ReceiptRow` — same |
| `components/receiptView.tsx` | `import type { ReceiptRow } from '../lib/queries';` |
| `lib/loadReceipt.ts` | `import { getReceiptByHash, type ReceiptRow } from './queries';` |

New form, with the path depth adjusted per file:

```ts
import type { ReceiptModel } from '../../lib/receiptModel';
```

- [ ] **Step 4: Widen the two string fields in `alerts.ts`**

In `packages/dashboard/lib/alerts.ts`, `ReceiptSummary` declares:

```ts
	notionalUsd: string | null;
	allInCostBps: string | null;
```

Change both to `number | null`. The two `Number(...)` calls in `receiptCreatedMessage` below them are already correct for either — leave them. Update the doc comment above the interface from `a ReceiptRow satisfies it` to `a ReceiptModel satisfies it`.

- [ ] **Step 5: Update the test fixtures to numbers**

In `packages/dashboard/components/receiptView.test.tsx`, every fixture numeric currently written as a string becomes a number: `notionalUsd: '1000'` → `notionalUsd: 1000`, `marketMid: '3421.5'` → `marketMid: 3421.5`, and so on for `realizedPrice`, `allInCostBps`, `inputAmount`, `outputAmount`, `lpFeeBps`, `aggFeeBps`, `slippageBps`, `gasCostUsd`, and the `marketMidBefore` / `marketMidAfter` pair.

**These assertions must keep passing unchanged.** That is what proves the retype is behaviour-neutral — if an expected output string moves, the migration broke something and the fix is in the code, not the expectation.

- [ ] **Step 6: Typecheck, and fix what the compiler finds**

```bash
npx tsc --build
```

Expected: clean. The compiler is the completion criterion for this task — any remaining `ReceiptRow` reference is a compile error naming its own file and line. Fix each by the same substitution and re-run until clean.

- [ ] **Step 7: Confirm `ReceiptRow` is gone from the UI**

```bash
grep -rn "ReceiptRow" packages/dashboard --include='*.ts' --include='*.tsx' | grep -v node_modules | grep -v '\.next'
```

Expected: matches only in `lib/queries.ts` (the type is still declared there and used by `getReceiptByHash` / `insertReceipt`, both deleted in Task 9).

- [ ] **Step 8: Run the tests and commit**

```bash
npx vitest run packages/dashboard && npm run lint
git add -A packages packages/core
git commit -m "$(cat <<'EOF'
refactor(receipt): the UI consumes core's Receipt, not a DB row shape

ReceiptRow was a lossy projection of Receipt with numerics as strings,
because that is how Drizzle returns `numeric`. The UI was already written
for either — four signatures declared string|number|null and two took
unknown — so this is a type change with no runtime edit and no moved
assertion.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `loadReceipt` computes on demand

The heart of the change.

**Files:**
- Modify: `packages/dashboard/lib/loadReceipt.ts`
- Modify: `packages/dashboard/lib/loadReceipt.test.ts`

**Interfaces:**
- Produces: `loadReceipt(chain: Chain, hash: string): Promise<ReceiptModel | null>` — same signature as today, new body.

- [ ] **Step 1: Write the failing tests**

Replace the body of `packages/dashboard/lib/loadReceipt.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const analyzeTransaction = vi.fn();
const enrichFeeSinkNames = vi.fn();

vi.mock('@fabric-tca/core', () => ({
	analyzeTransaction: (...a: unknown[]) => analyzeTransaction(...a),
	enrichFeeSinkNames: (...a: unknown[]) => enrichFeeSinkNames(...a),
	resolveAggregator: () => ({ slug: 'odos' }),
	resolveLegRouter: () => null,
}));

const { loadReceipt } = await import('./loadReceipt');
const { BASE } = await import('./chains');

const RECEIPT = {
	txHash: '0x' + 'a'.repeat(64),
	chainId: 8453,
	aggregator: 'odos',
	routerAddress: '0xrouter',
	feeSinks: [{ address: '0xsink', feeBps: 5, source: 'vault_map' }],
	routeLegs: [{ venue: '0xpool', type: 'v3' }],
};

beforeEach(() => {
	vi.clearAllMocks();
	process.env.TCA_RPC_URL = 'https://rpc.example';
	enrichFeeSinkNames.mockImplementation(async (sinks) =>
		sinks.map((s: { address: string }) => ({ ...s, name: 'Named Sink' })),
	);
});

describe('loadReceipt', () => {
	it('analyzes the transaction on the chain it was given', async () => {
		analyzeTransaction.mockResolvedValue(RECEIPT);
		await loadReceipt(BASE, RECEIPT.txHash);
		expect(analyzeTransaction).toHaveBeenCalledWith(RECEIPT.txHash, BASE.id, {
			rpcUrl: 'https://rpc.example',
		});
	});

	it('returns null when the transaction cannot be analyzed', async () => {
		analyzeTransaction.mockResolvedValue(null);
		expect(await loadReceipt(BASE, RECEIPT.txHash)).toBeNull();
	});

	// Both enrichments used to happen elsewhere — fee-sink names at persist time,
	// leg routers at read time. If either is dropped in the move, the receipt
	// renders a bare address where a name belongs, which no type catches.
	it('resolves fee-sink names', async () => {
		analyzeTransaction.mockResolvedValue(RECEIPT);
		const out = await loadReceipt(BASE, RECEIPT.txHash);
		expect(out!.feeSinks[0]!.name).toBe('Named Sink');
	});

	it('runs leg-router enrichment over the legs', async () => {
		analyzeTransaction.mockResolvedValue(RECEIPT);
		const out = await loadReceipt(BASE, RECEIPT.txHash);
		expect(out!.routeLegs).toHaveLength(1);
	});

	// A missing RPC URL must not read as "this transaction does not exist".
	it('throws rather than returning null when TCA_RPC_URL is unset', async () => {
		delete process.env.TCA_RPC_URL;
		await expect(loadReceipt(BASE, RECEIPT.txHash)).rejects.toThrow(/TCA_RPC_URL/);
	});
});
```

If `lib/chains.ts` does not export a chain constant named `BASE`, re-read it and use whatever it does export (e.g. `DEFAULT_CHAIN`).

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run packages/dashboard/lib/loadReceipt.test.ts
```

Expected: FAIL — the current implementation calls `getReceiptByHash` and never calls `analyzeTransaction`.

- [ ] **Step 3: Write the implementation**

Replace `packages/dashboard/lib/loadReceipt.ts` entirely:

```ts
import { analyzeTransaction, enrichFeeSinkNames } from '@fabric-tca/core';
import { enrichLegRouters } from './legRouterEnrichment';
import type { ReceiptModel } from './receiptModel';
import type { Chain } from './chains';

/**
 * The single place the receipt route gets its data.
 *
 * Every call is a fresh analysis — roughly 40 RPC calls. Nothing is cached and
 * nothing is stored: a mined transaction plus fixed pricing code is a pure
 * function, and the receipt is its output, so there is no state to keep.
 *
 * That is a deliberate trade. It costs deduplication — a link that reaches
 * fifty people in two seconds fires fifty analyses — and the global hourly
 * ceiling on the /tx route is the only thing bounding the bill. See the
 * Deferred section of docs/superpowers/specs/2026-08-06-database-removal-design.md
 * for the caching options surveyed. Whichever is chosen lands in THIS function.
 *
 * The two enrichments below used to happen in two different places at two
 * different times — fee-sink names at persist time, leg routers at read time.
 * With nothing persisted there is one moment, and it is here.
 */
export async function loadReceipt(chain: Chain, hash: string): Promise<ReceiptModel | null> {
	const rpcUrl = process.env.TCA_RPC_URL;
	// Deliberately a throw, not a null. Null on this path is the answer to "is
	// this a decodable swap?", and an unset env var is not evidence about the
	// transaction — it would render a confident "not a swap" for every hash.
	if (!rpcUrl) throw new Error('TCA_RPC_URL is not set');

	const receipt = await analyzeTransaction(hash, chain.id, { rpcUrl });
	if (!receipt) return null;

	return {
		...receipt,
		feeSinks: await enrichFeeSinkNames(receipt.feeSinks),
		routeLegs: enrichLegRouters(receipt.routeLegs, receipt.routerAddress, receipt.aggregator),
	};
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run packages/dashboard/lib/loadReceipt.test.ts
```

Expected: 5 passing.

- [ ] **Step 5: Verify the enrichment tests are not vacuous (mutation check)**

Temporarily delete the `feeSinks:` line from the returned object and re-run. The `resolves fee-sink names` test MUST fail. Restore it. Repeat for `routeLegs:` against the leg test.

If either test still passes with its line removed, it is asserting nothing — fix the test before continuing.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npx tsc --build && npm run lint
git add packages/dashboard/lib/loadReceipt.ts packages/dashboard/lib/loadReceipt.test.ts
git commit -m "$(cat <<'EOF'
feat(receipts): compute receipts on demand instead of reading them

The seam does what its docstring promised. Both read-time and persist-time
enrichments collapse into the one moment that now exists.

No caching — every view is ~40 RPC calls, and the global ceiling is the
only bound. Deliberate; the options are written up in the spec.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Relocate the rate limiters onto `/tx`

**The most load-bearing task in this plan.** Until now the expensive path was `POST /api/receipts`, which carried three limiters. That route is about to be deleted, and the expense moves to a plain `GET` — reachable by crawlers, link unfurlers, and an `<img>` tag, with no JS and no CORS preflight.

**Files:**
- Modify: `packages/dashboard/app/tx/[chain]/[hash]/page.tsx`
- Modify: `packages/dashboard/app/tx/[chain]/[hash]/page.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add to `packages/dashboard/app/tx/[chain]/[hash]/page.test.tsx`:

```ts
// The property that protects the RPC bill: a request rejected by the global
// ceiling must not reach loadReceipt. Asserting on the rendered output alone
// would pass even if the analysis ran and its result was thrown away.
it('does not analyze once the global hourly ceiling is exhausted', async () => {
	process.env.RATE_LIMIT_ANALYSES_GLOBAL_PER_HOUR = '1';
	loadReceipt.mockResolvedValue(RECEIPT);

	await ReceiptPage({ params: paramsFor(HASH_A) });
	expect(loadReceipt).toHaveBeenCalledTimes(1);

	await ReceiptPage({ params: paramsFor(HASH_B) });
	expect(loadReceipt).toHaveBeenCalledTimes(1); // still 1 — the second was refused
});

it('refuses politely rather than rendering a false negative', async () => {
	process.env.RATE_LIMIT_ANALYSES_GLOBAL_PER_HOUR = '1';
	loadReceipt.mockResolvedValue(RECEIPT);

	await ReceiptPage({ params: paramsFor(HASH_A) });
	const html = renderToString(await ReceiptPage({ params: paramsFor(HASH_B) }));

	// A ceiling is about US, not about the transaction. Rendering the normal
	// "not a swap" state here would assert something we never checked.
	expect(html).toContain('temporarily unavailable');
	expect(html).not.toContain('Not a swap');
});
```

Follow the existing file's conventions for `paramsFor`, `RECEIPT`, and the `loadReceipt` mock — re-read it first.

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run "packages/dashboard/app/tx/[chain]/[hash]/page.test.tsx"
```

Expected: FAIL — `loadReceipt` is called twice; there is no ceiling on this route yet.

- [ ] **Step 3: Move the limiters**

In `packages/dashboard/app/tx/[chain]/[hash]/page.tsx`, add above the component, alongside the existing `diagnosisLimiter`:

```ts
const envInt = (name: string, fallback: number): number => {
	const raw = Number(process.env[name]);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
};

/**
 * Per-IP analysis budget. Moved here verbatim from POST /api/receipts when
 * receipts stopped being stored — same limit, same window, new address.
 */
const analysisLimiter = createRateLimiter(createMemoryStore(), {
	limit: envInt('RATE_LIMIT_ANALYSES_PER_MIN', 20),
	windowMs: 60_000,
});

/**
 * Circuit breaker on total spend, counted across every client.
 *
 * This route is public and now costs a full analysis (~40 RPC calls) on every
 * hit, so per-IP limits alone do not bound the bill — a flood just uses more
 * IPs, each arriving with a full budget. This is the only ceiling a distributed
 * source cannot walk around, and with receipts no longer stored there is no
 * cache hit to fall back on. It is blunt on purpose: when it trips, receipts
 * pause for everyone rather than quietly running up an RPC invoice.
 */
const GLOBAL_ANALYSES_PER_HOUR = envInt('RATE_LIMIT_ANALYSES_GLOBAL_PER_HOUR', 500);
const globalAnalysisLimiter = createRateLimiter(createMemoryStore(), {
	limit: GLOBAL_ANALYSES_PER_HOUR,
	windowMs: 60 * 60 * 1000,
});
const GLOBAL_KEY = 'global';

/** Warn with a fifth of the hourly budget left — once the ceiling trips the tool is already down. */
const BUDGET_WARNING_FRACTION = 0.2;

const alertNotify = createNotifier({
	webhookUrl: process.env.ALERT_WEBHOOK_URL,
	debounceMs: 60 * 60 * 1000,
});
```

Then, inside the component, **between** the URL resolution and the `loadReceipt` call:

```ts
	const client = clientKeyFromHeaders(await headers());

	const perIp = await analysisLimiter(client);
	const globalBudget = perIp.allowed
		? await globalAnalysisLimiter(GLOBAL_KEY)
		: { allowed: false, remaining: 0, retryAfterSecs: perIp.retryAfterSecs };

	if (!globalBudget.allowed) {
		if (perIp.allowed) {
			console.warn('[tx] global analysis ceiling reached — pausing new receipts');
			void alertNotify(
				'ceiling_reached',
				ceilingReachedMessage(GLOBAL_ANALYSES_PER_HOUR, globalBudget.retryAfterSecs),
			);
		}
		return <CeilingNotice />;
	}
	if (globalBudget.remaining <= GLOBAL_ANALYSES_PER_HOUR * BUDGET_WARNING_FRACTION) {
		void alertNotify(
			'budget_warning',
			budgetWarningMessage(GLOBAL_ANALYSES_PER_HOUR, globalBudget.remaining),
		);
	}

	const receipt = await loadReceipt(chain, hash);
```

And a local component at the foot of the file:

```tsx
/**
 * The ceiling is a statement about US, not about the transaction. Every other
 * empty state on this page asserts something the analysis established; this one
 * must not, because no analysis ran.
 */
function CeilingNotice() {
	return (
		<div className="mt-[40px] font-['Sohne_Mono'] text-[12px] leading-[18px]">
			Receipt generation is temporarily unavailable — the hourly analysis budget
			is exhausted. Please try again shortly.
		</div>
	);
}
```

Add the imports: `createNotifier`, `ceilingReachedMessage`, `budgetWarningMessage` from `../../../../lib/alerts.js`.

- [ ] **Step 4: Run to verify they pass**

```bash
npx vitest run "packages/dashboard/app/tx/[chain]/[hash]/page.test.tsx"
```

Expected: all passing.

- [ ] **Step 5: Verify the ceiling test is not vacuous (mutation check)**

Temporarily change `if (!globalBudget.allowed)` to `if (false)`. The `does not analyze once the global hourly ceiling is exhausted` test MUST fail with `expected 1, received 2`. Restore.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npx tsc --build && npm run lint && npx vitest run packages/dashboard
git add -A packages/dashboard/app/tx
git commit -m "$(cat <<'EOF'
feat(tx): move the RPC circuit breaker onto the receipt route

The expensive path is now a plain GET, reachable by crawlers and unfurlers
with no JS. All three limiters move with it, and a tripped ceiling renders
a statement about us rather than a false claim about the transaction.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Search navigates instead of posting

**Files:**
- Modify: `packages/dashboard/components/receiptSearch.tsx`
- Create: `packages/dashboard/app/tx/[chain]/[hash]/loading.tsx`

**Re-read `receiptSearch.tsx` before editing — it changed during this plan's authoring.**

- [ ] **Step 1: Replace `go()`**

The current `go()` awaits a POST, then navigates in its `finally`. The POST existed only to persist a row before the page read it back; the page now computes directly, so navigation is the whole job.

```tsx
	// Navigate; the /tx route computes the receipt during its server render. The
	// button's loading state is the route transition itself, which is honest
	// about what is happening — the previous version reported "Analyzing" while
	// awaiting a POST whose only purpose was to write a row.
	const go = (raw: string) => {
		const trimmed = raw.trim();
		if (!trimmed || isPending) return;
		const word = nextLoaderWord(lastLoaderWord.current);
		lastLoaderWord.current = word;
		setLoaderWord(word);
		startTransition(() => {
			router.push(receiptPath(DEFAULT_CHAIN, trimmed) as Route);
		});
	};
```

Replace the `submitting` state with `useTransition`:

```tsx
	const [isPending, startTransition] = useTransition();
```

Delete `const [submitting, setSubmitting] = useState(false);`, add `useTransition` to the `react` import, and replace every remaining `submitting` reference (the button's `disabled` and the loading label condition) with `isPending`. `go` is no longer `async`, so `onPaste`'s `void go(pasted)` becomes `go(pasted)` and `submit`'s `void go(value)` becomes `go(value)`.

- [ ] **Step 2: Add the route-level loading state**

Create `packages/dashboard/app/tx/[chain]/[hash]/loading.tsx`:

```tsx
/**
 * Shown while the server render analyzes the transaction — roughly 40 RPC calls,
 * so this is seconds, not milliseconds. Without it the browser sits on the old
 * page with no feedback: the search box's own spinner covers a client-side
 * navigation that has already handed off.
 */
export default function Loading() {
	return (
		<div className="mt-[40px] font-['Sohne_Mono'] text-[12px] leading-[18px]">
			Analyzing transaction…
		</div>
	);
}
```

- [ ] **Step 3: Verify no POST remains**

```bash
grep -rn "api/receipts" packages/dashboard/components packages/dashboard/app --include='*.tsx' | grep -v '\.next'
```

Expected: no matches.

- [ ] **Step 4: Run the tests**

```bash
npx vitest run packages/dashboard && npx tsc --build && npm run lint
```

Any `receiptSearch` test asserting on a `fetch` call must be rewritten to assert on `router.push`. If a test mocks `fetch` and asserts it was called, that assertion is now wrong — replace it, do not delete it.

- [ ] **Step 5: Commit**

```bash
git add -A packages/dashboard
git commit -m "$(cat <<'EOF'
feat(search): navigate straight to /tx, drop the persist-then-go POST

The POST only ever wrote a row for the page to read back. The loader is a
route transition now, which is what was actually happening all along.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Delete `/api/receipts`

**Files:**
- Delete: `packages/dashboard/app/api/receipts/` (`route.ts` and all five test files)

- [ ] **Step 1: Delete the directory**

```bash
git rm -r packages/dashboard/app/api/receipts
```

- [ ] **Step 2: Relocate anything still needed**

`route.ts` held `toNewReceipt` (dead — nothing to insert), the three limiters (moved in Task 7), and the `activityNotify` Slack notifier. The activity notifier is **not** dead: it announces new receipts. Move it into `app/tx/[chain]/[hash]/page.tsx`, firing after a successful `loadReceipt`:

```ts
/**
 * Deliberately NOT debounced — a launch-day burst of real receipts should all
 * be reported. The global ceiling above already bounds the volume.
 *
 * Its own URL, independent of ALERT_WEBHOOK_URL: sharing a channel would bury a
 * ceiling warning under activity during a flood.
 */
const activityNotify = createNotifier({ webhookUrl: process.env.ACTIVITY_WEBHOOK_URL });
```

and after the receipt resolves non-null:

```ts
	if (receipt) {
		void activityNotify(
			'receipt_created',
			receiptCreatedMessage(receipt, baseUrlFromHeaders(await headers())),
		);
	}
```

`baseUrlFrom` takes a `Request`, which a server component does not have — it has
`await headers()`. Add a `Headers`-shaped sibling to `lib/alerts.ts`, keeping
`baseUrlFrom` for now (it is exercised by `alerts.test.ts`):

```ts
/**
 * `baseUrlFrom` for callers holding a Headers rather than a Request — server
 * components, which never see the Request object.
 *
 * Same trust model, and it matters as much here: `Host` and `X-Forwarded-Proto`
 * are attacker-controlled on this public route, and a forged Host would land a
 * convincing phishing link in the team's own Slack, sent by the team's own bot.
 * APP_BASE_URL removes those headers from the trust chain once it is set.
 */
export function baseUrlFromHeaders(h: Headers): string {
	const configured = process.env.APP_BASE_URL;
	if (configured) return configured.replace(/\/+$/, '');
	const host = h.get('host') ?? 'localhost:3000';
	const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
	return `${proto}://${host}`;
}
```

Add a test alongside the existing `baseUrlFrom` cases in `lib/alerts.test.ts`
asserting that `APP_BASE_URL` wins over a forged `host` header — that is the
property the comment claims, and it should not rest on the comment.

Note the behaviour change and record it in the commit: this now fires on **every view**, not on first analysis, because there is no longer a stored/not-stored distinction. If that is too noisy, the honest fix is to drop the notifier — not to fake a distinction that no longer exists.

- [ ] **Step 3: Verify and commit**

```bash
grep -rn "api/receipts" packages/dashboard --include='*.ts' --include='*.tsx' | grep -v '\.next'
npx vitest run packages/dashboard && npx tsc --build && npm run lint
git add -A packages/dashboard
git commit -m "$(cat <<'EOF'
feat(api): delete /api/receipts

Its POST wrote rows nobody reads and its DELETE removed them. The activity
notifier moves to the route that now does the work — and fires per view,
since first-analysis is no longer a distinction that exists.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Delete the login stack

With `/trades` and `DELETE` gone, `PROTECTED_PAGE_PREFIXES` is empty and `PUBLIC_API_METHODS` names no APIs. The gate guards nothing.

**Files:**
- Delete: `packages/dashboard/middleware.ts`, `lib/accessDecision.ts`, `lib/accessDecision.test.ts`, `lib/auth.ts`, `lib/auth.test.ts`, `app/api/login/route.ts`, `app/api/login/route.test.ts`, `components/loginForm.tsx`, `components/loginForm.test.tsx`

- [ ] **Step 1: Confirm security headers do not depend on middleware**

Already verified during planning: `packages/dashboard/next.config.mjs` applies them via `async headers()` from `./lib/securityHeaders.mjs`. Re-confirm before deleting:

```bash
grep -n "securityHeaders" packages/dashboard/next.config.mjs packages/dashboard/middleware.ts
```

Expected: a match in `next.config.mjs`, none in `middleware.ts`. **If `middleware.ts` matches, stop** — headers must be relocated before it can be deleted.

- [ ] **Step 2: Delete**

```bash
git rm packages/dashboard/middleware.ts \
       packages/dashboard/lib/accessDecision.ts \
       packages/dashboard/lib/accessDecision.test.ts \
       packages/dashboard/lib/auth.ts \
       packages/dashboard/lib/auth.test.ts \
       packages/dashboard/components/loginForm.tsx \
       packages/dashboard/components/loginForm.test.tsx
git rm -r packages/dashboard/app/api/login
```

- [ ] **Step 3: Verify nothing references them**

```bash
grep -rn "accessDecision\|SESSION_COOKIE\|verifySession\|LoginForm\|APP_SESSION_SECRET\|APP_ACCESS_PASSWORD" packages/dashboard --include='*.ts' --include='*.tsx' --include='*.mjs' | grep -v '\.next'
```

Expected: no matches. `scripts/smokeDeploy.mjs` still probes `/api/login` — fixed in Task 12.

- [ ] **Step 4: Confirm the headers still ship**

```bash
npx vitest run packages/dashboard/lib/securityHeaders.test.ts
```

Expected: passing — the header set is unchanged, only the gate is gone.

- [ ] **Step 5: Commit**

```bash
npx tsc --build && npm run lint
git add -A packages/dashboard
git commit -m "$(cat <<'EOF'
feat(auth): delete the login stack

It existed to protect /trades and DELETE. Both are gone, the protected
list is empty, and a gate over nothing is a gate that will eventually be
trusted for something it does not do.

Security headers were never routed through middleware — they come from
next.config's headers(), verified before this deletion.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: The dev-only `/qa` route

**Files:**
- Create: `packages/dashboard/app/qa/tx/[chain]/[hashes]/page.tsx`
- Create: `packages/dashboard/app/qa/tx/[chain]/[hashes]/page.test.tsx`

**Interfaces:**
- Consumes: `resolveChainParam` from `lib/chains`, `HASH_RE` from `lib/receiptUrl`, `loadReceipt` from `lib/loadReceipt`.

URL shape: `/qa/tx/base/0xaaa…,0xbbb…,0xccc…`

- [ ] **Step 1: Write the failing tests**

Create `packages/dashboard/app/qa/tx/[chain]/[hashes]/page.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderToString } from 'react-dom/server';

const loadReceipt = vi.fn();
const notFound = vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); });

vi.mock('../../../../../lib/loadReceipt', () => ({ loadReceipt: (...a: unknown[]) => loadReceipt(...a) }));
vi.mock('next/navigation', () => ({ notFound }));

const QaPage = (await import('./page')).default;

const A = `0x${'a'.repeat(64)}`;
const B = `0x${'b'.repeat(64)}`;
const paramsFor = (hashes: string) => Promise.resolve({ chain: 'base', hashes });
const ORIGINAL_ENV = process.env.NODE_ENV;

beforeEach(() => vi.clearAllMocks());
afterEach(() => { process.env.NODE_ENV = ORIGINAL_ENV; });

describe('/qa/tx/[chain]/[hashes]', () => {
	// The ONLY thing between a public URL and an unmetered n x 40 RPC call.
	it('404s in production without analyzing anything', async () => {
		process.env.NODE_ENV = 'production';
		await expect(QaPage({ params: paramsFor(`${A},${B}`) })).rejects.toThrow('NEXT_NOT_FOUND');
		expect(loadReceipt).not.toHaveBeenCalled();
	});

	it('loads every hash in the comma-separated list', async () => {
		loadReceipt.mockResolvedValue({ txHash: A, inputSymbol: 'USDC', outputSymbol: 'WETH', allInCostBps: 12 });
		await QaPage({ params: paramsFor(`${A},${B}`) });
		expect(loadReceipt).toHaveBeenCalledTimes(2);
	});

	// One unanalyzable hash in a list of ten must not cost the other nine.
	it('isolates a failing hash to its own row', async () => {
		loadReceipt.mockImplementation(async (_c: unknown, h: string) =>
			h === A ? { txHash: A, inputSymbol: 'USDC', outputSymbol: 'WETH', allInCostBps: 12 } : null,
		);
		const html = renderToString(await QaPage({ params: paramsFor(`${A},${B}`) }));
		expect(html).toContain('USDC');
		expect(html).toContain('no receipt');
	});

	it('rejects a malformed hash without spending an analysis', async () => {
		await expect(QaPage({ params: paramsFor('0xnope') })).rejects.toThrow('NEXT_NOT_FOUND');
		expect(loadReceipt).not.toHaveBeenCalled();
	});

	it('404s on an unknown chain', async () => {
		await expect(QaPage({ params: Promise.resolve({ chain: 'solana', hashes: A }) }))
			.rejects.toThrow('NEXT_NOT_FOUND');
		expect(loadReceipt).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run "packages/dashboard/app/qa/tx/[chain]/[hashes]/page.test.tsx"
```

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the page**

Create `packages/dashboard/app/qa/tx/[chain]/[hashes]/page.tsx`:

```tsx
import { notFound } from 'next/navigation';
import { resolveChainParam } from '../../../../../lib/chains';
import { HASH_RE } from '../../../../../lib/receiptUrl';
import { loadReceipt } from '../../../../../lib/loadReceipt';

export const dynamic = 'force-dynamic';

/**
 * Side-by-side receipt comparison for QA. Replaces the /trades history table.
 *
 * DEV ONLY. The App Router cannot conditionally register a route file, so the
 * guard is the first statement below. It is the only thing between a public URL
 * and an unmetered n x 40 RPC call — this page has no rate limiting at all,
 * deliberately, because locally it runs against your own key.
 *
 * Stateless by design: the hashes live in the URL, so there is no corpus file to
 * curate and no state to keep. Paste whatever you are comparing.
 */
export default async function QaPage({
	params,
}: {
	params: Promise<{ chain: string; hashes: string }>;
}) {
	if (process.env.NODE_ENV === 'production') notFound();

	const { chain: chainParam, hashes: hashesParam } = await params;

	const resolved = resolveChainParam(chainParam);
	if (!resolved) notFound();

	// Validated before anything is spent — a malformed list costs one regex each.
	const hashes = decodeURIComponent(hashesParam).split(',').map((h) => h.trim()).filter(Boolean);
	if (hashes.length === 0 || !hashes.every((h) => HASH_RE.test(h))) notFound();

	// Sequential, not Promise.all: ten hashes in parallel is ~400 simultaneous
	// RPC calls, which gets you rate-limited by the provider rather than fast.
	const rows: { hash: string; receipt: Awaited<ReturnType<typeof loadReceipt>> }[] = [];
	for (const hash of hashes) {
		// One unanalyzable hash must not cost the other nine.
		try {
			rows.push({ hash, receipt: await loadReceipt(resolved.chain, hash) });
		} catch {
			rows.push({ hash, receipt: null });
		}
	}

	return (
		<div className="mt-[40px] overflow-x-auto">
			<table className="w-full font-['Sohne_Mono'] text-[12px] leading-[18px]">
				<thead>
					<tr className="text-left">
						<th className="pr-[16px]">Tx</th>
						<th className="pr-[16px]">Pair</th>
						<th className="pr-[16px]">Aggregator</th>
						<th className="pr-[16px]">Notional</th>
						<th className="pr-[16px]">All-in bps</th>
						<th className="pr-[16px]">LP bps</th>
						<th className="pr-[16px]">Slippage bps</th>
						<th className="pr-[16px]">Tier</th>
					</tr>
				</thead>
				<tbody>
					{rows.map(({ hash, receipt }) => (
						<tr key={hash}>
							<td className="pr-[16px]">{`${hash.slice(0, 10)}…`}</td>
							{receipt ? (
								<>
									<td className="pr-[16px]">{`${receipt.inputSymbol} → ${receipt.outputSymbol}`}</td>
									<td className="pr-[16px]">{receipt.aggregator}</td>
									<td className="pr-[16px]">{receipt.notionalUsd ?? '–'}</td>
									<td className="pr-[16px]">{receipt.allInCostBps ?? '–'}</td>
									<td className="pr-[16px]">{receipt.lpFeeBps ?? '–'}</td>
									<td className="pr-[16px]">{receipt.slippageBps ?? '–'}</td>
									<td className="pr-[16px]">{receipt.tier ?? '–'}</td>
								</>
							) : (
								<td colSpan={7}>no receipt</td>
							)}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
```

`overflow-x-auto` on the wrapper is required — a wide table must scroll inside its own container rather than the page body.

- [ ] **Step 4: Run to verify they pass**

```bash
npx vitest run "packages/dashboard/app/qa/tx/[chain]/[hashes]/page.test.tsx"
```

Expected: 5 passing.

- [ ] **Step 5: Verify the production guard is not vacuous (mutation check)**

Temporarily change the guard to `if (false) notFound();`. The `404s in production` test MUST fail. Restore.

- [ ] **Step 6: Try it against the real thing**

With the dev server running (`npm run dev`), open:

```
http://localhost:3000/qa/tx/base/<hash1>,<hash2>
```

using two hashes from `docs/qa/corpus.json`. Confirm both rows render with real numbers.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
npx tsc --build && npm run lint
git add -A packages/dashboard/app/qa
git commit -m "$(cat <<'EOF'
feat(qa): dev-only /qa/tx/<chain>/<hash>,<hash> comparison table

Stateless — the hashes are the URL, so there is no corpus to curate. The
production guard is the whole security model, so it has a mutation-checked
test. Loads sequentially: ten hashes in parallel is 400 simultaneous RPC
calls, which is slower, not faster.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Delete the database packages

**Files:**
- Delete: `packages/db/`, `drizzle.config.ts`, `packages/dashboard/lib/db.ts`, `lib/queries.ts`, `lib/queries.test.ts`
- Modify: root `package.json`, `packages/dashboard/package.json`, `packages/core/package.json`, `packages/dashboard/next.config.mjs`, `tsconfig.json`, `.env.example`, `scripts/smokeDeploy.mjs`, `README.md`

- [ ] **Step 1: Delete the code**

```bash
git rm -r packages/db
git rm drizzle.config.ts \
       packages/dashboard/lib/db.ts \
       packages/dashboard/lib/queries.ts \
       packages/dashboard/lib/queries.test.ts
```

- [ ] **Step 2: Strip the dependencies**

- Root `package.json`: delete the `db:generate`, `db:migrate`, `db:check` scripts and the `drizzle-kit` devDependency.
- `packages/dashboard/package.json`: delete `"@fabric-tca/db": "*"`, `"drizzle-orm"`, `"postgres"`.
- `packages/core/package.json`: delete `"@fabric-tca/db": "*"` and `"drizzle-orm"`. **These are already dead** — verified during planning that no file under `packages/core/src/` imports either. The declarations are stale.
- `packages/dashboard/next.config.mjs`: `transpilePackages: ['@fabric-tca/db', '@fabric-tca/core']` → `transpilePackages: ['@fabric-tca/core']`.
- Root `tsconfig.json`: remove the `packages/db` project reference.

Then:

```bash
npm install
```

- [ ] **Step 3: Strip the env vars**

Remove `TCA_DATABASE_URL`, `APP_SESSION_SECRET`, and `APP_ACCESS_PASSWORD` from `.env.example`, along with their explanatory comments. Leave the user's own `.env` alone — it is untracked and not this plan's business.

- [ ] **Step 4: Rewrite the smoke test**

`scripts/smokeDeploy.mjs` probes `/trades`, `POST/DELETE/PUT/GET /api/receipts`, `/login`, and `/api/login` — none of which exist. Replace those checks with:

```js
// The receipt route computes on demand now; a known-good hash must render.
const receipt = await req(`/tx/base/${KNOWN_HASH}`);
check('GET /tx/base/<hash> renders a receipt', receipt.status === 200, `status ${receipt.status}`);
check('  …with the pair on the page', /→/.test(receipt.body));

// A malformed hash costs one regex, not an analysis.
const bad = await req('/tx/base/0xnope');
check('a malformed hash 404s', bad.status === 404, `status ${bad.status}`);

// The QA route is dev-only. If this ever returns 200 in production, it is an
// open, unmetered door to the RPC bill.
const qa = await req(`/qa/tx/base/${KNOWN_HASH}`);
check('/qa is not reachable in production', qa.status === 404, `status ${qa.status} — QA ROUTE IS LIVE`);
```

Set `KNOWN_HASH` from any `tx_hash` in `docs/qa/corpus.json`.

- [ ] **Step 5: Update the README**

Remove the database from setup instructions, drop the `db:migrate` step, and delete `TCA_DATABASE_URL` / `APP_SESSION_SECRET` / `APP_ACCESS_PASSWORD` from the environment table. Add one line under architecture: *receipts are computed on demand and never stored; the service persists nothing.*

- [ ] **Step 6: Verify the database is gone**

```bash
grep -rn "drizzle\|postgres\|TCA_DATABASE_URL\|@fabric-tca/db" packages scripts *.json *.ts README.md .env.example 2>/dev/null | grep -v node_modules | grep -v '\.next' | grep -v package-lock | grep -v freezeCorpus
```

Expected: no matches. `scripts/freezeCorpus.mjs` is excluded — it is the historical record of how the corpus was made and keeps its import.

- [ ] **Step 7: Full verification**

```bash
npx vitest run && npx tsc --build && npm run lint
```

Expected: all green. Record the test count in the commit — the number moves and a stale figure is worse than none.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(db): delete the database

packages/db, the migrations, drizzle, postgres, and the three env vars
that configured them. core's dependency on @fabric-tca/db was already
dead — no file under src/ ever imported it.

The service now writes nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: The logger

Last, so no console call site is converted in a file that was about to be deleted.

**Files:**
- Create: `packages/dashboard/lib/log.ts`, `packages/dashboard/lib/log.test.ts`
- Modify: every surviving `console.*` call site

- [ ] **Step 1: Write the failing tests**

Create `packages/dashboard/lib/log.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL = process.env.LOG_LEVEL;
afterEach(() => { process.env.LOG_LEVEL = ORIGINAL; vi.restoreAllMocks(); });

async function freshLogger() {
	vi.resetModules();
	return (await import('./log')).log;
}

describe('log', () => {
	beforeEach(() => vi.clearAllMocks());

	it('emits one line of parseable JSON', async () => {
		process.env.LOG_LEVEL = 'info';
		const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
		(await freshLogger()).info('receipt computed', { hash: '0xabc', ms: 812 });

		const written = out.mock.calls[0]![0] as string;
		expect(written.endsWith('\n')).toBe(true);
		expect(written.trimEnd().includes('\n')).toBe(false);
		expect(JSON.parse(written)).toMatchObject({
			level: 'info', msg: 'receipt computed', hash: '0xabc', ms: 812,
		});
	});

	it('suppresses levels below the configured one', async () => {
		process.env.LOG_LEVEL = 'warn';
		const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
		const log = await freshLogger();
		log.debug('noisy');
		log.info('also noisy');
		expect(out).not.toHaveBeenCalled();
	});

	it('emits levels at or above the configured one', async () => {
		process.env.LOG_LEVEL = 'warn';
		const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
		const log = await freshLogger();
		log.warn('heard');
		log.error('heard');
		expect(err).toHaveBeenCalledTimes(2);
	});

	// error/warn to stderr, everything else to stdout — so a log drain can split
	// them without parsing, and a crash dump keeps the two streams distinct.
	it('routes error and warn to stderr, the rest to stdout', async () => {
		process.env.LOG_LEVEL = 'trace';
		const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
		const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
		const log = await freshLogger();
		log.error('e'); log.warn('w'); log.info('i'); log.debug('d'); log.trace('t');
		expect(err).toHaveBeenCalledTimes(2);
		expect(out).toHaveBeenCalledTimes(3);
	});

	it('falls back to info on an unrecognised LOG_LEVEL', async () => {
		process.env.LOG_LEVEL = 'chatty';
		const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
		const log = await freshLogger();
		log.debug('suppressed');
		log.info('emitted');
		expect(out).toHaveBeenCalledTimes(1);
	});
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run packages/dashboard/lib/log.test.ts
```

Expected: FAIL — `Failed to resolve import "./log"`.

- [ ] **Step 3: Write the logger**

Create `packages/dashboard/lib/log.ts`:

```ts
/**
 * Levelled structured logging.
 *
 * With no database, log lines are the only record this service produces — so
 * they are a deliberate artifact rather than leftover debugging.
 *
 * One JSON object per line to stdout (stderr for warn/error), which is what
 * Railway ingests and what its field filters query. Nothing is written to disk,
 * nothing is rotated, nothing is retained by us. Durable logs, if ever wanted,
 * are a Railway log drain — not code here.
 */
const LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const;
export type Level = (typeof LEVELS)[number];

const RANK: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

/**
 * Resolved once at module load. An unrecognised value falls back to `info`
 * rather than throwing or silencing everything: a typo'd LOG_LEVEL must not be
 * the reason an incident has no logs.
 */
function configuredLevel(): Level {
	const raw = process.env.LOG_LEVEL?.toLowerCase();
	if (raw && (LEVELS as readonly string[]).includes(raw)) return raw as Level;
	return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

const threshold = RANK[configuredLevel()];

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
	if (RANK[level] > threshold) return;
	const line = `${JSON.stringify({ level, msg, ...fields })}\n`;
	// warn/error to stderr so a drain can split severity without parsing.
	if (level === 'error' || level === 'warn') process.stderr.write(line);
	else process.stdout.write(line);
}

export const log = {
	error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
	warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
	info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
	debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
	trace: (msg: string, fields?: Record<string, unknown>) => emit('trace', msg, fields),
};
```

- [ ] **Step 4: Run to verify they pass**

```bash
npx vitest run packages/dashboard/lib/log.test.ts
```

Expected: 5 passing.

- [ ] **Step 5: Convert the surviving call sites**

```bash
grep -rn "console\." packages/dashboard packages/core/src --include='*.ts' --include='*.tsx' | grep -v '\.test\.' | grep -v '\.next'
```

For each, convert to the matching level, moving interpolated values into fields:

```ts
// before
console.warn('[tx] global analysis ceiling reached — pausing new receipts');
// after
log.warn('global analysis ceiling reached, pausing new receipts', { route: 'tx' });
```

The bracketed `[module]` prefixes become a field, not part of the message — that is the point of structured logging, and it is what makes Railway's filters work.

**Leave `scripts/**` alone.** Those are CLI tools whose `console.log` output *is* their interface; routing it through a JSON logger would make them unreadable.

`packages/core` cannot import from `packages/dashboard`. Either add a matching `packages/core/src/log.ts` (same file, no dashboard import) or leave core's `console.*` as-is and note the split. Prefer the former — the whole point is one level control.

- [ ] **Step 6: Document the env var**

Add to `.env.example`:

```
# Log verbosity: error | warn | info | debug | trace
# Defaults to `info` in production and `debug` in development.
LOG_LEVEL=debug
```

- [ ] **Step 7: Full verification and commit**

```bash
npx vitest run && npx tsc --build && npm run lint
git add -A
git commit -m "$(cat <<'EOF'
feat(log): levelled JSON logging, LOG_LEVEL controlled

With nothing stored, log lines are the only record the service produces.
One JSON object per line, warn/error to stderr so a drain can split
severity without parsing. Scripts keep their console.log — their output
is their interface.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] **Full suite, typecheck, lint**

```bash
npx vitest run && npx tsc --build && npm run lint
```

Run in **both** env states — clean, and with `.env` exported (`set -a && source .env && set +a`). RPC end-to-end tests skip silently without `TCA_RPC_URL`, so a green run in one state proves less than it looks.

- [ ] **Nothing persists**

```bash
grep -rn "drizzle\|postgres\|TCA_DATABASE_URL" packages scripts README.md .env.example | grep -v node_modules | grep -v '\.next' | grep -v freezeCorpus
```

Expected: no matches.

- [ ] **Manual pass against a live dev server**

1. `/` renders the search box.
2. Pasting a hash navigates to `/tx/base/<hash>` and renders a receipt — confirm it took seconds, i.e. it really analyzed.
3. Reloading that URL analyzes **again** (watch the RPC call count or the logs). This is the expected behaviour with no cache — confirm it, do not treat it as a bug.
4. `/qa/tx/base/<hash>,<hash>` renders both rows.
5. `/trades` 404s.

- [ ] **Report to the user, then stop**

Do **not** delete the Railway Postgres instance. Report that the code no longer touches it, that `docs/qa/corpus.json` holds the frozen 62 receipts, and that dropping the instance is theirs to do.

---

## Notes for the reviewer

**Deliberately not done:**

- **No caching.** Every view is a fresh ~40 RPC calls. `loadReceipt` is the single function a cache lands in; the surveyed options are in the spec's Deferred section. The exposure is real: a link that reaches fifty people in two seconds fires fifty concurrent analyses and trips the 500/hour ceiling on one receipt.
- **The redundant `Number()` calls stay.** Now that numerics arrive as numbers, ~30 `Number(x)` calls are identity. They are null-guarded and finite-checked, and removing them is churn in the files most under review — where one dropped `Number.isFinite` puts a `NaN` on a receipt.
- **Both limiters remain per-process.** Correct on one Railway instance. At two replicas the hourly ceiling silently becomes 1,000/hr. Already true before this change; it matters more now that there is no shared row to deduplicate on.

**Accepted loss:** corpus-wide regression detection. `rpcProviderAB.mjs` once caught an 11-of-63 silent corruption that a green suite missed. Against a frozen JSON it can still A/B two RPC providers, but it can no longer answer "does today's code disagree with last month's" — the frozen file *is* last month, permanently.
