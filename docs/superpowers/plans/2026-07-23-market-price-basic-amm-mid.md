# Market Price basic-AMM mid reader — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the single-ruler Market Price discover and read basic-AMM (Solidly/Aerodrome/UniV2 `getReserves`) pools, so pairs whose deepest liquidity is a constant-product pool get a non-null `market_mid`.

**Architecture:** Introduce an extensible pool-family registry (`poolFamilies.ts`) that owns per-family factory discovery + a `mechanism` tag (`v3-slot0` | `v2-reserves`). Rewrite the pair-discovery ranker to gather candidates across all families and rank them by one uniform yardstick — the pool's `balanceOf` of the reference token — then dispatch the mid read by mechanism (`slot0` vs `getReserves`). The reserve→price math (`v2MidFromReserves`) already exists and is reused unchanged.

**Tech Stack:** TypeScript, viem (RPC reads), vitest. Package: `packages/core`.

## Global Constraints

- No new pricing math — reuse `v2MidFromReserves` / `sqrtPriceX96ToPrice` from `priceMath.ts`.
- No DB imports in `packages/core/src/*` pricing/discovery modules — viem RPC reads only.
- Reference mids are read at `blockNumber` as passed by callers (already `N-1`); do not add block offsets.
- Only the **Aerodrome basic** factory is enabled now (`0x420DD381b31aEf6683db6B902084cB0FFECe40Da`, verified on-chain). Registry must make adding another family a single descriptor entry.
- Basic factory `getPool` signature: `getPool(address tokenA, address tokenB, bool stable)` — scan `stable` ∈ `[false, true]`.
- Reference-token depth yardstick replaces the V3-only `liquidity()` ranking key; the `slot0`/`getReserves` initialized gate and mid read remain per-family.
- Empty/one-sided pool guard retained: reject a V3 pool at a sqrt-ratio bound or below the liquidity floor; reject a basic pool with either reserve `0`.
- TDD: failing test → run red → minimal impl → run green → commit, one behavior per task.
- ESLint tabs (existing flat config). Run `npm --workspace @fabric-tca/core run lint` if present before committing multi-file tasks.

---

## File Structure

- **Create** `packages/core/src/poolFamilies.ts` — `PoolMechanism`, `mechanismForKind`, `pickReferenceToken`, `PoolFamily`, `POOL_FAMILIES` (univ3, pancakev3, aerodrome_cl, aerodrome_basic), family factory addresses + ABIs.
- **Create** `packages/core/src/poolFamilies.test.ts` — pure unit tests.
- **Modify** `packages/core/src/poolDiscovery.ts` — add `aerodrome_basic` to `PoolKind`; add `readErc20Balance`; add pure `rankCandidatesByDepth`; rewrite `getDeepestPoolWithDepth` over `POOL_FAMILIES`. Move the V3/CL factory constants + factory ABIs into `poolFamilies.ts`.
- **Modify** `packages/core/src/poolDiscovery.test.ts` (new) — `rankCandidatesByDepth` unit tests.
- **Modify** `packages/core/src/receiptPure.ts` — export `anchorRank`.
- **Modify** `packages/core/src/pricing.ts` — `PoolMidReaders` gains `readV2Reserves`; `defaultGetPairMid` mechanism branch; wire `createDefaultPricingDeps`.
- **Modify** `packages/core/src/pricing.test.ts` — reserves-branch tests for `defaultGetPairMid`.
- **Modify** `packages/core/src/tokenPricing.ts` — `EstimatedMidReaders` gains `readV2Reserves`; `midViaDeepest` mechanism branch; wire the estimated readers.
- **Modify** `packages/core/src/tokenPricing.test.ts` (or nearest existing) — reserves-branch test for `midViaDeepest`.
- **Create** `scripts/regressReprice.mjs` — RPC+DB regression harness (re-price persisted receipts, diff chosen pool/mid).

Note: `discoverPool` (first-found, used only by `tokenPricing.getPairMid` which already has its own `fallbackPool` reserves path) is **intentionally left V3-only**; the registry is the forward path for deepest-pool discovery.

---

### Task 1: Pool-family registry (pure core + Aerodrome basic family)

**Files:**
- Create: `packages/core/src/poolFamilies.ts`
- Test: `packages/core/src/poolFamilies.test.ts`
- Modify: `packages/core/src/receiptPure.ts` (export `anchorRank`)

**Interfaces:**
- Consumes: `PoolKind` (type-only, from `poolDiscovery.ts`); `anchorRank` (from `receiptPure.ts`).
- Produces:
  - `type PoolMechanism = 'v3-slot0' | 'v2-reserves'`
  - `mechanismForKind(kind: PoolKind): PoolMechanism`
  - `pickReferenceToken(a: string, b: string): \`0x${string}\`` — lowercased; higher `anchorRank` wins, tie → lexicographically greater address.
  - `interface PoolFamily { kind: PoolKind; mechanism: PoolMechanism; discover(client: PublicClient, a: string, b: string, block?: bigint): Promise<\`0x${string}\`[]> }`
  - `const POOL_FAMILIES: PoolFamily[]`

- [ ] **Step 1: Export `anchorRank`**

In `packages/core/src/receiptPure.ts` change `function anchorRank(` to `export function anchorRank(`.

- [ ] **Step 2: Write failing tests**

`packages/core/src/poolFamilies.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mechanismForKind, pickReferenceToken, POOL_FAMILIES } from './poolFamilies.js';

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const BLUAI = '0xed9ae3def8d6f052971bb8b6d1975ff267cf9aad';

describe('mechanismForKind', () => {
	it('maps V3-style kinds to v3-slot0', () => {
		expect(mechanismForKind('univ3')).toBe('v3-slot0');
		expect(mechanismForKind('pancakev3')).toBe('v3-slot0');
		expect(mechanismForKind('aerodrome_cl')).toBe('v3-slot0');
	});
	it('maps basic-AMM kinds to v2-reserves', () => {
		expect(mechanismForKind('aerodrome_basic')).toBe('v2-reserves');
		expect(mechanismForKind('univ2')).toBe('v2-reserves');
	});
});

describe('pickReferenceToken', () => {
	it('prefers the stronger anchor (WETH over a volatile token)', () => {
		expect(pickReferenceToken(BLUAI, WETH)).toBe(WETH);
		expect(pickReferenceToken(WETH, BLUAI)).toBe(WETH);
	});
	it('prefers a stablecoin over WETH', () => {
		expect(pickReferenceToken(WETH, USDC)).toBe(USDC);
	});
	it('is deterministic on an anchor tie (higher address wins)', () => {
		const a = '0x0000000000000000000000000000000000000001';
		const b = '0x0000000000000000000000000000000000000002';
		expect(pickReferenceToken(a, b)).toBe(b);
		expect(pickReferenceToken(b, a)).toBe(b);
	});
});

describe('POOL_FAMILIES', () => {
	it('includes the Aerodrome basic family with v2-reserves mechanism', () => {
		const basic = POOL_FAMILIES.find((f) => f.kind === 'aerodrome_basic');
		expect(basic).toBeDefined();
		expect(basic!.mechanism).toBe('v2-reserves');
	});
	it('every family mechanism agrees with mechanismForKind', () => {
		for (const f of POOL_FAMILIES) expect(f.mechanism).toBe(mechanismForKind(f.kind));
	});
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm --workspace @fabric-tca/core exec vitest run src/poolFamilies.test.ts`
Expected: FAIL — `Cannot find module './poolFamilies.js'`.

- [ ] **Step 4: Implement `poolFamilies.ts`**

```ts
/**
 * poolFamilies.ts — registry of pool "families" for reference-pool discovery.
 *
 * Each family owns its factory address(es), the parameter axis it scans
 * (V3 fee tiers, CL tick spacings, Solidly stable flags), and a `mechanism`
 * tag that tells discovery + pricing how to gate/read the pool: `v3-slot0`
 * (read slot0 sqrtPriceX96) or `v2-reserves` (read getReserves). Adding a new
 * pool type is a single POOL_FAMILIES entry — no edits to the ranker or the
 * mid reader.
 */
import { type PublicClient, parseAbi } from 'viem';
import type { PoolKind } from './poolDiscovery.js';
import { anchorRank } from './receiptPure.js';

export type PoolMechanism = 'v3-slot0' | 'v2-reserves';

const V2_MECHANISM_KINDS: readonly PoolKind[] = ['aerodrome_basic', 'univ2'];

/** How a pool of `kind` is initialized-gated and priced. */
export function mechanismForKind(kind: PoolKind): PoolMechanism {
	return V2_MECHANISM_KINDS.includes(kind) ? 'v2-reserves' : 'v3-slot0';
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * The pool member used as the uniform depth yardstick: the stronger anchor
 * (stable > WETH > volatile). On an anchor tie the lexicographically greater
 * address wins so discovery is order-independent in (a, b).
 */
export function pickReferenceToken(a: string, b: string): `0x${string}` {
	const la = a.toLowerCase() as `0x${string}`;
	const lb = b.toLowerCase() as `0x${string}`;
	const ra = anchorRank(la);
	const rb = anchorRank(lb);
	if (ra !== rb) return ra > rb ? la : lb;
	return la > lb ? la : lb;
}

export interface PoolFamily {
	kind: PoolKind;
	mechanism: PoolMechanism;
	/** Candidate pool addresses for (a, b); may include uninitialized pools. */
	discover(client: PublicClient, a: string, b: string, block?: bigint): Promise<`0x${string}`[]>;
}

// ── Factory addresses (Base mainnet, confirmed on-chain) ─────────────────────
const UNIV3_FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD' as const;
const PANCAKE_V3_FACTORY = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865' as const;
const AERO_CL_FACTORY = '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A' as const;
/** Aerodrome basic PoolFactory — factory() of 0x5fb5a087… (verified 2026-07-22). */
const AERO_BASIC_FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da' as const;

const V3_FACTORY_ABI = parseAbi([
	'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
]);
const AERO_CL_FACTORY_ABI = parseAbi([
	'function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address pool)',
]);
const SOLIDLY_FACTORY_ABI = parseAbi([
	'function getPool(address tokenA, address tokenB, bool stable) view returns (address pool)',
]);

const V3_FEE_TIERS: readonly number[] = [100, 500, 3000, 10000];
const AERO_TICK_SPACINGS: readonly number[] = [1, 50, 100, 200];
const SOLIDLY_STABLE_FLAGS: readonly boolean[] = [false, true];

async function scanGetPool<T>(
	client: PublicClient,
	factory: `0x${string}`,
	abi: typeof V3_FACTORY_ABI | typeof AERO_CL_FACTORY_ABI | typeof SOLIDLY_FACTORY_ABI,
	a: string,
	b: string,
	params: readonly T[],
): Promise<`0x${string}`[]> {
	const out: `0x${string}`[] = [];
	const la = a.toLowerCase() as `0x${string}`;
	const lb = b.toLowerCase() as `0x${string}`;
	for (const p of params) {
		try {
			const pool = await client.readContract({
				address: factory, abi, functionName: 'getPool', args: [la, lb, p],
			} as never);
			if (pool && pool !== ZERO_ADDRESS) out.push(pool as `0x${string}`);
		} catch {
			// factory reverts for a missing tier/variant — skip
		}
	}
	return out;
}

export const POOL_FAMILIES: PoolFamily[] = [
	{ kind: 'univ3', mechanism: 'v3-slot0',
		discover: (c, a, b) => scanGetPool(c, UNIV3_FACTORY, V3_FACTORY_ABI, a, b, V3_FEE_TIERS) },
	{ kind: 'pancakev3', mechanism: 'v3-slot0',
		discover: (c, a, b) => scanGetPool(c, PANCAKE_V3_FACTORY, V3_FACTORY_ABI, a, b, V3_FEE_TIERS) },
	{ kind: 'aerodrome_cl', mechanism: 'v3-slot0',
		discover: (c, a, b) => scanGetPool(c, AERO_CL_FACTORY, AERO_CL_FACTORY_ABI, a, b, AERO_TICK_SPACINGS) },
	{ kind: 'aerodrome_basic', mechanism: 'v2-reserves',
		discover: (c, a, b) => scanGetPool(c, AERO_BASIC_FACTORY, SOLIDLY_FACTORY_ABI, a, b, SOLIDLY_STABLE_FLAGS) },
];
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm --workspace @fabric-tca/core exec vitest run src/poolFamilies.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/poolFamilies.ts packages/core/src/poolFamilies.test.ts packages/core/src/receiptPure.ts
git commit -m "feat(core): pool-family registry with Aerodrome basic discovery"
```

---

### Task 2: Uniform depth ranking + ERC-20 balance reader

**Files:**
- Modify: `packages/core/src/poolDiscovery.ts` (add `aerodrome_basic` to `PoolKind:17`; add `readErc20Balance`; add `rankCandidatesByDepth`)
- Test: `packages/core/src/poolDiscovery.test.ts` (new)

**Interfaces:**
- Consumes: `PoolKind`, `DiscoveredPool` (poolDiscovery); `mechanismForKind` is **not** used here — the caller supplies `isInitialized`/`readDepth`, keeping this function pure.
- Produces:
  - `type PoolCandidate = { address: \`0x${string}\`; kind: PoolKind }`
  - `interface RankReaders { isInitialized(c: PoolCandidate): Promise<boolean>; readDepth(c: PoolCandidate): Promise<bigint> }`
  - `rankCandidatesByDepth(candidates: PoolCandidate[], readers: RankReaders): Promise<{ pool: DiscoveredPool; depth: bigint } | null>`
  - `readErc20Balance(client: PublicClient, token: string, holder: string, blockNumber?: bigint): Promise<bigint>` (0n on revert)

- [ ] **Step 1: Add `aerodrome_basic` to `PoolKind`**

`packages/core/src/poolDiscovery.ts:17`:

```ts
export type PoolKind = 'univ3' | 'pancakev3' | 'aerodrome_cl' | 'aerodrome_basic' | 'univ2' | 'univ4';
```

- [ ] **Step 2: Write failing tests**

`packages/core/src/poolDiscovery.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { rankCandidatesByDepth, type PoolCandidate, type RankReaders } from './poolDiscovery.js';

const mk = (address: string, kind: PoolCandidate['kind']): PoolCandidate =>
	({ address: address as `0x${string}`, kind });

const readers = (
	init: Record<string, boolean>,
	depth: Record<string, bigint>,
): RankReaders => ({
	isInitialized: async (c) => init[c.address] ?? false,
	readDepth: async (c) => depth[c.address] ?? 0n,
});

describe('rankCandidatesByDepth', () => {
	it('picks the deepest initialized pool by the uniform yardstick, across families', async () => {
		const v3 = mk('0xaaa', 'univ3');
		const basic = mk('0xbbb', 'aerodrome_basic');
		const best = await rankCandidatesByDepth([v3, basic],
			readers({ '0xaaa': true, '0xbbb': true }, { '0xaaa': 10n, '0xbbb': 999n }));
		expect(best?.pool.address).toBe('0xbbb');
		expect(best?.pool.kind).toBe('aerodrome_basic');
		expect(best?.depth).toBe(999n);
	});
	it('skips uninitialized candidates even when they would rank deepest', async () => {
		const v3 = mk('0xaaa', 'univ3');
		const basic = mk('0xbbb', 'aerodrome_basic');
		const best = await rankCandidatesByDepth([v3, basic],
			readers({ '0xaaa': true, '0xbbb': false }, { '0xaaa': 10n, '0xbbb': 999n }));
		expect(best?.pool.address).toBe('0xaaa');
	});
	it('returns null when no candidate is initialized', async () => {
		const best = await rankCandidatesByDepth([mk('0xaaa', 'univ3')],
			readers({ '0xaaa': false }, { '0xaaa': 10n }));
		expect(best).toBeNull();
	});
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm --workspace @fabric-tca/core exec vitest run src/poolDiscovery.test.ts`
Expected: FAIL — `rankCandidatesByDepth` is not exported.

- [ ] **Step 4: Implement `readErc20Balance` + `rankCandidatesByDepth`**

Add near the other readers in `poolDiscovery.ts` (and add the ABI with the other ABIs):

```ts
const ERC20_BALANCE_ABI = parseAbi([
	'function balanceOf(address) view returns (uint256)',
]);

export type PoolCandidate = { address: `0x${string}`; kind: PoolKind };

export interface RankReaders {
	isInitialized(c: PoolCandidate): Promise<boolean>;
	readDepth(c: PoolCandidate): Promise<bigint>;
}

/**
 * Rank candidate pools across families by one uniform depth yardstick, keeping
 * only initialized pools. Pure over injected readers so it is unit-testable
 * without a live client. Unreadable depth ⇒ 0 (caller's readDepth policy), so a
 * pool is never dropped purely because its depth read reverted.
 */
export async function rankCandidatesByDepth(
	candidates: PoolCandidate[],
	readers: RankReaders,
): Promise<{ pool: DiscoveredPool; depth: bigint } | null> {
	let best: { pool: DiscoveredPool; depth: bigint } | null = null;
	for (const cand of candidates) {
		if (!(await readers.isInitialized(cand))) continue;
		const depth = await readers.readDepth(cand);
		if (best === null || depth > best.depth) {
			best = { pool: { address: cand.address, kind: cand.kind }, depth };
		}
	}
	return best;
}

/** ERC-20 balanceOf a holder; 0n on revert. Used only to rank pool depth. */
export async function readErc20Balance(
	client: PublicClient,
	token: string,
	holder: string,
	blockNumber?: bigint,
): Promise<bigint> {
	try {
		return await client.readContract({
			address: token.toLowerCase() as `0x${string}`,
			abi: ERC20_BALANCE_ABI,
			functionName: 'balanceOf',
			args: [holder.toLowerCase() as `0x${string}`],
			...(blockNumber !== undefined ? { blockNumber } : {}),
		});
	} catch {
		return 0n;
	}
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm --workspace @fabric-tca/core exec vitest run src/poolDiscovery.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/poolDiscovery.ts packages/core/src/poolDiscovery.test.ts
git commit -m "feat(core): pure cross-family depth ranker + erc20 balance reader"
```

---

### Task 3: Rewrite `getDeepestPoolWithDepth` over the registry

**Files:**
- Modify: `packages/core/src/poolDiscovery.ts` (`getDeepestPoolWithDepth:255-317`; remove the now-unused hard-coded factory constants/ABIs that moved to `poolFamilies.ts` — keep `SLOT0_*`, `V2_PAIR_ABI`, V4 consts, `readSlot0`, `readV2Reserves`, `readLiquidity`)

**Interfaces:**
- Consumes: `POOL_FAMILIES`, `mechanismForKind`, `pickReferenceToken` (poolFamilies); `rankCandidatesByDepth`, `readErc20Balance`, `readSlot0`, `readV2Reserves` (poolDiscovery).
- Produces: unchanged public signature `getDeepestPoolWithDepth(client, tokenA, tokenB, blockNumber?): Promise<{ pool: DiscoveredPool; depth: bigint } | null>`.

- [ ] **Step 1: Replace the body of `getDeepestPoolWithDepth`**

```ts
import { POOL_FAMILIES, mechanismForKind, pickReferenceToken } from './poolFamilies.js';

export async function getDeepestPoolWithDepth(
	client: PublicClient,
	tokenA: string,
	tokenB: string,
	blockNumber?: bigint,
): Promise<{ pool: DiscoveredPool; depth: bigint } | null> {
	const a = tokenA.toLowerCase();
	const b = tokenB.toLowerCase();
	const refToken = pickReferenceToken(a, b);

	// Gather candidates from every family.
	const candidates: PoolCandidate[] = [];
	for (const fam of POOL_FAMILIES) {
		const addrs = await fam.discover(client, a, b, blockNumber);
		for (const addr of addrs) candidates.push({ address: addr, kind: fam.kind });
	}

	return rankCandidatesByDepth(candidates, {
		isInitialized: async (c) => {
			if (mechanismForKind(c.kind) === 'v2-reserves') {
				const r = await readV2Reserves(client, c.address, blockNumber);
				return r !== null && r[0] > 0n && r[1] > 0n;
			}
			const sqrt = await readSlot0(client, c.address, blockNumber);
			return sqrt !== null && sqrt > 0n;
		},
		readDepth: (c) => readErc20Balance(client, refToken, c.address, blockNumber),
	});
}
```

- [ ] **Step 2: Delete moved constants**

Remove from `poolDiscovery.ts` the now-unused `UNIV3_FACTORY`, `PANCAKE_V3_FACTORY`, `AERO_CL_FACTORY`, `V3_FACTORY_ABI`, `AERO_CL_FACTORY_ABI`, `V3_FEE_TIERS`, `AERO_TICK_SPACINGS`, and `ZERO_ADDRESS` **only if** `discoverPool` no longer references them. `discoverPool` still uses them — so instead of deleting, **leave `discoverPool` and its constants untouched** and let `poolFamilies.ts` hold its own copies. (Duplication is intentional and bounded: `discoverPool` is a separate first-found path being retired later.)

Net effect for this step: add the new imports and the rewritten `getDeepestPoolWithDepth`; make no deletions.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --build packages/core`
Expected: no errors. (Confirms imports/types line up; ranking behavior is covered by Task 2 unit tests and the Task 7 e2e.)

- [ ] **Step 4: Run the core suite**

Run: `npm --workspace @fabric-tca/core exec vitest run`
Expected: PASS — no regressions in existing pricing/marketPrice tests (they stub readers, so discovery internals don't affect them).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/poolDiscovery.ts
git commit -m "feat(core): discover deepest pool across families, ranked by balanceOf depth"
```

---

### Task 4: `defaultGetPairMid` reads the mid by mechanism (direct estimator)

**Files:**
- Modify: `packages/core/src/pricing.ts` (`PoolMidReaders:138-151`; `defaultGetPairMid:166-196`; `createDefaultPricingDeps` poolReaders `208-213`)
- Test: `packages/core/src/pricing.test.ts`

**Interfaces:**
- Consumes: `mechanismForKind` (poolFamilies); `v2MidFromReserves` (priceMath); `readV2Reserves` (poolDiscovery).
- Produces: `PoolMidReaders` gains `readV2Reserves(poolAddress: string, blockNumber: bigint): Promise<[bigint, bigint] | null>`. `defaultGetPairMid` return shape unchanged (`PairMidResult | null`).

- [ ] **Step 1: Write failing test**

Append to `packages/core/src/pricing.test.ts` (mirror the existing `defaultGetPairMid` fake-reader setup; a basic-AMM pool must price via reserves):

```ts
import { defaultGetPairMid, type PoolMidReaders } from './pricing.js';

describe('defaultGetPairMid — basic-AMM (v2-reserves) pool', () => {
	// token0 < token1 so no inversion; 18-decimals both sides.
	const token0 = '0x1111111111111111111111111111111111111111';
	const token1 = '0x2222222222222222222222222222222222222222';

	const readers = (kind: string): PoolMidReaders => ({
		getDeepestPool: async () => ({ address: '0xpool', kind }),
		readSlot0: async () => { throw new Error('slot0 should not be called for a basic pool'); },
		readLiquidity: async () => 0n,
		readV2Reserves: async () => [2n * 10n ** 18n, 6000n * 10n ** 18n], // 3000 token1 per token0
		readDecimals: async () => 18,
	});

	it('prices a basic pool from reserves instead of slot0', async () => {
		const res = await defaultGetPairMid(readers('aerodrome_basic'), token0, token1, 100n);
		expect(res).not.toBeNull();
		expect(res!.price).toBeCloseTo(3000, 6);
		expect(res!.poolKind).toBe('aerodrome_basic');
	});

	it('returns null on a one-sided basic pool (zero reserve)', async () => {
		const r: PoolMidReaders = { ...readers('aerodrome_basic'), readV2Reserves: async () => [0n, 5n] };
		expect(await defaultGetPairMid(r, token0, token1, 100n)).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace @fabric-tca/core exec vitest run src/pricing.test.ts -t "basic-AMM"`
Expected: FAIL — `readV2Reserves` not on `PoolMidReaders` (type error) / `slot0 should not be called`.

- [ ] **Step 3: Extend `PoolMidReaders` and branch `defaultGetPairMid`**

Add to the `PoolMidReaders` interface (after `readLiquidity`):

```ts
	/** Reserves for a basic-AMM (Solidly/UniV2) pool; null on revert or empty. */
	readV2Reserves: (poolAddress: string, blockNumber: bigint) => Promise<[bigint, bigint] | null>;
```

Add imports at the top of `pricing.ts`:

```ts
import { mechanismForKind } from './poolFamilies.js';
import { v2MidFromReserves } from './priceMath.js'; // if not already imported
import type { PoolKind } from './poolDiscovery.js';
```

Rewrite `defaultGetPairMid` body after the `getDeepestPool` call:

```ts
	const pool = await readers.getDeepestPool(token0, token1, blockNumber);
	if (!pool) return null;

	const [dec0, dec1] = await Promise.all([readers.readDecimals(token0), readers.readDecimals(token1)]);
	let rawPrice: number; // token1 per token0

	if (mechanismForKind(pool.kind as PoolKind) === 'v2-reserves') {
		const reserves = await readers.readV2Reserves(pool.address, blockNumber);
		if (reserves === null || reserves[0] === 0n || reserves[1] === 0n) return null;
		rawPrice = v2MidFromReserves(reserves[0], reserves[1], dec0, dec1);
	} else {
		const sqrtPriceX96 = await readers.readSlot0(pool.address, blockNumber);
		if (sqrtPriceX96 === null) return null;
		// Reject an empty / one-sided pool: its slot0 price is a garbage extreme.
		if (sqrtPriceX96 <= MIN_SQRT_RATIO + 1n || sqrtPriceX96 >= MAX_SQRT_RATIO - 1n) return null;
		const liquidity = await readers.readLiquidity(pool.address, blockNumber);
		if (liquidity === null || liquidity < ESTIMATED_MID_MIN_LIQUIDITY) return null;
		rawPrice = sqrtPriceX96ToPrice(sqrtPriceX96, dec0, dec1);
	}

	const price = inverted ? (rawPrice > 0 ? 1 / rawPrice : 0) : rawPrice;
	if (!(price > 0)) return null;
	return { price, poolAddress: pool.address, poolKind: pool.kind };
```

(The `dec0`/`dec1` read moves above the branch; delete the old post-slot0 decimals read to avoid a double read.)

- [ ] **Step 4: Wire `createDefaultPricingDeps`**

In the `poolReaders` object (`pricing.ts:208`) add:

```ts
		readV2Reserves: (poolAddress, blockNumber) => readV2Reserves(client, poolAddress as `0x${string}`, blockNumber),
```

Ensure `readV2Reserves` is imported from `./poolDiscovery.js` at the top of `pricing.ts` (add to the existing import from that module).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm --workspace @fabric-tca/core exec vitest run src/pricing.test.ts`
Expected: PASS (new basic-AMM cases + all existing `defaultGetPairMid` V3 cases unchanged).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/pricing.ts packages/core/src/pricing.test.ts
git commit -m "feat(core): defaultGetPairMid reads basic-AMM mid from reserves by mechanism"
```

---

### Task 5: `midViaDeepest` reserves branch (bridged / estimated estimator)

**Files:**
- Modify: `packages/core/src/tokenPricing.ts` (`EstimatedMidReaders:195-199`; `midViaDeepest:201-219`; and the two `createDefaultPricingDeps` estimated-reader wirings in `pricing.ts:236-242` and `256-262`)
- Test: `packages/core/src/tokenPricing.test.ts` (nearest existing estimated-mid test file)

**Interfaces:**
- Consumes: `mechanismForKind` (poolFamilies); `v2MidFromReserves` (priceMath); `readV2Reserves` (poolDiscovery).
- Produces: `EstimatedMidReaders` gains `readV2Reserves(pool: string, block: bigint): Promise<[bigint, bigint] | null>`; `getDeepestPoolWithDepth` reader already returns `{ address, depth }` — extend it to also return `kind` so `midViaDeepest` can dispatch.

- [ ] **Step 1: Write failing test**

Add to the estimated-mid test file (mirror its existing `midViaDeepest`/`getEstimatedMidAtBlock` fakes) a case where the deepest pool is a basic-AMM `kind` and the mid comes from reserves:

```ts
it('midViaDeepest prices a basic-AMM deepest pool from reserves', async () => {
	const token0 = '0x1111111111111111111111111111111111111111';
	const token1 = '0x2222222222222222222222222222222222222222';
	const readers = {
		getDeepestPoolWithDepth: async () => ({ address: '0xpool', depth: 5n, kind: 'aerodrome_basic' as const }),
		readSlot0: async () => { throw new Error('slot0 not for basic'); },
		readV2Reserves: async () => [1n * 10n ** 18n, 2500n * 10n ** 18n] as [bigint, bigint],
		readDecimals: async () => 18,
	};
	const res = await midViaDeepest(readers as never, token0, token1, 100n);
	expect(res!.price).toBeCloseTo(2500, 6);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --workspace @fabric-tca/core exec vitest run src/tokenPricing.test.ts -t "basic-AMM deepest"`
Expected: FAIL — `midViaDeepest` calls `readSlot0` / reader shape mismatch.

- [ ] **Step 3: Extend readers + branch `midViaDeepest`**

In `EstimatedMidReaders` (`tokenPricing.ts:195`):

```ts
	getDeepestPoolWithDepth: (a: string, b: string, block: bigint) => Promise<{ address: string; depth: bigint; kind: string } | null>;
	readSlot0: (pool: string, block: bigint) => Promise<bigint | null>;
	readV2Reserves: (pool: string, block: bigint) => Promise<[bigint, bigint] | null>;
	readDecimals: (addr: string) => Promise<number>;
```

Rewrite `midViaDeepest` (after computing `token0`/`token1`/`inverted` as it already does):

```ts
	const disc = await readers.getDeepestPoolWithDepth(tokenA, tokenB, block);
	if (!disc) return null;
	const inverted = tokenA.toLowerCase() > tokenB.toLowerCase();
	const token0 = inverted ? tokenB : tokenA;
	const token1 = inverted ? tokenA : tokenB;
	const [dec0, dec1] = await Promise.all([readers.readDecimals(token0), readers.readDecimals(token1)]);
	let raw: number;
	if (mechanismForKind(disc.kind as PoolKind) === 'v2-reserves') {
		const r = await readers.readV2Reserves(disc.address, block);
		if (r === null || r[0] === 0n || r[1] === 0n) return null;
		raw = v2MidFromReserves(r[0], r[1], dec0, dec1);
	} else {
		const sqrt = await readers.readSlot0(disc.address, block);
		if (sqrt === null || sqrt <= 0n) return null;
		raw = sqrtPriceX96ToPrice(sqrt, dec0, dec1);
	}
	const price = inverted ? (raw > 0 ? 1 / raw : 0) : raw;
	if (!(price > 0)) return null;
	return { price, depth: disc.depth };
```

Add imports to `tokenPricing.ts`: `mechanismForKind` from `./poolFamilies.js`, `v2MidFromReserves` from `./priceMath.js` (if absent), `type PoolKind` from `./poolDiscovery.js`.

- [ ] **Step 4: Wire the estimated readers in `pricing.ts`**

Both estimated-reader blocks (`pricing.ts:236` and `:256`) already build `getDeepestPoolWithDepth`, `readSlot0`, `readDecimals`. In each, (a) include `kind` in the returned pool object:

```ts
					getDeepestPoolWithDepth: async (a, b, block) => {
						const best = await getDeepestPoolWithDepth(client, a, b, block);
						return best ? { address: best.pool.address, depth: best.depth, kind: best.pool.kind } : null;
					},
```

and (b) add:

```ts
					readV2Reserves: (pool, block) => readV2Reserves(client, pool as `0x${string}`, block),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm --workspace @fabric-tca/core exec vitest run src/tokenPricing.test.ts`
Expected: PASS (new case + existing estimated-mid cases unchanged).

- [ ] **Step 6: Typecheck + full core suite**

Run: `npx tsc --build packages/core && npm --workspace @fabric-tca/core exec vitest run`
Expected: no type errors; whole core suite green.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/tokenPricing.ts packages/core/src/pricing.ts packages/core/src/tokenPricing.test.ts
git commit -m "feat(core): estimated/bridged mid reads basic-AMM pools from reserves"
```

---

### Task 6: Regression harness (no V3 chosen-pool/mid drift)

**Files:**
- Create: `scripts/regressReprice.mjs`

**Interfaces:**
- Consumes: `TCA_DATABASE_URL`, `TCA_RPC_URL` from repo-root `.env` (`set -a && source .env && set +a` — `source` alone does not export).
- Produces: a console diff report; non-zero exit if any previously-priced V3 pair changed its chosen pool or mid beyond tolerance.

- [ ] **Step 1: Write the harness**

`scripts/regressReprice.mjs` — for each persisted receipt, re-run the core Market Price for its pair at its stored `block_number` using `createDefaultPricingDeps(TCA_RPC_URL)`, and compare against the stored `market_mid`:

```js
// Reads receipts, re-prices each pair, reports:
//  - rows that were null and are now priced (EXPECTED WINS, e.g. id 209)
//  - rows previously priced whose mid moved > 1 bps (REGRESSION → nonzero exit)
// Uses packages/core dist build; run `npx tsc --build packages/core` first.
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { createDefaultPricingDeps } from '../packages/core/dist/pricing.js';

const env = Object.fromEntries(
	readFileSync(new URL('../.env', import.meta.url), 'utf8')
		.split('\n').filter((l) => l.includes('=')).map((l) => {
			const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
		}),
);
const sql = postgres(env.TCA_DATABASE_URL, { prepare: false });
const deps = createDefaultPricingDeps(env.TCA_RPC_URL);

const rows = await sql`select id, input_token, output_token, block_number, market_mid from receipts order by id`;
let regressions = 0, newlyPriced = 0;
for (const r of rows) {
	const mp = await deps.getMarketPrice(r.input_token, r.output_token, BigInt(r.block_number) - 1n);
	const before = r.market_mid == null ? null : Number(r.market_mid);
	const after = mp.marketMid;
	if (before == null && after != null) { newlyPriced++; console.log(`NEW  id=${r.id} mid=${after}`); }
	else if (before != null && after != null) {
		const devBps = Math.abs(after - before) / before * 10_000;
		if (devBps > 1) { regressions++; console.log(`DRIFT id=${r.id} ${before} -> ${after} (${devBps.toFixed(2)}bps)`); }
	} else if (before != null && after == null) { regressions++; console.log(`LOST id=${r.id} was ${before} now null`); }
}
console.log(`\nnewlyPriced=${newlyPriced} regressions=${regressions}`);
await sql.end();
process.exit(regressions > 0 ? 1 : 0);
```

- [ ] **Step 2: Build core + run the harness**

```bash
npx tsc --build packages/core
set -a && source .env && set +a
node scripts/regressReprice.mjs
```

Expected: `regressions=0`; at least id 209 listed under `NEW`. If any `DRIFT`/`LOST` appears, STOP — the `balanceOf` re-ranking changed an existing V3 pair; switch to the type-tiered contingency (V3 keeps `liquidity()`; `balanceOf` only breaks V3-vs-basic ties) documented in the spec, then re-run.

- [ ] **Step 3: Commit**

```bash
git add scripts/regressReprice.mjs
git commit -m "test(tooling): market-price regression harness (no V3 chosen-pool/mid drift)"
```

---

### Task 7: Live e2e for id 209 + receipt repopulation

**Files:**
- Modify: `packages/core/src/*.e2e.test.ts` (nearest RPC-gated e2e file) — add an id-209 pricing assertion
- Use: existing `scripts/repopulateReceipts.mjs`

- [ ] **Step 1: Add an RPC-gated e2e assertion**

In the existing RPC-gated e2e suite (guarded by `TCA_RPC_URL`), add: analyze tx `0xc8078a93d1ccfe88e9fc78ed1d1a4feaf9485f71d9fd91189cf2081d6dd365c8` and assert `marketMid` (or the receipt's market price) is non-null and `> 0`, and `pricing_status` ∈ {`full`, `estimated`}.

- [ ] **Step 2: Run the e2e**

```bash
set -a && source .env && set +a
npm --workspace @fabric-tca/core exec vitest run -t "c8078a93"
```

Expected: PASS (skips silently if `TCA_RPC_URL` unset — confirm it actually ran, not skipped).

- [ ] **Step 3: Repopulate affected receipts in place**

```bash
set -a && source .env && set +a
node scripts/repopulateReceipts.mjs --dry-run          # inspect: id 209 gains a market mid
node scripts/repopulateReceipts.mjs --ids 209          # apply after confirming the dry-run
```

Then sweep for any other rows with null `market_mid` that route through a basic-AMM venue and repopulate them the same way. Never patch columns onto a stale row — always re-analyze.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/*.e2e.test.ts
git commit -m "test(core): e2e — BLUAI/WETH (id 209) prices via Aerodrome basic reserves"
```

---

## Self-Review

**Spec coverage:**
- Registry / extensibility → Task 1. ✓
- Basic-AMM discovery (Aerodrome, stable+volatile) → Task 1 (`POOL_FAMILIES`) + Task 3 (wired into deepest-pool). ✓
- Uniform `balanceOf` depth ranking replacing `liquidity()` → Task 2 (pure ranker) + Task 3 (real readers). ✓
- Mid read by mechanism, direct estimator → Task 4. ✓
- Bridged/estimated estimator family-aware → Task 5. ✓
- Empty/one-sided guards retained → Task 3 (init gate `r[0]>0 && r[1]>0`), Task 4 (`reserves[0]===0n || reserves[1]===0n`). ✓
- V3 re-ranking risk gate → Task 6 regression harness. ✓
- id 209 prices + repopulate → Task 7. ✓
- Non-goal (UniV2 `getPair` forks deferred) → registry supports it; not wired. ✓

**Placeholder scan:** none — every code step shows full code; commands have expected output.

**Type consistency:** `PoolMechanism`, `mechanismForKind`, `pickReferenceToken`, `PoolCandidate`, `RankReaders`, `rankCandidatesByDepth`, `readErc20Balance`, `PoolMidReaders.readV2Reserves`, and the `{ address, depth, kind }` estimated-reader shape are defined once and referenced consistently. `getDeepestPoolWithDepth` keeps its existing return type `{ pool: DiscoveredPool; depth }`; the estimated wiring maps `best.pool.kind` → `kind`.
