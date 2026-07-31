# PancakeSwap Infinity Legs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decode PancakeSwap Infinity's `Swap` events into per-pool route legs, so
routes touching it can reconstruct instead of collapsing into an unmodelled venue.

**Architecture:** Infinity is structurally identical to Uniswap V4 — a singleton
emitting `Swap` with an indexed `poolId`, plus per-pool key and slot0 readers. It
gets its own `infinityLegs.ts` mirroring `v4Legs.ts`, and a second rescue block in
`decomposeRoute`. **`v4Legs.ts`'s logic is not refactored**: the V4 path carries
three separately-earned correctness guards and unifying the two singletons would
rewrite them against a sample of two.

**Tech Stack:** TypeScript, viem, Vitest, Node ESM scripts, Drizzle/Postgres.

Spec: `docs/superpowers/specs/2026-07-31-pancake-infinity-legs-design.md`

## Global Constraints

- `packages/core/src/**` — **match each file's existing indentation.** Measured
  2026-07-31, so trust this over any earlier note: **2 spaces** —
  `v4Legs.ts`, `receiptPure.ts`, `poolDiscovery.ts`, **`routeGraph.ts`**;
  **TABS** — `decomposeRoute.ts`, `routeVenueScan.ts`, `routeReaders.ts`,
  `analyzeTransaction.ts`. Verify with `grep -cP '^\t' <file>` if unsure.
  `packages/dashboard/**` uses tabs.
- **Adding `VenueType: 'pancake_infinity'` REQUIRES both a fee-reader case AND a
  `getLegMidAtBlock` branch.** A venue type without the mid branch falls through
  and returns null, which **nulls the leg's price impact** — the receipt gets
  worse than today. This has happened before (QuickSwap v4). Tasks 3 and 4 must
  land together before anything is repopulated.
- **Fee units:** Infinity fees are *pips* (1e6 = 100%), same as V4. bps = pips ÷ 100.
  47 pips = 0.47 bps.
- **`infinityFeeRaw` holds LP-ONLY pips** — the output of `infinityLpFeePips`,
  never the event's raw `fee` field. On id 408 that is **47**, not 70.
- Never run `npm run build` — it corrupts a running dev server's `.next`. Use
  `npx tsc --build`.
- ⚠️ `npx vitest run <path> -t 'substring'` filters by **substring**. A typo runs
  ZERO tests and reports green. Always confirm a non-zero count.
- Suite baseline: **669 passed + 3 skipped** with `.env` exported
  (`set -a && source .env && set +a`). `tsc --build` exit 0, eslint exit 0.
  Run the exported and unexported suites as **separate tool calls** — chaining
  them in one shell leaks the env into the second.
- Work from the repo root: `/Users/justinvoorhees/withfabricxyz/fabric-tca-decoder`
- ⚠️ **The PERSISTED key in `receipts.route_legs` stays `v4Emitter`** even though
  the in-memory field is now `replacesVenue` (`analyzeTransaction.ts:137` maps
  one to the other). Renaming the persisted key would strand every existing row
  — the dashboard would read `undefined` and silently lose V4 Basescan links and
  router provenance until a full repopulation. Do not "tidy" this.
- ⚠️ Another agent is active in this repo. **Stage files explicitly — never
  `git add -A`** — and `git fetch` before each commit.

## File Structure

| file | responsibility |
|---|---|
| `packages/core/src/routeGraph.ts` | **modify** — `Leg.v4Emitter` → `Leg.replacesVenue`; `VenueType` gains `pancake_infinity`; `Leg` gains `infinityPoolId` / `infinityFeeRaw` |
| `packages/core/src/v4Legs.ts` | **modify** — rename only, at the one site that sets the field |
| `packages/core/src/analyzeTransaction.ts` | **modify** — rename only, in `frameKey` |
| `packages/core/src/infinityLegs.ts` | **create** — pure Infinity decode + leg synthesis. No RPC. |
| `packages/core/src/infinityLegs.test.ts` | **create** |
| `packages/core/src/poolDiscovery.ts` | **modify** — `readInfinitySlot0` |
| `packages/core/src/routeReaders.ts` | **modify** — pool-key reader, fee case, mid branch |
| `packages/core/src/routeVenueScan.ts` | **modify** — register the Vault on an Infinity Swap |
| `packages/core/src/decomposeRoute.ts` | **modify** — second rescue block |
| `packages/dashboard/components/receipt/receiptDisplay.tsx` | **modify** — label for the new type |
| `docs/attribution-worklist.md` | **modify** — §4 marked done |

## Verified facts this plan is built on

Measured on-chain 2026-07-31 — do not re-derive, but do not silently contradict:

- CLPoolManager `0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b`, Vault
  `0x238a358808379702088667322f80ac48bad5e6c4`.
- Swap topic `0x04206ad2b7c0f463bff3dd4f33c5735b0f2957a351e4f79763a4fa9e775dd237`,
  **2 indexed topics + 7 data words** (V4's has only 6 — Infinity adds
  `protocolFee`).
- id 408's swap: `amount0 = +1605452779327540` (native ETH),
  `amount1 = −2991046` (USDC), `fee = 70`, `protocolFee = 23`.
- **Amount sign convention verified, not assumed:** id 408 is USDC→ETH, so the
  swapper PAYS USDC; `amount1` (USDC) is NEGATIVE, and its magnitude 2.991046
  matches the Vault's measured net USDC delta exactly. So **negative = paid in**,
  identical to `V4_AMOUNT_SIGN.positiveIsTokenIn = false`.
- `poolIdToPoolKey` = `0x0e2d484a`; for pool
  `0xf6e81e5d16a7274d273905e0068f9f607b840c20bec23b2e442976ee03b29d91` returns
  `(currency0 = 0x0 native, currency1 = USDC, hooks = 0x0, poolManager, fee = 47,
  parameters = 65536)`.
- `getSlot0` = `0xc815641c`, **on the CLPoolManager itself** — no StateView
  indirection like V4. Returns `sqrtPriceX96` first; decodes to 1,869.75 USDC per
  ETH on that pool.
- Corpus footprint: **2 receipts** — id 408 ($12.07, 1 swap) and id 445
  ($3,733.49, 3 swaps).

---

### Task 1: Rename `Leg.v4Emitter` → `Leg.replacesVenue`

**Files:**
- Modify: `packages/core/src/routeGraph.ts` (interface + the replacement filter)
- Modify: `packages/core/src/v4Legs.ts` (the one site that sets it)
- Modify: `packages/core/src/analyzeTransaction.ts` (`frameKey`)
- Modify: `packages/core/src/routeGraph.test.ts` (fixtures)

**Interfaces:**
- Consumes: nothing.
- Produces: `Leg.replacesVenue?: string` — *the address-derived leg that these
  synthesized legs replace.* Task 2 sets it to the Infinity **Vault**.

⚠️ **Rename only. No logic changes.** If any test's expected VALUE changes, stop
— you have changed behaviour.

- [ ] **Step 1: Rename every occurrence**

```bash
grep -rn "v4Emitter" packages/core/src packages/dashboard | grep -v node_modules
```

Rename `v4Emitter` → `replacesVenue` at every hit. Expected sites:
`routeGraph.ts` (the `Leg` field declaration and `extraV4Emitters`),
`v4Legs.ts` (`v4Emitter: s.emitter` in `synthesizeV4Legs`),
`analyzeTransaction.ts` (`frameKey`), and `routeGraph.test.ts` fixtures.

Also rename the local `extraV4Emitters` → `extraReplacedVenues` in
`routeGraph.ts`, and update the `Leg` field's doc comment to:

```ts
  /** The address-derived leg these synthesized legs REPLACE. For Uniswap V4 that
   *  is the PoolManager, which both emits Swap and custodies tokens. For
   *  PancakeSwap Infinity the two DIFFER — the CLPoolManager emits, the Vault
   *  custodies — and it is the custodian's leg that must be replaced. Naming it
   *  for its role rather than for V4 is what lets both share the merge logic. */
  replacesVenue?: string;
```

- [ ] **Step 2: Verify nothing changed but names**

```bash
npx tsc --build
npx vitest run packages/core
npx eslint packages/core
```

Expected: tsc 0, eslint 0, and the core suite **passing with the same counts as
before the rename**. A changed count means you altered behaviour.

- [ ] **Step 3: Confirm the old name is gone**

```bash
grep -rn "v4Emitter" packages/core packages/dashboard --include='*.ts' --include='*.tsx' | grep -v node_modules
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/routeGraph.ts packages/core/src/v4Legs.ts \
        packages/core/src/analyzeTransaction.ts packages/core/src/routeGraph.test.ts
git commit -m "refactor(core): rename Leg.v4Emitter to Leg.replacesVenue

The field means 'the address-derived leg these synthesized legs replace'.
For Uniswap V4 that is the PoolManager, which both emits and custodies. For
PancakeSwap Infinity the two differ, so naming it for V4 would force
duplicating routeGraph's merge logic. Rename only, no behaviour change.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `infinityLegs.ts` — pure decode and leg synthesis

**Files:**
- Modify: `packages/core/src/routeGraph.ts` (`VenueType`, two `Leg` fields)
- Create: `packages/core/src/infinityLegs.ts`
- Create: `packages/core/src/infinityLegs.test.ts`

**Interfaces:**
- Consumes: `Leg.replacesVenue` (Task 1).
- Produces, all from `infinityLegs.ts`:
  - `INFINITY_SWAP_TOPIC: string` (the CLPoolManager address is NOT declared
    here — see the ownership note in the module doc)
  - `interface InfinitySwap { poolId: string; lpFeePips: number; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint }`
  - `infinityLpFeePips(swapFee: number, protocolFee: number): number`
  - `collectInfinitySwaps(logs: readonly LogLike[]): InfinitySwap[]`
  - `synthesizeInfinityLegs(swaps: readonly InfinitySwap[], poolKeys: Map<string, { currency0: string; currency1: string }>, wethSentinel: string): Leg[]`
  - `shouldAttemptInfinityRescue(args: { reconstructed: boolean; breakReason?: { kind: string } | undefined; swaps: readonly InfinitySwap[] }): boolean`

⚠️ `infinityLegs.ts` uses **2-space** indentation (matching `v4Legs.ts`).

- [ ] **Step 1: Add the venue type and leg fields**

In `packages/core/src/routeGraph.ts` (TABS), add `'pancake_infinity'` to the
`VenueType` union, and add to `Leg` beside `v4PoolId` / `v4FeeRaw`:

```ts
	infinityPoolId?: string;  // for pancake_infinity (from Swap event id)
	infinityFeeRaw?: number;  // LP-ONLY pips, already inverted out of swapFee
```

- [ ] **Step 2: Write the failing tests**

Create `packages/core/src/infinityLegs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  collectInfinitySwaps,
  infinityLpFeePips,
  shouldAttemptInfinityRescue,
  synthesizeInfinityLegs,
  INFINITY_SWAP_TOPIC,
} from './infinityLegs.js';
import type { InfinitySwap } from './infinityLegs.js';

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const VAULT = '0x238a358808379702088667322f80ac48bad5e6c4';

const word = (v: bigint) => (v < 0n ? 2n ** 256n + v : v).toString(16).padStart(64, '0');
const swapLog = (
  poolId: string,
  amount0: bigint,
  amount1: bigint,
  fee: bigint,
  protocolFee: bigint,
  sqrt = 12345678n,
) => ({
  // collectInfinitySwaps filters by TOPIC, not address, so any address works.
  address: '0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b' as `0x${string}`,
  topics: [INFINITY_SWAP_TOPIC, poolId, `0x${'0'.repeat(64)}`] as unknown as readonly `0x${string}`[],
  data: `0x${word(amount0)}${word(amount1)}${word(sqrt)}${word(0n)}${word(0n)}${word(fee)}${word(protocolFee)}` as `0x${string}`,
});

describe('infinityLpFeePips', () => {
  it('inverts calculateSwapFee to the LP-only share', () => {
    // Pancake: swapFee = protocolFee + lpFee − protocolFee·lpFee/1e6.
    // id 408 emitted swapFee=70, protocolFee=23 → lpFee 47.001, and the pool
    // key's static fee for that pool reads exactly 47. Both agree.
    expect(infinityLpFeePips(70, 23)).toBeCloseTo(47.001, 2);
  });

  it('returns the whole fee when no protocol cut is taken', () => {
    expect(infinityLpFeePips(500, 0)).toBeCloseTo(500, 6);
  });

  it('is zero for a zero fee', () => {
    expect(infinityLpFeePips(0, 0)).toBe(0);
  });

  it('never returns a negative fee', () => {
    // Defensive: a protocolFee exceeding swapFee is nonsense, but must not
    // produce a negative LP fee that would later read as a rebate.
    expect(infinityLpFeePips(10, 50)).toBe(0);
  });
});

describe('collectInfinitySwaps', () => {
  it('decodes a real swap and stores the LP-ONLY fee', () => {
    // id 408's actual log: amount0 +1605452779327540 (native ETH),
    // amount1 −2991046 (USDC), fee 70, protocolFee 23.
    const out = collectInfinitySwaps([
      swapLog(`0x${'f6'.repeat(32)}`, 1605452779327540n, -2991046n, 70n, 23n),
    ] as never);
    expect(out).toHaveLength(1);
    expect(out[0]!.amount0).toBe(1605452779327540n);
    expect(out[0]!.amount1).toBe(-2991046n);
    // 47, not the event's 70 — storing the total would overstate the LP fee.
    expect(out[0]!.lpFeePips).toBeCloseTo(47.001, 2);
  });

  it('skips a swap that moved nothing', () => {
    // Same guard as V4: a no-op swap's poolId is not the pool the trade used,
    // and using it would poison the mid read.
    expect(collectInfinitySwaps([swapLog(`0x${'aa'.repeat(32)}`, 0n, 0n, 70n, 23n)] as never)).toEqual([]);
  });

  it('keeps a swap with one side zero', () => {
    expect(collectInfinitySwaps([swapLog(`0x${'bb'.repeat(32)}`, 0n, -500n, 70n, 23n)] as never)).toHaveLength(1);
  });

  it('ignores logs with another topic', () => {
    const other = { ...swapLog(`0x${'cc'.repeat(32)}`, 1n, -1n, 70n, 23n) };
    (other as { topics: string[] }).topics = [`0x${'de'.repeat(32)}`];
    expect(collectInfinitySwaps([other] as never)).toEqual([]);
  });
});

describe('synthesizeInfinityLegs', () => {
  const swap = (poolId: string, a0: bigint, a1: bigint): InfinitySwap => ({
    poolId, lpFeePips: 47, amount0: a0, amount1: a1, sqrtPriceX96: 1n,
  });

  it('maps native currency0 to the WETH sentinel', () => {
    // id 408's pool is (native ETH, USDC). The route graph is ERC-20 only, so
    // native must be remapped or the leg can never chain.
    const keys = new Map([['0xf6', { currency0: '0x0000000000000000000000000000000000000000', currency1: USDC }]]);
    const legs = synthesizeInfinityLegs([swap('0xf6', 1605452779327540n, -2991046n)], keys, WETH);
    expect(legs).toHaveLength(1);
    expect([legs[0]!.tokenIn, legs[0]!.tokenOut]).toContain(WETH);
  });

  it('uses the VERIFIED sign convention: negative == paid in', () => {
    // Pinned on id 408 (USDC→ETH): amount1 (USDC) is negative and the swapper
    // pays USDC — its magnitude matches the Vault's measured net delta exactly.
    // So the NEGATIVE side is tokenIn, same as V4.
    const keys = new Map([['0xf6', { currency0: WETH, currency1: USDC }]]);
    const legs = synthesizeInfinityLegs([swap('0xf6', 1605452779327540n, -2991046n)], keys, WETH);
    expect(legs[0]!.tokenIn).toBe(USDC);
    expect(legs[0]!.tokenOut).toBe(WETH);
    expect(legs[0]!.amountInRaw).toBe(2991046n);
    expect(legs[0]!.amountOutRaw).toBe(1605452779327540n);
  });

  it('names the venue by pool and marks the VAULT as the leg it replaces', () => {
    // The CLPoolManager emits, but transfers land at the Vault — so the Vault's
    // address-derived leg is the one these replace.
    const keys = new Map([['0xf6', { currency0: WETH, currency1: USDC }]]);
    const legs = synthesizeInfinityLegs([swap('0xf6', 1n, -1n)], keys, WETH);
    expect(legs[0]!.venue).toBe('inf:0xf6');
    expect(legs[0]!.replacesVenue).toBe(VAULT);
    expect(legs[0]!.type).toBe('pancake_infinity');
    expect(legs[0]!.infinityPoolId).toBe('0xf6');
    expect(legs[0]!.infinityFeeRaw).toBe(47);
  });

  it('drops a swap whose pool key did not resolve', () => {
    // A null key means we do not know the tokens; a leg without them is worse
    // than no leg. decomposeRoute's shortfall guard then catches the shortfall.
    expect(synthesizeInfinityLegs([swap('0xf6', 1n, -1n)], new Map(), WETH)).toEqual([]);
  });
});

describe('shouldAttemptInfinityRescue', () => {
  const s = (poolId: string): InfinitySwap => ({
    poolId, lpFeePips: 47, amount0: 1n, amount1: -1n, sqrtPriceX96: 1n,
  });

  it('fires on a failed graph with an orphan token', () => {
    expect(shouldAttemptInfinityRescue({ reconstructed: false, breakReason: { kind: 'orphan_token' }, swaps: [s('0xa')] })).toBe(true);
  });

  it('fires on a failed graph blamed on fee-on-transfer', () => {
    expect(shouldAttemptInfinityRescue({ reconstructed: false, breakReason: { kind: 'fee_on_transfer' }, swaps: [s('0xa')] })).toBe(true);
  });

  it('does NOT fire on an unrelated break reason', () => {
    expect(shouldAttemptInfinityRescue({ reconstructed: false, breakReason: { kind: 'unreconstructed' }, swaps: [s('0xa')] })).toBe(false);
  });

  it('fires on a reconstructed graph spanning more than one pool', () => {
    expect(shouldAttemptInfinityRescue({ reconstructed: true, breakReason: undefined, swaps: [s('0xa'), s('0xb')] })).toBe(true);
  });

  it('does NOT fire on a reconstructed single-pool route', () => {
    expect(shouldAttemptInfinityRescue({ reconstructed: true, breakReason: undefined, swaps: [s('0xa')] })).toBe(false);
  });

  it('counts DISTINCT pools, not swap events', () => {
    expect(shouldAttemptInfinityRescue({ reconstructed: true, breakReason: undefined, swaps: [s('0xa'), s('0xa')] })).toBe(false);
  });

  it('never fires without swaps', () => {
    expect(shouldAttemptInfinityRescue({ reconstructed: false, breakReason: { kind: 'orphan_token' }, swaps: [] })).toBe(false);
    expect(shouldAttemptInfinityRescue({ reconstructed: true, breakReason: undefined, swaps: [] })).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

```bash
npx vitest run packages/core/src/infinityLegs.test.ts
```

Expected: FAIL — cannot resolve `./infinityLegs.js`.

- [ ] **Step 4: Implement**

Create `packages/core/src/infinityLegs.ts` (2-space indent):

```ts
/**
 * infinityLegs.ts — PancakeSwap Infinity per-pool leg extraction.
 *
 * Structurally the same problem as v4Legs.ts: a singleton clears every pool, so
 * address-level net deltas collapse a multi-pool route into one un-modelable
 * venue. The Swap event carries per-pool amounts + poolId, so we synthesize one
 * route-graph leg per swap.
 *
 * ⚠️ Infinity SPLITS what Uniswap V4 unifies. The CLPoolManager EMITS the Swap;
 * the Vault CUSTODIES the tokens, so it is the Vault that appears in transfers
 * and therefore the Vault's address-derived leg that these replace.
 *
 * Deliberately a sibling of v4Legs.ts rather than a shared abstraction: the V4
 * path carries three separately-earned correctness guards, and unifying the two
 * against a sample of two would put those at risk for no present gain.
 *
 * Pure module: no RPC. poolId→token resolution is injected by the caller.
 */
import { decodeEventLog, parseAbiItem, toEventSelector } from 'viem';
import type { Leg } from './routeGraph.js';
import type { LogLike } from './tradeEndpoints.js';
import { PANCAKE_INFINITY_VAULT } from './tradeDecoders.js';

// ⚠️ Address ownership, to avoid a third copy of each: the VAULT already lives
// in tradeDecoders.ts as PANCAKE_INFINITY_VAULT (shipped with the singleton
// custodian registry) and is imported here. The CLPoolManager is an RPC target,
// so it lives in poolDiscovery.ts beside V4_POOL_MANAGER — this module never
// needs it, since it filters logs by TOPIC rather than by emitter address.

/** ⚠️ Seven non-indexed fields — one MORE than V4's, which has no protocolFee. */
export const INFINITY_SWAP_EVENT_ABI = [
  parseAbiItem(
    'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee, uint16 protocolFee)',
  ),
] as const;

export const INFINITY_SWAP_TOPIC = toEventSelector(INFINITY_SWAP_EVENT_ABI[0]).toLowerCase();

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface InfinitySwap {
  poolId: string;   // lowercase bytes32
  lpFeePips: number; // LP-ONLY pips, already inverted out of the event's swapFee
  amount0: bigint;  // signed
  amount1: bigint;  // signed
  sqrtPriceX96: bigint;
}

/**
 * Recover the LP-only fee from the event's total.
 *
 * Pancake charges `swapFee = protocolFee + lpFee − protocolFee·lpFee/1e6`, so
 * `lpFee = (swapFee − protocolFee) / (1 − protocolFee/1e6)`.
 *
 * ⚠️ Persisting the event's `fee` directly would overstate the LP fee by the
 * protocol's share — 0.70 bps instead of 0.47 on id 408. Deriving it from the
 * EVENT rather than the pool key is also correct for dynamic-fee pools, where
 * the key's static value would be stale.
 */
export function infinityLpFeePips(swapFee: number, protocolFee: number): number {
  const net = swapFee - protocolFee;
  if (net <= 0) return 0;
  return net / (1 - protocolFee / 1_000_000);
}

/** Extract one InfinitySwap per Infinity Swap log. Malformed logs are skipped. */
export function collectInfinitySwaps(logs: readonly LogLike[]): InfinitySwap[] {
  const out: InfinitySwap[] = [];
  for (const log of logs) {
    if (!log.topics || log.topics.length === 0) continue;
    if (log.topics[0]!.toLowerCase() !== INFINITY_SWAP_TOPIC) continue;
    try {
      const decoded = decodeEventLog({
        abi: INFINITY_SWAP_EVENT_ABI,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      const a = decoded.args as {
        id: string;
        amount0: bigint;
        amount1: bigint;
        sqrtPriceX96: bigint;
        fee: number | bigint;
        protocolFee: number | bigint;
      };
      // A swap that moved nothing is a no-op, and its poolId is not the pool the
      // trade went through — identifying a venue from it poisons the mid read.
      // Same guard, same reason, as collectV4Swaps.
      if (a.amount0 === 0n && a.amount1 === 0n) continue;
      out.push({
        poolId: a.id.toLowerCase(),
        lpFeePips: infinityLpFeePips(Number(a.fee), Number(a.protocolFee)),
        amount0: a.amount0,
        amount1: a.amount1,
        sqrtPriceX96: a.sqrtPriceX96,
      });
    } catch {
      // malformed Infinity log — skip
    }
  }
  return out;
}

/**
 * One route-graph leg per swap.
 *
 * ⚠️ Sign convention VERIFIED on id 408, not assumed: that trade is USDC→ETH so
 * the swapper pays USDC, and the log's `amount1` (USDC) is NEGATIVE with a
 * magnitude (2.991046) matching the Vault's measured net USDC delta exactly.
 * Therefore the NEGATIVE side is tokenIn — the same convention as V4.
 *
 * Native currency (address(0)) is remapped to the WETH sentinel so the
 * ERC-20-only route graph can chain the leg. Swaps whose pool key did not
 * resolve are dropped: a leg without known tokens is worse than no leg, and
 * decomposeRoute's shortfall guard catches the resulting under-accounting.
 */
export function synthesizeInfinityLegs(
  swaps: readonly InfinitySwap[],
  poolKeys: Map<string, { currency0: string; currency1: string }>,
  wethSentinel: string,
): Leg[] {
  const out: Leg[] = [];
  for (const s of swaps) {
    const key = poolKeys.get(s.poolId);
    if (!key) continue;
    const map = (c: string) => {
      const lc = c.toLowerCase();
      return lc === ZERO_ADDRESS ? wethSentinel : lc;
    };
    const tok0 = map(key.currency0);
    const tok1 = map(key.currency1);
    const zeroIsIn = s.amount0 < 0n; // negative == paid in
    const abs = (x: bigint) => (x < 0n ? -x : x);
    out.push({
      venue: `inf:${s.poolId}`,
      type: 'pancake_infinity',
      tokenIn: zeroIsIn ? tok0 : tok1,
      tokenOut: zeroIsIn ? tok1 : tok0,
      amountInRaw: zeroIsIn ? abs(s.amount0) : abs(s.amount1),
      amountOutRaw: zeroIsIn ? abs(s.amount1) : abs(s.amount0),
      infinityPoolId: s.poolId,
      infinityFeeRaw: s.lpFeePips,
      replacesVenue: PANCAKE_INFINITY_VAULT,
    });
  }
  return out;
}

/**
 * Should we synthesize per-pool Infinity legs for this route?
 *
 * Mirrors shouldAttemptV4Rescue, for the same two reasons: the first pass FAILED
 * in a way a hidden pool explains, or it RECONSTRUCTED over more than one
 * distinct pool — which chains fine while being wrong, since the collapsed leg
 * keeps only one pool's identity. Distinctness, not swap count.
 */
export function shouldAttemptInfinityRescue(args: {
  reconstructed: boolean;
  breakReason?: { kind: string } | undefined;
  swaps: readonly InfinitySwap[];
}): boolean {
  const { reconstructed, breakReason, swaps } = args;
  if (swaps.length === 0) return false;
  if (!reconstructed) {
    return breakReason?.kind === 'orphan_token' || breakReason?.kind === 'fee_on_transfer';
  }
  return new Set(swaps.map((s) => s.poolId)).size > 1;
}
```

- [ ] **Step 5: Run to verify they pass**

```bash
npx vitest run packages/core/src/infinityLegs.test.ts
npx tsc --build
```

Expected: 20 PASS, tsc 0.

- [ ] **Step 6: Verify the sign test by mutation**

Change `const zeroIsIn = s.amount0 < 0n;` to `> 0n`, re-run, and confirm the
"VERIFIED sign convention" test FAILS. Revert and confirm it passes. This is the
one assumption that would silently invert every Infinity leg.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/infinityLegs.ts packages/core/src/infinityLegs.test.ts \
        packages/core/src/routeGraph.ts
git commit -m "feat(core): decode PancakeSwap Infinity swaps into per-pool legs

Pure module mirroring v4Legs.ts. The CLPoolManager emits the Swap while the
Vault custodies the tokens, so synthesized legs mark the VAULT as the leg
they replace.

The LP fee is recovered from the event by inverting Pancake's
calculateSwapFee, so it needs no RPC — and unlike the pool key's static
value it stays correct for dynamic-fee pools. infinityFeeRaw holds LP-only
pips (47 on id 408), never the event's total of 70.

Sign convention verified against id 408 rather than assumed from V4.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Readers — pool key and slot0

**Files:**
- Modify: `packages/core/src/poolDiscovery.ts` (2-space)
- Modify: `packages/core/src/routeReaders.ts` (TABS)

**Interfaces:**
- Consumes: nothing from earlier tasks — this task DECLARES
  `INFINITY_CL_POOL_MANAGER` in `poolDiscovery.ts`, beside `V4_POOL_MANAGER`.
- Produces:
  - `readInfinitySlot0(client: PublicClient, poolId: \`0x${string}\`, blockNumber?: bigint): Promise<bigint | null>` from `poolDiscovery.ts`
  - `makeInfinityPoolKeyReader(fetchKey: (poolId: string) => Promise<{ currency0: string; currency1: string } | null>): V4PoolKeyReader` and
    `createDefaultInfinityPoolKeyReader(rpcUrl: string, blockNumber: bigint): V4PoolKeyReader` from `routeReaders.ts`

Reuse the existing `V4PoolKeyReader` type — the signature is identical and a
second identical type alias would be noise.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/routeReaders.test.ts` (create it if absent, with
`import { describe, expect, it } from 'vitest';`):

```ts
describe('makeInfinityPoolKeyReader', () => {
  it('lowercases currencies and caches per poolId, including a miss', async () => {
    let calls = 0;
    const { makeInfinityPoolKeyReader } = await import('./routeReaders.js');
    const reader = makeInfinityPoolKeyReader(async (poolId) => {
      calls++;
      return poolId === '0xaa'
        ? { currency0: '0x0000000000000000000000000000000000000000', currency1: '0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913' }
        : null;
    });
    expect(await reader('0xAA')).toEqual({
      currency0: '0x0000000000000000000000000000000000000000',
      currency1: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    });
    await reader('0xaa');
    expect(calls).toBe(1); // cached

    expect(await reader('0xbb')).toBeNull();
    await reader('0xbb');
    expect(calls).toBe(2); // a null miss is cached too, not retried
  });

  it('never throws — a failing fetch degrades to null', async () => {
    const { makeInfinityPoolKeyReader } = await import('./routeReaders.js');
    const reader = makeInfinityPoolKeyReader(async () => { throw new Error('rpc down'); });
    await expect(reader('0xaa')).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run packages/core/src/routeReaders.test.ts
```

Expected: FAIL — `makeInfinityPoolKeyReader` is not exported.

- [ ] **Step 3: Add `readInfinitySlot0`**

In `packages/core/src/poolDiscovery.ts` (2-space), beside `readV4Slot0`:

```ts
/** PancakeSwap Infinity CLPoolManager — emits Swap AND answers state reads. */
export const INFINITY_CL_POOL_MANAGER = '0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b' as const;

const INFINITY_CL_ABI = [
  parseAbiItem(
    'function getSlot0(bytes32 id) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  ),
  parseAbiItem(
    'function poolIdToPoolKey(bytes32 id) view returns (address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters)',
  ),
] as const;

/**
 * Read slot0 for an Infinity pool at a given block. Returns sqrtPriceX96 or null.
 *
 * ⚠️ Called on the CLPoolManager ITSELF. Uniswap V4 needs a separate StateView
 * contract for this; Infinity does not, and there is no Infinity StateView to
 * go looking for.
 */
export async function readInfinitySlot0(
  client: PublicClient,
  poolId: `0x${string}`,
  blockNumber?: bigint,
): Promise<bigint | null> {
  try {
    const result = await client.readContract({
      address: INFINITY_CL_POOL_MANAGER,
      abi: INFINITY_CL_ABI,
      functionName: 'getSlot0',
      args: [poolId],
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    });
    return result[0] > 0n ? result[0] : null;
  } catch {
    return null;
  }
}

/** Read an Infinity pool's two currencies at a given block, or null. */
export async function readInfinityPoolKey(
  client: PublicClient,
  poolId: `0x${string}`,
  blockNumber?: bigint,
): Promise<{ currency0: string; currency1: string } | null> {
  try {
    const r = await client.readContract({
      address: INFINITY_CL_POOL_MANAGER,
      abi: INFINITY_CL_ABI,
      functionName: 'poolIdToPoolKey',
      args: [poolId],
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    });
    return { currency0: r[0], currency1: r[1] };
  } catch {
    return null;
  }
}
```

Add `parseAbiItem` to `poolDiscovery.ts`'s viem import if it is not already there.

- [ ] **Step 4: Add the pool-key reader**

In `packages/core/src/routeReaders.ts` (TABS), beside the V4 readers:

```ts
/**
 * Pure cache over an injected Infinity pool-key fetcher. Lowercases the
 * currencies, caches per poolId INCLUDING a null miss so a failed read is not
 * retried on every leg, and never throws.
 */
export function makeInfinityPoolKeyReader(
	fetchKey: (poolId: string) => Promise<{ currency0: string; currency1: string } | null>,
): V4PoolKeyReader {
	const cache = new Map<string, { currency0: string; currency1: string } | null>();
	return async (poolId: string) => {
		const key = poolId.toLowerCase();
		if (cache.has(key)) return cache.get(key)!;
		let result: { currency0: string; currency1: string } | null = null;
		try {
			const k = await fetchKey(key);
			if (k) {
				result = { currency0: k.currency0.toLowerCase(), currency1: k.currency1.toLowerCase() };
			}
		} catch {
			result = null;
		}
		cache.set(key, result);
		return result;
	};
}

/**
 * Live Infinity pool-key reader.
 *
 * ⚡ A single eth_call. V4's equivalent has to scan historical Initialize logs
 * because Uniswap's PoolManager exposes no poolIdToPoolKey; Infinity does.
 */
export function createDefaultInfinityPoolKeyReader(rpcUrl: string, blockNumber: bigint): V4PoolKeyReader {
	if (!rpcUrl || rpcUrl === 'unused' || rpcUrl === 'http://invalid') return async () => null;
	const rpc = createPublicClient({ chain: base, transport: http(rpcUrl) });
	return makeInfinityPoolKeyReader((poolId) =>
		readInfinityPoolKey(rpc, poolId as `0x${string}`, blockNumber),
	);
}
```

Extend `routeReaders.ts`'s import from `./poolDiscovery.js` to include
**`readInfinityPoolKey` ONLY**.

⚠️ Do NOT import `readInfinitySlot0` or `INFINITY_CL_POOL_MANAGER` here — this
task does not use them, and eslint's `no-unused-vars` is an error in this repo,
so importing them now leaves the branch failing lint until Task 4 lands. Task 4
adds them when it uses them.

- [ ] **Step 5: Run to verify they pass**

```bash
npx vitest run packages/core/src/routeReaders.test.ts
npx tsc --build
```

Expected: PASS, tsc 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/poolDiscovery.ts packages/core/src/routeReaders.ts \
        packages/core/src/routeReaders.test.ts
git commit -m "feat(core): add Infinity pool-key and slot0 readers

Both live on the CLPoolManager itself — Infinity needs no StateView
indirection, unlike V4. The pool-key read is a single eth_call rather than
V4's historical Initialize-log scan, because Infinity exposes
poolIdToPoolKey.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Fee case and mid branch — the pair that must not be split

**Files:**
- Modify: `packages/core/src/routeReaders.ts` (fee reader + `getLegMidAtBlock`)

**Interfaces:**
- Consumes: `readInfinitySlot0` (Task 3), `Leg.infinityPoolId` / `infinityFeeRaw`
  and `VenueType: 'pancake_infinity'` (Task 2).
- Produces: nothing new — completes the venue type.

⚠️⚠️ **Both halves ship together.** A `VenueType` with a fee case but no mid
branch falls through `getLegMidAtBlock` and returns null, which NULLS the leg's
price impact. Today those legs get a mid via the `unknown` → discovery fallback,
so shipping half of this would make the receipt WORSE. Do not commit between the
two.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/routeReaders.test.ts`:

```ts
describe('pancake_infinity fee reader', () => {
  it('converts LP pips to bps and reports the fee as resolved', async () => {
    const { createDefaultFeeReader } = await import('./routeReaders.js');
    // 'unused' short-circuits the RPC client; the univ4/infinity cases read
    // their fee off the leg, so they still answer.
    const read = createDefaultFeeReader('unused', 1n);
    const out = await read('inf:0xf6', 'pancake_infinity', 47);
    expect(out.bps).toBeCloseTo(0.47, 6);
    expect(out.defaulted).toBe(false);
  });

  it('reports unresolved when the leg carries no fee', async () => {
    const { createDefaultFeeReader } = await import('./routeReaders.js');
    const read = createDefaultFeeReader('unused', 1n);
    const out = await read('inf:0xf6', 'pancake_infinity', undefined);
    expect(out.defaulted).toBe(true);
  });
});
```

⚠️ The existing fee reader's third parameter is named `v4FeeRaw`. Rename it to
`feeRawPips` in the signature — both `univ4` and `pancake_infinity` use it, and
the V4-specific name would misdescribe it. Update the `DecomposeRouteDeps.feeReader`
type in `decomposeRoute.ts` to match.

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run packages/core/src/routeReaders.test.ts -t 'pancake_infinity fee'
```

Expected: FAIL — falls through to the `default` case, so `defaulted` is true and
`bps` is 0.

- [ ] **Step 3: Add the fee case**

In `createDefaultFeeReader`'s switch, beside `case 'univ4'`:

```ts
			case 'pancake_infinity':
				// The LP fee rides on the Swap event (already inverted out of the
				// total by infinityLpFeePips), so there is nothing to read on-chain.
				// Same pips convention as V4: 47 pips = 0.47 bps.
				return feeRawPips !== undefined
					? { bps: feeRawPips / 100, defaulted: false }
					: unresolvedFee(addr, type, 'the Infinity Swap event carried no fee');
```

- [ ] **Step 4: Add the mid branch**

First extend `routeReaders.ts`'s `./poolDiscovery.js` import with
`readInfinitySlot0` and `INFINITY_CL_POOL_MANAGER` — Task 3 deliberately left
them out, because it did not use them and eslint errors on unused imports.

Also wire the fee through at its call site. `decomposeRoute.ts` currently
forwards only `leg.v4FeeRaw`, so an Infinity leg's fee never reaches the reader
and the case above would be correct in isolation but dead in the live pipeline —
which also makes Task 5's success criterion unreachable:

```ts
		const feeResult = await feeReader(leg.venue, leg.type, leg.v4FeeRaw ?? leg.infinityFeeRaw);
```

A leg is only ever one venue type, so exactly one of the two is ever set and the
`??` cannot pick the wrong one.

Then, in `getLegMidAtBlock`, immediately after the `univ4` block:

```ts
  // Infinity pools: read slot0 by poolId from the CLPoolManager. Like V4 they
  // may hold native ETH rather than WETH, so the pool's currency order need not
  // match the address sort — compute the price both ways and keep whichever
  // agrees with the leg's realized direction.
  if (type === 'pancake_infinity') {
    if (!leg.infinityPoolId) return null;
    const sqrtPriceX96 = await readInfinitySlot0(client, leg.infinityPoolId as `0x${string}`, blockNumber);
    if (sqrtPriceX96 === null) return null;

    const priceA = sqrtPriceX96ToPrice(sqrtPriceX96, dec0, dec1);
    const priceB = priceA > 0 ? 1 / priceA : 0;

    const decIn = tokenIn === token0 ? dec0 : dec1;
    const decOut = tokenOut === token0 ? dec0 : dec1;
    const realized = leg.amountInRaw > 0n
      ? (Number(leg.amountOutRaw) / 10 ** decOut) / (Number(leg.amountInRaw) / 10 ** decIn)
      : 0;

    const candidateA = inverted ? priceB : priceA;
    const candidateB = inverted ? priceA : priceB;

    let price: number;
    if (realized <= 0) {
      price = candidateA;
    } else {
      const ratioA = candidateA > 0 ? Math.abs(Math.log(candidateA / realized)) : Infinity;
      const ratioB = candidateB > 0 ? Math.abs(Math.log(candidateB / realized)) : Infinity;
      price = ratioA <= ratioB ? candidateA : candidateB;
    }

    return { price, poolAddress: INFINITY_CL_POOL_MANAGER, poolKind: 'pancake_infinity' };
  }
```

- [ ] **Step 5: Verify both, and that the type is fully wired**

```bash
npx vitest run packages/core/src/routeReaders.test.ts
npx tsc --build
grep -n "pancake_infinity" packages/core/src/routeReaders.ts
```

Expected: PASS, tsc 0, and **three** hits in `routeReaders.ts` — the fee `case`,
plus TWO from the mid branch (`if (type === …)` and `poolKind: …`). What matters
is that BOTH a fee case and a mid branch are present; a single hit means you
shipped only the fee case, which is the half that nulls price impact.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/routeReaders.ts packages/core/src/routeReaders.test.ts \
        packages/core/src/decomposeRoute.ts
git commit -m "feat(core): read Infinity's fee and mid for the new venue type

Fee comes off the Swap event (47 pips = 0.47 bps, LP-only). The mid reads
getSlot0 by poolId from the CLPoolManager, reusing V4's native-ETH
orientation disambiguation since Infinity pools also hold address(0).

Both ship together deliberately: a VenueType with a fee case but no mid
branch returns null from getLegMidAtBlock and NULLS the leg's price impact,
which would be worse than today's discovery-path fallback.

Also renames the fee reader's v4FeeRaw parameter to feeRawPips — both
singletons use it now.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Wire the rescue, label it, and repopulate

**Files:**
- Modify: `packages/core/src/routeVenueScan.ts` (TABS)
- Modify: `packages/core/src/decomposeRoute.ts` (TABS)
- Modify: `packages/dashboard/components/receipt/receiptDisplay.tsx` (tabs)
- Modify: `docs/attribution-worklist.md`

**Interfaces:**
- Consumes: everything from Tasks 2-4.
- Produces: nothing consumed later.

- [ ] **Step 1: Register the Vault as a venue**

In `routeVenueScan.ts`'s scan loop, beside the V4 branch:

```ts
		// PancakeSwap Infinity Swap — emitted by the CLPoolManager, but the tokens
		// move through the VAULT, so it is the vault that appears in transfers and
		// therefore the vault we must register as the venue. Registering the
		// emitter instead would leave the vault's leg typed `unknown`.
		if (topic0 === INFINITY_SWAP_TOPIC && log.topics.length >= 3) {
			venues.set(PANCAKE_INFINITY_VAULT, { type: 'pancake_infinity' });
		}
```

Import `INFINITY_SWAP_TOPIC` from `./infinityLegs.js` and
`PANCAKE_INFINITY_VAULT` from `./tradeDecoders.js` — the vault address already
lives there from the singleton custodian registry, and a second copy would drift.

⚠️ Unlike the V4 branch this stores **no** poolId or fee: with several pools
behind one vault there is no single correct value, and the collapsed leg is
replaced by synthesized legs anyway. Storing "the last one" is the exact bug
fixed in `routeVenueScan.ts` for V4.

- [ ] **Step 2: Add the second rescue block**

In `decomposeRoute.ts`, immediately after the V4 rescue block closes:

```ts
	// PancakeSwap Infinity — same shape as the V4 rescue above, separate because
	// the two singletons are deliberately not unified (see infinityLegs.ts).
	const infinitySwaps = collectInfinitySwaps(logs);
	if (
		shouldAttemptInfinityRescue({
			reconstructed: graph.reconstructed,
			breakReason: graph.breakReason,
			swaps: infinitySwaps,
		})
	) {
		const keyReader = deps?.infinityPoolKeyReader
			?? createDefaultInfinityPoolKeyReader(input.rpcUrl, input.blockNumber);
		const poolKeys = new Map<string, { currency0: string; currency1: string }>();
		for (const s of infinitySwaps) {
			if (poolKeys.has(s.poolId)) continue;
			const key = await keyReader(s.poolId);
			if (key) poolKeys.set(s.poolId, key);
		}
		const extraLegs = synthesizeInfinityLegs(infinitySwaps, poolKeys, WETH);
		if (extraLegs.length > 0) {
			const infGraph = buildRouteGraph({
				transfers,
				trader: input.trader,
				venues,
				denylist: extendedDenylist,
				extraLegs,
			});
			// Same completeness guard as the V4 rescue, for the same reason:
			// `reconstructed` compares no endpoint totals, so it accepts a rescue
			// that under-accounts when a pool key fails to resolve.
			const traderLc = input.trader.toLowerCase();
			const traderSent = transfers
				.filter((t) => t.from.toLowerCase() === traderLc && t.token.toLowerCase() === infGraph.inputToken)
				.reduce((s, t) => s + t.value, 0n);
			const afterIn = infGraph.legs
				.filter((l) => l.tokenIn === infGraph.inputToken)
				.reduce((s, l) => s + l.amountInRaw, 0n);
			const shortfall =
				traderSent > 0n && afterIn < traderSent && (traderSent - afterIn) * 1000n > traderSent;
			if (infGraph.reconstructed && !shortfall) {
				const changed = infGraph.legs.length !== graph.legs.length;
				graph = infGraph;
				if (changed) {
					routeFlags.push(`INFINITY_LEGS: synthesized ${extraLegs.length} Infinity pool leg(s) from Swap events`);
				}
			} else if (shortfall) {
				routeFlags.push(
					`INFINITY_RESCUE_REJECTED: synthesized legs consume ${afterIn} of the ${traderSent} input`
					+ ` the trader sent (a pool key likely failed to resolve); keeping the un-rescued route`,
				);
			}
		}
	}
```

Add `infinityPoolKeyReader?: V4PoolKeyReader;` to `DecomposeRouteDeps`, and
import `collectInfinitySwaps`, `shouldAttemptInfinityRescue`,
`synthesizeInfinityLegs` from `./infinityLegs.js` plus
`createDefaultInfinityPoolKeyReader` from `./routeReaders.js`.

- [ ] **Step 3: Label the venue**

In `receiptDisplay.tsx`'s `getVenueLabel`, beside the other type cases:

```tsx
	if (leg.type === 'pancake_infinity') return 'PancakeSwap Infinity';
```

The Vault address is already in `KNOWN_VENUE_LABELS`; this covers the
synthesized `inf:<poolId>` legs, whose venue is a pool id rather than an address.

Also extend `legLinkAddress` so an `inf:` leg links somewhere real:

```tsx
	// `inf:<poolId>` and `v4:<poolId>` venues are pool ids, not addresses.
	if (leg.venue.startsWith('inf:')) return INFINITY_CL_POOL_MANAGER_ADDRESS;
```

with `const INFINITY_CL_POOL_MANAGER_ADDRESS = '0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b';`
declared beside `KNOWN_VENUE_LABELS`.

- [ ] **Step 4: Run the whole suite, both shell states**

```bash
npx vitest run
```
then, as a **separate** call:
```bash
set -a && source .env && set +a && npx vitest run
```
then:
```bash
npx tsc --build && npx eslint packages/core packages/dashboard
```

Expected: all pass in both states; tsc 0; eslint 0.

⚠️ Watch `decomposeRoute V4 multi-pool extraction (id 56)` — it exercises the V4
rescue end-to-end and must stay green. A failure there means the second rescue
block disturbed the first.

- [ ] **Step 5: Repopulate and verify against the success criteria**

```bash
npx tsc --build packages/core
node scripts/repopulateReceipts.mjs --ids=408,445
node scripts/repopulateReceipts.mjs --ids=408,445 --commit
```

⚠️ `WATCH` excludes **both** `routeLegs` and `normalizeFlags`, so this may print
`no change` / `changed=0` while writing. Verify by querying:

```bash
node --input-type=module -e '
import { connect, costedLegs } from "./scripts/analysis/_env.mjs";
const sql = await connect();
const rows = await sql`select id, lp_fee_bps, agg_fee_bps, slippage_bps, all_in_cost_bps, route_legs, normalize_flags from receipts where id in (408,445) order by id`;
await sql.end();
for (const r of rows) {
  console.log(`\nid ${r.id}  allIn=${r.all_in_cost_bps} lpFee=${r.lp_fee_bps} aggFee=${r.agg_fee_bps} slip=${r.slippage_bps}`);
  for (const l of costedLegs(r)) console.log(`   ${String(l.type).padEnd(17)} ${String(l.venue).slice(0,26).padEnd(26)} fee=${l.feeTierBps} feeResolved=${l.feeResolved} PI=${l.priceImpactBps}`);
  for (const f of (r.normalize_flags ?? []).map(String).filter((x) => /INFINITY/.test(x))) console.log(`   FLAG ${f}`);
}
'
```

**Success is measured on id 408**, where Infinity is the only gap:
- its `0x238a3588…` leg is replaced by an `inf:<poolId>` leg;
- that leg has `feeTierBps` ≈ **0.47** and no `feeResolved: false`;
- that leg has a **non-null `priceImpactBps`** — this is the proof the mid branch
  works, and the single most important check in this plan;
- `allIn = lpFee + aggFee + slippage` still closes.

⚠️ **id 445 is NOT a success criterion.** Infinity is three of its seven
uncaptured venues; the rest include two unrecognised WBTC/cbBTC pools and a V4
rescue the shortfall guard correctly rejects. Record what changed for it. If it
still does not reconstruct, that is an accepted outcome — do not chase it.

If id 408 fails any of the four criteria, STOP and report. Do not adjust the
criteria. Backups: `docs/receipt-408-prerepop-backup.json`,
`docs/receipts-full-corpus-backup-2026-07-31.json`.

- [ ] **Step 6: Mark the worklist done**

In `docs/attribution-worklist.md`, change the §4 heading to
`## 4. PancakeSwap Infinity  ✅ DONE 2026-07-31` and replace the
"⭐ STILL OPEN: the 0.47 bps leg fee" paragraph with:

```markdown
**Delivered 2026-07-31.** `infinityLegs.ts` decodes the Infinity Swap topic into
one leg per pool, with the LP fee recovered from the event by inverting
`calculateSwapFee` (no RPC), and `pancake_infinity` gains both a fee-reader case
and a `getLegMidAtBlock` branch reading `getSlot0` from the CLPoolManager.

⚡ The value was mis-stated above as 0.17 bps on a $12 trade. That was the right
number for the wrong question: id 445 ($3,733) contains three Infinity swaps that
were not modelled at all, so its route could not conserve and `reconstructed` was
false — and `decomposeRoute.ts` gates ALL price impact behind that flag. The cost
was a receipt producing nothing, not a fraction of a basis point.

⚠️ Still open: `0x60b393a76cea4a3afff00e1fb08d0f63a8f4a314`, a SECOND contract
emitting the Uniswap V4 Swap topic (a fork), found in id 445. It is typed
`univ4`, so its fee and mid reads assume the real PoolManager's state view.
```

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/routeVenueScan.ts packages/core/src/decomposeRoute.ts \
        packages/dashboard/components/receipt/receiptDisplay.tsx docs/attribution-worklist.md
git commit -m "feat(core,dashboard): synthesize Infinity legs and label them

routeVenueScan registers the VAULT (not the emitting CLPoolManager) as the
pancake_infinity venue, because that is where transfers land. decomposeRoute
gains a second rescue block mirroring V4's, including the same trader-outflow
shortfall guard — reconstruction is not a completeness check.

Marks worklist item 4 done and corrects its value: the cost of not modelling
Infinity was a \$3,733 receipt producing nothing, not 0.17 bps on a \$12 one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Out of scope

- **Generalising V4 and Infinity into one registry-driven mechanism.** Decided
  2026-07-31: the V4 path carries three separately-earned guards and unifying
  against a sample of two risks them for no present gain. Revisit at a third.
- **id 445 reconstructing** — see Task 5 Step 5.
- **The two unrecognised WBTC/cbBTC pools in id 445**, and its rejected V4 rescue.
- **`0x60b393a76cea4a3afff00e1fb08d0f63a8f4a314`** — a second contract emitting
  the Uniswap V4 Swap topic. Real, separate, recorded in the worklist.
- **Surfacing the fee-on-transfer tax** — parked separately by the user.
