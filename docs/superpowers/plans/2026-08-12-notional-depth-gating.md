# Notional Depth Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the receipt's `Size` row from publishing a dollar figure derived from a pool too thin to price anything, without discarding the figure where it comes from a USD-anchored side.

**Architecture:** The receipt notional currently resolves through `getPairMidAtBlock` → `discoverPool`, which is first-match and prefers the direct `token/USDC` pool — the dead-pool trap. The depth floor shipped on 2026-08-12 (`c89b0ff`) already built the correct apparatus for the market price: `usdRefGated` prices a token through its **deepest** `token/WETH` pool, applies a $100 USD depth floor to the ranked winner, and returns its evidence. This plan puts the notional path on that same apparatus. Because `bestEffortNotional` already tries the other side when one returns null, a rejected dust side automatically falls through to an anchored side when there is one — so `0x7e21b6dc` keeps its `~$81.68` and a both-sides-dust receipt gets no dollar figure at all.

**Tech Stack:** TypeScript, viem, vitest, Next.js (App Router, server components), Node scripts under `scripts/analysis/`.

**Spec:** `docs/superpowers/specs/2026-08-12-corpus-migration-and-notional-gating.md`, Part B. Part A (corpus → cases migration) is a separate plan and shares no code with this one.

## Global Constraints

- **Run vitest from the repo root.** `npx vitest run` from `packages/dashboard` silently reports roughly half the suite.
- **E2E tests skip SILENTLY without `TCA_RPC_URL`, and `source .env` does not export.** Every e2e run in this plan uses: `set -a && source .env && set +a && npx vitest run …`. A "skipped" result proves nothing.
- **Golden captures must be serial.** `decodeGolden.mjs` defaults to `--concurrency=1`; never pass anything higher for a capture whose result you intend to believe. Concurrent decodes of the same tx produce different receipts with no flag.
- **`npm test` does not typecheck and `tsc --build` does not lint.** Lint is what fails the deploy. Run `npm run typecheck` and `npm run lint` from the root before the final commit.
- **Never run a root `next build` while a dev server is running** — they share the same `.next` directory.
- The scripts under `scripts/analysis/` import from `packages/core/dist/`. Run `npm run typecheck` (which is `tsc --build`) before any script invocation, or you are measuring stale code.
- Core source (`packages/core/src`) indents with **2 spaces**. Dashboard source (`packages/dashboard`) indents with **tabs**. Match the file you are editing.
- The depth floor is `MIN_REFERENCE_DEPTH_USD = 100` and the L sanity floor is `MIN_POOL_LIQUIDITY_L = 1n`, both already exported from `packages/core/src/tokenPricing.ts`. Do not introduce a second threshold.

---

### Task 1: Capture the pre-change golden baseline

This must happen **before any source change**. There is no way to reconstruct it afterwards without checking out the old commit, and the whole point of Task 5 is comparing against it.

**Files:**
- Create: `/private/tmp/claude-501/-Users-justinvoorhees-withfabricxyz-fabric-tca-decoder/6743b6fd-df5c-4dc7-bbf4-457b0ddfd8e8/scratchpad/golden-before.json` (outside the repo — this is a measurement artifact, not a fixture, and must not be committed)
- Modify: none

**Interfaces:**
- Produces: `golden-before.json`, a map of `txHash → stable-keyed decoded receipt` for all 62 corpus transactions. Task 5 diffs against it.

- [ ] **Step 1: Verify the working tree is clean of source changes and core is built**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder
export SCRATCH="/private/tmp/claude-501/-Users-justinvoorhees-withfabricxyz-fabric-tca-decoder/6743b6fd-df5c-4dc7-bbf4-457b0ddfd8e8/scratchpad"
git status --short          # configs/routers.json may be modified; no packages/ changes
npm run typecheck
```

Export `SCRATCH` in every shell that runs a step below — the golden captures are large measurement artifacts and must not land in the repo.

Expected: `tsc --build` completes with no errors. If `packages/core/dist/index.js` does not exist afterwards, stop — every script in this plan reads from `dist`.

- [ ] **Step 2: Capture the baseline, serially, in the background**

This decodes 62 transactions at roughly 10 seconds each — budget 10–15 minutes. Run it in the background rather than blocking on it.

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder
set -a && source .env && set +a && \
node scripts/analysis/decodeGolden.mjs capture \
  "$SCRATCH/golden-before.json" --concurrency=1
```

where `$SCRATCH` is the scratchpad directory named above. Do **not** add `--concurrency=N` for N > 1: the script prints a warning and the result is worthless as a baseline.

- [ ] **Step 3: Verify the capture is complete before proceeding**

⚠️ **Each entry is `{ "receipt": {…}, "error": … }`, not a bare receipt.** Reading `v['notionalUsd']` at the top level returns `None` for every row, which looks exactly like "nothing moved". Always go through `v['receipt']`.

```bash
python3 -c "
import json,os
d=json.load(open(os.environ['SCRATCH']+'/golden-before.json'))
rec=[v['receipt'] for v in d.values() if isinstance(v,dict) and v.get('receipt')]
print('receipts:', len(d))
print('errors:', sum(1 for v in d.values() if isinstance(v,dict) and v.get('error')))
print('with notionalUsd:', sum(1 for r in rec if r.get('notionalUsd') is not None))
"
```

Measured on 2026-08-12: **62 receipts, 0 errors, 62 with a non-null `notionalUsd`.** Task 5 compares against exactly this.

Expected: 62 receipts. A handful of errors is tolerable if they are transport failures; note the count, because Task 5 compares like for like. If the count is below 62, the capture did not finish — re-run it.

- [ ] **Step 4: No commit**

Nothing in the repo changed. The baseline lives in the scratchpad on purpose.

---

### Task 2: Gated token valuation in core

**Files:**
- Modify: `packages/core/src/tokenPricing.ts` — extract the WETH/USDC anchor block out of `getEstimatedMidOutcome` (lines 374–383) into a reusable helper, then add the new gated valuation beneath `getEstimatedMidAtBlock`
- Test: `packages/core/src/tokenPricing.test.ts`

**Interfaces:**
- Consumes: the existing private `usdRefGated(readers, token, block, wethUsd, minLiquidity, minDepthUsd): Promise<SideOutcome>` and `midViaDeepest`, `depthUsd`, `pickReferenceToken`, all already in this file.
- Produces:
  - `export interface GatedUsdValue { usd: number | null; rejected: boolean; unverified: boolean }`
  - `export async function getTokenUsdcValueGated(readers: EstimatedMidReaders, token: string, amountRaw: bigint, blockNumber: bigint, minLiquidity: bigint, minDepthUsd: number, precomputedWethUsd?: number): Promise<GatedUsdValue>`
  - a private `resolveWethUsdGated(readers, block, minLiquidity, minDepthUsd): Promise<AnchorOutcome>` where `AnchorOutcome = { wethUsd: number | null; depthUsd: number | null; poolAddress: string | null; rejected: boolean }`

  Task 3 calls `getTokenUsdcValueGated` and reads only `.usd`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/tokenPricing.test.ts`, immediately after the existing `describe('getEstimatedMidAtBlock', …)` block. It reuses the `makeReaders` helper already defined above that block (WETH/USDC and WARP/WETH pools, both at depth `10n ** 24n`, `readSlot0` returning `SQRT_1`, `readDecimals` returning 18 — which makes `wethUsd` = 1 and one WARP = $1).

Add the new symbols to the existing import at the top of the file: `getTokenUsdcValueGated`, `MIN_REFERENCE_DEPTH_USD` is already imported.

```typescript
// ── getTokenUsdcValueGated — the notional path on the ruler's apparatus ──────

describe('getTokenUsdcValueGated', () => {
  const FLOOR = 100; // MIN_REFERENCE_DEPTH_USD, passed explicitly so the test
                     // states the threshold it is exercising.

  it('values a volatile token through its deepest token/WETH pool', async () => {
    // makeReaders prices WARP at $1 (see its comment): 5 WARP -> $5.
    const res = await getTokenUsdcValueGated(
      makeReaders(), WARP, 5n * 10n ** 18n, 100n, 1n, FLOOR,
    );
    expect(res.usd).toBeCloseTo(5, 6);
    expect(res.rejected).toBe(false);
  });

  it('refuses a token whose deepest pool is below the USD depth floor', async () => {
    // WARP/WETH holds 1 WETH == $1 of depth, far under the $100 floor. The old
    // first-match path returned a number here; that number was the defect.
    const readers = makeReaders({
      getDeepestPoolWithDepth: async (a, b) => {
        const key = [a.toLowerCase(), b.toLowerCase()].sort().join('|');
        if (key === [WETH, USDC].sort().join('|')) return { address: '0xwethusdc', depth: 10n ** 24n, kind: 'univ3' };
        if (key === [WARP, WETH].sort().join('|')) return { address: '0xwarpweth', depth: 10n ** 18n, kind: 'univ3' }; // dust
        return null;
      },
    });
    const res = await getTokenUsdcValueGated(readers, WARP, 5n * 10n ** 18n, 100n, 1n, FLOOR);
    expect(res.usd).toBeNull();
    expect(res.rejected).toBe(true);
  });

  it('refuses when the WETH/USDC anchor pool is itself below the floor', async () => {
    const readers = makeReaders({
      getDeepestPoolWithDepth: async (a, b) => {
        const key = [a.toLowerCase(), b.toLowerCase()].sort().join('|');
        if (key === [WETH, USDC].sort().join('|')) return { address: '0xwethusdc', depth: 10n ** 6n, kind: 'univ3' }; // dust
        if (key === [WARP, WETH].sort().join('|')) return { address: '0xwarpweth', depth: 10n ** 24n, kind: 'univ3' };
        return null;
      },
    });
    const res = await getTokenUsdcValueGated(readers, WARP, 5n * 10n ** 18n, 100n, 1n, FLOOR);
    expect(res.usd).toBeNull();
    expect(res.rejected).toBe(true);
  });

  it('values USDC directly, touching no pool and no anchor', async () => {
    // A pool read here would be a wasted RPC round trip on every single receipt.
    const readers = makeReaders({
      getDeepestPoolWithDepth: async () => { throw new Error('USDC must not discover a pool'); },
    });
    const res = await getTokenUsdcValueGated(readers, USDC, 1_500_000n, 100n, 1n, FLOOR);
    expect(res.usd).toBeCloseTo(1.5, 9); // 1.5 USDC at 6 decimals
    expect(res.rejected).toBe(false);
  });

  it('uses precomputedWethUsd for WETH without discovering the anchor pool', async () => {
    const readers = makeReaders({
      getDeepestPoolWithDepth: async () => { throw new Error('precomputed wethUsd must skip discovery'); },
    });
    const res = await getTokenUsdcValueGated(readers, WETH, 10n ** 18n, 100n, 1n, FLOOR, 3000);
    expect(res.usd).toBeCloseTo(3000, 6);
  });

  it('prices native ETH as WETH without reading decimals("native")', async () => {
    // A real decimals() read on the "native" pseudo-address reverts, and
    // makeDecimalsCache deliberately still throws — so this must never be called.
    const readers = makeReaders({
      readDecimals: async (addr: string) => {
        if (addr.toLowerCase() === 'native') throw new Error('decimals("native") must not be called');
        return 18;
      },
    });
    const res = await getTokenUsdcValueGated(readers, 'native', 5n * 10n ** 17n, 100n, 1n, FLOOR, 3000);
    expect(res.usd).toBeCloseTo(1500, 6); // 0.5 ETH x 3000
  });
});
```

> **Note on `unverified`:** it is plumbed through for parity with the market-price ruler but is structurally unreachable on this path. `usdRefGated` always prices against WETH, and `pickReferenceToken(volatile, WETH)` always returns WETH, so `depthUsd` can only return null when `wethUsd` is invalid — and that case fails anchor resolution first. Do not write a test that fakes it into existence; a test that has to defeat the type to fire is testing the fake.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder
npx vitest run packages/core/src/tokenPricing.test.ts -t "getTokenUsdcValueGated"
```

Expected: FAIL — `getTokenUsdcValueGated is not a function` / import error. If it fails for any other reason, the fakes are wrong; fix them before writing implementation.

- [ ] **Step 3: Extract the anchor resolution from `getEstimatedMidOutcome`**

In `packages/core/src/tokenPricing.ts`, add above `getEstimatedMidOutcome`:

```typescript
/** The gated WETH/USDC anchor, plus the evidence behind a refusal. */
interface AnchorOutcome {
  wethUsd: number | null;
  depthUsd: number | null;
  poolAddress: string | null;
  rejected: boolean;
}

/**
 * USDC-per-WETH via the deepest WETH/USDC pool, with the depth floor applied.
 *
 * Not circular: the anchor's own reference token is USDC, a stable, so its depth
 * is valued without needing `wethUsd`. Shared by the bridged estimator and the
 * notional path so both gate the anchor by the same rule — if they diverged, the
 * Market Price and Size rows could disagree about the same pool.
 */
async function resolveWethUsdGated(
  readers: EstimatedMidReaders,
  blockNumber: bigint,
  minLiquidity: bigint,
  minDepthUsd: number,
): Promise<AnchorOutcome> {
  const none: AnchorOutcome = { wethUsd: null, depthUsd: null, poolAddress: null, rejected: false };
  const pool = await readers.getDeepestPoolWithDepth(WETH, USDC, blockNumber);
  if (pool === null) return none;
  const ref = pickReferenceToken(WETH, USDC); // USDC — a stable, so no wethUsd needed
  const usd = depthUsd(ref, pool.depth, 0, await readers.readDecimals(ref));
  if (usd !== null && usd < minDepthUsd) {
    return { wethUsd: null, depthUsd: usd, poolAddress: pool.address, rejected: true };
  }
  const anchor = await midViaDeepest(readers, WETH, USDC, blockNumber); // USDC per WETH
  if (anchor === null || anchor.price <= 0 || anchor.depth < minLiquidity) return none;
  return { wethUsd: anchor.price, depthUsd: usd, poolAddress: pool.address, rejected: false };
}
```

Then replace the first nine lines of `getEstimatedMidOutcome`'s body — everything from `const anchorPool = await readers.getDeepestPoolWithDepth(WETH, USDC, blockNumber);` down to and including `const wethUsd = anchor.price;` — with:

```typescript
  const anchor = await resolveWethUsdGated(readers, blockNumber, minLiquidity, minDepthUsd);
  if (anchor.rejected) {
    return { ...none, rejected: true, depthUsd: anchor.depthUsd, poolAddress: anchor.poolAddress };
  }
  if (anchor.wethUsd === null) return none;
  const wethUsd = anchor.wethUsd;
```

Leave the `const none: EstimatedMidOutcome = {…}` declaration above it exactly as it is. This is a pure extraction: same reads, same order, same return values.

- [ ] **Step 4: Add the gated valuation**

Add immediately after `getEstimatedMidAtBlock` in the same file:

```typescript
/** A gated USD valuation, with the evidence behind a refusal. */
export interface GatedUsdValue {
  /** USD value of the amount, or null when no trustworthy pool priced it. */
  usd: number | null;
  /** A pool existed and was rejected for being below the USD depth floor. */
  rejected: boolean;
  /** Depth could not be valued, so the floor was not applied. */
  unverified: boolean;
}

/**
 * USD value of `amountRaw` of `token`, on the SAME ranked-and-floored apparatus
 * the Market Price ruler uses.
 *
 * The predecessor (`getTokenUsdcValue`) resolved mids through first-match
 * `discoverPool` and preferred the direct token/USDC pool — the dead-pool trap
 * that inflated a WARP->ETH notional ~7x. `usdRefGated` ranks by depth, prices
 * only through token/WETH, and refuses a winner under `minDepthUsd`.
 *
 * A refusal returns `usd: null`, which lets `bestEffortNotional` fall through to
 * the other side. That fall-through is what keeps an anchored side's notional on
 * receipts whose ruler was floored — the number there is independently derived
 * and correct, and hiding it would discard a measurement we trust.
 */
export async function getTokenUsdcValueGated(
  readers: EstimatedMidReaders,
  token: string,
  amountRaw: bigint,
  blockNumber: bigint,
  minLiquidity: bigint,
  minDepthUsd: number,
  precomputedWethUsd?: number,
): Promise<GatedUsdValue> {
  const t = token.toLowerCase();

  // USDC needs neither a pool nor the anchor — short-circuit before any RPC.
  if (t === USDC) {
    return { usd: Number(amountRaw) / 1e6, rejected: false, unverified: false };
  }

  let wethUsd = precomputedWethUsd;
  if (wethUsd == null) {
    const anchor = await resolveWethUsdGated(readers, blockNumber, minLiquidity, minDepthUsd);
    if (anchor.wethUsd === null) {
      return { usd: null, rejected: anchor.rejected, unverified: false };
    }
    wethUsd = anchor.wethUsd;
  }

  const side = await usdRefGated(readers, t, blockNumber, wethUsd, minLiquidity, minDepthUsd);
  if (side.price === null) {
    return { usd: null, rejected: side.rejected, unverified: side.unverified };
  }

  // native is a synthetic endpoint with no contract to read decimals() from; it
  // is 1:1 with WETH (18). This MUST precede the readDecimals call, which throws.
  const dec = t === NATIVE ? 18 : await readers.readDecimals(t);
  return {
    usd: (Number(amountRaw) / 10 ** dec) * side.price,
    rejected: false,
    unverified: side.unverified,
  };
}
```

- [ ] **Step 5: Run the new tests to verify they pass**

```bash
npx vitest run packages/core/src/tokenPricing.test.ts -t "getTokenUsdcValueGated"
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Run the whole core suite — the extraction in Step 3 must not have moved anything**

```bash
npx vitest run packages/core
```

Expected: PASS. The `getEstimatedMidAtBlock` tests are the ones that prove the extraction was behaviour-preserving; if any of the four fail, the extraction changed a return shape — re-read Step 3 against the original block rather than adjusting the test.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/tokenPricing.ts packages/core/src/tokenPricing.test.ts
git commit -m "feat(pricing): a ranked, floored token valuation for the notional path

getTokenUsdcValueGated puts token->USD valuation on the same apparatus the
Market Price ruler already uses: deepest token/WETH pool, never the direct
token/USDC pool, with the \$100 depth floor applied to the ranked winner.

The WETH/USDC anchor block is extracted out of getEstimatedMidOutcome so both
callers gate the anchor by one rule. Pure extraction, same reads in the same
order.

Not wired up yet — that is the next commit.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QsCVvRTgk8M5ZG7hoCTqbC"
```

---

### Task 3: Wire the notional path to it, and retire the first-match path

**Files:**
- Modify: `packages/core/src/pricing.ts` — the import at line 29, and the `getUsdValue` wiring at lines 443–445
- Modify: `packages/core/src/tokenPricing.ts` — delete `getTokenUsdcValue` (lines 425–492) and the now-stale priority list in its docstring
- Modify: `packages/core/src/tokenPricing.test.ts` — delete the `describe('getTokenUsdcValue', …)` block, whose two cases were ported to the gated function in Task 2
- Test: `packages/core/src/pricing.test.ts`

**Interfaces:**
- Consumes: `getTokenUsdcValueGated` from Task 2; `bridgeReaders`, already constructed at `pricing.ts:362`; `MIN_POOL_LIQUIDITY_L` and `MIN_REFERENCE_DEPTH_USD`, already imported in `pricing.ts`.
- Produces: no signature change anywhere. `PricingDeps.getUsdValue` keeps returning `Promise<number | null>` and `bestEffortNotional` is not touched — the gate lives entirely inside the dep implementation, so a refusal reaches `bestEffortNotional` as the null it already knows how to handle.

- [ ] **Step 1: Write the failing tests**

Two behaviours in `bestEffortNotional` become load-bearing once a refusal can return null, and neither is currently pinned. Add both to `packages/core/src/pricing.test.ts`, inside the existing `describe('priceReceipt', …)`. The harness — `makeDeps`, `baseArgs`, `EXOTIC_A`, `EXOTIC_B` — is already defined at the top of that file; `priceReceipt` takes `(args, deps)` in that order.

```typescript
  it('keeps the anchored side’s notional when the volatile side is refused', async () => {
    // 0x7e21b6dc’s shape: a memecoin whose only pool is dust (gated to null),
    // swapped for ETH. bestEffortNotional prefers the anchored side outright, so
    // the receipt keeps its dollar figure even with the ruler floored. This is
    // the assertion standing between the gate and deleting a correct number.
    const MEME = '0xd9159ad2d5fe625cd1f54f4d328fb19cb5262b07';
    const r = await priceReceipt(
      { ...baseArgs, inputToken: MEME, outputToken: 'native', inputAmountRaw: 10n ** 18n, outputAmountRaw: 10n ** 16n },
      makeDeps({ getUsdValue: async (token) => (token.toLowerCase() === MEME ? null : 81.68) }),
    );
    expect(r.notionalUsd).toBeCloseTo(81.68, 6);
  });

  it('falls through to the other side when the first one is refused', async () => {
    // Neither side anchors, so the input is tried first. Its pool is dust and
    // gated to null; the output side clears the floor and supplies the notional.
    // Collapsing the loop in bestEffortNotional to a single attempt fails here.
    const r = await priceReceipt(
      { ...baseArgs, inputToken: EXOTIC_A, outputToken: EXOTIC_B, inputAmountRaw: 1000n, outputAmountRaw: 5n },
      makeDeps({ getUsdValue: async (token) => (token.toLowerCase() === EXOTIC_A ? null : 42) }),
    );
    expect(r.notionalUsd).toBeCloseTo(42, 6);
  });
```

- [ ] **Step 2: Run them to see where they stand**

```bash
npx vitest run packages/core/src/pricing.test.ts -t "refused"
```

Expected: **both already PASS.** `bestEffortNotional`'s anchored-side preference and its fall-through loop both predate this work — these tests do not drive new behaviour, they pin behaviour the rewire is about to start depending on. That is the point: before this change a refusal never happened, so nothing protected either property.

If either FAILS, stop and re-read `bestEffortNotional` at `pricing.ts:749` before going further — the plan's central assumption is that a null from `getUsdValue` is already handled gracefully, and a failure here says it is not.

- [ ] **Step 3: Rewire `getUsdValue`**

In `packages/core/src/pricing.ts`, replace lines 443–445:

```typescript
    getUsdValue: (token, amountRaw, blockNumber, precomputedWethUsd) =>
      getTokenUsdcValue(client, token, amountRaw, blockNumber, decCache, precomputedWethUsd),
```

with:

```typescript
    // The notional rides the SAME ranked-and-floored apparatus as the ruler.
    // A refusal surfaces as null so bestEffortNotional falls through to the
    // other side — an anchored side keeps its number on a floored receipt.
    getUsdValue: async (token, amountRaw, blockNumber, precomputedWethUsd) => {
      const out = await getTokenUsdcValueGated(
        bridgeReaders, token, amountRaw, blockNumber,
        MIN_POOL_LIQUIDITY_L, MIN_REFERENCE_DEPTH_USD, precomputedWethUsd,
      );
      return out.usd;
    },
```

Then update the import at line 29: replace `getTokenUsdcValue` with `getTokenUsdcValueGated`. Confirm `MIN_POOL_LIQUIDITY_L` and `MIN_REFERENCE_DEPTH_USD` are already in that import list (they are — they are used at line 409); do not add duplicates.

- [ ] **Step 4: Delete the first-match valuation**

`getTokenUsdcValue` now has zero production callers. Verify that, then delete it:

```bash
grep -rn "getTokenUsdcValue\b" packages/ scripts/ --include="*.ts" --include="*.tsx" --include="*.mjs"
```

Expected after the rewire: hits only in `tokenPricing.ts` (its own definition) and `tokenPricing.test.ts` (the block being deleted). It is not re-exported from `packages/core/src/index.ts`, so there are no external consumers. If the grep shows anything else, stop and report it rather than deleting.

Delete the function (lines 425–492, including its docstring), and delete the `describe('getTokenUsdcValue', …)` block from `tokenPricing.test.ts` — both of its cases were ported to `getTokenUsdcValueGated` in Task 2, so no coverage is lost.

Then check whether `getPairMidAtBlock` still has callers:

```bash
grep -rn "getPairMidAtBlock" packages/ --include="*.ts"
```

Expected: it survives — the leg-level `fallbackPool` path still uses it. Leave it alone. It is only the *notional's* use of it that this change retires.

- [ ] **Step 5: Run the full core suite**

```bash
npx vitest run packages/core
```

Expected: PASS. Watch specifically for tests that fed a `client` fake into the old path — if any fail with "getTokenUsdcValue is not exported", one was missed in Step 4.

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```

Expected: no errors. `npm test` does not typecheck, so this is not redundant.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/pricing.ts packages/core/src/tokenPricing.ts packages/core/src/tokenPricing.test.ts packages/core/src/pricing.test.ts
git commit -m "fix(pricing): gate the receipt notional on reference-pool depth

The Size row was the last number on the receipt still resolved by first-match
pool discovery, and it preferred the direct token/USDC pool -- the dead-pool
trap that inflated a WARP->ETH notional ~7x. It now rides the same ranked,
\$100-floored apparatus as the Market Price ruler.

A refused side returns null, so bestEffortNotional falls through to the other
one. That is what keeps 0x7e21b6dc's ~\$81.68: the ETH side is independently
derived and correct, and only a both-sides-dust receipt loses its dollar
figure entirely.

getTokenUsdcValue had no other caller and is deleted rather than left around
to be reached for -- one apparatus is the whole point.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QsCVvRTgk8M5ZG7hoCTqbC"
```

---

### Task 4: Let the reader interrogate the refused Size row

The gate produces a new reason for `Size` to be empty, and `5b67b11` established that a whole-trade N/A the reader cannot interrogate is a dead end. `DetailRow` already accepts `valueTooltip`, so this is a one-prop change plus a string.

**Files:**
- Modify: `packages/dashboard/components/receipt/receiptDisplay.tsx` — add the constant next to `NULL_PRICE_TOOLTIP` at line 439
- Modify: `packages/dashboard/components/receiptView.tsx` — the import block at lines 23-ish, and the Size row at lines 256–260
- Test: `packages/dashboard/components/receiptView.test.tsx` — the existing `describe('Size row', …)` block at line 879

**Interfaces:**
- Consumes: `DetailRow`'s existing `valueTooltip?: string` prop (`receiptRows.tsx:200`), and `UNAVAILABLE` from `receipt/priceFormat` (already imported in `receiptView.tsx`).
- Produces: `export const NULL_NOTIONAL_TOOLTIP` from `receiptDisplay.tsx`.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe('Size row', …)` block in `packages/dashboard/components/receiptView.test.tsx`:

```tsx
	it('lets the reader interrogate a Size the depth floor refused', async () => {
		const { Receipt } = await import('./receiptView');
		// Both sides volatile and the notional refused: the receipt now has no
		// dollar figure at all, so the row must say why rather than dead-end.
		const html = renderToStaticMarkup(
			<Receipt row={{
				...fullUsdcWethRow, aggregator: 'fabric', pricingStatus: 'partial',
				inputSymbol: 'LFI', outputSymbol: 'GITLAWB',
				inputToken: '0x3722264ab15a1dfce5a5af89e6547f7949a8aba3',
				outputToken: '0x5f980dcfc4c0fa3911554cf5ab288ed0eb13dba3',
				inputAmount: 6745937.5, outputAmount: 7234145.96,
				notionalUsd: null, marketMid: null, allInCostBps: null,
			} as never} />,
		);
		// Bound the window by the NEXT row's label: Size and Token In sit adjacent
		// and an over-wide slice reads the neighbour's markup and passes vacuously.
		const window = html.slice(html.indexOf('Size'), html.indexOf('Token In'));
		expect(window).toContain('Unavailable for this pair');
		expect(window).toContain('No pool with enough liquidity to value this trade');
	});

	it('leaves a Size that resolved without a tooltip', async () => {
		const { Receipt } = await import('./receiptView');
		const html = renderToStaticMarkup(
			<Receipt row={{
				...fullUsdcWethRow, pricingStatus: 'partial',
				marketMid: null, allInCostBps: null, notionalUsd: 1000.00,
			} as never} />,
		);
		const window = html.slice(html.indexOf('Size'), html.indexOf('Token In'));
		expect(window).toContain('$1,000.00');
		expect(window).not.toContain('No pool with enough liquidity');
	});
```

- [ ] **Step 2: Run to verify the first fails and the second passes**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder
npx vitest run packages/dashboard/components/receiptView.test.tsx -t "Size row"
```

Expected: the interrogate test FAILS (tooltip string absent); the second PASSES already. Run from the repo root — from `packages/dashboard` the suite silently halves.

- [ ] **Step 3: Add the tooltip string**

In `packages/dashboard/components/receipt/receiptDisplay.tsx`, next to `NULL_PRICE_TOOLTIP` at line 439:

```typescript
// The notional's counterpart to NULL_PRICE_TOOLTIP. Deliberately covers both
// causes of an absent Size — no pool at all, and a pool the depth floor
// refused — because the receipt does not carry which one it was, and a tooltip
// that named the floor would be a guess on the no-pool case.
export const NULL_NOTIONAL_TOOLTIP = 'No pool with enough liquidity to value this trade';
```

- [ ] **Step 4: Use it on the Size row**

In `packages/dashboard/components/receiptView.tsx`, add `NULL_NOTIONAL_TOOLTIP` to the existing import from `./receipt/receiptDisplay` (the block containing `NULL_PRICE_TOOLTIP` at line 23), then change the Size row:

```tsx
				{!anchored && (
					<DetailRow
						label="Size"
						valueTooltip={row.notionalUsd == null ? NULL_NOTIONAL_TOOLTIP : undefined}
					>
						{row.notionalUsd == null ? UNAVAILABLE : `~${formatSubvalueUsd(Number(row.notionalUsd))}`}
					</DetailRow>
				)}
```

The file indents with tabs.

- [ ] **Step 5: Run the tests**

```bash
npx vitest run packages/dashboard/components/receiptView.test.tsx -t "Size row"
```

Expected: PASS, all cases in the block.

- [ ] **Step 6: Verify the test by mutation**

Positional `indexOf`/`slice` assertions in this file have been defective repeatedly — a passing test is not evidence until you have seen it fail for the right reason.

Temporarily revert Step 4 (drop the `valueTooltip` prop), re-run, and confirm the interrogate test fails **on the tooltip assertion**, not on a slice that came back empty. Then restore it.

- [ ] **Step 7: Lint and typecheck**

```bash
npm run lint
npm run typecheck
```

Expected: clean. Lint is what fails the deploy, and `tsc --build` does not run it.

- [ ] **Step 8: Commit**

```bash
git add packages/dashboard/components/receipt/receiptDisplay.tsx packages/dashboard/components/receiptView.tsx packages/dashboard/components/receiptView.test.tsx
git commit -m "fix(receipt): say why Size is empty instead of dead-ending

The depth gate gives Size a new way to be absent, and 5b67b11 settled that a
whole-trade N/A the reader cannot interrogate is a dead end. DetailRow already
carries valueTooltip, so this is the string plus one prop.

The copy covers both causes -- no pool, and a pool under the floor -- because
the receipt does not record which, and naming the floor would be a guess on the
no-pool case. Verified by mutation: dropping the prop fails the test on the
tooltip assertion, not on an empty slice.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QsCVvRTgk8M5ZG7hoCTqbC"
```

---

### Task 5: Measure the blast radius and pin it against the live chain

Fakes cannot catch what this change does — the depth floor's own retrospective found three defects that only the live-chain test caught. This task is where the change is actually verified.

**Files:**
- Create: `$SCRATCH/golden-after.json` (scratchpad, not committed)
- Modify: `packages/core/src/referencePoolDepthFloor.e2e.test.ts` — add the notional cases to the existing describe
- Modify: `docs/superpowers/specs/2026-08-12-corpus-migration-and-notional-gating.md` — record the measured result

**Interfaces:**
- Consumes: `golden-before.json` from Task 1; the receipts produced by Tasks 2–4.
- Produces: the measured list of receipts whose `notionalUsd` moved, and at least one pinned transaction hash for the e2e test.

- [ ] **Step 1: Rebuild and capture the after-golden, serially**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder
npm run typecheck   # scripts read packages/core/dist — a stale dist measures nothing
set -a && source .env && set +a && \
node scripts/analysis/decodeGolden.mjs capture "$SCRATCH/golden-after.json" --concurrency=1
```

Another 10–15 minutes; background it.

- [ ] **Step 2: Diff**

```bash
node scripts/analysis/decodeGolden.mjs diff "$SCRATCH/golden-before.json" "$SCRATCH/golden-after.json"
```

- [ ] **Step 3: Classify every difference — this is the deliverable, not a formality**

⚠️ Entries nest under `receipt` — go through it or every comparison silently reads `None` against `None` and reports no movement.

```bash
python3 -c "
import json,os
S=os.environ['SCRATCH']
a=json.load(open(S+'/golden-before.json')); b=json.load(open(S+'/golden-after.json'))
g=lambda d,h: (d[h] or {}).get('receipt') or {}
for h in sorted(set(a)&set(b)):
    x,y=g(a,h),g(b,h)
    if not x or not y: continue
    if x.get('notionalUsd')!=y.get('notionalUsd'):
        print(h[:12], x.get('direction'),
              '|', x.get('notionalUsd'),'->',y.get('notionalUsd'))
"
```

Expected shape of the result:
- **Movement confined to receipts where neither side anchors.** Check each hash's input/output tokens against `anchorsToUsd` (stables, WETH, native). A moved notional on a pair with an anchored side means the fall-through is not working — that is a regression, stop and investigate.
- **Some notionals go null.** That is the gate firing, and it is the intended change.
- **Some notionals change value without going null.** That is ranking beating first-match. Spot-check one by hand: the new value should be the deeper pool's.

Then check the second-order effect the spec flagged — `analyzeTransaction` passes `notionalUsd ?? 0` into `decomposeTrade`, so a newly-null notional zeroes the fallback notional of any leg with neither a USDC nor a WETH endpoint:

```bash
python3 -c "
import json,os
S=os.environ['SCRATCH']
a=json.load(open(S+'/golden-before.json')); b=json.load(open(S+'/golden-after.json'))
for h in sorted(set(a)&set(b)):
    x,y=a[h],b[h]
    if not isinstance(x,dict) or not isinstance(y,dict): continue
    if x.get('weightedPriceImpactBps')!=y.get('weightedPriceImpactBps') or x.get('lpFeeBps')!=y.get('lpFeeBps'):
        print(h[:12],'PI', x.get('weightedPriceImpactBps'),'->',y.get('weightedPriceImpactBps'),
              '| LP', x.get('lpFeeBps'),'->',y.get('lpFeeBps'))
"
```

Every hash printed here must also appear in the notional list from the previous command. One that does not means the change reached the leg path by a route this plan did not predict — stop and report.

- [ ] **Step 4: Pin the cases in the e2e test**

Pick from Step 3's output: one receipt whose notional went **null** (the gate firing) and, if the diff produced one, one whose notional **changed value** (ranking beating first-match). Add to the existing describe in `packages/core/src/referencePoolDepthFloor.e2e.test.ts`, substituting the real hashes and values you measured:

```typescript
	// The gate firing: neither side anchors and the only pool that could value
	// this trade is under the floor, so the receipt publishes no dollar figure
	// rather than one off a dust pool. Before this change it reported <VALUE>.
	it('refuses a notional whose only reference pool is dust', async () => {
		const r = await analyzeTransaction('<HASH FROM STEP 3>', CHAIN, { rpcUrl: RPC! });
		expect(r).not.toBeNull();
		expect(r!.notionalUsd).toBeNull();
	}, 120000);
```

The protection case is **already pinned**: the existing first test in this file asserts `expect(r!.notionalUsd).toBeGreaterThan(50)` for `0x7e21b6dc`. Do not duplicate it — confirm it still passes, because it is the assertion standing between this change and deleting a correct number.

- [ ] **Step 5: Run the e2e suite against the live chain**

```bash
cd /Users/justinvoorhees/withfabricxyz/fabric-tca-decoder
set -a && source .env && set +a && \
npx vitest run packages/core/src/referencePoolDepthFloor.e2e.test.ts
```

Expected: PASS, including the pre-existing `0x7e21b6dc` case. **A "skipped" line means `TCA_RPC_URL` did not export and you have verified nothing** — re-run with the `set -a` prefix.

- [ ] **Step 6: Full suite, both env states**

```bash
npx vitest run                                          # e2e skipped
set -a && source .env && set +a && npx vitest run       # e2e live
npm run lint
npm run typecheck
```

Expected: PASS in both env states. Record the true test counts rather than quoting a remembered number.

- [ ] **Step 7: Record the measurement in the spec**

Add a short "Measured result" section at the end of Part B of `docs/superpowers/specs/2026-08-12-corpus-migration-and-notional-gating.md`: how many of the 62 receipts moved, how many went null, how many changed value, and whether any leg-level number moved. State the numbers, not "as expected" — the depth floor's own spec section is the model.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/referencePoolDepthFloor.e2e.test.ts docs/superpowers/specs/2026-08-12-corpus-migration-and-notional-gating.md
git commit -m "test(pricing): pin the gated notional against the live chain

Fakes cannot catch this class of defect -- the depth floor found three that
only the live-chain test caught. Pins the gate firing on a both-sides-dust
receipt, alongside the pre-existing 0x7e21b6dc assertion that stands between
this change and deleting a correct number.

Golden diff (serial, 62 receipts) recorded in the spec.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QsCVvRTgk8M5ZG7hoCTqbC"
```

---

## Not in this plan

- **Part A** (corpus → cases migration) — separate plan, no shared code.
- **Per-leg notional valuation.** There is nothing to change: `valueLegNotionalUsdc` (`legFees.ts:51`) is pure and never discovers a pool. The leg path is reached only through `notionalUsd ?? 0`, which Step 3 of Task 5 measures.
- **Persisting the refusal reason on the Receipt.** The tooltip copy covers both causes without it. Adding a field would let the copy be specific, but receipts are ephemeral and nothing else needs the distinction yet.
