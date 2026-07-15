# Aggregator Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Identify aggregators by rotation-proof on-chain identity instead of a hardcoded address list, so 0x Settler (21% of Base aggregator volume, currently landing as raw hex) resolves correctly today and after every future rotation.

**Architecture:** A refresh script scans the 0x Deployer's ERC721 `Transfer` logs into a committed `configs/settlers.json`. A synchronous resolver consults that set, then the curated `routers.json`, and otherwise returns unknown — never guessing from event topics, because aggregators nest. Topics keep a verification role and gain a triage-hint role.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), viem, vitest, Node 20, Postgres/Drizzle.

**Spec:** `docs/superpowers/specs/2026-07-15-aggregator-detection-design.md`

## Global Constraints

- **Never run `npm run build`** — it runs `next build` into the same `.next` a running `next dev` owns and breaks dev CSS. Use `npx tsc --build` to compile core.
- **`labelAddress` and `resolveAggregator` must stay synchronous** — `analyzeTransaction.ts:271` calls them synchronously. Registries load via top-level `await` at module load, mirroring `tagging.ts:50-61`.
- **Never throw from labeling/resolution.** Unloadable config degrades to an empty registry, mirroring `tagging.ts:53-61`.
- **Topics never determine identity.** Only the Deployer registry and curated `routers.json` may auto-label. This is Design Decision 1; do not "improve" on it.
- **Addresses are stored and compared lowercase.**
- **ESM imports need the `.js` extension** even for `.ts` sources (e.g. `import { x } from './foo.js'`).
- **Chain is Base, chainId 8453.** Deployer address `0x00000000000004533fe15556b1e086bb1a72ceae` is identical on every chain.
- Tests run from the repo root: `npx vitest run <path>`. Note vitest CLI args are **substring filters**, not exact paths.
- Do not trust historical test counts. True baseline: **24 files / 304 tests**.

## Deliberate deviations from the spec

Three, all mechanical — flagged so a reviewer doesn't read them as drift:

1. **The spec's single `aggregatorResolver.ts` is split into `settlerRegistry.ts` (config loading, testable without I/O) and `resolveAggregator.ts` (the precedence chain).** This mirrors the existing `routerRegistry.ts` / `tagging.ts` split exactly, and keeps the chain logic unit-testable apart from file loading.
2. **Scripts live at `packages/core/src/scripts/`, not a repo-root `scripts/`.** The repo has no `tsx`/`ts-node` and adding a runner dependency for two scripts isn't worth it. The established path is `tsc --build` → `node packages/core/dist/...`, which the npm scripts wrap.
3. **The refresh script has no recorded-log fixture.** The spec asked for one, but all the logic lives in `parseDeployerTransfers`, which Task 1 fixture-tests against handcrafted mint/rotate/burn logs. What's left is I/O glue, verified in Task 3 by asserting exact counts (57 settlers, feature 2's newest == receipt 179's `to`) against live chain data. A recorded fixture would test the mock, not the scan.

---

### Task 1: Parse Deployer transfers into settler entries

Pure function, no I/O. Converts raw ERC721 `Transfer` logs into the address set.

**Files:**
- Create: `packages/core/src/settlerRegistry.ts`
- Test: `packages/core/src/settlerRegistry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SettlerEntry` (`{aggregator: string; feature: number; address: string; fromBlock: number; source: string}`), `parseDeployerTransfers(logs, aggregator): SettlerEntry[]`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/settlerRegistry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseDeployerTransfers } from './settlerRegistry.js';

// ERC721 Transfer topics: [sig, from, to, tokenId]. tokenId == feature number.
const SIG = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (addr: string) => '0x' + addr.slice(2).padStart(64, '0');
const ZERO = '0x0000000000000000000000000000000000000000';
const A = '0xbec2c2f65085c674da686b8229fa2b42f9b2f27b';
const B = '0x3d868cd3f8f24da361364e442411dae23cd79cc4';
const C = '0x109969447f53b29ee4b446323c41757b97481906';

const log = (from: string, to: string, feature: number, block: number) => ({
	topics: [SIG, pad(from), pad(to), '0x' + feature.toString(16).padStart(64, '0')],
	blockNumber: '0x' + block.toString(16),
});

describe('parseDeployerTransfers', () => {
	it('records the mint target as a settler at its mint block', () => {
		const out = parseDeployerTransfers([log(ZERO, A, 2, 14769149)], '0x');
		expect(out).toEqual([
			{ aggregator: '0x', feature: 2, address: A, fromBlock: 14769149, source: 'deployer-transfer-scan' },
		]);
	});

	it('keeps BOTH sides of a rotation — identity is a set, not a timeline', () => {
		const out = parseDeployerTransfers(
			[log(ZERO, A, 2, 14769149), log(A, B, 2, 14890301)],
			'0x',
		);
		expect(out.map((e) => e.address)).toEqual([A, B]);
	});

	it('filters the zero address so a burn does not enter the set', () => {
		const out = parseDeployerTransfers(
			[log(ZERO, C, 1, 12723120), log(C, ZERO, 1, 14859201)],
			'0x',
		);
		expect(out.map((e) => e.address)).toEqual([C]);
		expect(out.map((e) => e.address)).not.toContain(ZERO);
	});

	it('dedupes a re-registered address to its earliest block', () => {
		const out = parseDeployerTransfers([log(ZERO, A, 2, 500), log(B, A, 2, 900)], '0x');
		expect(out).toHaveLength(1);
		expect(out[0]!.fromBlock).toBe(500);
	});

	it('lowercases addresses', () => {
		const out = parseDeployerTransfers([log(ZERO, A.toUpperCase(), 2, 1)], '0x');
		expect(out[0]!.address).toBe(A);
	});

	it('sorts by feature then block', () => {
		const out = parseDeployerTransfers(
			[log(ZERO, B, 4, 100), log(ZERO, A, 2, 200), log(ZERO, C, 2, 50)],
			'0x',
		);
		expect(out.map((e) => e.feature)).toEqual([2, 2, 4]);
		expect(out.map((e) => e.fromBlock)).toEqual([50, 200, 100]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run settlerRegistry`
Expected: FAIL — `Failed to resolve import "./settlerRegistry.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/core/src/settlerRegistry.ts`:

```ts
/**
 * settlerRegistry.ts — the rotation-proof aggregator address set.
 *
 * 0x Settler's address rotates on every release (feature 2 has rotated 19
 * times). Rather than hardcode addresses, we read them from 0x's own on-chain
 * Deployer/registry — an ERC721 at 0x0000…72ceae (same address on every chain)
 * where tokenId == feature number and the owner is that feature's live Settler.
 * Every rotation is therefore a Transfer, and scanning Transfers yields the
 * complete history.
 *
 * Identity is a SET, not a timeline (Design Decision 2). We only ever ask "is
 * this address 0x?", never "is this the CURRENT Settler?", so an address that
 * was ever a Settler stays identifiable forever. That makes historical trades
 * resolve for free and dissolves 0x's deployment dwell-time problem entirely —
 * no prev() call needed. `fromBlock` is recorded for audit only and is never
 * consulted at lookup.
 */

import { readFile } from 'node:fs/promises';

export interface SettlerEntry {
	aggregator: string;
	feature: number;
	address: string;
	fromBlock: number;
	source: string;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Extract the 20-byte address from a 32-byte indexed topic. */
function topicToAddress(topic: string): string {
	return ('0x' + topic.slice(26)).toLowerCase();
}

/**
 * Fold ERC721 Transfer logs into the set of every address ever registered to a
 * feature. Burns (transfers to the zero address) retire a feature but do not
 * add an address — the pre-burn owner stays in the set, because it really was a
 * Settler. Feature 1 on Base is exactly this case: minted at 12723120, burned
 * at 14859201.
 */
export function parseDeployerTransfers(
	logs: readonly { topics: readonly string[]; blockNumber: string }[],
	aggregator: string,
): SettlerEntry[] {
	const byAddress = new Map<string, SettlerEntry>();
	for (const l of logs) {
		const to = topicToAddress(l.topics[2]!);
		if (to === ZERO_ADDRESS) continue;
		const feature = Number(BigInt(l.topics[3]!));
		const fromBlock = Number(BigInt(l.blockNumber));
		const prev = byAddress.get(to);
		if (!prev || fromBlock < prev.fromBlock) {
			byAddress.set(to, { aggregator, feature, address: to, fromBlock, source: 'deployer-transfer-scan' });
		}
	}
	return [...byAddress.values()].sort(
		(a, b) => a.feature - b.feature || a.fromBlock - b.fromBlock,
	);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run settlerRegistry`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/settlerRegistry.ts packages/core/src/settlerRegistry.test.ts
git commit -m "feat(core): parse 0x Deployer Transfer logs into a settler address set"
```

---

### Task 2: Settler registry loader

Adds the async loader + indexed lookup. Mirrors `routerRegistry.ts:22-31` exactly.

**Files:**
- Modify: `packages/core/src/settlerRegistry.ts`
- Modify: `packages/core/src/settlerRegistry.test.ts`

**Interfaces:**
- Consumes: `SettlerEntry`, `parseDeployerTransfers` (Task 1).
- Produces: `SettlerRegistry` (`{byAddressLower: Map<string, SettlerEntry>; all: readonly SettlerEntry[]}`), `loadSettlerRegistry(path): Promise<SettlerRegistry>`, `SettlersConfig`.

- [ ] **Step 1: Write the failing test**

In `packages/core/src/settlerRegistry.test.ts`, extend the **existing** import to
`import { parseDeployerTransfers, loadSettlerRegistry } from './settlerRegistry.js';`
(do not add a second import from the same module — the linter rejects duplicates), add the
node imports at the top, then append the new describe block:

```ts
// add alongside the existing imports at the top of the file
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// append at the end of the file
describe('loadSettlerRegistry', () => {
	async function writeConfig(body: unknown): Promise<string> {
		const dir = await mkdtemp(path.join(tmpdir(), 'settlers-'));
		const p = path.join(dir, 'settlers.json');
		await writeFile(p, JSON.stringify(body), 'utf8');
		return p;
	}

	it('indexes settlers by lowercase address', async () => {
		const p = await writeConfig({
			deployer: '0x00000000000004533fe15556b1e086bb1a72ceae',
			chainId: 8453,
			settlers: [
				{ aggregator: '0x', feature: 2, address: '0x7747f8d2a76bd6345cc29622a946a929647f2359', fromBlock: 44438102, source: 'deployer-transfer-scan' },
			],
		});
		const reg = await loadSettlerRegistry(p);
		expect(reg.byAddressLower.get('0x7747f8d2a76bd6345cc29622a946a929647f2359')!.aggregator).toBe('0x');
		expect(reg.all).toHaveLength(1);
	});

	it('is case-insensitive on lookup', async () => {
		const p = await writeConfig({
			deployer: '0x0', chainId: 8453,
			settlers: [{ aggregator: '0x', feature: 2, address: '0x7747F8D2A76BD6345CC29622A946A929647F2359', fromBlock: 1, source: 's' }],
		});
		const reg = await loadSettlerRegistry(p);
		expect(reg.byAddressLower.get('0x7747f8d2a76bd6345cc29622a946a929647f2359')).toBeTruthy();
	});

	it('throws on a missing file so the caller can decide to degrade', async () => {
		await expect(loadSettlerRegistry('/nonexistent/settlers.json')).rejects.toThrow();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run settlerRegistry`
Expected: FAIL — `loadSettlerRegistry is not exported`.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/core/src/settlerRegistry.ts`:

```ts
export interface SettlersConfig {
	_comment?: string;
	generatedAt?: string;
	deployer: string;
	chainId: number;
	settlers: SettlerEntry[];
}

export interface SettlerRegistry {
	byAddressLower: Map<string, SettlerEntry>;
	all: readonly SettlerEntry[];
}

/**
 * Load and index `configs/settlers.json`. Throws if unreadable — callers that
 * must not fail (the resolver) catch and degrade to an empty registry.
 */
export async function loadSettlerRegistry(path: string): Promise<SettlerRegistry> {
	const raw = await readFile(path, 'utf8');
	const parsed = JSON.parse(raw) as SettlersConfig;
	const byAddressLower = new Map<string, SettlerEntry>();
	for (const s of parsed.settlers ?? []) {
		byAddressLower.set(s.address.toLowerCase(), s);
	}
	return { byAddressLower, all: parsed.settlers ?? [] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run settlerRegistry`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/settlerRegistry.ts packages/core/src/settlerRegistry.test.ts
git commit -m "feat(core): add settler registry loader"
```

---

### Task 3: Refresh script + generated `configs/settlers.json`

Generates the real config from live chain data and commits it.

**Files:**
- Create: `packages/core/src/scripts/refreshSettlers.ts`
- Create: `configs/settlers.json` (generated output — commit it)
- Modify: `package.json` (root, add script)

**Interfaces:**
- Consumes: `parseDeployerTransfers`, `SettlersConfig` (Tasks 1–2).
- Produces: `configs/settlers.json` conforming to `SettlersConfig`.

**Context:** the repo has no `tsx`/`ts-node`. The established path is compile-then-run: `npx tsc --build` emits to `packages/core/dist/`, then `node packages/core/dist/...`. Do **not** add a runner dependency.

- [ ] **Step 1: Write the script**

Create `packages/core/src/scripts/refreshSettlers.ts`:

```ts
/**
 * Regenerate configs/settlers.json from the 0x Deployer's ERC721 Transfer logs.
 *
 * Run:  npm run settlers:refresh
 *
 * Rotation happens a few times a year, so this is on-demand, and its output is
 * committed and reviewed as a diff. The whole history fits in ONE unranged
 * eth_getLogs (58 logs as of 2026-07-15) — no block-chunking needed.
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseDeployerTransfers, type SettlersConfig } from '../settlerRegistry.js';

const DEPLOYER = '0x00000000000004533fe15556b1e086bb1a72ceae';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const CHAIN_ID = 8453;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.resolve(__dirname, '../../../../configs/settlers.json');

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
	const json = (await res.json()) as { result?: unknown; error?: { message: string } };
	if (json.error) throw new Error(`${method} failed: ${json.error.message}`);
	return json.result;
}

async function main(): Promise<void> {
	const rpcUrl = process.env.TCA_RPC_URL;
	if (!rpcUrl) throw new Error('TCA_RPC_URL is not set — export it or source .env');

	const logs = (await rpc(rpcUrl, 'eth_getLogs', [
		{ address: DEPLOYER, topics: [TRANSFER_TOPIC], fromBlock: '0x0', toBlock: 'latest' },
	])) as { topics: string[]; blockNumber: string }[];

	const settlers = parseDeployerTransfers(logs, '0x');
	if (settlers.length === 0) {
		// Never write an empty set — that would silently un-identify every 0x
		// trade. Fail loudly and leave the last-known-good config in place.
		throw new Error('Deployer scan produced 0 settlers — refusing to overwrite config');
	}

	const config: SettlersConfig = {
		_comment:
			'GENERATED by `npm run settlers:refresh` — do not hand-edit. Every address ever ' +
			'registered to a 0x Deployer feature. Identity is a set: `fromBlock` is audit-only ' +
			'and is not consulted at lookup. Features: 2=taker-submitted, 3=gasless/metatxn, ' +
			'4=intents, 5=bridge. Feature 1 is retired (minted 12723120, burned 14859201).',
		generatedAt: new Date().toISOString(),
		deployer: DEPLOYER,
		chainId: CHAIN_ID,
		settlers,
	};

	await writeFile(OUT_PATH, JSON.stringify(config, null, '\t') + '\n', 'utf8');
	const features = [...new Set(settlers.map((s) => s.feature))].sort((a, b) => a - b);
	console.log(`Wrote ${settlers.length} settlers (features ${features.join(', ')}) → ${OUT_PATH}`);
}

main().catch((e: unknown) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
```

- [ ] **Step 2: Add the npm script**

In root `package.json`, add to `"scripts"` (note: `tsc --build`, **not** `npm run build`):

```json
"settlers:refresh": "tsc --build && node packages/core/dist/scripts/refreshSettlers.js"
```

- [ ] **Step 3: Run it and verify the output**

```bash
source .env && npm run settlers:refresh
```

Expected: `Wrote 57 settlers (features 1, 2, 3, 4, 5) → …/configs/settlers.json`

Verify the counts and the known-good tail (feature 2's newest must be the address from receipt id 179):

```bash
node -e '
const c = require("./configs/settlers.json");
const byF = {};
for (const s of c.settlers) (byF[s.feature] ??= []).push(s);
console.log("total:", c.settlers.length);
for (const f of Object.keys(byF).sort()) console.log("  feature", f + ":", byF[f].length);
const f2 = byF[2].sort((a,b)=>b.fromBlock-a.fromBlock)[0];
console.log("feature 2 newest:", f2.address, "@", f2.fromBlock);
console.log("zero addr present:", c.settlers.some(s=>/^0x0+$/.test(s.address)));
'
```

Expected exactly:
```
total: 57
  feature 1: 1
  feature 2: 19
  feature 3: 19
  feature 4: 11
  feature 5: 7
feature 2 newest: 0x7747f8d2a76bd6345cc29622a946a929647f2359 @ 44438102
zero addr present: false
```

If `total` is not 57, **stop** — either the scan is wrong or 0x rotated since 2026-07-15. Confirm against `ownerOf` before proceeding:

```bash
source .env && curl -s -X POST "$TCA_RPC_URL" -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x00000000000004533fe15556b1e086bb1a72ceae","data":"0x6352211e0000000000000000000000000000000000000000000000000000000000000002"},"latest"]}'
```
The last 40 hex chars must equal feature 2's newest address.

- [ ] **Step 4: Commit**

```bash
git add configs/settlers.json packages/core/src/scripts/refreshSettlers.ts package.json
git commit -m "feat(core): generate configs/settlers.json from the 0x Deployer registry"
```

---

### Task 4: Widen signatures to multi-topic; backfill Odos; mark 0x anonymous

Must land **before** Task 6. Once `analyzeTransaction` starts labeling 0x correctly, `AGGREGATOR_SIGNATURES['0x']` gets found, and its stale ExchangeProxy `settlementContract` would emit a spurious `SETTLEMENT_EVENT_MISSING` flag on every 0x trade. The `detectBy: 'none'` marker added here prevents that.

**Files:**
- Modify: `packages/core/src/aggregatorSignatures.ts`
- Modify: `packages/core/src/aggregatorSignatures.test.ts`
- Modify: `configs/routers.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `SettlementSignature` with `eventTopics: readonly string[]` (replaces `eventTopic0`) and `detectBy?: 'router' | 'event_anywhere' | 'none'`; `matchSettlementEvent(logs, sig): string | null`; `findAggregatorHints(logs): string[]`; `settlementEventPresent(logs, sig): boolean` (retained wrapper).

**Verified topic values** (derived from the DefiLlama Odos adapter ABI, then confirmed on-chain — do not re-derive):

| Signature | topic0 |
|---|---|
| `Swap(address,uint256,address,uint256,address,int256,uint32)` | `0x823eaf01002d7353fbcadb2ea3305cc46fa35d799cb0914846d185ac06f8ad05` |
| `SwapMulti(address,uint256[],address[],uint256[],address[],uint32)` | `0x7d7fb03518253ae01913536628b78d6d82e63e19b943aab5f4948356021259be` |
| `Swap(address,uint256,address,uint256,address,int256,uint64,uint64,address)` | `0x69db20ca9e32403e6c56e5193b3e3b2827ae5c430ccfdea392ba950d2d1ab2bc` |
| `SwapMulti(address,uint256[],address[],uint256[],address[],int256[],uint64,uint64,address)` | `0x2c96555a96d94780f3a97aeb724514e80e331842f3143742d85da5aa68df9d30` |

- [ ] **Step 1: Write the failing test**

Replace the whole `describe('settlementEventPresent', …)` block in `packages/core/src/aggregatorSignatures.test.ts` and add new blocks. Full replacement for the file's contents **after** line 32 (keep the existing `findSettlementEvents` describe block, but change its third test's field name as shown):

```ts
// In the existing `findSettlementEvents` describe block, replace the
// 'has a signature entry per v1 provider' test with:
	it('has a signature entry per v1 provider', () => {
		for (const slug of ['fabric', 'kyberswap', '0x', 'nordstern', 'odos', 'relay', 'velora']) {
			expect(AGGREGATOR_SIGNATURES[slug]).toBeTruthy();
			expect(AGGREGATOR_SIGNATURES[slug]!.settlementContract).toMatch(/^0x[0-9a-f]{40}$/);
			expect(Array.isArray(AGGREGATOR_SIGNATURES[slug]!.eventTopics)).toBe(true);
		}
	});
```

Then replace everything from `describe('settlementEventPresent', …)` onward with:

```ts
describe('matchSettlementEvent', () => {
	describe('router mode (default)', () => {
		const sig = {
			aggregator: 'test', settlementContract: ROUTER,
			eventTopics: ['0xaaa'], eventName: null,
		};

		it('returns the matched topic when emitted by the settlement contract', () => {
			expect(matchSettlementEvent([{ address: ROUTER, topics: ['0xaaa'] }], sig)).toBe('0xaaa');
		});

		it('returns null when the topic comes from a different address', () => {
			expect(matchSettlementEvent([{ address: '0xpool', topics: ['0xaaa'] }], sig)).toBeNull();
		});

		it('returns null when the topic is absent entirely', () => {
			expect(matchSettlementEvent([{ address: ROUTER, topics: ['0xzzz'] }], sig)).toBeNull();
		});

		it('matches ANY listed topic when several are registered', () => {
			const multi = { ...sig, eventTopics: ['0xaaa', '0xbbb'] };
			expect(matchSettlementEvent([{ address: ROUTER, topics: ['0xbbb'] }], multi)).toBe('0xbbb');
		});

		it('falls back to the first observed non-noise event when no topics are registered', () => {
			const unknown = { ...sig, eventTopics: [] };
			expect(matchSettlementEvent([{ address: ROUTER, topics: ['0xnew'] }], unknown)).toBe('0xnew');
		});

		it('is case-insensitive on the observed topic', () => {
			expect(matchSettlementEvent([{ address: ROUTER, topics: ['0xAAA'] }], sig)).toBe('0xaaa');
		});
	});

	describe("detectBy 'event_anywhere'", () => {
		const sig = {
			aggregator: 'test', settlementContract: ROUTER,
			eventTopics: ['0xbbb'], eventName: null, detectBy: 'event_anywhere' as const,
		};

		it('matches on ANY address, not just the router', () => {
			expect(matchSettlementEvent([{ address: '0xother', topics: ['0xbbb'] }], sig)).toBe('0xbbb');
		});

		it('returns null when absent', () => {
			expect(matchSettlementEvent([{ address: '0xother', topics: ['0xccc'] }], sig)).toBeNull();
		});

		it('returns null when no topics are registered', () => {
			expect(matchSettlementEvent([{ address: ROUTER, topics: ['0xbbb'] }], { ...sig, eventTopics: [] })).toBeNull();
		});
	});

	describe("detectBy 'none' (anonymous log)", () => {
		it('never matches — 0x Settler emits a zero-topic log that no topic rule can see', () => {
			const sig = AGGREGATOR_SIGNATURES['0x']!;
			expect(sig.detectBy).toBe('none');
			expect(sig.eventTopics).toEqual([]);
			// The real anonymous log from tx 0xb02037…9e26: topics is empty.
			const logs = [{ address: '0x7747f8d2a76bd6345cc29622a946a929647f2359', topics: [] as string[] }];
			expect(matchSettlementEvent(logs, sig)).toBeNull();
		});
	});
});

describe('settlementEventPresent', () => {
	it('is a boolean wrapper over matchSettlementEvent', () => {
		const sig = { aggregator: 't', settlementContract: ROUTER, eventTopics: ['0xaaa'], eventName: null };
		expect(settlementEventPresent([{ address: ROUTER, topics: ['0xaaa'] }], sig)).toBe(true);
		expect(settlementEventPresent([{ address: ROUTER, topics: ['0xzzz'] }], sig)).toBe(false);
	});
});

describe('Odos backfill (verified against receipts id 75/78 and the live V3 router)', () => {
	const ODOS_SWAP_V2 = '0x823eaf01002d7353fbcadb2ea3305cc46fa35d799cb0914846d185ac06f8ad05';
	const ODOS_SWAP_V3 = '0x69db20ca9e32403e6c56e5193b3e3b2827ae5c430ccfdea392ba950d2d1ab2bc';
	const ODOS_V3_ROUTER = '0x0d05a7d3448512b78fa8a9e46c4872c88c4a0d05';

	it('registers all four Odos topics', () => {
		expect(AGGREGATOR_SIGNATURES['odos']!.eventTopics).toHaveLength(4);
	});

	it('matches the v2 Swap topic seen in receipts id 75 and 78', () => {
		const logs = [{ address: ROUTER, topics: [ODOS_SWAP_V2] }];
		expect(matchSettlementEvent(logs, AGGREGATOR_SIGNATURES['odos']!)).toBe(ODOS_SWAP_V2);
	});

	it('matches the V3 router, which is not the registered settlementContract', () => {
		const logs = [{ address: ODOS_V3_ROUTER, topics: [ODOS_SWAP_V3] }];
		expect(matchSettlementEvent(logs, AGGREGATOR_SIGNATURES['odos']!)).toBe(ODOS_SWAP_V3);
	});

	it('no longer accepts an arbitrary non-noise event — the check can now fail', () => {
		const logs = [{ address: ROUTER, topics: ['0xdeadbeef'] }];
		expect(matchSettlementEvent(logs, AGGREGATOR_SIGNATURES['odos']!)).toBeNull();
	});
});

describe('findAggregatorHints', () => {
	it('names aggregators whose settlement topic appears anywhere in the logs', () => {
		const nordstern = AGGREGATOR_SIGNATURES['nordstern']!.eventTopics[0]!;
		expect(findAggregatorHints([{ address: '0xanything', topics: [nordstern] }])).toEqual(['nordstern']);
	});

	it('returns empty when no known topic is present', () => {
		expect(findAggregatorHints([{ address: '0xanything', topics: ['0xnope'] }])).toEqual([]);
	});

	it('never names 0x — its anonymous log is invisible to topic matching', () => {
		expect(findAggregatorHints([{ address: '0x7747f8d2a76bd6345cc29622a946a929647f2359', topics: [] }])).toEqual([]);
	});
});
```

Update the test file's import line to:

```ts
import { findSettlementEvents, AGGREGATOR_SIGNATURES, settlementEventPresent, matchSettlementEvent, findAggregatorHints } from './aggregatorSignatures.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run aggregatorSignatures`
Expected: FAIL — `matchSettlementEvent is not exported`.

- [ ] **Step 3: Write the implementation**

In `packages/core/src/aggregatorSignatures.ts`, replace the `SettlementSignature` interface, the `AGGREGATOR_SIGNATURES` map, and `settlementEventPresent`:

```ts
export interface SettlementSignature {
	aggregator: string;
	settlementContract: string;
	/** Known settlement topics (lowercase). Empty = not yet discovered; router
	 *  mode then falls back to "any non-noise event from settlementContract". */
	eventTopics: readonly string[];
	eventName: string | null;
	/** 'router' (default): topic must come FROM settlementContract.
	 *  'event_anywhere': topic may come from any contract — for aggregators whose
	 *  settlement event lives on a per-route executor (Velora) or on a second
	 *  router not listed as settlementContract (Odos V3).
	 *  'none': this aggregator is not topic-detectable at all (0x — anonymous log).
	 *  NB: these modes govern VERIFICATION only. Identity always comes from
	 *  `to` via the resolver/curated tiers — see resolveAggregator.ts. */
	detectBy?: 'router' | 'event_anywhere' | 'none';
}

export const AGGREGATOR_SIGNATURES: Record<string, SettlementSignature> = {
	// Odos runs TWO live routers emitting different-arity events, so it needs
	// multiple topics AND event_anywhere (the V3 router is not settlementContract).
	// Topics derived from the DefiLlama adapter ABI, then confirmed on-chain:
	// 0x823eaf01 appears in receipts id 75/78; 0x69db20ca fired 272x from the V3
	// router in ~9000 blocks. Before this, eventTopics was empty and the router-mode
	// fallback accepted ANY non-noise event — settlement_event_seen was vacuous.
	odos: {
		aggregator: 'odos', settlementContract: '0x19ceead7105607cd444f5ad10dd51356436095a1',
		eventTopics: [
			'0x823eaf01002d7353fbcadb2ea3305cc46fa35d799cb0914846d185ac06f8ad05', // Swap v2
			'0x7d7fb03518253ae01913536628b78d6d82e63e19b943aab5f4948356021259be', // SwapMulti v2
			'0x69db20ca9e32403e6c56e5193b3e3b2827ae5c430ccfdea392ba950d2d1ab2bc', // Swap v3
			'0x2c96555a96d94780f3a97aeb724514e80e331842f3143742d85da5aa68df9d30', // SwapMulti v3
		],
		eventName: 'Swap', detectBy: 'event_anywhere',
	},
	// 0x Settler emits an ANONYMOUS log (topics: []), so no topic rule can ever
	// see it — `findSettlementEvents` skips zero-topic logs by construction.
	// Identity comes from the Deployer registry instead (configs/settlers.json).
	// settlementContract below is the RETIRED ExchangeProxy, kept for provenance
	// only; detectBy 'none' stops it producing a false SETTLEMENT_EVENT_MISSING.
	'0x': {
		aggregator: '0x', settlementContract: '0xdef1c0ded9bec7f1a1670819833240f027b25eff',
		eventTopics: [], eventName: null, detectBy: 'none',
	},
	// KyberSwap MetaAggregationRouterV2: keccak(Swapped(address,address,address,address,uint256,uint256))
	kyberswap: {
		aggregator: 'kyberswap', settlementContract: '0x6131b5fae19ea4f9d964eac0408e4408b66337b5',
		eventTopics: ['0xd6d4f5681c246c9f42c203e287975af1601f8df8035a9251f79aab5c8f09e2f8'], eventName: 'Swapped',
	},
	'1inch': {
		aggregator: '1inch', settlementContract: '0x111111125421ca6dc452d289314280a0f8842a65',
		eventTopics: [], eventName: null,
	}, // no sample tx in our dataset — deferred per the spec's stop rule
	// executor-emitted settlement event (per-route executor, not the Augustus router);
	// exact ABI name unidentified; observed in smoke-36 0x12adf9d1…
	velora: {
		aggregator: 'velora', settlementContract: '0x6a000f20005980200259b80c5102003040001068',
		eventTopics: ['0x8b3e96f2b889fa771c53c981b40daf005f63f637f1869f707052d15a3dd97140'],
		eventName: null, detectBy: 'event_anywhere',
	},
	fabric: {
		aggregator: 'fabric', settlementContract: '0x7c137a37742437d2212b7bd873ed135b5c4c61da',
		eventTopics: ['0xa17e8d88f61171e605d4e0dfc13de5f313c34d72184d9c5cbfc70e27be23fdc8'], eventName: null,
	}, // discovered: 0x9703bfa3…
	nordstern: {
		aggregator: 'nordstern', settlementContract: '0xc87de04e2ec1f4282dff2933a2d58199f688fc3d',
		eventTopics: ['0x97d8fe5395a5423bef64e2004851e9b3f60f7848835afa581b4a0a8e84bc662d'], eventName: null,
	}, // discovered: 0x0d4227d1…
	relay: {
		aggregator: 'relay', settlementContract: '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be',
		eventTopics: ['0xafbab204e8271965231d37baed9b1abca8725b7409c70314455f68bc89142b91'], eventName: null,
	}, // discovered: 0x8fa230b6…
};
```

Then replace `settlementEventPresent` with:

```ts
/**
 * The settlement topic actually observed for this aggregator, or null. Returns
 * the MATCHED topic (not the expected one) so callers can record what really
 * fired — which is also how an unknown aggregator's topic gets discovered.
 */
export function matchSettlementEvent(
	logs: readonly { address: string; topics: readonly string[] }[],
	sig: SettlementSignature,
): string | null {
	if (sig.detectBy === 'none') return null;

	const want = sig.eventTopics.map((t) => t.toLowerCase());

	if (sig.detectBy === 'event_anywhere') {
		if (want.length === 0) return null;
		for (const l of logs) {
			const t = l.topics[0]?.toLowerCase();
			if (t && want.includes(t)) return t;
		}
		return null;
	}

	const events = findSettlementEvents(logs, sig.settlementContract);
	if (want.length === 0) return events[0]?.topic0 ?? null;
	for (const e of events) if (want.includes(e.topic0)) return e.topic0;
	return null;
}

/** True if the aggregator's distinctive settlement event is present. */
export function settlementEventPresent(
	logs: readonly { address: string; topics: readonly string[] }[],
	sig: SettlementSignature,
): boolean {
	return matchSettlementEvent(logs, sig) !== null;
}

/**
 * Slugs of aggregators whose settlement topic appears ANYWHERE in the logs.
 *
 * This is a TRIAGE HINT, never an identity. "unknown `to` + known inner topic"
 * cannot distinguish a known aggregator's new router from a novel
 * meta-aggregator routing THROUGH a known one — both look identical from logs.
 * So we surface the evidence for a human and label nothing. See Design
 * Decision 1.
 */
export function findAggregatorHints(
	logs: readonly { address: string; topics: readonly string[] }[],
): string[] {
	const seen = new Set<string>();
	for (const l of logs) {
		const t = l.topics[0]?.toLowerCase();
		if (t) seen.add(t);
	}
	const hits = new Set<string>();
	for (const [slug, sig] of Object.entries(AGGREGATOR_SIGNATURES)) {
		if (sig.detectBy === 'none') continue;
		if (sig.eventTopics.some((topic) => seen.has(topic.toLowerCase()))) hits.add(slug);
	}
	return [...hits].sort();
}
```

Also update the file's header comment: replace the sentence `` `eventTopic0`/`eventName` start null and are filled in as we inspect the first sample tx per aggregator (Checkpoint A).`` with:

```
 * `eventTopics` starts empty and is filled in from a real sample tx per
 * aggregator. NOTE: these signatures verify a match and seed triage hints —
 * they never establish identity. Identity comes from `to` (resolveAggregator).
```

- [ ] **Step 4: Add the Odos V3 router to the curated tier**

In `configs/routers.json`, replace the Odos entry's `_comment` line and add a second Odos entry directly after it:

```json
		{
			"name": "Odos",
			"address": "0x19cEeAd7105607Cd444F5ad10dd51356436095a1",
			"version": "V2",
			"fee_recipients": [],
			"detection": "to_address",
			"active": true,
			"_verified": "OdosRouterV2 on Base."
		},
		{
			"name": "Odos",
			"address": "0x0D05a7D3448512B78fa8A9e46c4872C88C4a0D05",
			"version": "V3",
			"fee_recipients": [],
			"detection": "to_address",
			"active": true,
			"_verified": "Surfaced by the DefiLlama odos adapter, then confirmed on-chain 2026-07-15: 17,084-byte contract emitting Swap v3 topic 0x69db20ca 272x in ~9000 blocks. Closes the standing 'deferred: also add Odos V3' comment."
		},
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run aggregatorSignatures`
Expected: PASS.

Then confirm no other consumer broke on the `eventTopic0` → `eventTopics` rename:

Run: `npx tsc --build`
Expected: **one** error, in `analyzeTransaction.ts:409` (`sig?.eventTopic0` no longer exists). Task 6 fixes it. If any *other* file errors, fix it there before continuing.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/aggregatorSignatures.ts packages/core/src/aggregatorSignatures.test.ts configs/routers.json
git commit -m "feat(core): multi-topic signatures, verified Odos backfill, mark 0x anonymous-log"
```

---

### Task 5: The resolver — precedence chain + triage hints

**Files:**
- Create: `packages/core/src/resolveAggregator.ts`
- Test: `packages/core/src/resolveAggregator.test.ts`

**Interfaces:**
- Consumes: `loadSettlerRegistry` (Task 2), `configs/settlers.json` (Task 3), `findAggregatorHints` (Task 4), `labelAddress` from `tagging.js`.
- Produces: `resolveAggregator(to: string | null, logs): AggregatorResolution` where `AggregatorResolution = {label: string; slug: string; detectedVia: 'resolver' | 'address' | 'unknown'; hints: string[]}`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/resolveAggregator.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveAggregator } from './resolveAggregator.js';
import { AGGREGATOR_SIGNATURES } from './aggregatorSignatures.js';

const SETTLER_CURRENT = '0x7747f8d2a76bd6345cc29622a946a929647f2359'; // feature 2, blk 44438102
const SETTLER_RETIRED = '0xdc5d8200a030798bc6227240f68b4dd9542686ef'; // feature 2, retired at 44438102
const KYBER_ROUTER = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';
const KYBER_TOPIC = AGGREGATOR_SIGNATURES['kyberswap']!.eventTopics[0]!;
const NORDSTERN_TOPIC = AGGREGATOR_SIGNATURES['nordstern']!.eventTopics[0]!;
const UNKNOWN = '0x1234567890123456789012345678901234567890';

describe('resolveAggregator — resolver tier', () => {
	it('resolves the current 0x Settler (receipt id 179 regression)', () => {
		const r = resolveAggregator(SETTLER_CURRENT, []);
		expect(r.label).toBe('0x');
		expect(r.slug).toBe('0x');
		expect(r.detectedVia).toBe('resolver');
	});

	it('resolves a RETIRED Settler — identity is a set, not a timeline', () => {
		const r = resolveAggregator(SETTLER_RETIRED, []);
		expect(r.label).toBe('0x');
		expect(r.detectedVia).toBe('resolver');
	});

	it('is case-insensitive', () => {
		expect(resolveAggregator(SETTLER_CURRENT.toUpperCase(), []).label).toBe('0x');
	});
});

describe('resolveAggregator — address tier', () => {
	it('resolves a curated router', () => {
		const r = resolveAggregator(KYBER_ROUTER, []);
		expect(r.label).toBe('KyberSwap');
		expect(r.slug).toBe('kyberswap');
		expect(r.detectedVia).toBe('address');
	});
});

describe('resolveAggregator — nesting guard (Design Decision 1)', () => {
	it('a known `to` WINS over a foreign inner topic', () => {
		// A Kyber trade that routes through Nordstern internally must stay Kyber.
		const logs = [{ address: '0xinner', topics: [NORDSTERN_TOPIC] }];
		const r = resolveAggregator(KYBER_ROUTER, logs);
		expect(r.label).toBe('KyberSwap');
		expect(r.detectedVia).toBe('address');
		expect(r.hints).toEqual([]);
	});

	it('a 0x Settler `to` WINS over an inner topic (trade 0xb02037…9e26 shape)', () => {
		const logs = [{ address: '0xinner', topics: [KYBER_TOPIC] }];
		expect(resolveAggregator(SETTLER_CURRENT, logs).label).toBe('0x');
	});

	it('does NOT auto-label an unknown `to` from an inner topic — it hints instead', () => {
		// Indistinguishable from "new meta-aggregator routing through Nordstern",
		// so we must not guess.
		const logs = [{ address: '0xinner', topics: [NORDSTERN_TOPIC] }];
		const r = resolveAggregator(UNKNOWN, logs);
		expect(r.label).toBe(UNKNOWN);
		expect(r.detectedVia).toBe('unknown');
		expect(r.hints).toEqual(['nordstern']);
	});
});

describe('resolveAggregator — unknown tier', () => {
	it('returns the raw address with no hints when nothing matches', () => {
		const r = resolveAggregator(UNKNOWN, [{ address: '0xx', topics: ['0xnope'] }]);
		expect(r.label).toBe(UNKNOWN);
		expect(r.detectedVia).toBe('unknown');
		expect(r.hints).toEqual([]);
	});

	it('handles a null `to` (contract creation)', () => {
		const r = resolveAggregator(null, []);
		expect(r.label).toBe('unknown');
		expect(r.detectedVia).toBe('unknown');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run resolveAggregator`
Expected: FAIL — `Failed to resolve import "./resolveAggregator.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/resolveAggregator.ts`:

```ts
/**
 * resolveAggregator.ts — who did the taker actually trade with?
 *
 * Precedence (Design Decision 1):
 *   1. Resolver — `to` is in the 0x Deployer registry set (configs/settlers.json)
 *   2. Address  — `to` is a curated router (configs/routers.json)
 *   3. Unknown  — no guess; emit a triage hint carrying any topic evidence
 *
 * Note this INVERTS the venue chain (topic → factory() → address list). For
 * venues the pool address is the thing. For aggregators, `to` is the thing:
 * it is the contract the taker called, and therefore IS the aggregator they
 * used. Settlement topics are evidence about who is INSIDE the trade, and
 * aggregators nest — trade 0xb02037…9e26 has a Bebop settlement inside a 0x
 * route. Topic-based identity cannot tell "Nordstern shipped a new router"
 * from "a new meta-aggregator routes through Nordstern"; both are "unknown
 * `to` + known inner topic". So topics never label. A wrong attribution is
 * worse than `unknown`: `unknown` is honest and gets triaged.
 *
 * Both auto-labeling tiers are declarations, not inferences — 0x publishes its
 * own Settler addresses on-chain, and routers.json is human-verified.
 *
 * Synchronous by contract: analyzeTransaction.ts calls this inline.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadSettlerRegistry, type SettlerRegistry } from './settlerRegistry.js';
import { findAggregatorHints } from './aggregatorSignatures.js';
import { labelAddress } from './tagging.js';

export type DetectedVia = 'resolver' | 'address' | 'unknown';

export interface AggregatorResolution {
	/** Display name: '0x', 'KyberSwap', or the raw address when unknown. */
	label: string;
	/** Lowercased label — the AGGREGATOR_SIGNATURES key. */
	slug: string;
	detectedVia: DetectedVia;
	/** Aggregator slugs whose settlement topic appears in the logs. Populated
	 *  ONLY when detectedVia === 'unknown'; a hint is never an identity. */
	hints: string[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTLERS_CONFIG_PATH = path.resolve(__dirname, '../../../configs/settlers.json');

let settlerRegistry: SettlerRegistry;
try {
	settlerRegistry = await loadSettlerRegistry(SETTLERS_CONFIG_PATH);
} catch {
	// Degrade to "no known settlers" rather than throw — resolveAggregator must
	// never fail. Mirrors tagging.ts's contract.
	settlerRegistry = { byAddressLower: new Map(), all: [] };
}

export function resolveAggregator(
	to: string | null,
	logs: readonly { address: string; topics: readonly string[] }[],
): AggregatorResolution {
	if (!to) return { label: 'unknown', slug: 'unknown', detectedVia: 'unknown', hints: [] };

	const lower = to.toLowerCase();

	// Tier 1: the aggregator declares this address as its own, on-chain.
	const settler = settlerRegistry.byAddressLower.get(lower);
	if (settler) {
		return {
			label: settler.aggregator,
			slug: settler.aggregator.toLowerCase(),
			detectedVia: 'resolver',
			hints: [],
		};
	}

	// Tier 2: curated, human-verified.
	const labeled = labelAddress(to);
	if (labeled.kind === 'router') {
		return {
			label: labeled.label,
			slug: labeled.label.toLowerCase(),
			detectedVia: 'address',
			hints: [],
		};
	}

	// Tier 3: no guess.
	return { label: to, slug: lower, detectedVia: 'unknown', hints: findAggregatorHints(logs) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run resolveAggregator`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/resolveAggregator.ts packages/core/src/resolveAggregator.test.ts
git commit -m "feat(core): add resolveAggregator precedence chain with nesting guard"
```

---

### Task 6: Wire the resolver into `analyzeTransaction`

**Files:**
- Modify: `packages/core/src/analyzeTransaction.ts` (lines ~270-272, ~316-328, ~408-409)
- Modify: `packages/core/src/index.ts` (export the new surface)

**Interfaces:**
- Consumes: `resolveAggregator` (Task 5), `matchSettlementEvent` (Task 4).
- Produces: `Receipt.settlementEventTopic0` now carries the **matched** topic rather than the expected one; `normalizeFlags` gains `AGGREGATOR_DETECTED_VIA:` and possibly `AGGREGATOR_UNKNOWN_HINT:`.

- [ ] **Step 1: Move the log projection above the aggregator label**

`receiptLogs` is currently built at line ~317, but the resolver needs it at ~271. Delete this line from its current position:

```ts
		const receiptLogs = receipt.logs.map((l) => ({ address: l.address, topics: l.topics }));
```

and re-insert it immediately **above** the `// Aggregator label` comment at line ~270.

- [ ] **Step 2: Replace the aggregator label lines**

Replace lines ~270-272:

```ts
		// Aggregator label (best-effort; unknown → raw address, never fails).
		const aggregator = tx.to ? labelAddress(tx.to).label : 'unknown';
		const aggSlug = aggregator.toLowerCase();
```

with:

```ts
		// Aggregator identity: Deployer registry → curated routers → unknown.
		// Never inferred from event topics; see resolveAggregator.ts.
		const resolution = resolveAggregator(tx.to ?? null, receiptLogs);
		const aggregator = resolution.label;
		const aggSlug = resolution.slug;
```

- [ ] **Step 3: Update the settlement-event block**

Replace lines ~318-328:

```ts
		const sig = AGGREGATOR_SIGNATURES[aggSlug];
		const settlementEventSeen = sig ? settlementEventPresent(receiptLogs, sig) : false;

		const flags = [...route.flags];
		if (midImplausible)
			flags.push(
				`IMPLAUSIBLE_MID: deviation ${allInCostBpsRaw?.toExponential(2)}bps exceeds the plausibility cap — reference mid discarded, degraded to partial`,
			);
		if (!sig) flags.push(`NO_SIGNATURE: unknown aggregator '${aggSlug}'`);
		if (sig && !settlementEventSeen)
			flags.push(`SETTLEMENT_EVENT_MISSING: no distinctive event from ${sig.settlementContract}`);
```

with:

```ts
		const sig = AGGREGATOR_SIGNATURES[aggSlug];
		// Record the topic that actually fired, not the one we expected.
		const matchedTopic = sig ? matchSettlementEvent(receiptLogs, sig) : null;
		const settlementEventSeen = matchedTopic !== null;

		const flags = [...route.flags];
		if (midImplausible)
			flags.push(
				`IMPLAUSIBLE_MID: deviation ${allInCostBpsRaw?.toExponential(2)}bps exceeds the plausibility cap — reference mid discarded, degraded to partial`,
			);
		flags.push(`AGGREGATOR_DETECTED_VIA: ${resolution.detectedVia}`);
		for (const hint of resolution.hints)
			flags.push(
				`AGGREGATOR_UNKNOWN_HINT: to=${tx.to} carries ${hint}'s settlement topic — candidate for triage, NOT auto-labeled (it may be a new ${hint} router, or a new aggregator routing through ${hint})`,
			);
		if (!sig) flags.push(`NO_SIGNATURE: unknown aggregator '${aggSlug}'`);
		// detectBy 'none' means "not topic-detectable by construction" (0x's
		// anonymous log) — a missing event is expected, not a defect.
		if (sig && sig.detectBy !== 'none' && !settlementEventSeen)
			flags.push(`SETTLEMENT_EVENT_MISSING: no distinctive event from ${sig.settlementContract}`);
```

- [ ] **Step 4: Store the matched topic**

Replace line ~409:

```ts
			settlementEventTopic0: sig?.eventTopic0 ?? null,
```

with:

```ts
			settlementEventTopic0: matchedTopic,
```

- [ ] **Step 5: Fix the imports**

In `analyzeTransaction.ts`, update the aggregatorSignatures import (line ~31) to:

```ts
import { AGGREGATOR_SIGNATURES, matchSettlementEvent } from './aggregatorSignatures.js';
```

and add:

```ts
import { resolveAggregator } from './resolveAggregator.js';
```

`labelAddress` may now be unused in this file — if `npx tsc --build` reports it unused, remove it from its import. Do **not** remove `tagging.ts` itself; `resolveAggregator` uses it.

In `packages/core/src/index.ts`, add:

```ts
export { resolveAggregator, type AggregatorResolution, type DetectedVia } from './resolveAggregator.js';
export { loadSettlerRegistry, parseDeployerTransfers, type SettlerEntry, type SettlerRegistry } from './settlerRegistry.js';
```

- [ ] **Step 6: Verify the build and the full suite**

Run: `npx tsc --build`
Expected: clean, no errors.

Run: `npx vitest run`
Expected: PASS. Baseline is **24 files / 304 tests**; you have added 3 files, so expect **27 files** and ~330+ tests. If any *previously passing* test now fails, fix it before committing.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/analyzeTransaction.ts packages/core/src/index.ts
git commit -m "feat(core): resolve aggregator identity via registry chain, record matched topic"
```

---

### Task 7: Coverage gap report

Reporting only — writes no config, labels nothing.

**Files:**
- Create: `packages/core/src/aggregatorCoverage.ts`
- Test: `packages/core/src/aggregatorCoverage.test.ts`
- Create: `packages/core/src/scripts/reportAggregatorCoverage.ts`
- Create: `packages/core/src/__fixtures__/defillama-base-aggregators.json`
- Modify: `package.json` (root, add script)

**Interfaces:**
- Consumes: nothing.
- Produces: `computeCoverage(protocols, coveredModules): CoverageReport` where `CoverageReport = {totalUsd: number; coveredUsd: number; missingUsd: number; liveCount: number; gaps: {name: string; module: string; volumeUsd: number}[]}`; `COVERED_MODULES: Record<string, string>`.

- [ ] **Step 1: Record the fixture**

Tests must not hit live HTTP — volumes move daily and would make the suite flap.

```bash
curl -s "https://api.llama.fi/overview/aggregators/base?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);
      console.log(JSON.stringify({protocols:(r.protocols||[]).map(p=>({name:p.name,displayName:p.displayName,module:p.module,total24h:p.total24h}))},null,"\t"));})' \
  > packages/core/src/__fixtures__/defillama-base-aggregators.json
head -12 packages/core/src/__fixtures__/defillama-base-aggregators.json
```

Expected: a `protocols` array of ~65 entries, each with `module` and `total24h`.

- [ ] **Step 2: Write the failing test**

Create `packages/core/src/aggregatorCoverage.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { computeCoverage, COVERED_MODULES, type LlamaProtocol } from './aggregatorCoverage.js';

// Read the fixture rather than `import ... with { type: 'json' }` — `tsc --build`
// compiles test files, and a JSON import would be emitted into dist for no gain.
const fixturePath = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'__fixtures__/defillama-base-aggregators.json',
);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { protocols: LlamaProtocol[] };

describe('computeCoverage', () => {
	const protocols = [
		{ name: 'KyberSwap Aggregator', displayName: 'KyberSwap', module: 'kyberswap', total24h: 100 },
		{ name: 'OKX Swap', displayName: 'OKX Swap', module: 'okx', total24h: 60 },
		{ name: 'fly.trade', displayName: 'fly.trade', module: 'magpie', total24h: 40 },
		{ name: 'Dead Agg', displayName: 'Dead Agg', module: 'dead', total24h: 0 },
		{ name: 'Null Agg', displayName: 'Null Agg', module: 'nullagg', total24h: null },
	];

	it('splits covered from missing by module', () => {
		const r = computeCoverage(protocols, { kyberswap: 'KyberSwap' });
		expect(r.coveredUsd).toBe(100);
		expect(r.missingUsd).toBe(100);
		expect(r.totalUsd).toBe(200);
	});

	it('excludes zero- and null-volume aggregators from the live set', () => {
		const r = computeCoverage(protocols, { kyberswap: 'KyberSwap' });
		expect(r.liveCount).toBe(3);
	});

	it('ranks gaps by volume, descending', () => {
		const r = computeCoverage(protocols, { kyberswap: 'KyberSwap' });
		expect(r.gaps.map((g) => g.module)).toEqual(['okx', 'magpie']);
	});

	it('reports no gaps when everything is covered', () => {
		const r = computeCoverage(protocols, { kyberswap: 'K', okx: 'O', magpie: 'M' });
		expect(r.gaps).toEqual([]);
		expect(r.missingUsd).toBe(0);
	});

	it('maps every covered module to an aggregator we actually label', () => {
		for (const slug of Object.keys(COVERED_MODULES)) {
			expect(typeof COVERED_MODULES[slug]).toBe('string');
		}
		expect(COVERED_MODULES['zrx']).toBe('0x');
	});

	it('finds a real gap in the recorded DefiLlama fixture', () => {
		const r = computeCoverage(fixture.protocols, COVERED_MODULES);
		expect(r.liveCount).toBeGreaterThan(20);
		expect(r.missingUsd).toBeGreaterThan(0);
		expect(r.gaps.map((g) => g.module)).toContain('okx');
		// 0x must count as COVERED once the resolver lands.
		expect(r.gaps.map((g) => g.module)).not.toContain('zrx');
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run aggregatorCoverage`
Expected: FAIL — `Failed to resolve import "./aggregatorCoverage.js"`.

- [ ] **Step 4: Write the implementation**

Create `packages/core/src/aggregatorCoverage.ts`:

```ts
/**
 * aggregatorCoverage.ts — which Base aggregators do we not cover?
 *
 * DefiLlama's aggregator list gives NAMES and VOLUME but no addresses (every
 * protocol returns `address: undefined`), so it can never tag anything. Its
 * only value is knowing what we don't know: a gap list ranked by volume.
 *
 * This is a REPORT. Per Design Decision 5, DefiLlama is third-party inference
 * and must never auto-label — it feeds the curated tier via human + on-chain
 * verification. Nothing here writes config.
 *
 * The gap list is a research queue, not addresses to paste: the wallet
 * front-ends (OKX, Bitget, Binance) plausibly route THROUGH other aggregators,
 * and CoWSwap (batch intents) / Bebop (RFQ) settle in shapes our decomposition
 * has never seen. Each is its own investigation.
 */

export interface LlamaProtocol {
	name: string;
	displayName?: string;
	module: string;
	total24h: number | null;
}

export interface CoverageGap {
	name: string;
	module: string;
	volumeUsd: number;
}

export interface CoverageReport {
	totalUsd: number;
	coveredUsd: number;
	missingUsd: number;
	liveCount: number;
	gaps: CoverageGap[];
}

/**
 * DefiLlama `module` → the label we resolve it to. 'zrx' counts as covered
 * because the Deployer resolver identifies 0x Settler. Relay and Fabric have no
 * entry: DefiLlama classifies Relay as a bridge and does not list Fabric, so
 * this list is NOT a superset of what we need.
 */
export const COVERED_MODULES: Record<string, string> = {
	kyberswap: 'KyberSwap',
	zrx: '0x',
	odos: 'Odos',
	'1inch-agg': '1inch',
	paraswap: 'Velora',
	'nordstern-finance': 'Nordstern',
};

export function computeCoverage(
	protocols: readonly LlamaProtocol[],
	coveredModules: Record<string, string>,
): CoverageReport {
	const live = protocols.filter((p) => (p.total24h ?? 0) > 0);
	let coveredUsd = 0;
	let missingUsd = 0;
	const gaps: CoverageGap[] = [];

	for (const p of live) {
		const vol = p.total24h ?? 0;
		if (coveredModules[p.module]) {
			coveredUsd += vol;
		} else {
			missingUsd += vol;
			gaps.push({ name: p.displayName ?? p.name, module: p.module, volumeUsd: vol });
		}
	}

	gaps.sort((a, b) => b.volumeUsd - a.volumeUsd);
	return { totalUsd: coveredUsd + missingUsd, coveredUsd, missingUsd, liveCount: live.length, gaps };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run aggregatorCoverage`
Expected: PASS — 6 tests.

- [ ] **Step 6: Write the report script**

Create `packages/core/src/scripts/reportAggregatorCoverage.ts`:

```ts
/**
 * Print the Base aggregator coverage gap, ranked by 24h volume.
 *
 * Run:  npm run aggregators:coverage
 *
 * Reports only — writes no config and labels nothing.
 */

import { computeCoverage, COVERED_MODULES, type LlamaProtocol } from '../aggregatorCoverage.js';

const API = 'https://api.llama.fi/overview/aggregators/base' +
	'?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true';

const usd = (n: number) => '$' + (n / 1e6).toFixed(1) + 'M';

async function main(): Promise<void> {
	const res = await fetch(API);
	if (!res.ok) throw new Error(`DefiLlama returned ${res.status}`);
	const body = (await res.json()) as { protocols?: LlamaProtocol[] };
	const report = computeCoverage(body.protocols ?? [], COVERED_MODULES);

	const pct = (n: number) => ((100 * n) / report.totalUsd).toFixed(0) + '%';
	console.log(`\nBase aggregator volume (24h): ${usd(report.totalUsd)} across ${report.liveCount} live aggregators\n`);
	console.log(`  COVERED  ${usd(report.coveredUsd).padStart(8)}  ${pct(report.coveredUsd)}`);
	console.log(`  MISSING  ${usd(report.missingUsd).padStart(8)}  ${pct(report.missingUsd)}\n`);
	console.log('Gaps by volume (a research queue, not addresses to paste):');
	for (const g of report.gaps.slice(0, 15)) {
		console.log(`  ${usd(g.volumeUsd).padStart(8)}  ${g.name}  (module: ${g.module})`);
	}
	console.log('');
}

main().catch((e: unknown) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
```

Add to root `package.json` `"scripts"`:

```json
"aggregators:coverage": "tsc --build && node packages/core/dist/scripts/reportAggregatorCoverage.js"
```

- [ ] **Step 7: Run the report**

Run: `npm run aggregators:coverage`
Expected output shape (exact numbers will drift from the 2026-07-15 baseline of $102.1M / 59% covered / $42.2M missing):

```
Base aggregator volume (24h): $10X.XM across 4X live aggregators

  COVERED     $XX.XM  ~59%
  MISSING     $XX.XM  ~41%

Gaps by volume (a research queue, not addresses to paste):
     $11.9M  OKX Swap  (module: okx)
     $10.8M  fly.trade  (module: magpie)
     ...
```

Sanity check: `zrx` must **not** appear in the gap list.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/aggregatorCoverage.ts packages/core/src/aggregatorCoverage.test.ts \
        packages/core/src/scripts/reportAggregatorCoverage.ts \
        packages/core/src/__fixtures__/defillama-base-aggregators.json package.json
git commit -m "feat(core): add Base aggregator coverage gap report"
```

---

### Task 8: End-to-end verification + repopulate receipts 179/183

**Files:**
- Modify: `packages/core/src/analyzeTransaction.test.ts`

**Interfaces:**
- Consumes: `analyzeTransaction(hash, chainId, {rpcUrl})` (Task 6).
- Produces: nothing downstream.

**⚠️ Gotcha:** RPC e2e tests **silently skip** unless `TCA_RPC_URL` is exported. `dotenv` does not reliably pick up the repo-root `.env` from `packages/core`. Always `source .env` first, and confirm the test actually ran rather than trusting a green suite.

- [ ] **Step 1: Write the failing e2e test**

Append to `packages/core/src/analyzeTransaction.test.ts`:

```ts
describe('analyzeTransaction — 0x Settler identity (e2e)', () => {
	// The tx that motivated this work. `to` = 0x7747f8d2… = 0x Settler feature 2.
	const ZEROX_TX = '0xb02037466b0756a3972f77d674413a0d7468663aca62e8c6eb757f15ced59e26';

	it.skipIf(!RPC)('labels the 0x Settler trade as 0x, via the resolver', async () => {
		const r = await analyzeTransaction(ZEROX_TX, 8453, { rpcUrl: RPC! });
		expect(r).toBeTruthy();
		expect(r!.aggregator).toBe('0x');
		expect(r!.normalizeFlags).toContain('AGGREGATOR_DETECTED_VIA: resolver');
	}, 60_000);

	it.skipIf(!RPC)('does not emit a spurious SETTLEMENT_EVENT_MISSING for 0x', async () => {
		// 0x's log is anonymous, so a missing topic is expected, not a defect.
		const r = await analyzeTransaction(ZEROX_TX, 8453, { rpcUrl: RPC! });
		const flags = (r!.normalizeFlags ?? []) as string[];
		expect(flags.some((f) => f.startsWith('SETTLEMENT_EVENT_MISSING'))).toBe(false);
		expect(flags.some((f) => f.startsWith('NO_SIGNATURE'))).toBe(false);
		expect(r!.settlementEventSeen).toBe(false);
		expect(r!.settlementEventTopic0).toBeNull();
	}, 60_000);
});
```

- [ ] **Step 2: Run it and verify it actually ran**

```bash
source .env && npx vitest run analyzeTransaction -t "0x Settler"
```

Expected: **2 passed** — not "2 skipped". If it reports skipped, `TCA_RPC_URL` is not exported; fix that before believing any result.

- [ ] **Step 3: Confirm no regression on a non-0x aggregator**

```bash
source .env && npx vitest run
```

Expected: full suite passes. In particular the `Odos` rows' signature path still works — Task 4 changed Odos from a vacuous "any event" check to four specific topics.

- [ ] **Step 4: Repopulate the two affected receipts**

Delete the stale rows, then re-add each hash through the dashboard's paste flow (the receipts tool re-runs `analyzeTransaction` on ingest).

```bash
cat > /tmp/repop.mjs <<'EOF'
import 'dotenv/config';
import postgres from 'postgres';
const sql = postgres(process.env.TCA_DATABASE_URL);
const before = await sql`select id, tx_hash, aggregator from receipts where id in (179, 183)`;
console.log('BEFORE:', before);
await sql`delete from receipts where id in (179, 183)`;
console.log('deleted 2 rows — now re-paste both hashes in the dashboard');
await sql.end();
EOF
node /tmp/repop.mjs && rm /tmp/repop.mjs
```

Re-paste these two hashes in the dashboard:
- `0xb02037466b0756a3972f77d674413a0d7468663aca62e8c6eb757f15ced59e26`
- `0x0e3c5863fbc21e13fc15d76fed5fafb657db08ff4864437ddb9843ebfacb1511`

- [ ] **Step 5: Verify zero raw-hex aggregators remain**

```bash
cat > /tmp/verify.mjs <<'EOF'
import 'dotenv/config';
import postgres from 'postgres';
const sql = postgres(process.env.TCA_DATABASE_URL);
console.log('aggregator distribution:',
  await sql`select aggregator, count(*)::int as n from receipts group by aggregator order by n desc`);
console.log('remaining raw-hex rows (must be empty):',
  await sql`select id, tx_hash, aggregator from receipts where aggregator like '0x%' and length(aggregator) = 42`);
await sql.end();
EOF
node /tmp/verify.mjs && rm /tmp/verify.mjs
```

Expected exactly this distribution (43 rows total) and **zero** rows in the raw-hex query:

```
Fabric 13, KyberSwap 8, Velora 7, Nordstern 6, Relay 5, Odos 2, 0x 2
```

The six pre-existing labels must be unchanged — that is the regression check. If any of them
moved, the precedence chain is mislabeling; stop and investigate rather than repopulating more.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/analyzeTransaction.test.ts
git commit -m "test(core): e2e-verify 0x Settler resolves via the Deployer registry"
```

---

## Verification Checklist

- [ ] `npx tsc --build` clean
- [ ] `npx vitest run` — 27 files, all pass (baseline was 24 files / 304 tests)
- [ ] `source .env && npx vitest run analyzeTransaction -t "0x Settler"` reports **passed**, not skipped
- [ ] `configs/settlers.json` holds 57 settlers across features 1–5, no zero address
- [ ] Receipts 179 and 183 read `aggregator = '0x'`
- [ ] No receipt has a 42-char raw-hex aggregator
- [ ] `npm run aggregators:coverage` runs and omits `zrx` from the gap list
- [ ] `npm run build` was **never** run
