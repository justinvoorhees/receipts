# Curated RFQ Makers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let RFQ makers that are unprovable by the two on-chain tiers be identified via a curated, human-attested address list, resolving the `0x3dbe077e7986…` maker.

**Architecture:** A hand-maintained `configs/makers.json` (following the `settlers.json`/`routers.json` precedent) loaded by a new `makerRegistry.ts` exposing a synchronous `isCuratedMaker`. `decomposeRoute` Step 4b consults it as a **last-resort tier** — only when the two on-chain tiers do not fire — and retypes the leg `rfq` with a distinct `RFQ_LEG_CURATED` audit flag while reusing the "Market Maker" treatment.

**Tech Stack:** TypeScript, vitest. Built with `tsc --build` from the repo root; tests via `npx vitest run`; lint via `npm run lint`.

## Global Constraints

- **Curated is last-resort.** The curated tier is checked only when neither on-chain tier proves the leg (`proven` first, `curated` only if `!proven`). On-chain proof always takes precedence.
- **Reuse the existing `rfq` treatment.** A curated match sets `leg.type = 'rfq'` — identical "Market Maker" label, deliberate-null pricing, no confidence downgrade (every downstream consumer keys off `leg.type === 'rfq'`). The ONLY difference is the audit flag: curated → `RFQ_LEG_CURATED`, proven → `RFQ_LEG_UNPRICED`.
- **Fail-closed load.** A missing/malformed `makers.json` degrades `isCuratedMaker` to always-false (empty set); it never throws.
- **The exact curated address is `0x3dbe077e7986657e95e1cc50089f17a5a4af0aae`.** Use it verbatim everywhere — never reconstruct or abbreviate it (a prior session wasted a cycle on a wrong reconstructed tail).
- **No DB retype.** Do not write to the database. Existing rows relabel only on on-demand re-analysis.
- **Baseline: 427 tests / 32 files.** The full suite must stay green (this feature ADDS tests, so the total will rise — record the new total).
- Gates per task: `npx tsc --build`, `npm run lint`, `npx vitest run`.
- Commit trailer:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01ATi8n599KY63NMFrzJzbg2
  ```

---

### Task 1: `configs/makers.json` + `makerRegistry.ts`

**Files:**
- Create: `configs/makers.json`
- Create: `packages/core/src/makerRegistry.ts`
- Create: `packages/core/src/makerRegistry.test.ts`

**Interfaces:**
- Produces: `isCuratedMaker(address: string): boolean` (synchronous, case-insensitive) from `packages/core/src/makerRegistry.js`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/makerRegistry.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { isCuratedMaker } from './makerRegistry.js';

describe('isCuratedMaker', () => {
	it('is true for the curated maker address, case-insensitively', () => {
		expect(isCuratedMaker('0x3dbe077e7986657e95e1cc50089f17a5a4af0aae')).toBe(true);
		expect(isCuratedMaker('0x3DBE077E7986657E95E1CC50089F17A5A4AF0AAE')).toBe(true);
	});
	it('is false for an address not on the list', () => {
		expect(isCuratedMaker('0x0000000000000000000000000000000000000001')).toBe(false);
	});
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `npx vitest run packages/core/src/makerRegistry.test.ts`
Expected: FAIL — cannot resolve `./makerRegistry.js` (module not created yet).

- [ ] **Step 3: Create `configs/makers.json`**

```json
{
	"_comment": "Curated RFQ market-maker addresses on Base. HAND-MAINTAINED — makers are not scan-discoverable; each entry is a human attestation with provenance. Consulted ONLY as a last-resort tier for `unknown` legs that neither RFQ tier proves (see decomposeRoute Step 4b, RFQ_LEG_CURATED). Identity is a SET (lookup uses `address` only).",
	"chainId": 8453,
	"makers": [
		{
			"address": "0x3dbe077e7986657e95e1cc50089f17a5a4af0aae",
			"label": "Market Maker",
			"provenance": "Cross-aggregator RFQ counterparty (Nordstern/KyberSwap/Velora); silent value-mover (emits no logs), no pool interface / fill event / EIP-1967 slot; 4084-byte plain contract; diversified multi-chain inventory; Basescan unlabeled. Unprovable by the two on-chain tiers — human-attested.",
			"addedBy": "justin@withfabric.xyz",
			"date": "2026-07-21"
		}
	]
}
```

- [ ] **Step 4: Create `packages/core/src/makerRegistry.ts`**

Model on `tagging.ts`'s sync-config pattern (top-level await load, try/catch → empty set):

```typescript
/**
 * makerRegistry.ts — curated RFQ market-maker addresses.
 *
 * Unlike settlerRegistry/routerRegistry, makers are NOT scan-discoverable: each
 * entry in configs/makers.json is a human attestation with provenance. This
 * registry is consulted only as a last-resort tier in decomposeRoute Step 4b, for
 * `unknown` legs that neither on-chain RFQ tier proves.
 *
 * `isCuratedMaker` is synchronous (the Step-4b loop calls it inline), so the config
 * is loaded once at module init and cached as a lowercased address Set. A
 * missing/malformed file degrades to an empty set — fail-closed, never throws.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface MakerEntry {
	address: string;
	label: string;
	provenance: string;
	addedBy?: string;
	date?: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAKERS_CONFIG_PATH = path.resolve(__dirname, '../../../configs/makers.json');

let curatedMakers: Set<string>;
try {
	const raw = await readFile(MAKERS_CONFIG_PATH, 'utf8');
	const parsed = JSON.parse(raw) as { makers?: MakerEntry[] };
	curatedMakers = new Set((parsed.makers ?? []).map((m) => m.address.toLowerCase()));
} catch {
	// Config unreadable (path moved, running outside the checkout) → no curated
	// makers rather than throwing. isCuratedMaker must never throw.
	curatedMakers = new Set();
}

/** True when `address` is a curated (human-attested) RFQ market maker. */
export function isCuratedMaker(address: string): boolean {
	return curatedMakers.has(address.toLowerCase());
}
```

- [ ] **Step 5: Run the test — expect pass**

Run: `npx vitest run packages/core/src/makerRegistry.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Gate — tsc + lint**

```bash
npx tsc --build && npm run lint
```
Expected: both clean. (`import.meta.url` requires the module system already used by `tagging.ts` — no config change needed since tagging compiles the same way.)

- [ ] **Step 7: Commit**

```bash
git add configs/makers.json packages/core/src/makerRegistry.ts packages/core/src/makerRegistry.test.ts
git commit -m "$(cat <<'EOF'
feat(core): curated RFQ maker registry (configs/makers.json)

Hand-maintained, human-attested maker-address list following the settlers/routers
config precedent, loaded by makerRegistry.isCuratedMaker (sync, fail-closed to an
empty set). Seeds the 0x3dbe077e7986 maker with provenance. Not yet wired into
detection (Task 2).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ATi8n599KY63NMFrzJzbg2
EOF
)"
```

---

### Task 2: Wire the curated tier into `decomposeRoute` Step 4b

**Files:**
- Modify: `packages/core/src/decomposeRoute.ts`
- Modify: `packages/core/src/decomposeRoute.test.ts` (add one test to the existing `rfq maker retype pass` describe block)

**Interfaces:**
- Consumes: `isCuratedMaker` from `./makerRegistry.js` (Task 1).

- [ ] **Step 1: Write the failing test**

In `packages/core/src/decomposeRoute.test.ts`, inside the existing `describe('rfq maker retype pass', …)` block (after the tier-2 test near line 991), add:

```typescript
    it('curated tier: retypes an unknown plain-contract leg listed in makers.json, flagged RFQ_LEG_CURATED', async () => {
      const curatedMaker = '0x3dbe077e7986657e95e1cc50089f17a5a4af0aae' as `0x${string}`;
      // trader USDC → curatedMaker → VIRTUAL → poolB → WETH; no fill event (tier 1
      // silent), rfqProbe returns 'contract' (tier 2 silent) — only the curated
      // list can classify it.
      const trace = {
        from: syntheticTrader,
        to: '0xcccccccccccccccccccccccccccccccccccccccc' as `0x${string}`,
        input: '0x' as `0x${string}`,
        logs: [
          swapLog(poolB),
          transferLog(USDC as `0x${string}`, syntheticTrader, curatedMaker, 1_000000n),
          transferLog(VIRTUAL as `0x${string}`, curatedMaker, poolB, 3_000000000000000000n),
          transferLog(WETH as `0x${string}`, poolB, syntheticTrader, 500000000000000n),
        ],
        calls: [],
      };
      const result = await decomposeRoute(makeInput(trace), {
        trace: trace as any,
        feeReader,
        rfqProbe: () => 'contract', // neither on-chain tier fires
      });
      const makerLeg = result.legs.find((l) => l.leg.venue === curatedMaker)!;
      expect(makerLeg.leg.type).toBe('rfq');
      expect(result.flags.some((f) => f.startsWith('RFQ_LEG_CURATED'))).toBe(true);
      expect(result.flags.some((f) => f.startsWith('RFQ_LEG_UNPRICED'))).toBe(false);
    });
```

- [ ] **Step 2: Run it — expect failure**

Run: `npx vitest run packages/core/src/decomposeRoute.test.ts -t "curated tier"`
Expected: FAIL — the leg stays `unknown` (curated tier not wired), so `makerLeg.leg.type` is `'unknown'`, not `'rfq'`.

- [ ] **Step 3: Add the import**

In `packages/core/src/decomposeRoute.ts`, add near the other `./` imports:
```typescript
import { isCuratedMaker } from './makerRegistry.js';
```

- [ ] **Step 4: Replace the Step-4b retype loop**

Find the existing loop (the maker retype pass):
```typescript
	for (const leg of graph.legs) {
		if (leg.type !== 'unknown') continue;
		const isMaker = fillEmitters.has(leg.venue) || (await rfqProbe(leg.venue)) !== 'contract';
		if (!isMaker) continue;
		leg.type = 'rfq';
		routeFlags.push(`RFQ_LEG_UNPRICED: leg ${leg.venue.slice(0, 10)} — off-chain quote, no on-chain mid exists`);
	}
```
Replace it with (on-chain tiers first, curated as last resort, distinct flag):
```typescript
	for (const leg of graph.legs) {
		if (leg.type !== 'unknown') continue;
		const proven = fillEmitters.has(leg.venue) || (await rfqProbe(leg.venue)) !== 'contract';
		const curated = !proven && isCuratedMaker(leg.venue);
		if (!proven && !curated) continue;
		leg.type = 'rfq';
		routeFlags.push(
			proven
				? `RFQ_LEG_UNPRICED: leg ${leg.venue.slice(0, 10)} — off-chain quote, no on-chain mid exists`
				: `RFQ_LEG_CURATED: leg ${leg.venue.slice(0, 10)} — curated market maker (human-attested), no on-chain mid exists`,
		);
	}
```

- [ ] **Step 5: Run the new test — expect pass**

Run: `npx vitest run packages/core/src/decomposeRoute.test.ts -t "curated tier"`
Expected: PASS.

- [ ] **Step 6: Run the whole rfq describe block — confirm no regression**

Run: `npx vitest run packages/core/src/decomposeRoute.test.ts -t "rfq maker retype pass"`
Expected: all pass — the tier-1 and tier-2 tests still flag `RFQ_LEG_UNPRICED` (their makers are not in `makers.json`, so they hit the `proven` branch).

- [ ] **Step 7: Gate — tsc, lint, full suite**

```bash
npx tsc --build && npm run lint && npx vitest run 2>&1 | grep -E "Tests |Test Files "
```
Expected: clean / clean / 32 files, and Tests = 427 + the new tests (record the number; it should be 430 if 3 new tests landed — 2 in Task 1, 1 here).

- [ ] **Step 8: Verify end-to-end on demand (no DB write)**

With the dev server on `:3000`, re-analyze row 53's tx and confirm the curated leg now reads "Market Maker":
```bash
curl -s "http://localhost:3000/?tx=0xb169b2e5b0ef710bc32be123260e2eaf3263636839bf3abcd3c2a57e9b8bf536" | grep -c "Market Maker"
```
Expected: ≥ 1 (the `0x3dbe077e7986…` leg renders "Market Maker" instead of "Unknown Pool"). Note: this is an on-demand recompute; it does NOT persist unless the row is (re)saved. If the dev server is not running, note it and rely on the suite; do NOT run `next build`.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/decomposeRoute.ts packages/core/src/decomposeRoute.test.ts
git commit -m "$(cat <<'EOF'
feat(core): curated maker tier in decomposeRoute RFQ retype

The RFQ maker retype pass now falls back to the curated makers.json list when
neither on-chain tier proves an `unknown` leg. Curated matches get the identical
`rfq` treatment (Market Maker label, deliberate-null pricing) but a distinct
RFQ_LEG_CURATED audit flag, recording that identity was human-attested. On-chain
proof still takes precedence. Resolves the 0x3dbe077e7986 maker on re-analysis.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ATi8n599KY63NMFrzJzbg2
EOF
)"
```

---

### Task 3: Update the RFQ / backlog memory

**Files:**
- Modify: `/Users/justinvoorhees/.claude/projects/-Users-justinvoorhees-withfabricxyz-fabric-tca-decoder/memory/rfq-maker-legs.md`
- Modify: `/Users/justinvoorhees/.claude/projects/-Users-justinvoorhees-withfabricxyz-fabric-tca-decoder/memory/MEMORY.md`

- [ ] **Step 1: Record the curated-maker resolution**

In `rfq-maker-legs.md`, update the "Fail-closed known limitation" paragraph: the `0x3dbe077e7986657e95e1cc50089f17a5a4af0aae` maker is now resolved via a curated `configs/makers.json` + `makerRegistry.isCuratedMaker`, wired as a last-resort tier in decomposeRoute Step 4b with a distinct `RFQ_LEG_CURATED` flag. Note it now covers 4 rows across 3 aggregators (Nordstern 53 / KyberSwap 236 / Velora 208,210), NO DB retype was done (rows relabel on re-analysis), and the address was verified on-chain (4084-byte plain contract, impl slot 0, emits no logs). Add a one-line pointer in MEMORY.md if warranted. (Memory files are outside the repo — no commit.)

---

## Notes for the executor

- **Task order:** Task 1 before Task 2 — the curated test in Task 2 depends on `makers.json` and `isCuratedMaker` existing.
- **The curated test relies on the REAL `makers.json`.** `isCuratedMaker` is a module singleton that loads the real config; there is no injection seam, so the Task-2 test deliberately uses the real curated address `0x3dbe077e7986657e95e1cc50089f17a5a4af0aae`. If you change the seed address in `makers.json`, that test changes with it.
- **If a gate fails,** the fix is in the wiring, not the on-chain tiers — do not weaken the `proven`-first ordering or the fail-closed load.
