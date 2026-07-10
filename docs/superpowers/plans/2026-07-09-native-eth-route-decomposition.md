# Native-ETH Route Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make native-ETH-settled trades (e.g. WARP→ETH) decompose into a fully-costed per-leg breakdown that lists the pools they touched, surface wrap/unwrap as informational steps, and fall back to a pools-touched list otherwise.

**Architecture:** Native ETH emits no ERC-20 `Transfer`, so `routeGraph.buildRouteGraph`'s `identifyTraderTokens` returns null and bails before examining any pool. Fix by modeling native value transfers as WETH in the transfer set upstream of the graph (new Step 3a in `decomposeRoute`). Wrap/unwrap steps are detected from `Deposit`/`Withdrawal` events and appended to `routeLegs` for display only. When a route still yields no costed legs, emit uncosted entries from the detected Swap venues. The dashboard renders costed legs, a "Pools Touched" section, or "No Route Found".

**Tech Stack:** TypeScript monorepo, Vitest, viem, Drizzle/Postgres, Next.js. Packages: `@fabric-tca/core` (`packages/core`), dashboard (`packages/dashboard`).

## Global Constraints

- **No DB migration.** `route_legs` is jsonb; new leg shapes (null cost fields, `type: 'wrap'|'unwrap'`) require no schema change.
- **Native ETH maps to the canonical WETH address** `0x4200000000000000000000000000000000000006` inside the graph. The graph's token identity is display-invisible (receipt symbols come from `endpoints`).
- **Base-only.** Canonical WETH is the address above; chainId 8453.
- **TDD:** failing test first, minimal implementation, verify, commit. Run core tests with `npx vitest run <file>` from `packages/core`; dashboard tests from `packages/dashboard`.
- **Pure helpers stay pure:** no viem/RPC/DB imports in `extractNativeTransfers`, `detectWrapUnwrapSteps`, `venuesToUncostedLegs`.
- Existing decomposed (non-native) routes must be unaffected: the native transfer set is empty for them.

## File structure

- `packages/core/src/decomposeRoute.ts` — add `extractNativeTransfers`, `detectWrapUnwrapSteps`, `venuesToUncostedLegs`, `wrapUnwrapToLegEntry`; wire Step 3a; widen `RouteDecomposeResult.legs`; assemble legs at both return sites.
- `packages/core/src/routeGraph.ts` — extend `VenueType` with `'wrap' | 'unwrap'`.
- `packages/core/src/decomposeRoute.test.ts` — unit tests for the new helpers + native-flip integration.
- `packages/core/src/analyzeTransaction.test.ts` — upgrade the live WARP e2e.
- `packages/dashboard/lib/queries.ts` — widen `RouteLeg.lpFeeBps` to `number | null`.
- `packages/dashboard/components/TradesTable.tsx` — `getVenueLabel` wrap/unwrap labels; `getPriceImpactRows` exclude wrap/unwrap; `routePath` skip wrap/unwrap.
- `packages/dashboard/components/ReceiptView.tsx` — render costed vs "Pools Touched"; rename placeholder to "No Route Found".
- `packages/dashboard/components/ReceiptView.test.tsx`, `TradesTable.test.tsx` — render tests.

## Shared test constants

Used across the core tests below. Define at the top of each test file that needs them (or import from a shared block if the file already has equivalents):

```ts
const TRADER = '0x00000000000000000000000000000000000000a1';
const POOL_A = '0x00000000000000000000000000000000000000b1';
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEPOSIT_TOPIC = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c';      // Deposit(address indexed,uint256)
const WITHDRAWAL_TOPIC = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';  // Withdrawal(address indexed,uint256)

const pad32 = (addr: string) => '0x' + addr.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const u256 = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');
```

---

### Task 1: `extractNativeTransfers` pure helper

**Files:**
- Modify: `packages/core/src/decomposeRoute.ts` (add exported helper + widen `TraceNode` with `error?`)
- Test: `packages/core/src/decomposeRoute.test.ts`

**Interfaces:**
- Produces: `export function extractNativeTransfers(trace: TraceNode): { token: string; from: string; to: string; value: bigint }[]` — walks the callTracer tree; for each frame with `value > 0`, `type` in `{'CALL','CALLCODE'}`, and no `error`, emits `{ token: WETH, from, to, value }` (from/to lowercased). Skips `DELEGATECALL`/`STATICCALL`, zero-value, and reverted frames.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/decomposeRoute.test.ts` (import `extractNativeTransfers` from `./decomposeRoute.js`):

```ts
describe('extractNativeTransfers', () => {
  it('collects value-moving CALL frames as WETH transfers, skipping delegate/static/reverted/zero', () => {
    const trace = {
      type: 'CALL', from: TRADER, to: POOL_A, value: '0x0',
      calls: [
        { type: 'CALL', from: POOL_A, to: TRADER, value: u256(5n) },
        { type: 'DELEGATECALL', from: POOL_A, to: TRADER, value: u256(9n) },
        { type: 'CALL', from: POOL_A, to: TRADER, value: u256(7n), error: 'execution reverted' },
        { type: 'STATICCALL', from: POOL_A, to: TRADER, value: u256(3n) },
        { type: 'CALL', from: POOL_A, to: TRADER, value: '0x0',
          calls: [{ type: 'CALL', from: TRADER, to: POOL_A, value: u256(11n) }] },
      ],
    };
    const out = extractNativeTransfers(trace as never);
    expect(out).toEqual([
      { token: WETH, from: POOL_A, to: TRADER, value: 5n },
      { token: WETH, from: TRADER, to: POOL_A, value: 11n }, // nested frame collected
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `packages/core`): `npx vitest run src/decomposeRoute.test.ts -t extractNativeTransfers`
Expected: FAIL — `extractNativeTransfers is not a function` / import error.

- [ ] **Step 3: Write minimal implementation**

In `packages/core/src/decomposeRoute.ts`, add `error?: string;` to the `TraceNode` interface (after `type?: string;`), and add near `collectTraceLogs`:

```ts
/** Extract native ETH value transfers from a callTracer tree, modeled as WETH
 *  transfers so the ERC-20-only route graph can see native-settled legs. Skips
 *  delegate/static calls (no value), reverted frames, and zero-value frames. */
export function extractNativeTransfers(trace: TraceNode): { token: string; from: string; to: string; value: bigint }[] {
  const out: { token: string; from: string; to: string; value: bigint }[] = [];
  const visit = (node: TraceNode) => {
    const type = node.type ?? '';
    const moves = type === 'CALL' || type === 'CALLCODE';
    if (moves && !node.error && node.value && node.from && node.to) {
      const value = BigInt(node.value);
      if (value > 0n) {
        out.push({ token: WETH, from: node.from.toLowerCase(), to: node.to.toLowerCase(), value });
      }
    }
    if (node.calls) for (const child of node.calls) visit(child);
  };
  visit(trace);
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/decomposeRoute.test.ts -t extractNativeTransfers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/decomposeRoute.ts packages/core/src/decomposeRoute.test.ts
git commit -m "feat(core): extractNativeTransfers — model native ETH as WETH transfers"
```

---

### Task 2: Wire Step 3a — native modeling flips native routes to decomposed

**Files:**
- Modify: `packages/core/src/decomposeRoute.ts` (insert Step 3a between Step 3 and Step 3b, ~line 557-561)
- Test: `packages/core/src/decomposeRoute.test.ts`

**Interfaces:**
- Consumes: `extractNativeTransfers` (Task 1), existing `resolveV4Settlement`, `buildRouteGraph`.
- Produces: after this task, a trace whose trader receives native ETH decomposes; `decomposeRoute(...).legs` contains the costed pool leg(s), `routeShape` is `'single'`/`'linear'`.

- [ ] **Step 1: Write the failing test**

Add to `decomposeRoute.test.ts`. A single-hop USDC→native-ETH trade through an unrecognized (no Swap event) pool, which becomes an `'unknown'` venue:

```ts
describe('native-ETH decomposition (Step 3a)', () => {
  const nativeTrace = {
    type: 'CALL', from: TRADER, to: POOL_A, value: '0x0',
    logs: [
      { address: USDC, topics: [TRANSFER_TOPIC, pad32(TRADER), pad32(POOL_A)], data: u256(2_000000n) },
    ],
    calls: [
      { type: 'CALL', from: POOL_A, to: TRADER, value: u256(1_000000000000000000n) }, // 1 ETH out
    ],
  };
  const input = {
    trace: nativeTrace, txHash: '0xabc', trader: TRADER, direction: 'sell_weth', settledIn: 'ETH',
    allInCostBps: 0, notionalUsdc: 2, realizedPrice: 2000, gasCostUsd: 0, aggregator: 'unknown',
    blockNumber: 100n, rpcUrl: 'http://invalid', dustUsdc: 1e-6, structuralFloorUsd: 0,
    structuralFloorBps: 0.5, recognizeV3Forks: true, impureOnVenueThirdToken: true,
  } as never;

  it('decomposes a USDC→native-ETH single hop into one costed leg', async () => {
    const result = await decomposeRoute(input, {
      trace: nativeTrace as never,
      feeReader: async () => ({ bps: 30, defaulted: false }),
    });
    expect(result.legs).toHaveLength(1);
    expect(result.legs[0]!.leg.venue).toBe(POOL_A);
    expect(result.legs[0]!.leg.tokenIn).toBe(USDC);
    expect(result.legs[0]!.leg.tokenOut).toBe(WETH); // native modeled as WETH
    expect(typeof result.legs[0]!.lpFeeBps).toBe('number');
    expect(result.routeShape === 'single' || result.routeShape === 'linear').toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/decomposeRoute.test.ts -t "native-ETH decomposition"`
Expected: FAIL — `result.legs` has length 0 and `routeShape` is `'complex'` (native output invisible → `identifyTraderTokens` returns null).

- [ ] **Step 3: Write minimal implementation**

In `decomposeRoute.ts`, immediately before the `// Step 3b: Resolve V4 settlement proxies` block, insert:

```ts
	// Step 3a: Model native ETH value transfers as WETH so the ERC-20-only route
	// graph can chain native-settled legs (e.g. a Uniswap V4 pool paying ETH).
	const nativeTransfers = extractNativeTransfers(trace);
	const rawTransfersWithNative = [...rawTransfers, ...nativeTransfers];
```

Then change the `resolveV4Settlement` call to consume the augmented list:

```ts
	const { transfers, extendedDenylist } = resolveV4Settlement(
		rawTransfersWithNative, venues, input.trader, DENYLIST,
	);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/decomposeRoute.test.ts -t "native-ETH decomposition"`
Expected: PASS. Also run the whole file to confirm no regressions:
`npx vitest run src/decomposeRoute.test.ts` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/decomposeRoute.ts packages/core/src/decomposeRoute.test.ts
git commit -m "feat(core): Step 3a — decompose native-ETH-settled routes"
```

---

### Task 3: Wrap/unwrap informational steps

**Files:**
- Modify: `packages/core/src/routeGraph.ts` (extend `VenueType`)
- Modify: `packages/core/src/decomposeRoute.ts` (add `detectWrapUnwrapSteps`, `wrapUnwrapToLegEntry`; widen `RouteDecomposeResult.legs`; assemble at both return sites)
- Test: `packages/core/src/decomposeRoute.test.ts`

**Interfaces:**
- Produces:
  - `export function detectWrapUnwrapSteps(logs: readonly { address: string; topics: readonly string[]; data: string }[]): { kind: 'wrap' | 'unwrap'; amountRaw: bigint }[]` — returns at most one `wrap` (from WETH `Deposit`) and one `unwrap` (from WETH `Withdrawal`), amounts summed.
  - Result `legs` entries may now have `lpFeeBps: number | null` and `leg.type: 'wrap' | 'unwrap'`.

- [ ] **Step 1: Write the failing test**

Add to `decomposeRoute.test.ts` (reuses `nativeTrace`/`input` from Task 2's describe — redefine locally or lift to file scope):

```ts
describe('wrap/unwrap informational steps', () => {
  it('detectWrapUnwrapSteps returns one summed unwrap and one wrap', () => {
    const logs = [
      { address: WETH, topics: [WITHDRAWAL_TOPIC, pad32(TRADER)], data: u256(3n) },
      { address: WETH, topics: [WITHDRAWAL_TOPIC, pad32(TRADER)], data: u256(4n) },
      { address: WETH, topics: [DEPOSIT_TOPIC, pad32(TRADER)], data: u256(10n) },
      { address: USDC, topics: [TRANSFER_TOPIC, pad32(TRADER), pad32(POOL_A)], data: u256(1n) },
    ];
    expect(detectWrapUnwrapSteps(logs)).toEqual([
      { kind: 'wrap', amountRaw: 10n },
      { kind: 'unwrap', amountRaw: 7n },
    ]);
  });

  it('appends an unwrap leg (null cost) after the costed pool legs', async () => {
    const traceWithUnwrap = {
      type: 'CALL', from: TRADER, to: POOL_A, value: '0x0',
      logs: [
        { address: USDC, topics: [TRANSFER_TOPIC, pad32(TRADER), pad32(POOL_A)], data: u256(2_000000n) },
        { address: WETH, topics: [WITHDRAWAL_TOPIC, pad32(POOL_A)], data: u256(1_000000000000000000n) },
      ],
      calls: [{ type: 'CALL', from: POOL_A, to: TRADER, value: u256(1_000000000000000000n) }],
    };
    const input = {
      trace: traceWithUnwrap, txHash: '0xabc', trader: TRADER, direction: 'sell_weth', settledIn: 'ETH',
      allInCostBps: 0, notionalUsdc: 2, realizedPrice: 2000, gasCostUsd: 0, aggregator: 'unknown',
      blockNumber: 100n, rpcUrl: 'http://invalid', dustUsdc: 1e-6, structuralFloorUsd: 0,
      structuralFloorBps: 0.5, recognizeV3Forks: true, impureOnVenueThirdToken: true,
    } as never;
    const result = await decomposeRoute(input, {
      trace: traceWithUnwrap as never, feeReader: async () => ({ bps: 30, defaulted: false }),
    });
    const unwrap = result.legs.find((l) => l.leg.type === 'unwrap');
    expect(unwrap).toBeDefined();
    expect(unwrap!.lpFeeBps).toBeNull();
    expect(result.legs[result.legs.length - 1]!.leg.type).toBe('unwrap'); // appended last
    expect(result.legs.some((l) => typeof l.lpFeeBps === 'number')).toBe(true); // pool leg still costed
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/decomposeRoute.test.ts -t "wrap/unwrap"`
Expected: FAIL — `detectWrapUnwrapSteps is not a function`.

- [ ] **Step 3: Write minimal implementation**

**3a.** In `routeGraph.ts`, extend the union (append the two members):

```ts
export type VenueType = 'univ3' | 'sushiv3' | 'baseswapv3' | 'pancakev3' | 'univ4' | 'univ2' | 'aerodrome' | 'aerodrome_cl' | 'curve_stableng' | 'maverickv2' | 'rfq' | 'unknown' | 'wrap' | 'unwrap';
```

**3b.** In `decomposeRoute.ts`, add helpers near `extractNativeTransfers`:

```ts
/** Detect WETH wrap (Deposit) / unwrap (Withdrawal) events. At most one of each,
 *  amounts summed. Emitted as informational, zero-cost route steps. */
export function detectWrapUnwrapSteps(
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
): { kind: 'wrap' | 'unwrap'; amountRaw: bigint }[] {
  let wrap = 0n, unwrap = 0n, sawWrap = false, sawUnwrap = false;
  for (const log of logs) {
    if (log.address.toLowerCase() !== WETH) continue;
    const t0 = log.topics[0];
    if (t0 === DEPOSIT_TOPIC) { wrap += BigInt(log.data); sawWrap = true; }
    else if (t0 === WITHDRAWAL_TOPIC) { unwrap += BigInt(log.data); sawUnwrap = true; }
  }
  const steps: { kind: 'wrap' | 'unwrap'; amountRaw: bigint }[] = [];
  if (sawWrap) steps.push({ kind: 'wrap', amountRaw: wrap });
  if (sawUnwrap) steps.push({ kind: 'unwrap', amountRaw: unwrap });
  return steps;
}

/** Build a display-only leg entry for a wrap/unwrap step (null costs). */
function wrapUnwrapToLegEntry(
  step: { kind: 'wrap' | 'unwrap'; amountRaw: bigint },
): LegFeeInput & { lpFeeBps: number | null; priceImpactBps: number | null } {
  const isWrap = step.kind === 'wrap';
  return {
    leg: {
      venue: WETH,
      type: step.kind,
      tokenIn: isWrap ? 'native' : WETH,
      tokenOut: isWrap ? WETH : 'native',
      amountInRaw: step.amountRaw,
      amountOutRaw: step.amountRaw,
    },
    feeTierBps: 0,
    notionalUsdc: 0,
    notionalApprox: true,
    lpFeeBps: null,
    priceImpactBps: null,
  };
}
```

Add the DEPOSIT/WITHDRAWAL topic constants near the existing `UNI_V3_SWAP_TOPIC` constant:

```ts
const WETH_DEPOSIT_TOPIC = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c';
const WETH_WITHDRAWAL_TOPIC = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
```

Reference them as `WETH_DEPOSIT_TOPIC`/`WETH_WITHDRAWAL_TOPIC` in `detectWrapUnwrapSteps` (rename from the `DEPOSIT_TOPIC`/`WITHDRAWAL_TOPIC` used in the test block).

**3c.** Widen the result type (`RouteDecomposeResult`, ~line 92):

```ts
	legs: (LegFeeInput & { lpFeeBps: number | null; priceImpactBps: number | null })[];
```

**3d.** Compute wrap/unwrap once after `logs` is available (after Step 3, before the branch), then splice into both return sites. Add after Step 3's venue setup:

```ts
	const wrapUnwrapSteps = detectWrapUnwrapSteps(logs);
	const wrapEntries = wrapUnwrapSteps.filter((s) => s.kind === 'wrap').map(wrapUnwrapToLegEntry);
	const unwrapEntries = wrapUnwrapSteps.filter((s) => s.kind === 'unwrap').map(wrapUnwrapToLegEntry);
```

In the **decomposed** return (the `graph.reconstructed && …` block, ~line 730), change `legs: legsWithLp,` to:

```ts
		legs: [...wrapEntries, ...legsWithLp, ...unwrapEntries],
```

In the **ROUTE_NOT_DECOMPOSED** return (~line 760), change `legs: legsWithLp,` to (fallback filled in Task 4; for now keep `legsWithLp`):

```ts
		legs: [...wrapEntries, ...legsWithLp, ...unwrapEntries],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/decomposeRoute.test.ts` → all PASS.
Run: `npx tsc --noEmit` (from `packages/core`) — fix any `VenueType` exhaustiveness errors (add a `case 'wrap': case 'unwrap':` returning a benign default in any switch that newly fails). Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/routeGraph.ts packages/core/src/decomposeRoute.ts packages/core/src/decomposeRoute.test.ts
git commit -m "feat(core): surface WETH wrap/unwrap as zero-cost route steps"
```

---

### Task 4: Pools-touched fallback

**Files:**
- Modify: `packages/core/src/decomposeRoute.ts` (add `venuesToUncostedLegs`; use it in the ROUTE_NOT_DECOMPOSED return when `legsWithLp` is empty)
- Test: `packages/core/src/decomposeRoute.test.ts`

**Interfaces:**
- Produces: `export function venuesToUncostedLegs(venues: Map<string, { type: VenueType }>, transfers: { token: string; from: string; to: string; value: bigint }[]): (LegFeeInput & { lpFeeBps: null; priceImpactBps: null })[]` — one entry per venue; `tokenIn`/`tokenOut` filled only when that venue's net flow is a clean 1-in-1-out, else left as `''`.

- [ ] **Step 1: Write the failing test**

```ts
describe('venuesToUncostedLegs (pools-touched fallback)', () => {
  it('emits one uncosted entry per venue with best-effort token pair', () => {
    const venues = new Map([[POOL_A, { type: 'univ3' as const }]]);
    const transfers = [
      { token: USDC, from: TRADER, to: POOL_A, value: 2n },
      { token: WETH, from: POOL_A, to: TRADER, value: 1n },
    ];
    const out = venuesToUncostedLegs(venues, transfers);
    expect(out).toHaveLength(1);
    expect(out[0]!.leg.venue).toBe(POOL_A);
    expect(out[0]!.leg.type).toBe('univ3');
    expect(out[0]!.leg.tokenIn).toBe(USDC);
    expect(out[0]!.leg.tokenOut).toBe(WETH);
    expect(out[0]!.lpFeeBps).toBeNull();
  });

  it('leaves token pair empty for an ambiguous multi-token venue', () => {
    const venues = new Map([[POOL_A, { type: 'univ4' as const }]]);
    const transfers = [
      { token: USDC, from: TRADER, to: POOL_A, value: 2n },
      { token: WETH, from: TRADER, to: POOL_A, value: 5n }, // two net-received tokens
      { token: WETH, from: POOL_A, to: TRADER, value: 1n },
    ];
    const out = venuesToUncostedLegs(venues, transfers);
    expect(out[0]!.leg.tokenIn).toBe('');
    expect(out[0]!.leg.tokenOut).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/decomposeRoute.test.ts -t "venuesToUncostedLegs"`
Expected: FAIL — `venuesToUncostedLegs is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `decomposeRoute.ts`:

```ts
/** Best-effort uncosted "pools touched" entries for a route that could not be
 *  costed. One entry per detected venue; token pair filled only for a clean
 *  1-in-1-out net flow. */
export function venuesToUncostedLegs(
  venues: Map<string, { type: VenueType }>,
  transfers: { token: string; from: string; to: string; value: bigint }[],
): (LegFeeInput & { lpFeeBps: null; priceImpactBps: null })[] {
  const net = new Map<string, Map<string, bigint>>();
  for (const t of transfers) {
    const from = t.from.toLowerCase(), to = t.to.toLowerCase(), tok = t.token.toLowerCase();
    if (!net.has(from)) net.set(from, new Map());
    if (!net.has(to)) net.set(to, new Map());
    net.get(from)!.set(tok, (net.get(from)!.get(tok) ?? 0n) - t.value);
    net.get(to)!.set(tok, (net.get(to)!.get(tok) ?? 0n) + t.value);
  }
  const out: (LegFeeInput & { lpFeeBps: null; priceImpactBps: null })[] = [];
  for (const [addr, info] of venues) {
    const m = net.get(addr.toLowerCase());
    let tokenIn = '', tokenOut = '';
    if (m) {
      const recv = [...m].filter(([, d]) => d > 0n).map(([t]) => t);
      const sent = [...m].filter(([, d]) => d < 0n).map(([t]) => t);
      if (recv.length === 1 && sent.length === 1) { tokenIn = recv[0]!; tokenOut = sent[0]!; }
    }
    out.push({
      leg: { venue: addr, type: info.type, tokenIn, tokenOut, amountInRaw: 0n, amountOutRaw: 0n },
      feeTierBps: 0, notionalUsdc: 0, notionalApprox: true, lpFeeBps: null, priceImpactBps: null,
    });
  }
  return out;
}
```

In the ROUTE_NOT_DECOMPOSED return, replace the `legs:` line from Task 3 with a fallback when there are no costed legs:

```ts
		legs: [
			...wrapEntries,
			...(legsWithLp.length > 0 ? legsWithLp : venuesToUncostedLegs(venues, transfers)),
			...unwrapEntries,
		],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/decomposeRoute.test.ts` → all PASS. `npx tsc --noEmit` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/decomposeRoute.ts packages/core/src/decomposeRoute.test.ts
git commit -m "feat(core): pools-touched fallback for undecomposable routes"
```

---

### Task 5: Live e2e — WARP route now decomposes

**Files:**
- Modify: `packages/core/src/analyzeTransaction.test.ts` (the existing WARP `estimated`-tier test, ~line 99)

**Interfaces:**
- Consumes: Tasks 1–4 (native decomposition end-to-end via `analyzeTransaction`).

- [ ] **Step 1: Write the failing test**

Extend the existing WARP test body (keep the current assertions) with route-leg assertions:

```ts
		// Route now decomposes: 3 costed pool legs (native-ETH exit modeled as WETH).
		const legs = r!.routeLegs as { venue: string; type: string; lpFeeBps: number | null }[];
		const venues = legs.map((l) => l.venue.toLowerCase());
		expect(venues).toContain('0x53932cbd9c700cf191b2b45e0b1cd50d69f66a1e');   // Uni V3 WARP/WETH
		expect(venues).toContain('0x498581ff718922c3f8e6a244956af099b2652b2b');   // Uni V4 PM (USDC/ETH)
		expect(legs.filter((l) => typeof l.lpFeeBps === 'number').length).toBeGreaterThanOrEqual(3);
		expect(r!.routeShape).toBe('linear');
		// No wrap/unwrap in this route (V4 pays native directly).
		expect(legs.some((l) => l.type === 'wrap' || l.type === 'unwrap')).toBe(false);
```

> Note: `0x53932cbd…` and `0x498581ff…` are the full lowercased pool addresses from the traced route; the Maverick pool `0x72ab388e…` is the third. Verify the exact `0x53932cbd…` and `0x72ab388e…` full addresses against a fresh trace if the short forms differ; the two asserted above (`0x53932cbd9c700cf191b2b45e0b1cd50d69f66a1e` Uni V3, `0x498581ff718922c3f8e6a244956af099b2652b2b` Uni V4 PM) are the load-bearing ones.

- [ ] **Step 2: Run test to verify it fails (pre-implementation baseline) / passes (post)**

Run (needs `TCA_RPC_URL` in `packages/core/.env`): `npx vitest run src/analyzeTransaction.test.ts -t "WARP"`
Expected: with Tasks 1–4 merged, PASS. If run before Tasks 1–4, the leg assertions FAIL (empty `routeLegs`, `routeShape` `'complex'`).

- [ ] **Step 3: (no new implementation — validates Tasks 1–4)**

If the test fails on venue addresses, re-trace the hash to confirm the exact pool addresses (the Uni V4 PoolManager `0x498581ff…` and Uni V3 `0x53932cbd…` are stable) and adjust the literals. Do not weaken the "≥3 costed legs" / `routeShape === 'linear'` assertions.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/analyzeTransaction.test.ts` → PASS (WARP + existing).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/analyzeTransaction.test.ts
git commit -m "test(core): e2e WARP route decomposes to 3 costed pool legs"
```

---

### Task 6: Dashboard types & venue helpers

**Files:**
- Modify: `packages/dashboard/lib/queries.ts` (`RouteLeg.lpFeeBps` → `number | null`)
- Modify: `packages/dashboard/components/TradesTable.tsx` (`getVenueLabel`, `getPriceImpactRows`, `routePath`)
- Test: `packages/dashboard/components/TradesTable.test.tsx`

**Interfaces:**
- Produces: `getVenueLabel` returns `'Unwrap (WETH→ETH)'` / `'Wrap (ETH→WETH)'` for `type` `'unwrap'`/`'wrap'`; `getPriceImpactRows` omits wrap/unwrap legs; `routePath` skips them.

- [ ] **Step 1: Write the failing test**

Add to `TradesTable.test.tsx`:

```ts
describe('wrap/unwrap venue handling', () => {
  it('labels wrap and unwrap legs', async () => {
    const { getVenueLabel } = await import('./TradesTable');
    expect(getVenueLabel({ type: 'unwrap' })).toBe('Unwrap (WETH→ETH)');
    expect(getVenueLabel({ type: 'wrap' })).toBe('Wrap (ETH→WETH)');
  });
  it('excludes wrap/unwrap legs from price-impact rows', async () => {
    const { getPriceImpactRows } = await import('./TradesTable');
    const rows = getPriceImpactRows([
      { venue: '0xpool', type: 'univ3', tokenIn: '0xusdc', tokenOut: '0xweth', priceImpactBps: 5 },
      { venue: '0x4200000000000000000000000000000000000006', type: 'unwrap', tokenIn: '0x4200000000000000000000000000000000000006', tokenOut: 'native', priceImpactBps: null },
    ] as never);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).not.toContain('Unwrap');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `packages/dashboard`): `npx vitest run components/TradesTable.test.tsx -t "wrap/unwrap venue handling"`
Expected: FAIL — `getVenueLabel({type:'unwrap'})` returns `'UNWRAP'`; price-impact rows length 2.

- [ ] **Step 3: Write minimal implementation**

**6a.** `queries.ts` line 52: `lpFeeBps: number | null;`

**6b.** `TradesTable.tsx` `getVenueLabel` — add before the `rfq`/`unknown` case:

```ts
	if (leg.type === 'unwrap') return 'Unwrap (WETH→ETH)';
	if (leg.type === 'wrap') return 'Wrap (ETH→WETH)';
```

**6c.** `TradesTable.tsx` `getPriceImpactRows` — filter at the top of the function body, before `.map`:

```ts
	return legs
		.filter((leg) => leg.type !== 'wrap' && leg.type !== 'unwrap')
		.map((leg) => {
```

**6d.** `TradesTable.tsx` `routePath` — skip wrap/unwrap so the History summary path stays token-clean:

```ts
export function routePath(legs: RouteLeg[]): string {
	const swaps = legs.filter((l) => l.type !== 'wrap' && l.type !== 'unwrap');
	if (swaps.length === 0) return '–';
	const tokens = [tokenSymbol(swaps[0]!.tokenIn), ...swaps.map((leg) => tokenSymbol(leg.tokenOut))];
	return tokens.join('->');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run components/TradesTable.test.tsx` → PASS. `npx tsc --noEmit` (from `packages/dashboard`) → exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/lib/queries.ts packages/dashboard/components/TradesTable.tsx packages/dashboard/components/TradesTable.test.tsx
git commit -m "feat(dashboard): wrap/unwrap venue labels + null lpFee type"
```

---

### Task 7: ReceiptView — costed legs vs "Pools Touched" vs "No Route Found"

**Files:**
- Modify: `packages/dashboard/components/ReceiptView.tsx` (LP Fee section + Price Impact gate + placeholder rename)
- Test: `packages/dashboard/components/ReceiptView.test.tsx`

**Interfaces:**
- Consumes: `getVenueLabel`, `normalizeRouteLegs` (Task 6). `legs` = `normalizeRouteLegs(row.routeLegs)`.

- [ ] **Step 1: Write the failing test**

Add to `ReceiptView.test.tsx`:

```ts
describe('Receipt route rendering (native/fallback)', () => {
  const base = { ...fullUsdcWethRow };
  it('renders costed pool legs plus an informational unwrap row', async () => {
    const { ReceiptView } = await import('./ReceiptView');
    const row = { ...base, routeLegs: [
      { venue: '0x53932cbd9c700cf191b2b45e0b1cd50d69f66a1e', type: 'univ3', tokenIn: '0xd9159ad2d5fe625cd1f54f4d328fb19cb5262b07', tokenOut: '0x4200000000000000000000000000000000000006', feeTierBps: 30, notionalUsdc: 100, lpFeeBps: 30, priceImpactBps: 2 },
      { venue: '0x4200000000000000000000000000000000000006', type: 'unwrap', tokenIn: '0x4200000000000000000000000000000000000006', tokenOut: 'native', feeTierBps: 0, notionalUsdc: 0, lpFeeBps: null, priceImpactBps: null },
    ] };
    const html = renderToStaticMarkup(<ReceiptView trade={row as never} hash={row.txHash} />);
    expect(html).toContain('Uni v3');
    expect(html).toContain('Unwrap (WETH→ETH)');
    expect(html).not.toContain('No Route Found');
  });

  it('renders a Pools Touched section when no leg is costed', async () => {
    const { ReceiptView } = await import('./ReceiptView');
    const row = { ...base, pricingStatus: 'partial', routeLegs: [
      { venue: '0x498581ff718922c3f8e6a244956af099b2652b2b', type: 'univ4', tokenIn: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', tokenOut: 'native', feeTierBps: 0, notionalUsdc: 0, lpFeeBps: null, priceImpactBps: null },
    ] };
    const html = renderToStaticMarkup(<ReceiptView trade={row as never} hash={row.txHash} />);
    expect(html).toContain('Pools Touched');
    expect(html).toContain('Uni v4');
    expect(html).not.toContain('Liquidity Provider Fee');
  });

  it('renders "No Route Found" when there are no legs', async () => {
    const { ReceiptView } = await import('./ReceiptView');
    const row = { ...base, pricingStatus: 'partial', routeLegs: [] };
    const html = renderToStaticMarkup(<ReceiptView trade={row as never} hash={row.txHash} />);
    expect(html).toContain('No Route Found');
    expect(html).not.toContain('>Route<');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run components/ReceiptView.test.tsx -t "native/fallback"`
Expected: FAIL — no "Pools Touched"/"No Route Found"; unwrap row missing.

- [ ] **Step 3: Write minimal implementation**

In `ReceiptView.tsx`, after `const legs = normalizeRouteLegs(row.routeLegs);` (~line 298), add:

```ts
	const hasCostedLeg = legs.some((l) => typeof l.lpFeeBps === 'number');
```

Replace the Liquidity Provider Fee block (the `<BkdHeading label="Liquidity Provider Fee" plain />` and its `{legs.length > 0 ? … : <BkdRow label="Route" … />}`) with:

```tsx
				{legs.length === 0 ? (
					<>
						<BkdHeading label="Liquidity Provider Fee" plain />
						<BkdRow label="No Route Found" value="–" secondary />
					</>
				) : hasCostedLeg ? (
					<>
						<BkdHeading label="Liquidity Provider Fee" plain />
						{legs.map((leg, index) => {
							const isStep = leg.type === 'wrap' || leg.type === 'unwrap';
							const { text: lpText, color: lpColor } =
								leg.lpFeeBps == null ? { text: '–', color: undefined } : formatDialogBps(-leg.lpFeeBps);
							return (
								<BkdRow
									key={`${leg.venue}-${index}`}
									label={getVenueLabel(leg)}
									href={`https://basescan.org/address/${leg.venue}`}
									context={isStep ? undefined : `${tokenSymbol(leg.tokenIn)}/${tokenSymbol(leg.tokenOut)}`}
									value={lpText}
									color={lpColor}
									secondary
								/>
							);
						})}
					</>
				) : (
					<>
						<BkdHeading label="Pools Touched" plain />
						{legs.map((leg, index) => {
							const isStep = leg.type === 'wrap' || leg.type === 'unwrap';
							const hasPair = leg.tokenIn && leg.tokenOut;
							return (
								<BkdRow
									key={`${leg.venue}-${index}`}
									label={getVenueLabel(leg)}
									href={`https://basescan.org/address/${leg.venue}`}
									context={isStep || !hasPair ? undefined : `${tokenSymbol(leg.tokenIn)}/${tokenSymbol(leg.tokenOut)}`}
									value="–"
									secondary
								/>
							);
						})}
					</>
				)}
```

Change the Price Impact section gate (~line 491) from `{isPartial ? (` to:

```tsx
				{isPartial || !hasCostedLeg ? (
```

Rename the Price Impact placeholder (~line 513) `<BkdRow label="Route" value="–" secondary />` to `<BkdRow label="No Route Found" value="–" secondary />`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run components/ReceiptView.test.tsx` → PASS. `npx tsc --noEmit` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/components/ReceiptView.tsx packages/dashboard/components/ReceiptView.test.tsx
git commit -m "feat(dashboard): render costed legs / Pools Touched / No Route Found"
```

---

## Final verification

- [ ] From `packages/core`: `npx vitest run` → all PASS; `npx tsc --noEmit` → exit 0.
- [ ] From `packages/dashboard`: `npx vitest run` → all PASS; `npx tsc --noEmit` → exit 0.
- [ ] Manual: re-analyze `0xa21e4d82b961726614ce6f310e30e29a4b55b8eca1d6a46621c3adaf8edf6ab1` in the Receipts tab; confirm three interactive pool rows (Uni V3 WARP/WETH, Maverick v2 WETH/USDC, Uni V4 USDC/ETH) with LP Fee + Price Impact, and no "No Route Found".
