# V4 Multi-Pool Fee Averaging — design

Date: 2026-07-30. Implements **item 2** of `docs/attribution-worklist.md`
(rewritten in `4b21719`; the diagnosis this spec is built on replaced an earlier
one that was wrong).

## The problem

Uniswap V4 is a **singleton**: one address, `0x498581ff718922c3f8e6a244956af099b2652b2b`,
emits `Swap` for every pool it hosts. Two places treat that address as if it
were a single pool.

**`routeVenueScan.ts:89`** overwrites its venue entry on every V4 `Swap` log:

```ts
// V4 PoolManager can host multiple pools; use the latest fee info
venues.set(addr, { type: 'univ4', v4PoolId: poolId, v4FeeRaw: fee });
```

The map therefore retains only the **last** pool's `v4FeeRaw` *and* `v4PoolId`.
The fee drives `lpFeeBps`; the poolId drives the mid read. One overwrite
corrupts both — which is why the old worklist entry mistook this for two
independent broken readers.

**`decomposeTrade.ts:342-358`** independently averages the tiers for the
route-level `lp_fee_bps` and flags it:

```
NEEDS REVIEW: multiple V4 Swap fees detected (500, 10000), using average=52.50 bps
```

So the two paths disagree, and both are wrong: on id 55 the persisted leg
carries `feeTierBps: 100` (the last tier) while `lp_fee_bps` used 52.50.

Because core derives `priceImpact = (legTotalCost − feeTier) × share`
(`decomposeRoute.ts:374`, `:632`) from that same tier, the impact goes with it.

## Measured scope

Eight receipts averaged more than one V4 fee. Three were rescued (56, 251, 408).
**Five were not:**

| id | notional | raw fees | averaged | collapsed leg | outcome |
|---|---:|---|---:|---|---|
| 249 | $2,220 | 21222, 10000, 29500 | 202.41 | `BRIAN→USDC` @295 | **not clamped — silently wrong** |
| 55 | $1,446 | 500, 10000 | 52.50 | `USDC→CLAWD` @100 | clamped, PI null (−92,096 bps) |
| 59 | $637 | 3000, 500, 10003 | 45.01 | `USDC→GITLAWB` @100.03 | clamped, PI null (9,900 bps) |
| 211 | $193 | 1002, 1006, 1000, 1004, 500, 1003 | 9.19 | `WETH→USDC` @10.03 | **not clamped — silently wrong** |
| 207 | $1 | 49, 500 | 2.75 | `USDC→WETH` @5 | **not clamped — silently wrong** |

Total $4,497. The `PI_IMPLAUSIBLE` clamp catches only the extremes; **three of
the five display confident LP Fee and Price Impact numbers with nothing warning
anyone.** That is the real find, and it is not what the worklist advertised.

⚠️ ids 329, 330, 402, 403 carry `PI_IMPLAUSIBLE` on the same venue but **no
averaging flag** — a single V4 pool, a different failure mode, out of scope
here. id 215's implausible leg is **Hydrex**, not V4. See the worklist.

## The fix already exists — behind a gate that is too narrow

`decomposeRoute.ts:450` has a **V4 multi-pool RESCUE** that calls
`collectV4Swaps` → `v4PoolKeyReader` → `synthesizeV4Legs`, producing one leg per
pool with venue `v4:<poolId>` and that pool's own `v4FeeRaw`. It works:
receipts 56, 251 and 408 carry clean per-pool legs.

It is gated on **`!graph.reconstructed`** plus an `orphan_token` /
`fee_on_transfer` break reason. The five receipts above reconstruct
*successfully but wrongly* — one collapsed leg that happens to chain — so the
rescue never runs. The gate cannot tell "reconstructed well" from
"reconstructed wrong".

### Widening the gate alone is not enough

`routeGraph.ts:511-517` merges `extraLegs` with a **pair-based** guard:

```ts
const existingUniv4Pairs = new Set(
  legs.filter((l) => l.type === 'univ4').map((l) => `${l.tokenIn}>${l.tokenOut}`),
);
const dedupedExtraLegs = (args.extraLegs ?? []).filter(
  (l) => !existingUniv4Pairs.has(`${l.tokenIn}>${l.tokenOut}`),
);
```

Every one of the five is a split across **fee tiers of the same pair** — id 211
is six USDC/WETH pools collapsed into one `WETH→USDC` leg. Those synthesized
legs all share the collapsed leg's pair, so the guard would discard **all of
them** and the rescue would be a no-op. The merge rule has to change too.

## Design

Two changes, both in `packages/core/src`.

### 1. The gate — `decomposeRoute.ts:450`

Also attempt the rescue when the graph reconstructed but the trace shows more
than one distinct V4 `poolId`:

```ts
const v4Swaps = collectV4Swaps(logs);
const distinctV4Pools = new Set(v4Swaps.map((s) => s.poolId)).size;
const collapsedMultiPool = graph.reconstructed && distinctV4Pools > 1;
if (
  (!graph.reconstructed &&
    (graph.breakReason?.kind === 'orphan_token' || graph.breakReason?.kind === 'fee_on_transfer')) ||
  collapsedMultiPool
) { … }
```

`collectV4Swaps` is already called inside the existing block; it moves up so
both the gate and the body share one call. The existing
`if (v4Graph.reconstructed)` adoption check is **unchanged** — a rescue that
fails to reconstruct still changes nothing.

The existing `pmTokens.size > 1` inner guard is **left as-is** and applies to
both paths. It counts distinct tokens the PoolManager moved, and it is satisfied
for all five receipts: ids 207 and 211 settle in native ETH, but
`decomposeRoute.ts:422` already models native value transfers as WETH before the
graph is built, so the PoolManager registers two tokens (USDC + WETH) either
way. Test 5 below pins this rather than leaving it to inspection — a native-ETH
V4 route is exactly where an ERC-20-only reading of that guard would fail, and
it is not obvious from the guard's own code that it does not.

### 2. The merge rule — `routeGraph.ts:511-517`

Pair-based dedup is right when `buildLegs` captured a genuine single V4 pool.
It is wrong when several pools were collapsed, because then `buildLegs`' leg is
the corrupted one and the synthesized legs are strictly better.

```ts
// When the extra legs describe MORE THAN ONE V4 pool, buildLegs' own univ4 leg
// is the collapsed PoolManager artifact — one leg carrying the LAST pool's fee
// and poolId (routeVenueScan.ts:89). It is strictly worse information than the
// per-pool legs, so it is replaced rather than preferred.
const extraPoolIds = new Set(
  (args.extraLegs ?? []).map((l) => l.v4PoolId).filter((id): id is string => id != null),
);
const replaceCollapsedV4 = extraPoolIds.size > 1;
const legsAfterV4 = replaceCollapsedV4 ? legs.filter((l) => l.type !== 'univ4') : legs;
```

then dedup `extraLegs` against `legsAfterV4` exactly as today. With
`replaceCollapsedV4 === false` the behaviour is byte-identical to current.

### 3. A comment at the source — `routeVenueScan.ts:89`

Not a behavior change. The line's current comment ("use the latest fee info")
reads as deliberate; it is the defect. Replace it with one naming the
consequence and pointing at the rescue, so nobody re-derives this.

**Why not fix the overwrite properly?** The venue map is keyed by emitter
address across `routeGraph`, `routeVenueScan`, `decomposeRoute` and
`decomposeTrade`, and legs are matched to venues by that address. Re-keying V4
venues by poolId is a substantially larger change that would duplicate what
`synthesizeV4Legs` already does correctly. The rescue is the sanctioned,
tested mechanism for exactly this.

### Out of scope

`decomposeTrade.ts:342-358`'s averaging is left alone. It feeds the route-level
`lp_fee_bps` rollup, not `route_legs`. Once the rescue runs, `decomposeRoute`
recomputes `lpFeeBps` from the per-pool legs (`:566`), so the rollup is corrected
downstream. The `NEEDS REVIEW: multiple V4 Swap fees` flag stays — it is now an
accurate description of what the *other* path saw, and it is the marker this
work is keyed off. Removing it would destroy the ability to find these receipts.

## Testing

TDD. Baseline to hold: **624/624** with `.env` exported
(`set -a && source .env && set +a`), 621 + 3 skipped without; `npx tsc --build`
exit 0; eslint exit 0.

`decomposeRoute V4 multi-pool extraction (id 56)` in `decomposeRoute.test.ts` is
the template — it injects a `v4PoolKeyReader`, so no RPC is needed.

New cases, both chosen because they break the pair-based dedup:

1. **Same-pair two-tier split (id 207 shape).** Two V4 pools, both `USDC→WETH`,
   fees 49 and 500. Assert: two legs with venues `v4:<poolId>`, each carrying
   its OWN `feeTierBps` (0.49 and 5), and no leg at the bare PoolManager
   address. This fails today — the dedup drops both synthesized legs.
2. **Six-pool split (id 211 shape).** Six `WETH→USDC` pools. Assert six legs and
   that `Σ lpFeeBps` equals the notional-weighted sum of the six real tiers, not
   `6 × average`.
3. **Single-pool V4 is unchanged.** One pool → `replaceCollapsedV4` false →
   `buildLegs`' leg is kept and the extra leg deduped, exactly as today. This is
   the regression guard for the 21 currently-correct V4 receipts.
4. **A rescue that fails to reconstruct is a no-op.** Feed a poolKeyReader that
   returns null for every poolId; assert the graph is byte-identical to the
   un-rescued one.
5. **A native-ETH V4 split still passes the `pmTokens.size > 1` guard.** Two
   pools settling in native ETH rather than WETH. Asserts the rescue runs —
   guarding the reasoning above, which depends on `extractNativeTransfers`
   running before the graph is built.

## Repopulation

Back up first, then repopulate the five. Pattern already in the repo:
`docs/receipts-75-78-prerepop-backup.json`.

```
node scripts/repopulateReceipts.mjs --ids=55,59,207,211,249            # dry run
node scripts/repopulateReceipts.mjs --ids=55,59,207,211,249 --commit
```

⚠️ `WATCH` (line 61 of that script) does **not** include `routeLegs`, so a
legs-only change prints `no change` and `changed=0` while
`if (COMMIT) await db.update(...)` still writes. Do not read `changed=0` as
"nothing happened". Diff the backup against the new rows to verify.

**Success criteria per receipt:** the collapsed bare-`0x498581ff` leg is gone,
replaced by ≥2 `v4:<poolId>` legs each with a plausible own tier; no
`PI_IMPLAUSIBLE` on a V4 leg for 55 and 59; and for 207/211/249 an LP Fee that
differs from the old averaged value. Expect the displayed numbers to CHANGE —
that is the point of the change, unlike item 1.

⚠️ Only 5 rows, so this runs well inside the 5-minute tool timeout. A full-corpus
run would not.
