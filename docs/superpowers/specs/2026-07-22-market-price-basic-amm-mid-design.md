# Market Price: basic-AMM (Solidly/V2) mid reader — design

Date: 2026-07-22
Branch: `feat/market-price-v2-basic-amm-mid`

## Problem

The single-ruler Market Price cannot price a pair whose liquidity lives in a
**basic constant-product AMM pool** (Solidly/Aerodrome volatile+stable, UniV2).
For those pairs `market_mid` comes back null, which cascades to null
`all_in_cost_bps` and null `slippage_bps`, and the receipt shows no market price.

Reproduced on receipt **id 209**
(`0xc8078a93d1ccfe88e9fc78ed1d1a4feaf9485f71d9fd91189cf2081d6dd365c8`,
BLUAI→WETH): the trade routed through Aerodrome **basic volatile** pool
`0x5fb5a087a92bb8fdb7aa9ad456c76ac3c2a759bb`. On-chain, that pool answers
`getReserves()` but **reverts on `slot0()`**.

### Root cause

The market-price flow is *discover pool for the pair → read its mid*, and both
halves are V3-only:

- **Discovery** (`poolDiscovery.ts`): `discoverPool` and
  `getDeepestPoolWithDepth` scan only V3-style factories (Uniswap V3,
  PancakeSwap V3, Aerodrome **CL**) and gate a candidate on `slot0() > 0`.
  Basic-AMM factories are never consulted.
- **Mid read** (`pricing.ts::defaultGetPairMid`): reads `slot0()`
  unconditionally; no `getReserves()` branch.

With no direct mid, and (for a WETH-output pair) the bridged estimator being a
duplicate of direct, and no oracle feed for the volatile token,
`computeMarketPrice` returns `tier: 'none'`, `marketMid: null`, `NO_LIQUIDITY`.

The reserve→price math already exists and is battle-tested elsewhere
(`readV2Reserves` + `v2MidFromReserves`, used by the per-leg reader
`routeReaders.getLegMidAtBlock` and by `tokenPricing.ts`). **This is a plumbing
gap in the market-price path, not new pricing math.**

## Goal

Make the single Market Price ruler aware of basic-AMM pools for **any** pair, so
discovery ranks the genuinely deepest pool across pool *families* and reads its
mid via the correct method. Do it through an **extensible pool-family registry**
so adding a future pool type is a single descriptor entry, not edits scattered
across discovery + mid-reading + ranking.

### Non-goals

- No change to the Market Price *reducer* (`computeMarketPrice`) — corroboration,
  tiers, and the oracle-corroborate-only rule are untouched.
- No new pricing semantics: reserves→mid uses the existing `v2MidFromReserves`.
- UniV2-style `getPair(a,b)` forks (BaseSwap/Sushi V2) are **not** enabled in
  this change; the registry is structured so they drop in later. Aerodrome basic
  is the only new family wired on now (the confirmed, on-Base case).
- V4 singleton pools are out of scope for market-price discovery (unchanged;
  they are handled only in the per-leg reader).

## On-chain facts (verified 2026-07-22, Base)

- Aerodrome basic `PoolFactory` = `0x420DD381b31aEf6683db6B902084cB0FFECe40Da`.
- `factory()` of pool `0x5fb5a087…` returns that address.
- `getPool(address tokenA, address tokenB, bool stable)` selector `0x79bc57d5`;
  `getPool(WETH, BLUAI, false)` → `0x5fb5a087…` (volatile; `stable()` == false).
- Pool `token0` = WETH, `token1` = BLUAI (Solidly sorts by address, like UniV2).
- `getReserves()` works; `slot0()` reverts.
- `WETH.balanceOf(pool)` ≈ 46.16 WETH — the depth yardstick reads cleanly.

## Architecture: pool-family registry

Introduce a small registry that captures everything discovery + ranking +
mid-reading need to know about a pool *family*. Discovery iterates the registry;
ranking and mid-reading dispatch on the winning candidate's `kind`.

```ts
// poolFamilies.ts  (new module)

export type PoolMechanism = 'v3-slot0' | 'v2-reserves';

export interface PoolFamily {
  kind: PoolKind;                 // 'univ3' | 'pancakev3' | 'aerodrome_cl' | 'aerodrome_basic' | ...
  mechanism: PoolMechanism;       // how to read the mid + the initialized gate
  /**
   * Enumerate candidate pool addresses for (a, b) at `block`.
   * Each family owns its factory address(es) and the param axis it scans
   * (V3 fee tiers, CL tick spacings, Solidly stable flags).
   */
  discover(
    client: PublicClient, a: Address, b: Address, block?: bigint,
  ): Promise<Address[]>;
}

export const POOL_FAMILIES: PoolFamily[] = [
  univ3Family, pancakeV3Family, aerodromeClFamily, // existing, refactored in
  aerodromeBasicFamily,                             // NEW
];
```

- **V3-style families** (`v3-slot0`): scan `getPool(a,b,fee)` over `V3_FEE_TIERS`
  (or CL tick spacings); initialized gate = `slot0() > 0`; mid = `sqrtPriceX96`.
- **Basic families** (`v2-reserves`): scan `getPool(a,b,stable)` over
  `[false, true]` (volatile + stable); initialized gate = both reserves > 0;
  mid = `v2MidFromReserves`.

The existing hard-coded factory loops in `discoverPool` /
`getDeepestPoolWithDepth` are refactored to iterate `POOL_FAMILIES`, preserving
current V3/CL behavior (same factories, same param axes).

## Uniform cross-family depth ranking

Ranking must compare a V3 pool against a basic pool for the same pair.
`liquidity()` (V3, in-range, uint128) has no basic-AMM analogue, so we adopt one
**family-agnostic** yardstick:

> **depth = the pool's `balanceOf` of the reference token**, where the reference
> token is the pair member with the *higher* anchor rank (WETH/stable side when
> present, else the higher-address token — deterministic and pair-symmetric).

`balanceOf(pool)` is readable and monotonic-with-liquidity for both V3 and basic
pools, and gives a true cross-family "deepest". It **replaces** the V3-only
`liquidity()` read as the ranking key (the `slot0()`/`getReserves()` initialized
gate and mid read are still per-family).

- Candidates that revert on `balanceOf` (should not happen for ERC-20 pools) get
  depth 0 and still qualify if otherwise initialized — mirrors today's
  "unreadable depth ⇒ depth 0, don't drop the pool" rule.
- **Empty/one-sided pool guard is retained**: a basic pool with a zero reserve,
  or a V3 pool pinned at a sqrt-ratio bound / below the liquidity floor, is
  rejected before it can win (existing `defaultGetPairMid` guards, extended to
  the reserves branch: reject if either reserve is 0).

### Risk control (blast radius on existing pairs)

Switching V3 ranking from `liquidity()` → `balanceOf(refToken)` can, in
principle, re-rank a pair that has multiple V3 fee tiers. This is gated by a
**regression harness** (see Testing) that re-prices all persisted receipts and
asserts no change to the chosen pool / mid for pairs that already priced. If any
V3 pair regresses, we fall back to a type-tiered comparison (V3 keeps
`liquidity()`; `balanceOf` used only to break V3-vs-basic ties) — recorded here
as the contingency, not the primary path.

## Data flow (after change)

```
priceReceipt(inputToken, outputToken, block)          [unchanged]
  └─ deps.getMarketPrice(in, out, block)              [unchanged]
       └─ getMarketPriceForPair(...)                  [unchanged reducer]
            ├─ getDirectMid  → defaultGetPairMid(readers, in, out, block)
            │     └─ getDeepestPoolForPair(...)  ← iterates POOL_FAMILIES,
            │           collects candidates, ranks by balanceOf(refToken),
            │           returns { address, kind }
            │        then reads mid by mechanism:
            │           v3-slot0    → readSlot0 → sqrtPriceX96ToPrice
            │           v2-reserves → readV2Reserves → v2MidFromReserves
            │     (inversion to output-per-input unchanged)
            ├─ getBridgedMid → getEstimatedMidAtBlock(...)  ← same family-aware
            │     discovery via getDeepestPoolWithDepth (also refactored)
            └─ getOracleImpliedMid                    [unchanged]
```

Both `getDeepestPoolForPair` (direct) and `getDeepestPoolWithDepth` (bridged /
estimated) become family-aware through the shared registry, so direct **and**
bridged estimators both gain basic-AMM coverage.

## Mid math details (reuse, no new math)

- `v2MidFromReserves(reserve0, reserve1, dec0, dec1)` → token1-per-token0, then
  the existing `inverted = tokenIn > tokenOut` sort/inversion yields
  output-per-input. Same convention already used for slot0 mids.
- Decimals via the injected `readDecimals` cache (unchanged).
- Reserves read at `blockNumber - 1` like all reference mids (pre-trade).

## Error handling / edge cases

- Basic pool with a zero reserve → rejected (empty-pool guard).
- Factory `getPool` revert for a stable/volatile variant → that variant skipped,
  others still tried (per-call try/catch, as today).
- `balanceOf` revert → depth 0, pool still eligible.
- Reference-token selection is deterministic and symmetric so discovery is
  order-independent in (a, b).
- No V4 path added here; unaffected.

## Testing

1. **Unit — discovery + mid (fake readers).** `defaultGetPairMid` and the
   discovery functions are already parameterized over reader interfaces. Add:
   - a `v2-reserves` family candidate that beats a shallower `v3-slot0` candidate
     on `balanceOf` depth → chosen pool is the basic one, mid via reserves;
   - zero-reserve basic pool → rejected;
   - stable vs volatile variant selection.
2. **Unit — pool-family registry.** Each family enumerates the expected
   candidate set for a stubbed factory; new family added ⇒ picked up by discovery
   with no other edits (extensibility assertion).
3. **Regression — persisted receipts.** Re-price all receipts in the DB and
   assert: (a) previously-priced pairs keep the same chosen pool + mid (V3
   re-rank guard); (b) id 209 and any other basic-AMM-routed rows now yield a
   non-null `market_mid`.
4. **e2e (RPC-gated).** Live-price id 209 end to end → `pricing_status` becomes
   `full` or `estimated`, `market_mid`/`all_in_cost_bps`/`slippage_bps` non-null.
   (Requires `TCA_RPC_URL`; skips silently otherwise — known dotenv caveat.)

## Rollout

- After merge, repopulate affected receipts in place via the existing
  dry-run-gated `scripts/repopulateReceipts.mjs` (persisted rows go stale
  silently when core pricing changes — never patch columns onto stale rows).
- Sweep the receipt set for other basic-AMM-routed pairs that were showing null
  market price and confirm they now price.

## Risks

- **V3 re-ranking** (primary risk) — gated by the regression harness; contingency
  is the type-tiered tiebreak above.
- **Depth proxy fidelity** — `balanceOf(refToken)` over-counts out-of-range V3
  tokens and uncollected fees, but only affects *which* adequately-liquid pool is
  chosen as the reference, not the mid's correctness; the empty-pool / floor
  guards still reject degenerate pools.
- **Factory coverage** — only Aerodrome basic is enabled; other Solidly/UniV2
  forks remain null until added (one descriptor each). Documented as follow-on.
```
