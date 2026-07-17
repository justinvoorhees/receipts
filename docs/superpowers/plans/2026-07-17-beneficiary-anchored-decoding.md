# Beneficiary-anchored decoding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a receipt for relayer/solver/intent transactions by re-anchoring `analyzeTransaction` on the trade's beneficiary when `tx.from` is not the trader.

**Architecture:** A new `resolveTrader` orchestrator decides whose trade the receipt describes, with `resolveAggregator`-style precedence: self (`tx.from`) → protocol decoder (UniswapX `Fill.swapper`) → net-flow beneficiary detector → `null`. It is swapped in at `analyzeTransaction`'s single `tx.from` anchor line; the whole downstream pipeline is unchanged. Re-anchoring is strictly additive (runs only where the current code returns `null`) and fail-closed (never anchors an intermediary leg).

**Tech Stack:** TypeScript (ESM), viem, vitest, drizzle (no migration this plan). Core package `packages/core`, dashboard `packages/dashboard`.

## Global Constraints

- **Additive invariant:** re-anchoring runs ONLY when `extractEndpoints({trader: tx.from})` returns `null` (today's no-receipt path). No transaction that already produces a receipt may change.
- **Fail-closed invariant:** anchor only on a party identifiable as the end-beneficiary. On ambiguity, return `null` — never guess an intermediary/leg counterparty.
- **Never guess addresses:** reactor addresses are gathered on-chain into `configs/reactors.json` (the `settlers.json` discipline), never hand-typed.
- **`normalizeFlags` is `string[]`** (`analyzeTransaction.ts:171`) — provenance is stored as enum-style flag tokens, no jsonb object, no DB migration.
- **RPC e2e is gated:** tests use `const RPC = process.env.TCA_RPC_URL; const d = RPC ? describe : describe.skip;` and MUST be confirmed to actually run (a silent skip is not a pass). Source env with `set -a && source .env && set +a` (a bare `source .env` does NOT export).
- **Build before running dist scripts:** `npx tsc --build` (never root `npm run build` over a live dev server).
- **Verified constants:**
  - UniswapX `Fill(bytes32,address,address,uint256)` topic0 = `0x78ad7ec0e9f89e74012afa58738b6b661c024cb0fd185ee2f616c0a28924bd66`
  - ERC-20 `Transfer` topic0 = `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`
  - `swapper` is the 3rd indexed `Fill` param → `topics[3]`, address = `'0x' + topics[3].slice(-40)`.

---

### Task 1: UniswapX `Fill` decoder (pure)

**Files:**
- Create: `packages/core/src/settlementDecoders.ts`
- Test: `packages/core/src/settlementDecoders.test.ts`

**Interfaces:**
- Produces:
  - `FILL_TOPIC0: string`
  - `decodeUniswapXBeneficiary(logs: readonly LogLite[], reactors: ReadonlySet<string>): string | null` — returns the lowercased `swapper` iff exactly one `Fill` log is emitted by an address in `reactors`; `null` for zero or more-than-one (multi-order → out of scope).
  - `type LogLite = { address: string; topics: readonly string[] }`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { decodeUniswapXBeneficiary, FILL_TOPIC0, type LogLite } from './settlementDecoders.js';

const REACTOR = '0x1111111111111111111111111111111111111111';
const SWAPPER = '0x00000000000000000000000000000000000000aa';
const FILLER = '0x00000000000000000000000000000000000000bb';
const pad = (a: string) => ('0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0')) as string;
const fillLog = (emitter: string, swapper: string): LogLite => ({
	address: emitter,
	topics: [FILL_TOPIC0, pad('0xdead'), pad(FILLER), pad(swapper)],
});

describe('decodeUniswapXBeneficiary', () => {
	const reactors = new Set([REACTOR.toLowerCase()]);

	it('returns the swapper for a single Fill from a known reactor', () => {
		expect(decodeUniswapXBeneficiary([fillLog(REACTOR, SWAPPER)], reactors)).toBe(SWAPPER.toLowerCase());
	});
	it('ignores a Fill emitted by an unknown address', () => {
		expect(decodeUniswapXBeneficiary([fillLog('0x9999999999999999999999999999999999999999', SWAPPER)], reactors)).toBeNull();
	});
	it('returns null when no Fill log is present', () => {
		expect(decodeUniswapXBeneficiary([{ address: REACTOR, topics: ['0xabc'] }], reactors)).toBeNull();
	});
	it('returns null for a multi-order batch (more than one reactor Fill)', () => {
		expect(decodeUniswapXBeneficiary([fillLog(REACTOR, SWAPPER), fillLog(REACTOR, '0x00000000000000000000000000000000000000cc')], reactors)).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/settlementDecoders.test.ts`
Expected: FAIL — `Cannot find module './settlementDecoders.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/core/src/settlementDecoders.ts
/**
 * Protocol-aware settlement decoders. Authoritative beneficiary identity from a
 * protocol's own event, mirroring resolveAggregator's "declaration, not
 * inference" discipline. Seeded with UniswapX only; add a decoder per protocol.
 *
 * UniswapX BaseReactor emits `Fill(bytes32 orderHash, address filler, address
 * swapper, uint256 nonce)` — all three addresses indexed, so `swapper` is
 * topics[3] and no data decode is needed. Matching keys off the LOG EMITTER
 * being a known reactor (not tx.to), so a filler contract that is itself tx.to
 * and calls the reactor internally still matches.
 */
export type LogLite = { address: string; topics: readonly string[] };

export const FILL_TOPIC0 = '0x78ad7ec0e9f89e74012afa58738b6b661c024cb0fd185ee2f616c0a28924bd66';

const topicToAddress = (t: string): string => ('0x' + t.slice(-40)).toLowerCase();

/** Lowercased swapper iff exactly one Fill from a known reactor; else null. */
export function decodeUniswapXBeneficiary(
	logs: readonly LogLite[],
	reactors: ReadonlySet<string>,
): string | null {
	const fills = logs.filter(
		(l) => l.topics[0] === FILL_TOPIC0 && l.topics.length >= 4 && reactors.has(l.address.toLowerCase()),
	);
	if (fills.length !== 1) return null; // 0 = not UniswapX; >1 = batch (out of scope)
	return topicToAddress(fills[0]!.topics[3]!);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/settlementDecoders.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/settlementDecoders.ts packages/core/src/settlementDecoders.test.ts
git commit -m "feat(core): UniswapX Fill beneficiary decoder"
```

---

### Task 2: Reactor registry — parser, loader, refresh script, config

**Files:**
- Modify: `packages/core/src/settlementDecoders.ts` (add `parseReactors`, `loadReactors`)
- Test: `packages/core/src/settlementDecoders.test.ts` (add parser tests)
- Create: `packages/core/src/scripts/refreshReactors.ts`
- Create: `configs/reactors.json` (generated by the script; committed)
- Modify: `package.json` (add `reactors:refresh` script)

**Interfaces:**
- Consumes: `FILL_TOPIC0` (Task 1).
- Produces:
  - `interface ReactorsConfig { _comment: string; generatedAt: string; chainId: number; reactors: string[] }`
  - `parseReactors(json: string): Set<string>` — lowercased reactor addresses from a config blob.
  - `loadReactors(path: string): Promise<Set<string>>` — read + parse; on any error resolve to an empty set (never throw), matching `resolveAggregator`'s degrade-don't-fail contract.

- [ ] **Step 1: Write the failing test** (append to `settlementDecoders.test.ts`)

```typescript
import { parseReactors } from './settlementDecoders.js';

describe('parseReactors', () => {
	it('lowercases and indexes reactor addresses', () => {
		const json = JSON.stringify({ _comment: 'x', generatedAt: 't', chainId: 8453, reactors: ['0xAbC0000000000000000000000000000000000001'] });
		const set = parseReactors(json);
		expect(set.has('0xabc0000000000000000000000000000000000001')).toBe(true);
		expect(set.size).toBe(1);
	});
	it('returns an empty set for a config with no reactors array', () => {
		expect(parseReactors(JSON.stringify({ chainId: 8453 })).size).toBe(0);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/settlementDecoders.test.ts`
Expected: FAIL — `parseReactors` is not exported.

- [ ] **Step 3: Implement `parseReactors` + `loadReactors`** (append to `settlementDecoders.ts`)

```typescript
import { readFile } from 'node:fs/promises';

export interface ReactorsConfig {
	_comment: string;
	generatedAt: string;
	chainId: number;
	reactors: string[];
}

export function parseReactors(json: string): Set<string> {
	const parsed = JSON.parse(json) as Partial<ReactorsConfig>;
	const out = new Set<string>();
	for (const a of parsed.reactors ?? []) out.add(a.toLowerCase());
	return out;
}

/** Load the reactor allowlist; degrade to an empty set on any error (never throw). */
export async function loadReactors(path: string): Promise<Set<string>> {
	try {
		return parseReactors(await readFile(path, 'utf8'));
	} catch (err) {
		console.warn(
			`[settlementDecoders] could not load ${path} — UniswapX trades will not re-anchor: ${err instanceof Error ? err.message : String(err)}`,
		);
		return new Set();
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/settlementDecoders.test.ts`
Expected: PASS (6 tests total).

- [ ] **Step 5: Write the refresh script**

```typescript
// packages/core/src/scripts/refreshReactors.ts
/**
 * Regenerate configs/reactors.json from live UniswapX `Fill` logs on Base.
 *
 * Run:  npm run reactors:refresh   (requires TCA_RPC_URL)
 *
 * Distinct emitters of the Fill topic over a recent window ARE the reactors —
 * same "authoritative on-chain set" idea as settlers:refresh. Output is
 * committed and reviewed as a diff.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { FILL_TOPIC0, type ReactorsConfig } from '../settlementDecoders.js';

const CHAIN_ID = 8453;
const WINDOW_BLOCKS = 2_000_000n; // ~6 weeks on Base; widen if the set looks thin
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.resolve(__dirname, '../../../../configs/reactors.json');

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

	const head = BigInt((await rpc(rpcUrl, 'eth_blockNumber', [])) as string);
	const fromBlock = '0x' + (head - WINDOW_BLOCKS).toString(16);
	const logs = (await rpc(rpcUrl, 'eth_getLogs', [
		{ topics: [FILL_TOPIC0], fromBlock, toBlock: 'latest' },
	])) as { address: string; transactionHash: string }[];

	const reactors = [...new Set(logs.map((l) => l.address.toLowerCase()))].sort();
	if (reactors.length === 0) {
		throw new Error('Fill scan produced 0 reactors — widen WINDOW_BLOCKS or check the RPC; refusing to overwrite config');
	}

	const config: ReactorsConfig = {
		_comment:
			'GENERATED by `npm run reactors:refresh` — do not hand-edit. Distinct emitters of the ' +
			'UniswapX Fill topic on Base. Review the diff before committing (a stray emitter here ' +
			'would let a non-UniswapX contract re-anchor a trade).',
		generatedAt: new Date().toISOString(),
		chainId: CHAIN_ID,
		reactors,
	};
	await writeFile(OUT_PATH, JSON.stringify(config, null, '\t') + '\n', 'utf8');
	// Print sample fill txns so the e2e task (Task 7) has real hashes to use.
	const samples = [...new Set(logs.map((l) => l.transactionHash))].slice(0, 5);
	console.log(`Wrote ${reactors.length} reactor(s) → ${OUT_PATH}\nSample Fill txns: ${samples.join(', ')}`);
}

main().catch((e: unknown) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
```

- [ ] **Step 6: Add the npm script** to root `package.json` `scripts` (after `settlers:refresh`):

```json
"reactors:refresh": "tsc --build && node packages/core/dist/scripts/refreshReactors.js",
```

- [ ] **Step 7: Generate the config and eyeball the diff**

Run:
```bash
set -a && source .env && set +a
npm run reactors:refresh
```
Expected: prints `Wrote N reactor(s)` (N ≥ 1) and a list of sample Fill txns; `configs/reactors.json` now exists. **Record the sample txn hashes — Task 7 needs one.** Manually sanity-check each address is plausibly a UniswapX reactor (few, contract, recent Fills) before committing.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/settlementDecoders.ts packages/core/src/settlementDecoders.test.ts \
        packages/core/src/scripts/refreshReactors.ts configs/reactors.json package.json
git commit -m "feat(core): reactor registry + reactors:refresh script + generated config"
```

---

### Task 3: Extract shared net-flow beneficiary detector (DRY)

**Files:**
- Modify: `packages/core/src/endpoints.ts` (add `detectBeneficiaryByNetFlow`)
- Modify: `packages/core/src/classifyTransaction.ts` (call the shared helper)
- Test: `packages/core/src/endpoints.test.ts` (add detector tests)

**Interfaces:**
- Consumes: `findCleanSwapCandidates`, `selectBeneficiary`, `RelayerDetail`, `TraceNode` (all existing in `endpoints.ts`).
- Produces: `detectBeneficiaryByNetFlow(trace: TraceNode, trader: string, isEoa: (a: string) => Promise<boolean>): Promise<RelayerDetail | null>` — the exact logic currently inlined in `classifyTransaction` (resolve EOA flags for candidate addresses, then `selectBeneficiary`).

- [ ] **Step 1: Write the failing test** (append to `endpoints.test.ts`)

```typescript
import { detectBeneficiaryByNetFlow } from './endpoints.js';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (a: string) => ('0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0')) as string;
const word = (v: bigint) => ('0x' + v.toString(16).padStart(64, '0')) as string;
const xfer = (token: string, from: string, to: string, value: bigint) => ({
	address: token,
	topics: [TRANSFER, pad(from), pad(to)],
	data: word(value),
});

const TKA = '0xaa00000000000000000000000000000000000001';
const TKB = '0xbb00000000000000000000000000000000000002';
const RELAYER = '0x1111111111111111111111111111111111111111'; // tx.from, zero net
const BENE_EOA = '0x2222222222222222222222222222222222222222';
const INTERMEDIARY = '0x3333333333333333333333333333333333333333';

describe('detectBeneficiaryByNetFlow', () => {
	// Beneficiary EOA sells TKA, gets TKB; an intermediary contract does the
	// mirror TKB->TKA hop. Two clean-swap addresses; EOA must win.
	const trace = { logs: [
		xfer(TKA, BENE_EOA, INTERMEDIARY, 100n),
		xfer(TKB, INTERMEDIARY, BENE_EOA, 90n),
		xfer(TKA, INTERMEDIARY, '0x9999999999999999999999999999999999999999', 100n),
		xfer(TKB, '0x9999999999999999999999999999999999999999', INTERMEDIARY, 90n),
	] };
	const isEoa = async (a: string) => a.toLowerCase() === BENE_EOA.toLowerCase();

	it('selects the EOA beneficiary, never the contract intermediary', async () => {
		const d = await detectBeneficiaryByNetFlow(trace as never, RELAYER, isEoa);
		expect(d?.beneficiary.toLowerCase()).toBe(BENE_EOA.toLowerCase());
		expect(d?.inputToken.toLowerCase()).toBe(TKA);
		expect(d?.outputToken.toLowerCase()).toBe(TKB);
	});

	it('fails closed to null when two contract candidates are ambiguous', async () => {
		const d = await detectBeneficiaryByNetFlow(trace as never, RELAYER, async () => false);
		expect(d).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/endpoints.test.ts`
Expected: FAIL — `detectBeneficiaryByNetFlow` is not exported.

- [ ] **Step 3: Add the helper** to `endpoints.ts` (after `selectBeneficiary`):

```typescript
/** Shared net-flow beneficiary detection: resolve EOA flags for every clean-swap
 *  candidate, then delegate to selectBeneficiary. Used by classifyTransaction
 *  (detection) and resolveTrader tier 3 (decoding) so the two never diverge. */
export async function detectBeneficiaryByNetFlow(
	trace: TraceNode,
	trader: string,
	isEoa: (address: string) => Promise<boolean>,
): Promise<RelayerDetail | null> {
	const candidates = findCleanSwapCandidates(trace, trader);
	const addrs = [...new Set(candidates.map((c) => c.address.toLowerCase()))];
	const flags = new Map<string, boolean>();
	await Promise.all(addrs.map(async (a) => flags.set(a, await isEoa(a))));
	return selectBeneficiary(candidates, trader, (a) => flags.get(a.toLowerCase()) ?? false);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/endpoints.test.ts`
Expected: PASS (both new tests).

- [ ] **Step 5: Refactor `classifyTransaction` to use it** — replace the inlined block (`classifyTransaction.ts:52-66`) with:

```typescript
		const isEoa = async (a: string): Promise<boolean> => {
			try {
				const code = await rpc.getBytecode({ address: a as `0x${string}` });
				return !code || code === '0x';
			} catch {
				return false; // unknown → treat as contract (conservative)
			}
		};
		const detail = await detectBeneficiaryByNetFlow(trace, trader, isEoa);
		if (!detail) return { reason: 'NOT_DECODABLE' };
		return { reason: 'RELAYER_THIRD_PARTY', detail };
```

Update the import from `./endpoints.js` to add `detectBeneficiaryByNetFlow` and drop the now-unused `findCleanSwapCandidates`, `selectBeneficiary`.

- [ ] **Step 6: Verify classifyTransaction tests still pass (no behavior change)**

Run: `set -a && source .env && set +a && npx vitest run packages/core/src/classifyTransaction.test.ts`
Expected: PASS. Confirm the e2e block RAN (`classifyTransaction e2e` shows passing tests, not skipped) — if it skipped, `TCA_RPC_URL` didn't reach the child; re-source and retry.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/endpoints.ts packages/core/src/endpoints.test.ts packages/core/src/classifyTransaction.ts
git commit -m "refactor(core): extract detectBeneficiaryByNetFlow, share it with classifyTransaction"
```

---

### Task 4: `resolveTrader` orchestrator

**Files:**
- Create: `packages/core/src/resolveTrader.ts`
- Test: `packages/core/src/resolveTrader.test.ts`

**Interfaces:**
- Consumes: `extractEndpoints`, `detectBeneficiaryByNetFlow`, `TraceNode` (endpoints.ts); `decodeUniswapXBeneficiary`, `LogLite` (settlementDecoders.ts).
- Produces:
  - `type Anchor = { kind: 'self' } | { kind: 'beneficiary'; method: 'uniswapx' | 'net-flow' }`
  - `resolveTrader(args): Promise<{ trader: string; anchor: Anchor } | null>` where `args = { trace: TraceNode; txFrom: string; logs: readonly LogLite[]; reactors: ReadonlySet<string>; isEoa: (a: string) => Promise<boolean> }`.
  - `anchorFlags(anchor: Anchor): string[]` — the normalizeFlags tokens for an anchor.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { resolveTrader, anchorFlags } from './resolveTrader.js';
import { FILL_TOPIC0 } from './settlementDecoders.js';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (a: string) => ('0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0')) as string;
const word = (v: bigint) => ('0x' + v.toString(16).padStart(64, '0')) as string;
const xfer = (token: string, from: string, to: string, v: bigint) => ({ address: token, topics: [TRANSFER, pad(from), pad(to)], data: word(v) });
const fill = (reactor: string, swapper: string) => ({ address: reactor, topics: [FILL_TOPIC0, pad('0xdead'), pad('0xf1'), pad(swapper)] });

const TKA = '0xaa00000000000000000000000000000000000001';
const TKB = '0xbb00000000000000000000000000000000000002';
const TXFROM = '0x1111111111111111111111111111111111111111';
const SWAPPER = '0x2222222222222222222222222222222222222222';
const REACTOR = '0x3333333333333333333333333333333333333333';
const reactors = new Set([REACTOR.toLowerCase()]);
const alwaysEoa = async () => true;

describe('resolveTrader precedence', () => {
	it('tier 1 self: tx.from has a clean swap → anchor self, no re-anchor', async () => {
		const trace = { logs: [xfer(TKA, TXFROM, REACTOR, 100n), xfer(TKB, REACTOR, TXFROM, 90n)] };
		const r = await resolveTrader({ trace: trace as never, txFrom: TXFROM, logs: [], reactors, isEoa: alwaysEoa });
		expect(r).toEqual({ trader: TXFROM.toLowerCase(), anchor: { kind: 'self' } });
	});

	it('tier 2 uniswapx: tx.from has no flow, Fill names the swapper', async () => {
		const trace = { logs: [fill(REACTOR, SWAPPER)] };
		const r = await resolveTrader({ trace: trace as never, txFrom: TXFROM, logs: [fill(REACTOR, SWAPPER)], reactors, isEoa: alwaysEoa });
		expect(r).toEqual({ trader: SWAPPER.toLowerCase(), anchor: { kind: 'beneficiary', method: 'uniswapx' } });
	});

	it('tier 3 net-flow: no Fill, sole EOA beneficiary', async () => {
		const trace = { logs: [xfer(TKA, SWAPPER, REACTOR, 100n), xfer(TKB, REACTOR, SWAPPER, 90n)] };
		const isEoa = async (a: string) => a.toLowerCase() === SWAPPER.toLowerCase();
		const r = await resolveTrader({ trace: trace as never, txFrom: TXFROM, logs: [], reactors, isEoa });
		expect(r?.trader.toLowerCase()).toBe(SWAPPER.toLowerCase());
		expect(r?.anchor).toEqual({ kind: 'beneficiary', method: 'net-flow' });
	});

	it('returns null when nothing resolves (tx.from no flow, no Fill, no candidate)', async () => {
		const r = await resolveTrader({ trace: { logs: [] } as never, txFrom: TXFROM, logs: [], reactors, isEoa: alwaysEoa });
		expect(r).toBeNull();
	});
});

describe('anchorFlags', () => {
	it('self → no flags', () => { expect(anchorFlags({ kind: 'self' })).toEqual([]); });
	it('net-flow → BENEFICIARY_ANCHORED only', () => {
		expect(anchorFlags({ kind: 'beneficiary', method: 'net-flow' })).toEqual([expect.stringMatching(/^BENEFICIARY_ANCHORED/)]);
	});
	it('uniswapx → BENEFICIARY_ANCHORED + ANCHOR_VIA_UNISWAPX', () => {
		const f = anchorFlags({ kind: 'beneficiary', method: 'uniswapx' });
		expect(f[0]).toMatch(/^BENEFICIARY_ANCHORED/);
		expect(f[1]).toMatch(/^ANCHOR_VIA_UNISWAPX/);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/resolveTrader.test.ts`
Expected: FAIL — `Cannot find module './resolveTrader.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/core/src/resolveTrader.ts
/**
 * resolveTrader — whose trade does this receipt describe?
 *
 * Precedence (mirrors resolveAggregator's tiering):
 *   1. self      — tx.from has a clean 1-in/1-out (today's path; short-circuits)
 *   2. uniswapx  — a UniswapX Fill names the swapper (authoritative)
 *   3. net-flow  — the proven sole-beneficiary detector (generic relayers)
 *   4. null      — no confidently-identified end-beneficiary (fail-closed)
 *
 * INVARIANTS (see the spec):
 *  - Additive: analyzeTransaction only calls this in place of `tx.from`, and
 *    tier 1 reproduces today's behavior, so no working receipt changes.
 *  - Fail-closed: tiers 2/3 return a party only when uniquely identified; on
 *    ambiguity they yield nothing and we fall through to null. Never anchors an
 *    intermediary leg.
 *  - self precedes protocol deliberately (preserves the additive guarantee); a
 *    filler that itself nets a clean swap anchors self — see spec Limitations.
 */
import { extractEndpoints, detectBeneficiaryByNetFlow, type TraceNode } from './endpoints.js';
import { decodeUniswapXBeneficiary, type LogLite } from './settlementDecoders.js';

export type Anchor = { kind: 'self' } | { kind: 'beneficiary'; method: 'uniswapx' | 'net-flow' };

export interface ResolveTraderArgs {
	trace: TraceNode;
	txFrom: string;
	logs: readonly LogLite[];
	reactors: ReadonlySet<string>;
	isEoa: (address: string) => Promise<boolean>;
}

export async function resolveTrader(
	args: ResolveTraderArgs,
): Promise<{ trader: string; anchor: Anchor } | null> {
	const { trace, txFrom, logs, reactors, isEoa } = args;
	const self = txFrom.toLowerCase();

	// Tier 1: self.
	if (extractEndpoints({ trace, trader: self })) return { trader: self, anchor: { kind: 'self' } };

	// Tier 2: UniswapX (authoritative).
	const swapper = decodeUniswapXBeneficiary(logs, reactors);
	if (swapper) return { trader: swapper, anchor: { kind: 'beneficiary', method: 'uniswapx' } };

	// Tier 3: net-flow.
	const detail = await detectBeneficiaryByNetFlow(trace, self, isEoa);
	if (detail) return { trader: detail.beneficiary.toLowerCase(), anchor: { kind: 'beneficiary', method: 'net-flow' } };

	// Tier 4: fail-closed.
	return null;
}

export function anchorFlags(anchor: Anchor): string[] {
	if (anchor.kind === 'self') return [];
	const flags = ['BENEFICIARY_ANCHORED: receipt anchored on the trade beneficiary, not the tx submitter'];
	if (anchor.method === 'uniswapx') flags.push('ANCHOR_VIA_UNISWAPX: swapper identified from the UniswapX Fill event');
	return flags;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/resolveTrader.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/resolveTrader.ts packages/core/src/resolveTrader.test.ts
git commit -m "feat(core): resolveTrader precedence orchestrator (self -> uniswapx -> net-flow -> null)"
```

---

### Task 5: Wire `resolveTrader` into `analyzeTransaction`

**Files:**
- Modify: `packages/core/src/analyzeTransaction.ts`
- Test: covered by Task 4 (`anchorFlags`, `resolveTrader`) unit tests and Task 7 e2e; this task adds no new unit test (the wiring is RPC-driven — its behavior is pinned by Task 7).
- Export: add `resolveTrader` re-export to `packages/core/src/index.ts` if the dashboard/e2e need it (they import from analyzeTransaction only; skip unless a test needs it).

**Interfaces:**
- Consumes: `resolveTrader`, `anchorFlags` (Task 4); `loadReactors` (Task 2).

- [ ] **Step 1: Add module-scope reactor load + imports** near the top of `analyzeTransaction.ts` (after the existing imports), mirroring `resolveAggregator`'s config-at-module-init:

```typescript
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveTrader, anchorFlags } from './resolveTrader.js';
import { loadReactors } from './settlementDecoders.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REACTORS = await loadReactors(path.resolve(__dirname, '../../../configs/reactors.json'));
```

- [ ] **Step 2: Swap the anchor** — this is a SURGICAL single-line replacement. Replace ONLY line 216 (`const trader = tx.from.toLowerCase();`) with the block below. **Leave line 217 (`const blockNumber = receipt.blockNumber;`) and the existing `extractEndpoints`+guard at 219-222 untouched** — those 4 lines become the fail-closed check unchanged.

```typescript
			const receiptLogs = receipt.logs.map((l) => ({ address: l.address, topics: l.topics }));
			const isEoa = async (a: string): Promise<boolean> => {
				try {
					const code = await rpc.getBytecode({ address: a as `0x${string}` });
					return !code || code === '0x';
				} catch {
					return false; // unknown → contract (conservative)
				}
			};
			const resolved = await resolveTrader({
				trace,
				txFrom: tx.from,
				logs: receiptLogs,
				reactors: REACTORS,
				isEoa,
			});
			if (!resolved) return null;
			const trader = resolved.trader;
```

After this edit, lines read: `[resolveTrader block]` → `const blockNumber = receipt.blockNumber;` → the existing comment + `const endpoints = extractEndpoints({ trace, trader }); if (!endpoints) return null;`. The comment at 219-220 still says "Anchor endpoints on the trader" — update it to note it is now also the beneficiary fail-closed check.

- [ ] **Step 3: Feed anchor provenance into the flags array** — at the flags block (`analyzeTransaction.ts:331`, `const flags = [...route.flags];`), append immediately after it:

```typescript
		flags.push(...anchorFlags(resolved.anchor));
```

- [ ] **Step 4: De-duplicate receiptLogs** — Step 2 already declared `const receiptLogs = receipt.logs.map(...)` at the top of the block. Line ~275 builds the identical `const receiptLogs = receipt.logs.map((l) => ({ address: l.address, topics: l.topics }))` again — DELETE that later duplicate declaration (a redeclare is also a compile error). Confirm the aggregator/settlement code below still references the now-hoisted `receiptLogs`.

- [ ] **Step 5: Typecheck + full core suite**

Run: `set -a && source .env && set +a && npx tsc --build && npx vitest run packages/core`
Expected: typecheck clean; all core tests PASS. Confirm any RPC-gated blocks RAN (not skipped).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/analyzeTransaction.ts packages/core/src/index.ts
git commit -m "feat(core): re-anchor analyzeTransaction on the beneficiary via resolveTrader"
```

---

### Task 6: Dashboard provenance disclosure

**Files:**
- Modify: `packages/dashboard/components/TradesTable.tsx` (add `beneficiaryAnchorNote`; exclude anchor tokens from `getFlagLabel`)
- Modify: `packages/dashboard/components/ReceiptView.tsx` (render the note near the Aggregator row)
- Test: `packages/dashboard/components/TradesTable.test.tsx` (add note + getFlagLabel-exclusion tests)

**Interfaces:**
- Produces: `beneficiaryAnchorNote(row: Pick<ReceiptRow, 'normalizeFlags'>): string | null` — a human disclosure string when the receipt is beneficiary-anchored, else `null`.

- [ ] **Step 1: Write the failing test** (append to `TradesTable.test.tsx`)

```typescript
import { beneficiaryAnchorNote } from './TradesTable';

describe('beneficiaryAnchorNote', () => {
	it('is null for a normal (self-anchored) receipt', () => {
		expect(beneficiaryAnchorNote({ normalizeFlags: ['SETTLEMENT_EVENT_MISSING: x'] })).toBeNull();
	});
	it('names UniswapX when anchored via the Fill event', () => {
		expect(beneficiaryAnchorNote({ normalizeFlags: ['BENEFICIARY_ANCHORED: y', 'ANCHOR_VIA_UNISWAPX: z'] }))
			.toBe('Executed on your behalf via UniswapX');
	});
	it('is generic for a net-flow relayer anchor', () => {
		expect(beneficiaryAnchorNote({ normalizeFlags: ['BENEFICIARY_ANCHORED: y'] }))
			.toBe('Executed on your behalf by a solver');
	});
});

describe('getFlagLabel excludes provenance tokens', () => {
	it('does not surface anchor tokens as warning flags', () => {
		expect(getFlagLabel({ normalizeFlags: ['BENEFICIARY_ANCHORED: y', 'ANCHOR_VIA_UNISWAPX: z'] })).toBe('None');
	});
	it('still surfaces genuine warnings alongside an anchor token', () => {
		expect(getFlagLabel({ normalizeFlags: ['BENEFICIARY_ANCHORED: y', 'SETTLEMENT_EVENT_MISSING: x'] }))
			.toBe('SETTLEMENT_EVENT_MISSING: x');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/dashboard/components/TradesTable.test.tsx`
Expected: FAIL — `beneficiaryAnchorNote` not exported; getFlagLabel exclusion tests fail.

- [ ] **Step 3: Add `beneficiaryAnchorNote` and update `getFlagLabel`** in `TradesTable.tsx` (next to `getFlagLabel`, line ~591):

```typescript
const ANCHOR_TOKEN_PREFIXES = ['BENEFICIARY_ANCHORED', 'ANCHOR_VIA_'];
const isAnchorToken = (flag: string): boolean => ANCHOR_TOKEN_PREFIXES.some((p) => flag.startsWith(p));

/** Human disclosure that a receipt was anchored on the beneficiary, not tx.from.
 *  null for ordinary self-anchored receipts. */
export function beneficiaryAnchorNote(row: Partial<Pick<ReceiptRow, 'normalizeFlags'>>): string | null {
	const flags = Array.isArray(row.normalizeFlags) ? row.normalizeFlags.filter((f): f is string => typeof f === 'string') : [];
	if (!flags.some((f) => f.startsWith('BENEFICIARY_ANCHORED'))) return null;
	if (flags.some((f) => f.startsWith('ANCHOR_VIA_UNISWAPX'))) return 'Executed on your behalf via UniswapX';
	return 'Executed on your behalf by a solver';
}
```

Then in `getFlagLabel`, exclude anchor tokens from the warning join — change the filter (line ~592-594) to also drop `isAnchorToken`:

```typescript
	const flags = Array.isArray(row.normalizeFlags)
		? row.normalizeFlags.filter((flag): flag is string => typeof flag === 'string' && flag.trim().length > 0 && !isAnchorToken(flag))
		: [];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/dashboard/components/TradesTable.test.tsx`
Expected: PASS (all new tests + existing getFlagLabel tests still green).

- [ ] **Step 5: Render the note in `ReceiptView.tsx`** — near the aggregator row (around line 200-208 where `routerAddress`/aggregator is formatted), add, using the receipt row already in scope (call it `row`):

```tsx
{beneficiaryAnchorNote(row) && (
	<p className="text-sm text-secondary">{beneficiaryAnchorNote(row)}</p>
)}
```

Import `beneficiaryAnchorNote` from `./TradesTable` alongside the existing imports (mind the leaf-isolation note in memory — `ReceiptView` already imports from `TradesTable`, so this adds no new coupling). Match the surrounding className convention if `text-secondary` is not the one in use.

- [ ] **Step 6: Verify dashboard tests + typecheck**

Run: `npx vitest run packages/dashboard/components && npx tsc --build`
Expected: PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add packages/dashboard/components/TradesTable.tsx packages/dashboard/components/TradesTable.test.tsx packages/dashboard/components/ReceiptView.tsx
git commit -m "feat(dashboard): disclose beneficiary-anchored receipts; keep anchor tokens out of warning flags"
```

---

### Task 7: RPC e2e — Relay relayer + UniswapX live fill

**Files:**
- Create: `packages/core/src/beneficiaryAnchoring.e2e.test.ts`

**Interfaces:**
- Consumes: `analyzeTransaction` (produces a `Receipt` with `trader`, `inputSymbol`/`outputSymbol`, `normalizeFlags`).

- [ ] **Step 1: Write the e2e test.** Use the Relay hash (known) and one UniswapX fill hash printed by Task 2 Step 7 (replace `UNISWAPX_FILL_HASH`).

```typescript
import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import { analyzeTransaction } from './analyzeTransaction.js';

const RPC = process.env.TCA_RPC_URL;
const d = RPC ? describe : describe.skip;
const CHAIN = 8453;

d('beneficiary-anchored decoding e2e', () => {
	it('decodes the Relay relayer trade anchored on its EOA beneficiary', async () => {
		const r = await analyzeTransaction('0xd6bb5ae0ec9017de395fb9b0435fe18c1859c6fbf7830052bab20f36e496bc0f', CHAIN, { rpcUrl: RPC! });
		expect(r).not.toBeNull();
		expect(r!.trader.toLowerCase()).toBe('0xf70da97812cb96acdf810712aa562db8dfa3dbef');
		expect(r!.inputSymbol).toBe('USDC');
		expect(r!.outputSymbol).toBe('ETH');
		expect(r!.normalizeFlags.some((f) => f.startsWith('BENEFICIARY_ANCHORED'))).toBe(true);
	}, 60000);

	it('decodes a UniswapX single fill anchored on the swapper', async () => {
		const UNISWAPX_FILL_HASH = '0x__REPLACE_WITH_A_HASH_FROM_reactors:refresh__';
		const r = await analyzeTransaction(UNISWAPX_FILL_HASH, CHAIN, { rpcUrl: RPC! });
		expect(r).not.toBeNull();
		expect(r!.normalizeFlags.some((f) => f.startsWith('ANCHOR_VIA_UNISWAPX'))).toBe(true);
		expect(r!.trader.length).toBe(42); // a resolved swapper address
	}, 60000);
});
```

- [ ] **Step 2: Fill in the UniswapX hash and run**

Run: `set -a && source .env && set +a && npx tsc --build && npx vitest run packages/core/src/beneficiaryAnchoring.e2e.test.ts`
Expected: `2 passed` (NOT skipped). If skipped → env var didn't reach the child; re-source. If the UniswapX case returns null, its swapper may not net a clean 2-token flow in-trace (e.g. output routed to a different recipient) — pick a different sample fill hash; document if none in the sample decode (a real limitation to note, not a test to force green).

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/beneficiaryAnchoring.e2e.test.ts
git commit -m "test(core): e2e beneficiary-anchored decoding (Relay + UniswapX)"
```

---

### Task 8: Full-suite gate + spec/memory reconciliation

**Files:**
- Modify: `docs/superpowers/specs/2026-07-17-beneficiary-anchored-decoding-design.md` (only if implementation diverged)

- [ ] **Step 1: Run the whole suite**

Run: `set -a && source .env && set +a && npx tsc --build && npm test`
Expected: all green; note the file/test counts (memory says the count MOVES — record the real number, don't quote a stale one). Confirm RPC e2e blocks RAN.

- [ ] **Step 2: Reconcile the spec** — if the `via`/solver-persistence detail or anything else changed during build (this plan drops the `via` field and does NOT persist the solver EOA — router_address + method suffice), update the spec's Persistence and Architecture sections to match what shipped.

- [ ] **Step 3: Commit any doc updates**

```bash
git add docs/superpowers/specs/2026-07-17-beneficiary-anchored-decoding-design.md
git commit -m "docs(spec): reconcile beneficiary-anchoring spec with implementation"
```

- [ ] **Step 4: Finish the branch** — invoke `superpowers:finishing-a-development-branch` to choose merge/PR/cleanup.
