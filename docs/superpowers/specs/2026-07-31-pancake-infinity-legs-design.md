# PancakeSwap Infinity — model its swaps as route legs

Date: 2026-07-31. Reopens the deferred half of `docs/attribution-worklist.md` §4.

## Why this is worth more than the worklist said

§4 valued this at **0.17 bps on a $12 trade** and I agreed. That was the right
number for the wrong question. Receipt **id 445** (Nordstern, ETH→WBTC,
**$3,733.49**) contains **three Infinity swaps that are not modelled at all**.
They are not merely unpriced — no leg exists for them, so the route graph cannot
conserve, `reconstructed` is false, and `decomposeRoute.ts:662` gates the entire
price-impact computation behind that flag. The receipt therefore renders **no
price impact, no LP fee and no slippage at all**.

The real cost of not modelling Infinity is not a fraction of a basis point. It is
that a $3.7k receipt produces nothing.

**Corpus footprint: 2 receipts, $3,745.56** — id 408 ($12.07, 1 Infinity swap)
and id 445 ($3,733.49, 3 swaps).

## What already shipped, and what is still missing

Already done (`46aeed2`, `5fdcad9`): the Infinity **Vault** is in
`SINGLETON_DEX_CUSTODIANS`, so it is no longer misbooked as an aggregator fee
sink, and it is labelled "PancakeSwap Infinity" instead of "Unknown Pool".

Still missing: **nothing decodes the Infinity `Swap` topic.** No legs are
synthesized, so its fee is unread and its hops are invisible to the graph.

## Feasibility — verified on-chain, not assumed

Infinity is **structurally identical to Uniswap V4**: a singleton emitting `Swap`
with an indexed `poolId`, plus per-pool key and slot0 readers. Every input the V4
machinery needs, Infinity has. Probed on `CLPoolManager`
`0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b` (20,885 bytes):

| selector | returns | verified |
|---|---|---|
| `0x0e2d484a(poolId)` | `currency0, currency1, hooks, poolManager, fee, parameters` | pool `0xf6e81e5d…` → `(0x0 native, USDC, 0x0, 0xa0ffb9c1…, 47, 65536)` |
| `0xc815641c(poolId)` | `sqrtPriceX96, tick, protocolFee, lpFee` | decodes to **1,869.75 USDC per ETH** — plausible for that block |
| `0xfbfa77cf()` | `vault()` | returns `0x238a3588…`, confirming the custodian link |

⚡ **Infinity's pool-key reader is a single `eth_call`.** V4's
`createDefaultV4PoolKeyReader` has to scan historical `Initialize` logs because
Uniswap's PoolManager exposes no `poolIdToPoolKey`. Infinity does. Cheaper and
simpler — do not copy V4's log-scan shape here.

## Architecture: add alongside, do not refactor V4

Decision 2026-07-31. The V4 path now carries three separately-earned correctness
guards — the emitter-scoped leg replacement, the rescue shortfall guard, and the
zero-amount swap guard. Generalising the two singletons into one registry-driven
mechanism would rewrite all of that against a sample of two. Infinity gets its
own file mirroring the V4 shape.

### New: `packages/core/src/infinityLegs.ts`

Mirrors `v4Legs.ts`. Nothing in `v4Legs.ts` changes.

- `INFINITY_SWAP_TOPIC` = `0x04206ad2b7c0f463bff3dd4f33c5735b0f2957a351e4f79763a4fa9e775dd237`
- Event shape, confirmed against the real logs (2 indexed topics, 7 data words):
  ```
  Swap(PoolId indexed id, address indexed sender, int128 amount0, int128 amount1,
       uint160 sqrtPriceX96, uint128 liquidity, int24 tick,
       uint24 fee, uint16 protocolFee)
  ```
- `collectInfinitySwaps(logs)` — decode, and **skip swaps where both amounts are
  zero**, for the same reason as V4: a no-op swap's poolId is not the pool the
  trade used, and using it would poison the mid read.
- `infinityLpFeePips(swapFee, protocolFee)` — inverts Pancake's
  `calculateSwapFee = protocolFee + lpFee − protocolFee·lpFee/1e6`, i.e.
  `lpFee = (swapFee − protocolFee) / (1 − protocolFee/1e6)`.

  ⚡ **The fee needs no RPC** — it rides on the event, exactly like `v4FeeRaw`.
  Verified on id 408: `(70 − 23)/(1 − 23e−6) = 47.001`, matching the pool key's
  static `fee = 47`. Deriving from the **event** rather than the key is also
  correct for dynamic-fee pools, where the key's value would be stale.

  ⚠️ The event's `fee` is the TOTAL charged (LP + protocol). Persisting it
  directly would overstate the LP fee by the protocol share.
- `synthesizeInfinityLegs(swaps, poolKeys, wethSentinel)` — one leg per poolId,
  venue `inf:<poolId>`, mapping `ZERO_ADDRESS → WETH` sentinel. Infinity pools
  use native ETH (id 408's pool has `currency0 = 0x0`), so this is required, not
  defensive.
- `shouldAttemptInfinityRescue({ reconstructed, breakReason, swaps })` — same
  two-branch predicate as `shouldAttemptV4Rescue`: fire on a failed graph with
  `orphan_token` / `fee_on_transfer`, or on a reconstructed graph carrying more
  than one distinct poolId.

### Readers

- `readInfinitySlot0(client, poolId, blockNumber)` in `poolDiscovery.ts`, beside
  `readV4Slot0`. Calls `0xc815641c`, returns `sqrtPriceX96` or null.

  ⚠️ Call the **CLPoolManager itself**. V4 reads slot0 from a separate
  `V4_STATE_VIEW` contract; Infinity needs no such indirection — verified
  working directly against `0xa0ffb9c1…`. Do not go looking for an Infinity
  StateView.
- `createDefaultInfinityPoolKeyReader(rpcUrl, blockNumber)` in `routeReaders.ts`
  — a single `eth_call` to `0x0e2d484a`, returning `{ currency0, currency1 }`.

### Venue type, fee and mid

`VenueType` gains `'pancake_infinity'`. Both of the following are **required**;
adding the type without the mid branch is the failure mode this repo has hit
before (QuickSwap v4) and would **null the legs' price impact**, making the
receipt worse than today.

- **Fee** — `createDefaultFeeReader` gains a `pancake_infinity` case returning
  `{ bps: infinityFeeRaw / 100, defaulted: false }`, mirroring `univ4`.
  47 pips ÷ 100 = 0.47 bps; same pips convention as V4.

  ⚠️ **`infinityFeeRaw` holds the LP-ONLY pips — the OUTPUT of
  `infinityLpFeePips`, not the event's raw `fee` field.** On id 408 that is
  **47**, not 70. Storing the event value directly would overstate the LP fee by
  the protocol share (0.70 bps instead of 0.47). The inversion happens once, in
  `collectInfinitySwaps`, so every downstream consumer sees LP pips.
- **Mid** — `getLegMidAtBlock` gains a `pancake_infinity` branch calling
  `readInfinitySlot0`. It must reuse V4's **native-ETH orientation
  disambiguation**: compute the price both ways and pick the one consistent with
  the leg's realized price, because `currency0 = 0x0` means the pool's currency
  order need not match the address sort.

### `Leg` fields, and one rename in the V4 path

`Leg` gains `infinityPoolId?: string` and `infinityFeeRaw?: number`, alongside
the existing `v4PoolId` / `v4FeeRaw`.

⚠️ **Rename `Leg.v4Emitter` → `Leg.replacesVenue`.** Rename only, no logic
change. The field means *"the address-derived leg these synthesized legs
replace."* For V4 that is the PoolManager, which both emits and custodies. For
Infinity the two **differ**: the CLPoolManager emits, but transfers land at the
**Vault**, so the Vault's leg is the one to replace. Baking `v4` into the name is
exactly what would force duplicating `routeGraph`'s replacement logic. Touches
`v4Legs.ts` (set), `routeGraph.ts` (read), `analyzeTransaction.ts` (`frameKey`),
and their tests — all mechanical.

### `routeVenueScan` and `decomposeRoute`

- `routeVenueScan` registers the **Vault** (not the CLPoolManager) as a
  `pancake_infinity` venue when an Infinity `Swap` is seen, because that is where
  the transfers land and therefore where the address-derived leg sits.
- `decomposeRoute` gains a second rescue block after the V4 one, structurally
  identical: collect → resolve pool keys → synthesize → rebuild the graph →
  adopt **only if** it reconstructs **and** clears the same trader-outflow
  shortfall guard.

  ⚠️ Do not weaken or bypass the shortfall guard for Infinity. It has already
  fired correctly on real data (id 445: synthesized legs covering 0.391 of the
  2.0 ETH sent), and `reconstructed` alone is not a completeness check.

### Display

`KNOWN_VENUE_LABELS` already names the Vault address. Add a
`leg.type === 'pancake_infinity'` case in `getVenueLabel` returning
`'PancakeSwap Infinity'`, so synthesized `inf:<poolId>` legs — whose venue is a
pool id, not an address — are named too. Basescan links for those legs should
use the same `legLinkAddress` fallback pattern the `v4:` legs use, pointing at
the CLPoolManager.

## Success criteria

Measured on **id 408**, where Infinity is the only gap:

- its `0x238a3588…` leg is replaced by a `inf:<poolId>` leg with
  `feeTierBps = 0.47` and `feeResolved` absent (i.e. resolved);
- that leg carries a non-null `priceImpactBps` — **the mid branch works**;
- the `IMPACT_ABSORBS_FEE_TOOLTIP` caveat disappears from its Price Impact cell,
  because the fee is no longer unread;
- `allIn = LP + Agg + Slippage` still closes.

⚠️ **id 445 reconstructing is NOT a success criterion.** Infinity is three of its
seven uncaptured venues; the rest include two unrecognised WBTC/cbBTC pools and a
V4 rescue that the shortfall guard correctly rejects. This work may leave 445
unreconstructed, and that is an acceptable outcome. Record what changes for it,
do not chase it.

## Testing

TDD. Baseline: **669 passed + 3 skipped** with `.env` exported; `tsc --build`
exit 0; eslint exit 0.

Pure units, no RPC:
- `infinityLpFeePips(70, 23)` ≈ 47.001; `(0, 0)` = 0; protocol-only is handled.
- `collectInfinitySwaps` skips both-amounts-zero, keeps a one-sided zero, keeps
  ordinary swaps — same three cases as the V4 guard.
- `synthesizeInfinityLegs` maps `ZERO_ADDRESS → WETH`, emits `inf:<poolId>`
  venues, sets `replacesVenue` to the **Vault**, and drops swaps whose pool key
  failed to resolve.
- `shouldAttemptInfinityRescue` — all seven cases mirrored from
  `shouldAttemptV4Rescue`, including that an empty swap list never fires and that
  distinctness counts pools, not swap events.

End-to-end: repopulate ids 408 and 445 and verify against the criteria above.
Both are already backed up (`docs/receipt-408-prerepop-backup.json`,
`docs/receipts-full-corpus-backup-2026-07-31.json`).

⚠️ `repopulateReceipts.mjs`'s `WATCH` list excludes **both** `routeLegs` and
`normalizeFlags`, so a legs-or-flags-only change prints `no change` /
`changed=0` while still writing. Verify by querying the rows, never by reading
that number.

⚠️ Rebuild `packages/core/dist` before repopulating — the script imports from
dist, and a stale build silently re-runs the old code.

## Out of scope

- Generalising V4 and Infinity into one registry-driven mechanism (decision
  above; revisit at a third singleton).
- The two unrecognised WBTC/cbBTC pools in id 445, and its rejected V4 rescue.
- `0x60b393a76cea4a3afff00e1fb08d0f63a8f4a314`, a **second contract emitting the
  Uniswap V4 Swap topic** — a V4 fork found in id 445. It is currently typed
  `univ4`, so its fee and mid reads assume the real PoolManager's state view,
  which is probably wrong. Real, separate, and worth its own investigation.
