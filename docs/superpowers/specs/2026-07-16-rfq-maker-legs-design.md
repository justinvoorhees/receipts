# Market-Maker (RFQ) Leg Attribution

**Date:** 2026-07-16
**Status:** Approved (design), pending implementation
**Decisions locked by user:** (1) rfq legs get NO per-leg mid, by design, with an
explanatory tooltip; (2) detection = EOA + EIP-1967 proxy structural rule, generalized
via an RFQ fill-event registry; (3) display label = "Market Maker".

## Problem

Market-maker fills are counterparties, not pools, but the pipeline treats them as
"unknown pools": the `rfq` VenueType exists but is never assigned (`decomposeRoute`),
`getVenueLabel` renders them "Unknown Pool" (`TradesTable.tsx:593-614`), and
`tokenPricing.ts:497` benchmarks their off-chain-quoted fills against factory-discovered
AMM mids — an accident that produces garbage price impact (id 189's
`PI_IMPLAUSIBLE: pi=-145345.9`) and unearned confidence downgrades.

Known maker legs in the corpus: rows 36/47 (`0xbee3211a…`), 53/60/64 (`0x3dbe077e…`),
118 (`0x7d94baf6…` EOA), 189 (`0x69a9f156…`, the netted 0x-Settler maker).

## Detection (two-tier, evidence-verified 2026-07-16)

A retype pass in `decomposeRoute` immediately after the route graph is built (Step 4)
and before fee resolution (Step 5), applied ONLY to legs typed `unknown` (recognized
venue types are never overridden):

- **Tier 1 — maker fill events (no RPC):** the leg's venue address itself emitted a
  topic0 in a small `RFQ_FILL_TOPICS` registry within this tx. Seed:
  `0x51ab1232a73b82b6b0acb0fa91b834cf6e258a1858c4e23c72ce97241c71aa0d` — emitted 8×
  by id 189's maker proxy `0x69a9f156` (verified on-chain). Registry is extensible the
  same way venue event-topics are.
- **Tier 2 — structural (block-pinned RPC):** the venue is an **EOA**
  (`getCode` empty at the trade block) OR an **EIP-1967 proxy** (implementation slot
  `0x360894a1…382bbc` non-zero at the trade block). Verified: makers `0xbee3211a`
  (2 KB proxy, impl `0x45a507eb`), `0x69a9f156`/`0x7c976801`/`0x6a6951db` (130 B
  proxies — 0x settlement-helper family), `0x7d94baf6` (EOA).
- **Discriminator that makes this safe:** the 23 KB unrecognized AMM `0x51c72848`
  (id 189's other unknown leg) has impl slot = 0 and is not an EOA → stays `unknown`.
  ⚠️ Do NOT use "emitted no logs" as a maker signal — measured on id 189, it is
  BACKWARDS: the maker emitted 8 logs, the real pool emitted 0.
- 1inch LOP `OrderFilled` (`0xfec33135…`, router-emitted, verified in row 118's tx) is
  documented as corroboration only — its maker is an EOA, so tier 2 already covers it;
  no router-event mechanism is built now (YAGNI).

The tier-2 probe is injectable (like `feeReader`/`midReader`) so tests stub it; the
production impl uses viem `getBytecode` + `getStorageAt` pinned to `input.blockNumber`.

## Cost semantics

- Fee tier: `rfq` already resolves to `{bps: 0, defaulted: false}`
  (`decomposeRoute.ts:495-496`) — retyping alone removes the phantom "defaulted fee"
  confidence penalty maker legs carry today as `unknown`.
- Per-leg mid: in the Step-9 pricing loop, `rfq` legs are skipped BEFORE the midReader
  call: `priceImpactBps` stays null **by design**, `hasNullMid` is NOT set (the null is
  deliberate, like the no-midReader case), and a flag is pushed:
  `RFQ_LEG_UNPRICED: leg <venue10> — off-chain quote, no on-chain mid exists`.
  Belt-and-braces: remove `'rfq'` from `tokenPricing.ts:497`'s factory-discovery branch
  (return null there) so no caller can accidentally price one.
- Reconciliation: `reconResidualBps` is computed only when every leg has a valid mid;
  with an rfq leg present it stays null (the maker's spread is real cost that per-leg
  PI cannot see — a residual would just re-absorb it and trigger a spurious
  RECON_LOW downgrade). The trade-level invariant is untouched: the spread lands in
  `slippageBps = allIn − LP − agg` as before.
- Confidence: no downgrade from the deliberate rfq null. Other downgrade paths
  (approx notionals, LEG_FEE_IMPLAUSIBLE, genuine MID_NULL on non-rfq legs) unchanged.

## Display (dashboard)

- `getVenueLabel` (`TradesTable.tsx`): split the `rfq`/`unknown` alias — `rfq` →
  **"Market Maker"**, `unknown` stays "Unknown Pool".
- Route-breakdown dialog (`ReceiptView.tsx` per-leg rows): when `leg.type === 'rfq'`,
  the null LP-fee / price-impact cells carry the tooltip:
  "Filled from a market maker's inventory at an off-chain quoted price; no pool fee or
  on-chain mid exists for this hop."
  (Requires `type` to be present on stored legs — it already is, via `routeLegsBase`.)

## Rollout

- Full-corpus dry run (same script discipline as the netting rollout): expected
  changes ONLY in rows 36, 47, 53, 60, 64, 118, 189 (leg `type` unknown→rfq, per-leg
  PI nulled on those legs, possible confidence RISES where the defaulted-fee penalty
  or a maker-leg MID artifact was the only downgrade). Row 189's `PI_IMPLAUSIBLE` on
  `0x51c72848` should PERSIST (it stays `unknown`) — its confidence staying low is
  correct. Anything outside that set → STOP and diagnose.
- Repopulate changed rows IN PLACE (UPDATE preserving ids).
- Note: rows 53/60/64's venue `0x3dbe077e` has zero code TODAY; detection is pinned to
  the trade block, so the dry run reveals whether it was an EOA or proxy then — either
  qualifies for tier 2.

## Out of scope

- id 56 (multi-pool V4 leg-splitting via per-poolId Initialize resolution) and id 134
  (input-token mid-chain recurrence in `linearFlowValid`) — both DIAGNOSED 2026-07-16,
  each needs its own spec.
- Relayer/AA/P2P beneficiary-anchored decoding.
- The `0x57dafd63` "retained 75%" flag — a delegatecall trace artifact (it is the
  IMPLEMENTATION of wrap-helper proxy `0x6a6951db`); noted, separate cleanup.
- Router-emitted RFQ event corroboration (1inch OrderFilled mechanism).

## Testing

1. Unit: retype pass — tier-1 (stubbed logs carrying the fill topic), tier-2 (stubbed
   probe: EOA / 1967-proxy / plain-contract), negative case (plain 23 KB-style contract
   stays `unknown`), and recognized-venue immunity (a `univ3` leg is never retyped).
2. decomposeRoute synthetic: a route with one rfq leg → `RFQ_LEG_UNPRICED` flag,
   PI null on that leg only, `hasNullMid` not set (other legs' PI + recon behavior per
   spec), confidence not downgraded by the rfq null, LP fee excludes the maker leg
   without a defaulted-fee penalty.
3. RPC e2e pins: id 189's tx → maker leg `type: 'rfq'`, `RFQ_LEG_UNPRICED` present,
   no `PI_IMPLAUSIBLE` for `0x69a9f156` (the one for `0x51c72848` may remain);
   row 118's tx → EOA maker leg typed rfq.
4. Dashboard: `getVenueLabel({type:'rfq'})` = "Market Maker"; dialog tooltip renders
   for rfq legs (renderToStaticMarkup assertions, consistent with existing coverage).
