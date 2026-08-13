# Corpus → Cases Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete `docs/qa/corpus.json` — a frozen snapshot of decoded output that rots on every pricing change — and keep only what cannot rot: the 62 transaction hashes, in `docs/qa/cases.json`.

**Architecture:** Every consumer moves to live re-decode. The pivot is that this needs **one shared adapter, not twelve rewritten scripts**: the five scripts that read decoded columns all read the same snake_case fields, every one of which has a direct camelCase counterpart on the live `Receipt`, and their per-leg reads need no translation at all because corpus leg objects were already stored camelCase and identical to live legs. So `loadCasesDecoded()` decodes a case and hands back the row shape those scripts already expect, and their diffs become a loader swap.

**Tech Stack:** Node ESM scripts under `scripts/analysis/`, vitest, `@fabric-tca/core` consumed from `packages/core/dist`.

**Spec:** `docs/superpowers/specs/2026-08-12-corpus-migration-and-notional-gating.md`, Part A. Part B (notional depth gating) shipped in `8a88dc8` and shares no code with this.

## Global Constraints

- **Run vitest from the repo root.** `npx vitest run` from inside a package silently reports about half the suite.
- **The analysis scripts read `packages/core/dist`, not `src`.** Run `npm run typecheck` (which is `tsc --build`) before any script invocation, or you are measuring stale code.
- **Live decodes must be serial.** Concurrent decodes of the same transaction return different receipts with no flag. Never add concurrency to the adapter.
- **`set -a && source .env && set +a`** before anything that touches the chain. `source .env` alone does not export. Note `scripts/analysis/_env.mjs` reads the repo-root `.env` itself, so scripts importing `env` from it are already covered — but `npx vitest` is not.
- **Do not re-add a corpus freezer.** `scripts/freezeCorpus.mjs` was deleted with a "do not re-add" note. Regenerating the snapshot is the thing this plan exists to stop.
- Scripts under `scripts/` indent with **tabs**.
- `docs/qa/cases.json` indents with **tabs**, one object per entry.
- `$SCRATCH` below means your session scratchpad directory. Export it once per shell. Measurement artifacts and the one-off migration script go there, never into the repo.
- ⚠️ **`scripts/analysis/_env.mjs` has module-scope side effects**: it `readFileSync`s the repo-root `.env` and top-level-`await`s an import of `packages/core/dist/receiptPure.js`. Importing it throws when either is absent. This is why Task 2 puts the pure mapping function in its own leaf module — a vitest test must not require a populated `.env` and a built `dist` just to check a field map.

## Reference: the column map

Every field the five decoded-column scripts read, and its live counterpart. This table is the contract `loadCasesDecoded()` implements — Task 2 builds exactly this and nothing more.

| corpus column | live `Receipt` field |
|---|---|
| `id` | *(not on the Receipt — comes from the case's `corpusId`)* |
| `route_legs` | `routeLegs` |
| `slippage_bps` | `slippageBps` |
| `notional_usd` | `notionalUsd` |
| `tier` | `tier` |
| `decomp_confidence` | `decompConfidence` |
| `normalize_flags` | `normalizeFlags` |
| `aggregator` | `aggregator` |
| `pricing_status` | `pricingStatus` |
| `all_in_cost_bps` | `allInCostBps` |
| `recon_residual_bps` | `reconResidualBps` |
| `route_shape` | `routeShape` |
| `block_number` | `blockNumber` |
| `tx_hash` | `txHash` |

**Leg fields need no mapping.** Corpus legs were stored as `{feeTierBps, lpFeeBps, notionalUsdc, priceImpactBps, tokenIn, tokenInSymbol, tokenOut, tokenOutSymbol, type, venue}` — the same shape and casing the live decoder emits. Live legs additionally carry `feeResolved`, which `attributionCoverage.mjs` already reads and which was simply `undefined` on every corpus row; that script gets *more* correct after migration, not less.

**The string-vs-number trap is already neutralized.** `num()` in `_env.mjs` is `(v) => v == null ? null : Number(v)`, which behaves identically on the corpus's strings and on live numbers. Do not add coercion to the adapter.

## What this costs, stated up front

These scripts are instant today because they read a frozen file. After migration each one decodes 62 transactions serially — **roughly 3.5–4 minutes per run** (measured: the 62-receipt golden capture takes 210s). That is the price of not reading a stale snapshot, and the spec accepted it. Every migrated script therefore grows a `--limit=N` flag so an iterating developer can work on 5 transactions instead of 62.

**Explicit non-goal:** a decode cache keyed on a hash of `packages/core/dist`. It would make repeat runs instant without reintroducing staleness, and it is a reasonable follow-up — but it is machinery this migration does not need, and building it here would put a caching layer in the same change that removes one.

---

### Task 1: Move the 62 hashes into `cases.json`

**Files:**
- Modify: `docs/qa/cases.json` (7 entries today → 68)
- Create: a one-off migration script in the scratchpad — **not** in the repo. Run it once, then leave it behind. `scripts/freezeCorpus.mjs` was deleted with a "do not re-add" note, and a committed corpus-shaped script invites exactly that.
- Test: `scripts/cases.test.mjs` (new)

**Interfaces:**
- Produces: `cases.json` entries of shape `{ hash, chainId, blockNumber, added, corpusId, source, tags, why }` for the 62 migrated transactions. Existing hand-written entries keep their current shape and gain nothing except `corpusId` on the one overlap.

- [ ] **Step 1: Write the migration script in the scratchpad**

`$SCRATCH` is your session scratchpad directory. Do not put this in the repo.

```javascript
// $SCRATCH/migrate-corpus.mjs — run once, then abandon.
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/Users/justinvoorhees/withfabricxyz/fabric-tca-decoder';
const corpus = JSON.parse(readFileSync(`${ROOT}/docs/qa/corpus.json`, 'utf8'));
const cases = JSON.parse(readFileSync(`${ROOT}/docs/qa/cases.json`, 'utf8'));

const WHY = 'Migrated from the v1 analysis corpus (corpus-v1), the frozen 62-transaction sweep set the analysis scripts ran against. Bulk-curated as a batch for shape coverage, not individually justified — unlike the hand-written entries in this file, this one carries no per-transaction rationale.';

const byHash = new Map(cases.map((c) => [c.hash.toLowerCase(), c]));
let merged = 0;
const added = [];

for (const r of corpus) {
	const hash = r.tx_hash.toLowerCase();
	const existing = byHash.get(hash);
	if (existing) {
		// Corpus id 485 is already here with a hand-written `why`. Take the id,
		// leave everything else alone — the existing entry is the better one.
		existing.corpusId = r.id;
		merged++;
		continue;
	}
	added.push({
		hash,
		chainId: r.chain_id,
		blockNumber: r.block_number,
		added: r.created_at.slice(0, 10),
		corpusId: r.id,
		source: 'corpus-v1',
		tags: [],
		why: WHY,
	});
}

added.sort((a, b) => a.corpusId - b.corpusId);
writeFileSync(`${ROOT}/docs/qa/cases.json`, `${JSON.stringify([...cases, ...added], null, '\t')}\n`);
console.log(`merged ${merged}, added ${added.length}, total ${cases.length + added.length}`);
```

- [ ] **Step 2: Run it and check the counts**

```bash
node "$SCRATCH/migrate-corpus.mjs"
```

Expected exactly: `merged 1, added 61, total 68`. Any other numbers mean the overlap assumption is wrong — stop and report rather than editing the file by hand.

- [ ] **Step 3: Verify the merge did not damage the hand-written entry**

```bash
git diff docs/qa/cases.json | grep -E "^-" | grep -v "^---"
```

Expected: the ONLY removed lines are the closing `]` and the reformatting of existing entries (the rewrite re-serializes the whole file). Confirm specifically that entry `0x79854af2…` still carries its original long `why` — the one citing "Corpus id 485" — and that it gained `corpusId: 485` rather than a boilerplate `why`. If its `why` was replaced, the script's merge branch is wrong.

- [ ] **Step 4: Write the shape test**

Create `scripts/cases.test.mjs`:

```javascript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const cases = JSON.parse(
	readFileSync(new URL('../docs/qa/cases.json', import.meta.url), 'utf8'),
);

describe('the QA case list', () => {
	it('holds the 7 hand-written cases plus the 62 migrated corpus transactions', () => {
		expect(cases.length).toBe(68);
		expect(cases.filter((c) => c.corpusId != null).length).toBe(62);
	});

	// A duplicate hash means a transaction gets analysed twice and silently
	// double-weights every average taken across this set.
	it('has no duplicate hashes and no duplicate corpus ids', () => {
		const hashes = cases.map((c) => c.hash.toLowerCase());
		expect(new Set(hashes).size).toBe(hashes.length);
		const ids = cases.filter((c) => c.corpusId != null).map((c) => c.corpusId);
		expect(new Set(ids).size).toBe(ids.length);
	});

	// `why` is this file's whole contract: a hash with no explanation cannot be
	// pruned later, because nobody can tell what it was keeping.
	it('gives every entry a non-empty why and a usable hash', () => {
		for (const c of cases) {
			expect(c.hash, JSON.stringify(c)).toMatch(/^0x[0-9a-f]{64}$/);
			expect(typeof c.chainId, c.hash).toBe('number');
			expect((c.why ?? '').length, c.hash).toBeGreaterThan(0);
		}
	});

	// The one overlap: corpus id 485 was already here, hand-written. The
	// migration takes its id and must not overwrite the better rationale.
	it('keeps the hand-written why on the entry that was already present', () => {
		const c = cases.find((x) => x.corpusId === 485);
		expect(c).toBeDefined();
		expect(c.why).toContain('routeReconstructed');
		expect(c.source).toBeUndefined(); // not a bulk-migrated entry
	});
});
```

- [ ] **Step 5: Run it**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder
npx vitest run scripts/cases.test.mjs
```

Expected: PASS, 4 tests. If the last one fails on `routeReconstructed`, open the entry and assert on a distinctive phrase that is actually in its `why` — do not weaken the assertion to something every entry would satisfy.

- [ ] **Step 6: Commit**

```bash
git add docs/qa/cases.json scripts/cases.test.mjs
git commit -m "$(cat <<'EOF'
feat(qa): migrate the 62 corpus transactions into cases.json

Hashes, chain ids, block numbers and the date we added them — the facts about
each transaction. Everything decoded stays behind; corpus.json still exists and
still owns it until its last reader is migrated.

The 61 new entries share one `why` and a source: "corpus-v1" marker rather than
inventing per-entry rationale, because corpus.json carries no curatorial fields
at all to migrate — it is a raw DB dump. A reader can tell at a glance which
entries were individually justified and which inherited a batch explanation.

corpusId comes across as a curatorial label. "Corpus id 485" is the vocabulary a
dozen code comments and prior specs already speak; without the field every one
of those references dangles.

Corpus id 485 was ALREADY in this file with a hand-written why. It takes the id
and keeps its own rationale.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QsCVvRTgk8M5ZG7hoCTqbC
EOF
)"
```

---

### Task 2: The re-decode adapter

**Files:**
- Create: `scripts/analysis/_rowShape.mjs` — the pure Receipt→row mapping, no side effects, no imports
- Modify: `scripts/analysis/_env.mjs` — the live loader, plus a re-export of `receiptToRow` so callers keep one import site
- Test: `scripts/analysis/rowShape.test.mjs` (new)

**Interfaces:**
- Consumes: `loadCases()` (already in `_env.mjs`), `core('index.js')` for `analyzeTransaction`, `env.TCA_RPC_URL`.
- Produces:
  - `receiptToRow(receipt, corpusId)` in `_rowShape.mjs`, re-exported from `_env.mjs`
  - `async function loadCasesDecoded({ limit, filter } = {})` in `_env.mjs`, returning snake_case row objects in `corpusId` order, each shaped per the column map above, plus `_receipt` carrying the untouched live Receipt for anything the map does not cover

⚠️ **`receiptToRow` goes in its own leaf module, not in `_env.mjs`.** `_env.mjs` reads `.env` and awaits an import of `packages/core/dist` at module scope, so importing it from a test requires both to exist — a field-mapping test must not depend on a populated `.env` and a built `dist`. This mirrors the existing `@fabric-tca/core/pure` leaf-subpath idiom.

- [ ] **Step 1: Write the failing test**

Create `scripts/analysis/rowShape.test.mjs`. It imports the leaf, so it hits neither the chain nor `.env`:

```javascript
import { describe, it, expect } from 'vitest';
import { receiptToRow } from './_rowShape.mjs';

describe('receiptToRow', () => {
	// The five column-reading scripts index rows by snake_case names inherited
	// from the DB dump. This mapping is the whole reason they need no rewrite.
	it('maps every column the analysis scripts read', () => {
		const receipt = {
			txHash: '0xabc', blockNumber: 123, aggregator: 'kyberswap',
			notionalUsd: 1000, tier: 'full', pricingStatus: 'full',
			allInCostBps: -12.5, slippageBps: -3.25, reconResidualBps: 0.5,
			decompConfidence: 'high', routeShape: 'single',
			normalizeFlags: ['A'], routeLegs: [{ type: 'v3', venue: '0xpool' }],
		};
		const row = receiptToRow(receipt, 485);
		expect(row.id).toBe(485);
		expect(row.tx_hash).toBe('0xabc');
		expect(row.block_number).toBe(123);
		expect(row.aggregator).toBe('kyberswap');
		expect(row.notional_usd).toBe(1000);
		expect(row.tier).toBe('full');
		expect(row.pricing_status).toBe('full');
		expect(row.all_in_cost_bps).toBe(-12.5);
		expect(row.slippage_bps).toBe(-3.25);
		expect(row.recon_residual_bps).toBe(0.5);
		expect(row.decomp_confidence).toBe('high');
		expect(row.route_shape).toBe('single');
		expect(row.normalize_flags).toEqual(['A']);
	});

	// Legs pass through untouched: corpus stored them camelCase, identical to
	// what the decoder emits. A translation layer here would be a bug.
	it('passes route legs through without translating them', () => {
		const legs = [{ type: 'v3', venue: '0xp', notionalUsdc: 5, priceImpactBps: 1.5, feeResolved: true }];
		const row = receiptToRow({ routeLegs: legs }, 1);
		expect(row.route_legs).toBe(legs);
	});

	// A failed decode must not masquerade as a decoded receipt with null columns —
	// every script filtering on `route_legs != null` would silently drop it and
	// report a smaller sample with no indication anything was missing.
	it('keeps the receipt reachable for fields the map does not cover', () => {
		const receipt = { routeLegs: [], marketMid: 1800, referenceDepthUsd: 42 };
		const row = receiptToRow(receipt, 1);
		expect(row._receipt.marketMid).toBe(1800);
		expect(row._receipt.referenceDepthUsd).toBe(42);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run scripts/analysis/rowShape.test.mjs
```

Expected: FAIL — cannot resolve `./_rowShape.mjs`.

- [ ] **Step 3: Implement the mapping leaf**

Create `scripts/analysis/_rowShape.mjs` containing ONLY the function below and its docstring. No imports, no module-scope work — that is the point of the file.

```javascript
/**
 * A live Receipt in the snake_case row shape the analysis scripts inherited from
 * the DB dump.
 *
 * This exists so migrating off corpus.json is a loader swap rather than five
 * rewritten analyses: every column those scripts read has a direct counterpart
 * on the Receipt. Leg objects pass through UNTRANSLATED — corpus stored them
 * camelCase, identical to what the decoder emits, so touching them here would
 * introduce a difference that does not exist.
 *
 * `_receipt` carries the whole live receipt for anything this map omits; prefer
 * reading it over widening the map, which exists to serve the legacy shape and
 * should not grow.
 */
export function receiptToRow(receipt, corpusId) {
	return {
		id: corpusId,
		tx_hash: receipt.txHash,
		chain_id: receipt.chainId,
		block_number: receipt.blockNumber,
		aggregator: receipt.aggregator,
		notional_usd: receipt.notionalUsd,
		tier: receipt.tier,
		pricing_status: receipt.pricingStatus,
		all_in_cost_bps: receipt.allInCostBps,
		slippage_bps: receipt.slippageBps,
		recon_residual_bps: receipt.reconResidualBps,
		decomp_confidence: receipt.decompConfidence,
		route_shape: receipt.routeShape,
		normalize_flags: receipt.normalizeFlags,
		route_legs: receipt.routeLegs,
		_receipt: receipt,
	};
}

Then add the live loader to `scripts/analysis/_env.mjs`, below `loadCases()`, re-exporting the leaf so callers have one import site:

```javascript
export { receiptToRow } from './_rowShape.mjs';
import { receiptToRow } from './_rowShape.mjs';

/**
 * Every case, decoded against TODAY's code and TODAY's chain.
 *
 * The replacement for `loadCorpus()`. That returned a frozen snapshot and so
 * could only tell you whether today's code disagreed with the code that produced
 * the snapshot; this tells you what today's code actually does.
 *
 * SERIAL on purpose, and it must stay that way: concurrent decodes of the same
 * transaction return different receipts with no flag, so a parallel version
 * would produce numbers that change between runs.
 *
 * Costs roughly 3.5-4 minutes for the full 62. Pass `limit` while iterating.
 * A transaction that fails to decode is REPORTED and skipped, never returned as
 * a row of nulls — every script here filters on `route_legs != null`, so a null
 * row would silently shrink the sample with nothing to show for it.
 */
export async function loadCasesDecoded({ limit = Infinity, filter } = {}) {
	const { analyzeTransaction } = await core('index.js');
	const rpcUrl = env.TCA_RPC_URL;
	if (!rpcUrl) throw new Error('TCA_RPC_URL missing from the repo-root .env');

	const cases = loadCases()
		.filter((c) => (filter ? filter(c) : true))
		.sort((a, b) => (a.corpusId ?? Infinity) - (b.corpusId ?? Infinity))
		.slice(0, limit);

	const rows = [];
	const failures = [];
	for (const [i, c] of cases.entries()) {
		try {
			const receipt = await analyzeTransaction(c.hash, c.chainId, { rpcUrl });
			if (receipt) rows.push(receiptToRow(receipt, c.corpusId ?? null));
			else failures.push([c.hash, 'null receipt']);
		} catch (err) {
			failures.push([c.hash, err.message]);
		}
		if ((i + 1) % 10 === 0) console.error(`  decoded ${i + 1}/${cases.length}`);
	}
	if (failures.length) {
		console.error(`⚠️  ${failures.length} of ${cases.length} failed to decode:`);
		for (const [hash, msg] of failures) console.error(`     ${hash.slice(0, 12)} ${msg}`);
	}
	return rows;
}
```

- [ ] **Step 4: Run the test**

```bash
npx vitest run scripts/analysis/rowShape.test.mjs
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Smoke the live path on a small limit**

```bash
node -e "
import('./scripts/analysis/_env.mjs').then(async (m) => {
  const rows = await m.loadCasesDecoded({ limit: 3 });
  console.log('rows', rows.length);
  console.log(rows.map((r) => [r.id, r.tx_hash.slice(0, 10), r.tier, r.notional_usd]));
});
"
```

Expected: 3 rows with real ids, tiers and notionals. This proves the adapter against the chain before five scripts depend on it.

- [ ] **Step 6: Commit**

```bash
git add scripts/analysis/_env.mjs scripts/analysis/_rowShape.mjs scripts/analysis/rowShape.test.mjs
git commit -m "$(cat <<'EOF'
feat(analysis): loadCasesDecoded, the live counterpart to loadCorpus

Decodes every case against today's code and today's chain, in the snake_case row
shape the analysis scripts inherited from the DB dump — so migrating them off
the frozen corpus is a loader swap, not five rewritten analyses.

Leg objects pass through untranslated: corpus stored them camelCase, identical
to what the decoder emits.

Serial on purpose and must stay that way — concurrent decodes of one transaction
return different receipts with no flag. A failed decode is reported and skipped
rather than returned as a row of nulls, which every caller's
`route_legs != null` filter would drop silently.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QsCVvRTgk8M5ZG7hoCTqbC
EOF
)"
```

---

### Task 3: Migrate the five decoded-column scripts

These are the ones that break silently if `corpus.json` disappears under them. Each is a two-line change plus a `--limit` flag, and each must have its output compared before and after.

**Files:**
- Modify: `scripts/analysis/reconResidual.mjs`, `blastRadius.mjs`, `attributionCoverage.mjs`, `coverageEstimate.mjs`, `unpricedCauses.mjs`

**Interfaces:**
- Consumes: `loadCasesDecoded()` from Task 2.

- [ ] **Step 1: Capture the BEFORE output of all five**

While `corpus.json` and `loadCorpus()` still exist:

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder
npm run typecheck
for s in reconResidual blastRadius attributionCoverage coverageEstimate unpricedCauses; do
  node "scripts/analysis/$s.mjs" > "$SCRATCH/before-$s.txt" 2>&1
done
wc -l "$SCRATCH"/before-*.txt
```

- [ ] **Step 2: Migrate each script**

For each of the five, make exactly this change. `reconResidual.mjs` shown; the other four differ only in name and in their existing `.filter()`:

```javascript
// BEFORE
import { loadCorpus, num, quantile } from './_env.mjs';
const rows = loadCorpus().filter((r) => r.route_legs != null);

// AFTER
import { loadCasesDecoded, num, quantile } from './_env.mjs';
const limitFlag = process.argv.find((a) => a.startsWith('--limit='));
const rows = (await loadCasesDecoded({ limit: limitFlag ? Number(limitFlag.slice(8)) : Infinity }))
	.filter((r) => r.route_legs != null);
```

Keep every existing `.filter()` predicate exactly as it is — they are the scripts' own scoping decisions and are not yours to change. Do not touch anything below the loader line.

⚠️ These files are ESM modules already using top-level `await` elsewhere, but confirm per file: if a script has no top-level `await` today, adding one is fine (they are `.mjs`), but check it is not wrapped in a `main()` you need to await inside instead.

- [ ] **Step 3: Capture the AFTER output**

```bash
set -a && source .env && set +a
for s in reconResidual blastRadius attributionCoverage coverageEstimate unpricedCauses; do
  node "scripts/analysis/$s.mjs" > "$SCRATCH/after-$s.txt" 2>&1
done
```

Each takes ~4 minutes. Budget 20 minutes and run them one at a time.

- [ ] **Step 4: Diff and classify — this is the deliverable, not a formality**

```bash
for s in reconResidual blastRadius attributionCoverage coverageEstimate unpricedCauses; do
  echo "===== $s ====="
  diff "$SCRATCH/before-$s.txt" "$SCRATCH/after-$s.txt" | head -40
done
```

**Numbers WILL move, and that is the finding, not a bug.** The before column is a snapshot taken weeks ago; the after column is today's code. Where they differ, that difference is precisely the rot this migration exists to remove — in particular the notional-depth-gating change (`8a88dc8`) moved 35 of 62 notionals and every notional-normalized attribution component with them.

Record the differences. Do NOT adjust a script to reproduce its old output.

Two differences to expect specifically, and to call out rather than treat as noise:
- `attributionCoverage.mjs` reads `l.feeResolved`, which was `undefined` on every corpus leg and is a real boolean on live legs. Its coverage numbers should get *more* accurate, not merely different.
- Any script filtering on `route_legs != null` may see a different row count if a transaction now fails to decode. `loadCasesDecoded` prints those failures — if the count dropped, the reason is in that output.

- [ ] **Step 5: Commit**

```bash
git add scripts/analysis/reconResidual.mjs scripts/analysis/blastRadius.mjs scripts/analysis/attributionCoverage.mjs scripts/analysis/coverageEstimate.mjs scripts/analysis/unpricedCauses.mjs
git commit -m "$(cat <<'EOF'
refactor(analysis): re-decode the five column-reading scripts

These read decoded columns as their actual subject matter, so they were the ones
that would have broken silently when corpus.json went — still running, quietly
reporting on nothing. They now decode against today's code.

Their numbers move, and the movement IS the finding: the before column was a
snapshot weeks old, and 8a88dc8 alone shifted 35 of 62 notionals plus every
attribution component normalized by them. attributionCoverage in particular gets
more accurate rather than merely different — it reads leg.feeResolved, which was
undefined on every frozen row.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QsCVvRTgk8M5ZG7hoCTqbC
EOF
)"
```

---

### Task 4: Migrate the seven hash-driven scripts

These already re-decode everything material; most read `corpus.json` only for hashes, block numbers and a few report annotations.

**Files:**
- Modify: `scripts/analysis/decodeGolden.mjs`, `decodeBench.mjs`, `rpcProviderAB.mjs`, `referencePoolInRoute.mjs`, `preTxRulerError.mjs`, `referenceDepthDistribution.mjs`, `scripts/marketMidSnapshot.mjs`

- [ ] **Step 1: Migrate the four that need only hashes**

`decodeGolden.mjs`, `decodeBench.mjs`, `rpcProviderAB.mjs` and `marketMidSnapshot.mjs` read `tx_hash`, `chain_id`, and (for `marketMidSnapshot`) `block_number` / tokens. Swap `loadCorpus()` for `loadCases()` and read `c.hash` / `c.chainId` / `c.blockNumber` directly — no decode needed, so these stay fast.

`decodeGolden.mjs` line 63 becomes:

```javascript
	const rows = loadCases().slice(0, limit).map((c) => ({ hash: c.hash, chainId: c.chainId ?? 8453 }));
```

⚠️ `rpcProviderAB.mjs` and `referencePoolInRoute.mjs` also print `r.id`, `r.input_symbol` and `r.output_symbol` as report labels. `id` becomes `c.corpusId`. The symbols are decoder output and are NOT on a case — take them from the receipt each script already decodes, or drop them from the label. Do not reintroduce them into `cases.json`.

⚠️ `marketMidSnapshot.mjs` reads `r.input_token` / `r.output_token` as INPUTS. Those are decoder output (the 7702/ERC-4337 anchoring work changed which tokens a receipt calls in and out), so they cannot come from the case file — the script must decode to get the pair. This makes it slower; that is correct.

- [ ] **Step 2: Migrate `referenceDepthDistribution.mjs` and `preTxRulerError.mjs`**

Both read the token pair as an input plus several columns as annotations. Use `loadCasesDecoded()` and take the pair from `_receipt.inputToken` / `_receipt.outputToken`.

⚠️ `referenceDepthDistribution.mjs` is the closest thing this repo has to a model for the pattern — everything material is already re-decoded live, which is why it survived the depth floor untouched. It still reads `input_token`/`output_token` as inputs and `tier`/`all_in_cost_bps`/`notional_usd`/`input_symbol` as annotations, so it does need this change.

- [ ] **Step 3: Verify each still runs**

```bash
set -a && source .env && set +a
node scripts/analysis/decodeBench.mjs --limit=3
node scripts/analysis/referenceDepthDistribution.mjs --limit=3
node scripts/analysis/referencePoolInRoute.mjs --limit=3
node scripts/analysis/preTxRulerError.mjs --limit=3
node scripts/marketMidSnapshot.mjs --limit=3
node scripts/analysis/rpcProviderAB.mjs --limit=3
node scripts/analysis/decodeGolden.mjs capture "$SCRATCH/migration-check.json" --limit=3
```

Every one must produce real output on 3 transactions. A script that errors on a missing column has a reference the migration missed.

- [ ] **Step 4: Commit**

```bash
git add scripts/analysis/decodeGolden.mjs scripts/analysis/decodeBench.mjs scripts/analysis/rpcProviderAB.mjs scripts/analysis/referencePoolInRoute.mjs scripts/analysis/preTxRulerError.mjs scripts/analysis/referenceDepthDistribution.mjs scripts/marketMidSnapshot.mjs
git commit -m "$(cat <<'EOF'
refactor(analysis): point the hash-driven scripts at cases.json

These already re-decoded everything material and read the frozen file mostly for
hashes and report labels. Symbols and token addresses do NOT come across: they
are decoder output, and the 7702/ERC-4337 anchoring work already changed which
tokens a receipt calls in and out. Scripts that need the pair now decode for it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QsCVvRTgk8M5ZG7hoCTqbC
EOF
)"
```

---

### Task 5: Delete the corpus

Only once every consumer above is migrated and verified.

**Files:**
- Delete: `docs/qa/corpus.json`, `scripts/corpus.test.mjs`
- Modify: `scripts/analysis/_env.mjs` (remove `loadCorpus`)

- [ ] **Step 1: Prove there are no readers left**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder
grep -rn "loadCorpus\|corpus.json" scripts/ packages/ docs/ --include="*.mjs" --include="*.ts" --include="*.tsx" --include="*.json"
```

Expected: hits only in `scripts/corpus.test.mjs` (about to be deleted), `_env.mjs`'s `loadCorpus` definition (about to be deleted), and prose references in `docs/`. **If any script still calls `loadCorpus()`, stop** — deleting the file under it is the exact silent breakage this plan's sequencing exists to prevent.

- [ ] **Step 2: Delete**

```bash
git rm docs/qa/corpus.json scripts/corpus.test.mjs
```

`scripts/corpus.test.mjs` asserted that every row had `tx_hash`, `notional_usd` and `route_legs` and cleared a $5 notional floor. Two of those three properties are gone by design, and `scripts/cases.test.mjs` from Task 1 covers what remains true. It is replaced, not merely dropped.

Then remove `loadCorpus()` and its docstring from `scripts/analysis/_env.mjs`, leaving `loadCases()` and `loadCasesDecoded()` as the only loaders.

- [ ] **Step 3: Full verification**

```bash
npx vitest run
npm run lint
npm run typecheck
```

Expected: green. Report the true counts.

- [ ] **Step 4: Update the spec**

Mark Part A of `docs/superpowers/specs/2026-08-12-corpus-migration-and-notional-gating.md` as shipped, and record what the Task 3 diffs showed — how far the frozen snapshot had drifted from today's code. That number is the argument for why the file is gone, and it exists nowhere else once `corpus.json` is deleted.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(qa): delete corpus.json, the last frozen snapshot

Every reader now re-decodes. The file mixed a curated list of interesting
transactions, which never rots, with a snapshot of decoded output, which rots on
every pricing change — and the depth floor had already staled 14 of its 62 rows
before the notional gating moved 35 more.

corpus.test.mjs is replaced by cases.test.mjs rather than dropped: two of the
three properties it asserted on are gone by design.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QsCVvRTgk8M5ZG7hoCTqbC
EOF
)"
```

---

## Not in this plan

- **A decode cache.** Repeat runs stay slow. Keying a cache on a hash of `packages/core/dist` would fix that without reintroducing staleness, and it is the natural follow-up — but it does not belong in the change that removes a cache-shaped file.
- **The both-sides-dust case** the notional-gating review asked for, to give the $100 depth floor live coverage. It is a `cases.json` addition and will be trivial once Task 1 lands, but it needs a transaction found by search, not by migration.
- **Re-tagging the migrated entries.** All 61 carry `tags: []`. Filling those in is curation work with no deadline, and doing it from decoded output would reintroduce exactly the rot this removes.
