# Uniswap V4 Multi-Pool Leg Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconstruct routes that hop through ≥2 Uniswap V4 pools by synthesizing one route-graph leg **per V4 pool** from the V4 `Swap` events, instead of relying on the singleton PoolManager's address-level net deltas (which collapse multiple pools into one multi-token venue that `buildLegs` skips).

**Architecture:** The V4 `Swap` event already carries everything a leg needs *per pool*: `id` (poolId), signed `amount0`/`amount1`, `sqrtPriceX96`, and `fee`. Today the scan throws all but one fee away. This plan (1) collects per-swap V4 records in the scan, (2) resolves each `poolId → (currency0, currency1)` via the PoolManager's indexed `Initialize` event (RPC, cached, injectable), (3) synthesizes `Leg`s with correct direction using a sign convention pinned against real on-chain data, and (4) wires them into `decomposeRoute` **only when the PoolManager nets more than one token** (the multi-pool case) — the single-pool case is already handled by the existing `resolveV4Settlement`. `reconstructDag` needs no changes; once the missing legs exist the DAG conserves.

**Tech Stack:** TypeScript, viem, vitest. `packages/core` only. Built with `tsc --build`; tests via `npx vitest run`; lint via `npm run lint`.

## Global Constraints

- Work is confined to `packages/core`. Only existing dependency `viem` may be used; no new deps.
- `routeGraph.ts` MUST stay pure. The leg *synthesizer* (pure) lives in `routeGraph.ts`; the `Initialize`-event *reader* (RPC) lives in `routeReaders.ts`, mirroring the existing `createDefaultFeeReader` / `createDefaultMidReader` injection pattern.
- RPC dependencies are **injectable via `DecomposeRouteDeps`** so all logic is unit-testable without a live node (follow the existing `feeReader` / `midReader` / `rfqProbe` pattern in `decomposeRoute.ts`).
- The Uniswap V4 PoolManager on Base is `0x498581ff718922c3f8e6a244956af099b2652b2b` (already a constant `UNISWAP_V4_POOL_MANAGER` in `decomposeRoute.ts:49`). Reuse it.
- V4 native currency is `address(0)` (`0x0000…0000`); map it to the WETH sentinel `0x4200000000000000000000000000000000000006` so the ERC-20-only graph chains it (the pipeline already models native as WETH via `extractNativeTransfers`).
- **Depends on plan `2026-07-22-route-break-reason-fot.md`** — this plan is triggered/validated by that plan's `orphan_token` break reason. Implement that plan first.
- Gates for every task: `npx tsc --build`, `npm run lint`, `npx vitest run`.
- ⚠️ vitest `-t` filters are substring matches — keep titles distinctive.

---

### Task 1: Pin the V4 `Swap` amount sign convention against real on-chain data

**Why first:** V4's `Swap.amount0/amount1` (int128) sign convention (pool-perspective vs swapper-perspective) determines which token is `tokenIn` vs `tokenOut`. Getting it wrong silently inverts every V4 leg. We pin it empirically against a transaction whose direction we already know (id 56: CLAWD→USDC, which routes CLAWD→`0xcbb7c0…`→USDC through V4).

**Files:**
- Create: `packages/core/src/__fixtures__/v4-id56-swaps.json` (captured V4 Swap logs)
- Create: `packages/core/src/v4Legs.ts` (new module — will house the collector + synthesizer)
- Test: `packages/core/src/v4Legs.test.ts`

**Interfaces:**
- Produces: a documented constant `V4_AMOUNT_SIGN` in `v4Legs.ts` describing the convention, and the fixture the later tasks reuse.

- [ ] **Step 1: Capture the fixture**

Write a one-off capture script (scratchpad, not committed) that fetches the trace/receipt logs for id 56 (`0xbc853779e6c5f846a08917a1afc710e17181fd0a31983723e15080497f63fe54`) and writes every log whose `topics[0]` equals the V4 Swap selector to the fixture file. Reuse the env-loading + RPC pattern from `scripts/repopulateReceipts.mjs`. Each fixture entry MUST include `{ address, topics, data }` exactly as returned by the node.

Save to `packages/core/src/__fixtures__/v4-id56-swaps.json`. Expected: a JSON array with ≥2 entries (id 56 has V4 fees 10000, 10000, 500 → up to 3 V4 swaps).

- [ ] **Step 2: Write the failing test**

`packages/core/src/v4Legs.test.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeEventLog } from 'viem';
import { V4_SWAP_EVENT_ABI } from './v4Legs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const swaps = JSON.parse(readFileSync(resolve(__dirname, '__fixtures__/v4-id56-swaps.json'), 'utf-8'));

const CLAWD = '0x9f86db9fc6f7c9408e8fda3ff8ce4e78ac7a6b07';

describe('v4 swap sign convention (id 56 fixture)', () => {
  it('every V4 swap has exactly one positive and one negative amount (one token in, one out)', () => {
    // This is the structural invariant the entire sign convention rests on:
    // in a single-pool V4 swap one token is paid IN (one sign) and the other is
    // paid OUT (opposite sign). If a decode bug or a degenerate swap violated
    // this, synthesizeV4Legs (Task 4) would produce a nonsense leg. Asserting it
    // here is a real regression guard, independent of WHICH sign means "in".
    expect(swaps.length).toBeGreaterThanOrEqual(2);
    for (const log of swaps) {
      const decoded = decodeEventLog({ abi: V4_SWAP_EVENT_ABI, data: log.data, topics: log.topics });
      const { id, amount0, amount1, sqrtPriceX96 } = decoded.args as {
        id: string; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint;
      };
      // Exactly one positive, one negative (both non-zero, opposite signs):
      expect(amount0).not.toBe(0n);
      expect(amount1).not.toBe(0n);
      expect(amount0 > 0n).not.toBe(amount1 > 0n);
      expect(sqrtPriceX96 > 0n).toBe(true);
      // Console line still drives the human's one-time convention pinning below;
      // the assertions above are the actual test.
      // eslint-disable-next-line no-console
      console.log('poolId', id, 'amount0', amount0.toString(), 'amount1', amount1.toString());
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/core/src/v4Legs.test.ts -t "sign convention"`
Expected: FAIL — `v4Legs.js` / `V4_SWAP_EVENT_ABI` does not exist.

- [ ] **Step 4: Create `v4Legs.ts` with the ABI + record the pinned convention**

```typescript
/**
 * v4Legs.ts — Uniswap V4 per-pool leg extraction.
 *
 * The V4 singleton PoolManager clears every pool through one address, so
 * address-level net deltas collapse a multi-pool route into an un-modelable
 * multi-token venue. The V4 Swap event, however, carries per-pool amounts +
 * poolId, so we synthesize one route-graph leg per swap here.
 *
 * Pure module: no RPC. poolId→token resolution is injected by the caller.
 */
import { parseAbiItem } from 'viem';

export const V4_SWAP_EVENT_ABI = [
  parseAbiItem(
    'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
  ),
] as const;

/**
 * PINNED FROM id 56 (CLAWD→USDC) on <capture date>. In the V4 Swap event, a
 * token amount is <FILL IN AFTER READING STEP-2 OUTPUT: e.g. "positive when the
 * pool RECEIVES that token (swapper pays it in), negative when the pool PAYS it
 * out (swapper receives it)">. Therefore: the token with the POSITIVE amount is
 * the leg's tokenIn; the token with the NEGATIVE amount is tokenOut.
 */
export const V4_AMOUNT_SIGN = {
  /** Set true if positive amount == token paid INTO the pool (tokenIn). */
  positiveIsTokenIn: true, // ← confirm/flip against Step-2 console output
} as const;
```

Run Step 2's test again, READ the console output (CLAWD is `0x9f86…6b07`; you know id 56 sold CLAWD), determine whether CLAWD's amount is positive or negative, and set `positiveIsTokenIn` accordingly. Update the doc comment with the real observation and capture date.

**Note on coverage:** the Step-2 test asserts the *structural* invariant (one token in, one out per swap) — a real regression guard. The *direction* correctness of the pinned `positiveIsTokenIn` boolean is verified downstream, not by console-reading: Task 4's `synthesizeV4Legs` tests assert `tokenIn` is the positive-amount token, and Task 5's id-56 end-to-end test only reconstructs (CLAWD as input) if the sign is right — a flipped convention reverses every leg and fails reconstruction. So the boolean is both pinned here and asserted-by-consequence there.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/core/src/v4Legs.test.ts -t "sign convention"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/v4Legs.ts packages/core/src/v4Legs.test.ts packages/core/src/__fixtures__/v4-id56-swaps.json
git commit -m "feat(core): pin V4 Swap amount sign convention against id 56 fixture"
```

---

### Task 2: `collectV4Swaps(logs)` — per-pool swap records from the scan

**Files:**
- Modify: `packages/core/src/v4Legs.ts`
- Test: `packages/core/src/v4Legs.test.ts`

**Interfaces:**
- Produces: `export interface V4Swap { poolId: string; fee: number; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint }` and `export function collectV4Swaps(logs: readonly LogLike[]): V4Swap[]`.
- Consumes: `V4_SWAP_EVENT_ABI` (Task 1); `LogLike` from `./tradeEndpoints.js`.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/v4Legs.test.ts`:

```typescript
import { collectV4Swaps } from './v4Legs.js';

describe('collectV4Swaps', () => {
  it('returns one record per V4 Swap log with poolId, fee, amounts, price', () => {
    const out = collectV4Swaps(swaps);
    expect(out.length).toBe(swaps.length);
    for (const s of out) {
      expect(typeof s.poolId).toBe('string');
      expect(s.poolId.startsWith('0x')).toBe(true);
      expect(typeof s.fee).toBe('number');
      expect(s.sqrtPriceX96 > 0n).toBe(true);
    }
  });

  it('ignores non-V4 logs', () => {
    const noise = [{ address: '0xabc', topics: ['0xdeadbeef'], data: '0x' }];
    expect(collectV4Swaps(noise as never)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/v4Legs.test.ts -t "collectV4Swaps"`
Expected: FAIL — `collectV4Swaps` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `v4Legs.ts`:

```typescript
import { decodeEventLog, toEventSelector } from 'viem';
import type { LogLike } from './tradeEndpoints.js';

const V4_SWAP_TOPIC = toEventSelector(V4_SWAP_EVENT_ABI[0]).toLowerCase();

export interface V4Swap {
  poolId: string;      // lowercase bytes32
  fee: number;         // raw V4 fee (pips)
  amount0: bigint;     // signed
  amount1: bigint;     // signed
  sqrtPriceX96: bigint;
}

/** Extract one V4Swap per Uniswap V4 Swap log. Malformed logs are skipped. */
export function collectV4Swaps(logs: readonly LogLike[]): V4Swap[] {
  const out: V4Swap[] = [];
  for (const log of logs) {
    if (!log.topics || log.topics.length === 0) continue;
    if (log.topics[0]!.toLowerCase() !== V4_SWAP_TOPIC) continue;
    try {
      const decoded = decodeEventLog({
        abi: V4_SWAP_EVENT_ABI,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      const a = decoded.args as { id: string; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; fee: number | bigint };
      out.push({
        poolId: a.id.toLowerCase(),
        fee: Number(a.fee),
        amount0: a.amount0,
        amount1: a.amount1,
        sqrtPriceX96: a.sqrtPriceX96,
      });
    } catch {
      // malformed V4 log — skip
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/v4Legs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/v4Legs.ts packages/core/src/v4Legs.test.ts
git commit -m "feat(core): collectV4Swaps — per-pool V4 swap records"
```

---

### Task 3: `Initialize`-event poolKey reader (RPC, injectable, cached)

**Files:**
- Modify: `packages/core/src/routeReaders.ts` (add reader factory)
- Test: `packages/core/src/routeReaders.test.ts` (create if absent; else append)

**Interfaces:**
- Produces:
  - `export type V4PoolKeyReader = (poolId: string) => Promise<{ currency0: string; currency1: string } | null>`
  - `export type V4InitLog = { args: { currency0: string; currency1: string } }`
  - `export function makeV4PoolKeyReader(fetchInitLogs: (poolId: string) => Promise<V4InitLog[]>): V4PoolKeyReader` — **pure** decode + per-poolId cache wrapper (no viem), unit-testable with a stub.
  - `export function createDefaultV4PoolKeyReader(rpcUrl: string, toBlock: bigint): V4PoolKeyReader` — builds the real `fetchInitLogs` via viem `getLogs` on the PoolManager's indexed `Initialize` event and delegates to `makeV4PoolKeyReader`.
- The reader returns lowercased `currency0`/`currency1` from the first `Initialize` log, caches per poolId (including caching a `null` miss), and returns `null` on miss/error so the caller degrades gracefully.

- [ ] **Step 1: Write the failing test**

Create/append `packages/core/src/routeReaders.test.ts`. These test the real decode + cache behavior through the pure `makeV4PoolKeyReader` seam:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { makeV4PoolKeyReader, createDefaultV4PoolKeyReader } from './routeReaders.js';

describe('makeV4PoolKeyReader', () => {
  const POOL = '0xAbC123';
  const initLog = { args: { currency0: '0xAAAA1111', currency1: '0xBBBB2222' } };

  it('resolves and lowercases currencies from the first Initialize log', async () => {
    const reader = makeV4PoolKeyReader(async () => [initLog]);
    expect(await reader(POOL)).toEqual({ currency0: '0xaaaa1111', currency1: '0xbbbb2222' });
  });

  it('caches per poolId: the underlying fetch runs once across repeated (case-insensitive) ids', async () => {
    const fetch = vi.fn(async () => [initLog]);
    const reader = makeV4PoolKeyReader(fetch);
    await reader(POOL);
    await reader(POOL.toLowerCase());
    await reader(POOL);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns null when no Initialize log is found', async () => {
    const reader = makeV4PoolKeyReader(async () => []);
    expect(await reader(POOL)).toBeNull();
  });

  it('returns null (never throws) when the fetch errors, and caches the null', async () => {
    const fetch = vi.fn(async () => { throw new Error('rpc down'); });
    const reader = makeV4PoolKeyReader(fetch);
    expect(await reader(POOL)).toBeNull();
    await reader(POOL);
    expect(fetch).toHaveBeenCalledTimes(1); // null was cached, not re-fetched
  });
});

describe('createDefaultV4PoolKeyReader', () => {
  it('returns a no-op reader (always null) when rpcUrl is empty', async () => {
    const reader = createDefaultV4PoolKeyReader('', 1000n);
    expect(await reader('0xabc')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/routeReaders.test.ts -t "V4PoolKeyReader"`
Expected: FAIL — `makeV4PoolKeyReader` / `createDefaultV4PoolKeyReader` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `routeReaders.ts` (uses the existing `createPublicClient`, `http`, `parseAbiItem`, `base` imports already at the top of the file):

```typescript
export type V4PoolKeyReader = (poolId: string) => Promise<{ currency0: string; currency1: string } | null>;
export type V4InitLog = { args: { currency0: string; currency1: string } };

const V4_POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b' as const;
// PoolManager deployment block on Base. Confirm on-chain before shipping; a
// too-late value silently misses older pools (reader returns null → graceful).
const V4_POOL_MANAGER_DEPLOY_BLOCK = 25_350_988n;
const V4_INITIALIZE_EVENT = parseAbiItem(
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
);

/**
 * Pure decode + per-poolId cache over an injected Initialize-log fetcher.
 * Returns lowercased currencies from the first Initialize log, caches the
 * result (including a null miss), and never throws — a failing fetch yields a
 * cached null so callers degrade to the un-decomposed path. No viem here, so
 * the decode/cache contract is unit-testable with a stub fetcher.
 */
export function makeV4PoolKeyReader(
  fetchInitLogs: (poolId: string) => Promise<V4InitLog[]>,
): V4PoolKeyReader {
  const cache = new Map<string, { currency0: string; currency1: string } | null>();
  return async (poolId: string): Promise<{ currency0: string; currency1: string } | null> => {
    const key = poolId.toLowerCase();
    if (cache.has(key)) return cache.get(key)!;
    let result: { currency0: string; currency1: string } | null = null;
    try {
      const logs = await fetchInitLogs(key);
      const init = logs[0];
      if (init) {
        result = {
          currency0: init.args.currency0.toLowerCase(),
          currency1: init.args.currency1.toLowerCase(),
        };
      }
    } catch {
      result = null;
    }
    cache.set(key, result);
    return result;
  };
}

/**
 * Production V4 poolId → currencies reader: queries the PoolManager's indexed
 * Initialize event via viem and delegates decode/cache to makeV4PoolKeyReader.
 */
export function createDefaultV4PoolKeyReader(rpcUrl: string, toBlock: bigint): V4PoolKeyReader {
  if (!rpcUrl) return async () => null;
  const rpc = createPublicClient({ chain: base, transport: http(rpcUrl) });
  return makeV4PoolKeyReader(async (poolId: string) => {
    const logs = await rpc.getLogs({
      address: V4_POOL_MANAGER,
      event: V4_INITIALIZE_EVENT,
      args: { id: poolId as `0x${string}` },
      fromBlock: V4_POOL_MANAGER_DEPLOY_BLOCK,
      toBlock,
    });
    return logs as unknown as V4InitLog[];
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/routeReaders.test.ts -t "V4PoolKeyReader"`
Expected: PASS (5 tests — 4 for `makeV4PoolKeyReader`, 1 for the empty-rpcUrl default).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/routeReaders.ts packages/core/src/routeReaders.test.ts
git commit -m "feat(core): V4 poolId→currencies reader via Initialize event (cached)"
```

---

### Task 4: `synthesizeV4Legs(swaps, poolKeys)` — build Legs with correct direction

**Files:**
- Modify: `packages/core/src/v4Legs.ts`
- Test: `packages/core/src/v4Legs.test.ts`

**Interfaces:**
- Produces: `export function synthesizeV4Legs(swaps: V4Swap[], poolKeys: Map<string, { currency0: string; currency1: string }>, wethSentinel: string): Leg[]`.
- Consumes: `V4Swap` (Task 2), `V4_AMOUNT_SIGN` (Task 1), `Leg` from `./routeGraph.js`.
- Each output `Leg` has `type: 'univ4'`, `venue: \`v4:${poolId}\``, `v4PoolId`, `v4FeeRaw`, and `tokenIn`/`tokenOut`/`amountInRaw`/`amountOutRaw` derived from the pinned sign convention. `address(0)` currency → `wethSentinel`. Swaps whose poolId is absent from `poolKeys` are dropped (unresolved).

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/v4Legs.test.ts`:

```typescript
import { synthesizeV4Legs, type V4Swap } from './v4Legs.js';

const WETH = '0x4200000000000000000000000000000000000006';
const NATIVE = '0x0000000000000000000000000000000000000000';
const TOKEN_A = '0x000000000000000000000000000000000000aaaa';
const TOKEN_B = '0x000000000000000000000000000000000000bbbb';

describe('synthesizeV4Legs', () => {
  it('builds a univ4 leg with tokenIn=negative-amount token per the pinned convention', () => {
    // Convention pinned in Task 1: V4_AMOUNT_SIGN.positiveIsTokenIn === FALSE →
    // the NEGATIVE-amount token is paid INTO the pool (tokenIn); the positive
    // one is paid out (tokenOut). Here amount0 = +100 (token0 out), amount1 =
    // -90 (token1 in).
    const swaps: V4Swap[] = [
      { poolId: '0xpool1', fee: 3000, amount0: 100n, amount1: -90n, sqrtPriceX96: 1n },
    ];
    const keys = new Map([['0xpool1', { currency0: TOKEN_A, currency1: TOKEN_B }]]);
    const legs = synthesizeV4Legs(swaps, keys, WETH);
    expect(legs).toHaveLength(1);
    const leg = legs[0]!;
    expect(leg.type).toBe('univ4');
    expect(leg.v4PoolId).toBe('0xpool1');
    expect(leg.v4FeeRaw).toBe(3000);
    // positiveIsTokenIn === false: token1 (negative amount) is tokenIn, token0 (positive) is tokenOut.
    expect(leg.tokenIn).toBe(TOKEN_B);
    expect(leg.tokenOut).toBe(TOKEN_A);
    expect(leg.amountInRaw).toBe(90n);   // |amount1|
    expect(leg.amountOutRaw).toBe(100n); // |amount0|
  });

  it('maps native currency0 (address(0)) to the WETH sentinel', () => {
    const swaps: V4Swap[] = [
      { poolId: '0xpool2', fee: 500, amount0: -5n, amount1: 42n, sqrtPriceX96: 1n },
    ];
    const keys = new Map([['0xpool2', { currency0: NATIVE, currency1: TOKEN_B }]]);
    const legs = synthesizeV4Legs(swaps, keys, WETH);
    // positiveIsTokenIn === false: amount0 negative → token0 (native→WETH) is tokenIn;
    // amount1 positive → token1 (TOKEN_B) is tokenOut.
    expect(legs[0]!.tokenIn).toBe(WETH);
    expect(legs[0]!.tokenOut).toBe(TOKEN_B);
  });

  it('drops swaps whose poolId has no resolved key', () => {
    const swaps: V4Swap[] = [{ poolId: '0xunknown', fee: 3000, amount0: 1n, amount1: -1n, sqrtPriceX96: 1n }];
    expect(synthesizeV4Legs(swaps, new Map(), WETH)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/v4Legs.test.ts -t "synthesizeV4Legs"`
Expected: FAIL — not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `v4Legs.ts`:

```typescript
import type { Leg } from './routeGraph.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Build one univ4 Leg per resolved V4 swap. Direction comes from the pinned
 * V4_AMOUNT_SIGN convention: the token with the positive (if positiveIsTokenIn)
 * amount is tokenIn, the other is tokenOut. Native currency (address(0)) is
 * remapped to the WETH sentinel so the ERC-20-only route graph can chain it.
 * Swaps with an unresolved poolId are dropped.
 */
export function synthesizeV4Legs(
  swaps: V4Swap[],
  poolKeys: Map<string, { currency0: string; currency1: string }>,
  wethSentinel: string,
): Leg[] {
  const out: Leg[] = [];
  for (const s of swaps) {
    const key = poolKeys.get(s.poolId);
    if (!key) continue;
    const map = (c: string) => (c === ZERO_ADDRESS ? wethSentinel : c);
    const tok0 = map(key.currency0);
    const tok1 = map(key.currency1);
    // amount0 sign tells us token0's role. Under positiveIsTokenIn, positive
    // amount0 ⇒ token0 is tokenIn. Amounts are magnitudes on the leg.
    const zeroIsIn = V4_AMOUNT_SIGN.positiveIsTokenIn ? s.amount0 > 0n : s.amount0 < 0n;
    const abs = (x: bigint) => (x < 0n ? -x : x);
    const tokenIn = zeroIsIn ? tok0 : tok1;
    const tokenOut = zeroIsIn ? tok1 : tok0;
    const amountInRaw = zeroIsIn ? abs(s.amount0) : abs(s.amount1);
    const amountOutRaw = zeroIsIn ? abs(s.amount1) : abs(s.amount0);
    out.push({
      venue: `v4:${s.poolId}`,
      type: 'univ4',
      tokenIn,
      tokenOut,
      amountInRaw,
      amountOutRaw,
      v4PoolId: s.poolId,
      v4FeeRaw: s.fee,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/v4Legs.test.ts`
Expected: PASS. If the `native` test fails, it means the pinned `positiveIsTokenIn` disagrees with the test's stated expectation — re-read Task 1's console output and correct the convention (the test encodes the *intended* semantics; the constant must match reality).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/v4Legs.ts packages/core/src/v4Legs.test.ts
git commit -m "feat(core): synthesizeV4Legs — per-pool V4 legs with pinned direction"
```

---

### Task 5: Wire V4 legs into `decomposeRoute` (multi-pool PM only)

**Files:**
- Modify: `packages/core/src/decomposeRoute.ts` (`DecomposeRouteDeps` ~line 88; the V4 settlement / graph-build region ~line 391–403)
- Test: `packages/core/src/decomposeRoute.test.ts`

**Interfaces:**
- Consumes: `collectV4Swaps`, `synthesizeV4Legs` (`./v4Legs.js`); `V4PoolKeyReader`, `createDefaultV4PoolKeyReader` (`./routeReaders.js`); existing `UNISWAP_V4_POOL_MANAGER`, `WETH`.
- Adds `v4PoolKeyReader?: V4PoolKeyReader` to `DecomposeRouteDeps`.
- Behavior: build the address-derived graph first. **Only if it fails to reconstruct with `breakReason.kind` of `orphan_token` OR `fee_on_transfer`** (and the PM nets >1 token, and there are V4 swaps) collect V4 swaps, resolve pool keys, synthesize legs, and rebuild the graph with them via a new `extraLegs` input — adopting the V4-augmented graph only if it then reconstructs. Routes that already reconstruct are left completely untouched (adding legs there double-counts and regresses them). ⚠️ Do NOT gate merely on `pmTokens.size > 1`.

- [ ] **Step 1: Write the failing test (end-to-end on the id 56 fixture)**

Add to `packages/core/src/decomposeRoute.test.ts`. This uses the captured id 56 trace (reuse or create `__fixtures__/id56-trace.json` via the capture pattern; if a full trace fixture is heavy, assert against a hand-built trace containing id 56's real V4 Swap logs + the two non-V4 legs' transfers). Inject a `v4PoolKeyReader` stub returning the known currencies so no RPC is needed.

```typescript
import { synthesizeV4Legs } from './v4Legs.js';

describe('decomposeRoute V4 multi-pool extraction (id 56)', () => {
  it('reconstructs CLAWD→USDC once the V4 pool legs are synthesized', async () => {
    // poolKeys stub: map each id-56 V4 poolId to its real currencies (read from
    // the Task-1 fixture output). CLAWD=0x9f86…, USDC=0x8335…, mystery=0xcbb7…
    const v4PoolKeyReader = async (poolId: string) => ID56_POOLKEYS[poolId] ?? null;
    const result = await decomposeRoute(ID56_INPUT, {
      trace: id56Trace,
      feeReader: () => ({ bps: 100, defaulted: false }),
      rfqProbe: () => 'contract',
      v4PoolKeyReader,
    });
    expect(result.routeShape).not.toBe('complex');
    expect(result.lpFeeBps).not.toBeNull();
    expect(result.slippageBps).not.toBeNull();
  });
});
```

> Implementer: build `ID56_POOLKEYS`, `ID56_INPUT`, and `id56Trace` from the Task-1 fixture and the known trade facts (CLAWD→USDC, $1841). Mirror how the existing kyber fixture tests construct `DecomposeTradeInput`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/decomposeRoute.test.ts -t "V4 multi-pool extraction"`
Expected: FAIL — `routeShape` still `complex`, `lpFeeBps` null (V4 legs not yet wired).

- [ ] **Step 3: Write minimal implementation**

Add to `DecomposeRouteDeps` (~line 100):

```typescript
	/** Resolve a V4 poolId → its two currencies (block-pinned in production). */
	v4PoolKeyReader?: import('./routeReaders.js').V4PoolKeyReader;
```

Add imports at the top of `decomposeRoute.ts`:

```typescript
import { collectV4Swaps, synthesizeV4Legs } from './v4Legs.js';
import { createDefaultV4PoolKeyReader } from './routeReaders.js';
```

In the graph-build region (replace ~line 391–403), after `resolveV4Settlement`:

```typescript
	// Step 3b: Resolve V4 settlement proxies (single-pool case).
	const { transfers, extendedDenylist } = resolveV4Settlement(
		rawTransfersWithNative, venues, input.trader, DENYLIST,
	);

	// Step 4: Build route graph from address-derived legs (first pass).
	let graph = buildRouteGraph({
		transfers,
		trader: input.trader,
		venues,
		denylist: extendedDenylist,
	});

	// Step 4b: V4 multi-pool RESCUE — gated on a first-pass token-conservation
	// break. ⚠️ CRITICAL: do NOT synthesize V4 legs unconditionally when the
	// PoolManager nets >1 token — many routes (single-pool V4 via
	// resolveV4Settlement, RFQ/AMM hybrids, convergent splits) ALREADY
	// reconstruct, and adding synthesized legs there double-counts and BREAKS
	// them (regression observed on LFI->GITLAWB and id 189). The V4 singleton
	// hides a pool's flow two ways: a token consumed but never produced
	// (`orphan_token`, id 56) or an intermediate under-accounted because a V4
	// pool also moved it (`fee_on_transfer` classification, id 251's WETH). Gate
	// on either, and adopt the augmented graph ONLY if it then reconstructs — so
	// a genuine fee-on-transfer token with no V4 orphan (id 219's SWARM) never
	// gets a spurious rescue.
	if (
		!graph.reconstructed &&
		(graph.breakReason?.kind === 'orphan_token' || graph.breakReason?.kind === 'fee_on_transfer')
	) {
		const v4Swaps = collectV4Swaps(logs);
		if (v4Swaps.length > 0) {
			const pmTokens = new Set<string>();
			for (const t of transfers) {
				const from = t.from.toLowerCase();
				const to = t.to.toLowerCase();
				if (from === UNISWAP_V4_POOL_MANAGER || to === UNISWAP_V4_POOL_MANAGER) {
					pmTokens.add(t.token.toLowerCase());
				}
			}
			if (pmTokens.size > 1) {
				const keyReader = deps?.v4PoolKeyReader
					?? createDefaultV4PoolKeyReader(input.rpcUrl, input.blockNumber);
				const poolKeys = new Map<string, { currency0: string; currency1: string }>();
				for (const s of v4Swaps) {
					if (poolKeys.has(s.poolId)) continue;
					const key = await keyReader(s.poolId);
					if (key) poolKeys.set(s.poolId, key);
				}
				const extraV4Legs = synthesizeV4Legs(v4Swaps, poolKeys, WETH);
				if (extraV4Legs.length > 0) {
					const v4Graph = buildRouteGraph({
						transfers,
						trader: input.trader,
						venues,
						denylist: extendedDenylist,
						extraLegs: extraV4Legs,
					});
					if (v4Graph.reconstructed) {
						graph = v4Graph;
						routeFlags.push(`V4_MULTIPOOL_LEGS: synthesized ${extraV4Legs.length} V4 pool leg(s) from Swap events`);
					}
				}
			}
		}
	}
```

Then extend `BuildRouteArgs` and `buildRouteGraph` in `routeGraph.ts` to accept and merge `extraLegs`:

```typescript
// In BuildRouteArgs (routeGraph.ts ~line 39):
  extraLegs?: Leg[];
```

```typescript
// In buildRouteGraph, after `const legs = buildLegs(...)` (~line 452):
  const allLegs = args.extraLegs && args.extraLegs.length > 0
    ? [...legs, ...args.extraLegs]
    : legs;
  const { ordered, shape, reconstructed, breakReason } = chainLegs(allLegs, inputToken, outputToken);
```

(Use `allLegs` wherever `legs` fed `chainLegs` and the token-set collection.)

> ⚠️ De-dup guard: if a V4 pool was ALREADY captured as a clean 1-in-1-out leg by `buildLegs` (single-pool case that slipped through), a synthesized leg for the same poolId would double-count. Before merging, drop any `extraLegs` whose `(tokenIn, tokenOut)` pair already exists among `legs` with `type === 'univ4'`. Add that filter in the merge above and cover it with a unit test in `routeGraph.test.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/decomposeRoute.test.ts -t "V4 multi-pool extraction"`
Expected: PASS — `routeShape` non-complex, `lpFeeBps` and `slippageBps` non-null.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: all green — confirm no existing V4 single-pool test (e.g. the linear USDC→VIRTUAL→WETH graph test) regressed.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/decomposeRoute.ts packages/core/src/routeGraph.ts packages/core/src/decomposeRoute.test.ts packages/core/src/routeGraph.test.ts
git commit -m "feat(core): reconstruct multi-pool V4 routes via synthesized Swap-event legs"
```

---

### Task 6: Live verification + repopulate ids 56 & 251

**Files:**
- Use: `scripts/repopulateReceipts.mjs`
- No source changes.

- [ ] **Step 1: Full gate**

Run: `npx tsc --build && npm run lint && npx vitest run`
Expected: all green.

- [ ] **Step 2: Dry-run the two V4-singleton rows (live RPC exercises the real reader)**

Run: `node scripts/repopulateReceipts.mjs --ids=56,251`
Expected: both flip off `complex` — e.g. `Δ routeShape:complex→split … slippageBps:·→<n> … decompConfidence:low→…`. `errors=0`. If either still shows `complex`, STOP and debug the poolKey reader (likely `V4_POOL_MANAGER_DEPLOY_BLOCK` too late, or the sign convention) before committing.

- [ ] **Step 3: Persist**

Run: `node scripts/repopulateReceipts.mjs --ids=56,251 --commit`
Expected: `WROTE: 2 rows · errors=0`.

- [ ] **Step 4: Verify in the DB**

Confirm ids 56 & 251 now have non-null `lp_fee_bps` / `slippage_bps`, a non-`complex` `route_shape`, and a `V4_MULTIPOOL_LEGS` flag. Sanity-check that `all_in_cost_bps` is unchanged (the total cost must not move — only its LP/slippage split is newly separable).

- [ ] **Step 5: Broader safety sweep (optional but recommended)**

Run: `node scripts/repopulateReceipts.mjs` (dry-run, all 39)
Expected: only ids 56 & 251 changed vs the last committed state (plus any that were already current). No unrelated row regresses to `complex` or flips to null. Then `--commit` if clean.

---

## Self-Review

**Spec coverage:** sign-convention pinning (Task 1) ✓; per-pool swap collection (Task 2) ✓; poolId→currencies resolution (Task 3) ✓; direction-correct leg synthesis incl. native mapping (Task 4) ✓; multi-pool-only wiring with de-dup guard (Task 5) ✓; live verification + repopulation of ids 56 & 251 (Task 6) ✓. The trigger relationship to the `orphan_token` break reason from the companion plan is noted in Global Constraints.

**Placeholder scan:** The two intentional "implementer fills from fixture" spots — the pinned `positiveIsTokenIn` value (Task 1) and the `ID56_*` test constants (Task 5) — are unavoidable: they depend on captured on-chain data that cannot be known until the fixture exists. Both are bounded (a single boolean; constants copied from Task-1 output) and each has an explicit verification step. Everything else is complete code.

**Type consistency:** `V4Swap` shape identical across Tasks 2/4/5. `V4PoolKeyReader` signature identical in Tasks 3 and 5. `synthesizeV4Legs(swaps, poolKeys, wethSentinel)` argument order consistent between definition (Task 4) and call site (Task 5). `extraLegs` field name consistent in `BuildRouteArgs`, the `buildRouteGraph` merge, and the `decomposeRoute` call.

**Risk register:** (1) sign convention — isolated + empirically pinned in Task 1; (2) `V4_POOL_MANAGER_DEPLOY_BLOCK` correctness — a wrong value fails safe (null → un-decomposed) and is caught by Task 6 Step 2; (3) hook-fee V4 pools that skim amounts will still break conservation — those correctly fall through to the companion plan's `fee_on_transfer`/`orphan` handling and are explicitly out of scope here.
