# RFQ Maker Leg Netting — reconstruct routes with round-trip maker flows

**Date:** 2026-07-16
**Status:** Approved (design), pending implementation
**Case study:** receipts id 189 — `0xb02037466b0756a3972f77d674413a0d7468663aca62e8c6eb757f15ced59e26` (2.8 ETH → 1.30M jesse via 0x Settler, Base)

## Problem

The History table's L.P. Fee column reads the trade-level `lp_fee_bps` column, which core
nulls whenever route reconstruction fails (`decomposeRoute.ts` non-reconstructed branch).
The receipt still shows per-leg LP estimates, so the two surfaces disagree: receipt shows
fees, History shows `–`.

For id 189 the route is genuinely a conserved convergent DAG that `reconstructDag`
*should* accept:

```
2.8 ETH ─ wrap ─→ WETH
  ├─ 0.07  WETH → univ3 0xa0ca…   → 18.8k ZORA
  ├─ 0.35  WETH → pool  0xadb8…   → 94.4k ZORA
  ├─ 0.28  WETH → pool  0x4e40…   → 129.2k jesse   (direct → output)
  └─ 2.10  WETH → RFQ maker 0x69a9f156 → 4,022.61 USDC
                    ├─ 1,671 USDC → pool 0x51c7… → 236.5k ZORA
                    ├─ 1,034 USDC → pool 0xedc6… → 145.6k ZORA
                    └─ 1,317 USDC → pool 0x3f53… → 185.3k ZORA
        680.5k ZORA → univ4 PM (1% hook) → 1.17M jesse
```

## Root cause

`buildLegs` (`routeGraph.ts:166-167`, `:192-193`) synthesizes leg amounts from **gross**
flows. The RFQ maker `0x69a9f156` has a **round-trip** in USDC: it sent 6,999.87 USDC
gross to the settlement helper `0x7c976801` and received 2,976.86 back as change. Its
synthesized WETH→USDC leg therefore claims `amountOutRaw = 6,999.87` USDC, while the
downstream ZORA pools only consume 4,022.61. `reconstructDag`'s `conserved()` check sees
USDC inflow ≠ outflow → returns null → `shape=complex, reconstructed=false` → trade-level
`lpFeeBps`/`slippageBps` nulled.

With **net** amounts (2.1001 WETH → 4,023.01 USDC) USDC conserves to within 0.40 USDC —
exactly the 1 bp fee retained by `0x7c976801`, already identified as `fee_recipient` —
well inside `conserved()`'s 0.1% tolerance. The DAG then reconstructs and the existing
notional-weighted rollup produces the trade-level LP fee and per-leg price impact.

## Fix

In `buildLegs`, when a candidate address has a **round-trip in a leg token** (it both
sent and received the same token — gross ≠ net for the leg's `tokenIn` or `tokenOut`),
build that side's amount from the **net delta** instead of gross:

- `amountInRaw = |net delta|` for `tokenIn` when the address also *sent* some of `tokenIn`
  (else gross received, unchanged);
- `amountOutRaw = |net delta|` for `tokenOut` when the address also *received* some of
  `tokenOut` (else gross sent, unchanged).

Applies uniformly to known-venue and unknown legs — for conservation accounting, net is
the correct measure whenever a round-trip exists; when no round-trip exists, net == gross
and behavior is byte-identical to today.

Surfacing:

- `Leg` gains optional `amountsNetted?: boolean` (routeGraph stays pure — no flags
  channel there).
- `decomposeRoute` pushes a `LEG_AMOUNTS_NETTED: leg <venue> …` normalize flag for each
  netted leg and caps `confidence` at `medium` (netting is an interpretation, not an
  observation).

### Semantics already correct

The maker leg is classified `unknown` → `decomposeRoute.ts:497` assigns feeTier 0 bps
(defaulted → flagged). So the netted leg contributes **0 to LP fee** and its spread lands
in price-impact/slippage — the honest semantic for an off-chain-quoted fill. No LP-fee
inflation risk.

## Safety

- The conservation checks (`conserved()`, pure-source/pure-sink) remain **unchanged** —
  they are the fail-closed guard. If netting produces a wrong picture of some future
  route, reconstruction still fails to `complex` rather than publishing bad numbers.
- The deliberate output-token-recurrence feature (`linearFlowValid`, WARP→WETH→USDC→WETH)
  is unaffected: in that shape no single *leg address* has a round-trip; the recurrence
  is across pools.
- `resolveV4Settlement` is upstream of `buildLegs` and bails early on this tx (the V4 PM
  net-sends jesse, so no proxy rewrite occurs). Netting does not interact with it.

## Relationship to the RFQ/relayer bundle (NOT in scope)

This is the first installment of the ⭐ RFQ-maker bundle in `open-fast-follows`, but the
following remain **explicitly out of scope**:

- Assigning the `rfq` VenueType / fixing the "Unknown Pool" label for maker legs.
- The benchmark semantic for off-chain fills (`tokenPricing.ts:~495` accident).
- Relayer/AA/P2P beneficiary-anchored decoding (different axis: who the *trader* is).
- The other two `ROUTE_NOT_DECOMPOSED` rows — id 56 (multi-fee V4 hub) and id 134 fail
  for different reasons and need their own diagnoses.

## Testing

1. **Unit pin test** (`routeGraph.test.ts`): legs/transfers shaped like id 189's maker
   cluster (round-trip change flow) — asserts the leg amounts are netted and
   `reconstructDag` accepts the DAG; plus a no-round-trip case asserting amounts are
   byte-identical to today (gross).
2. **decomposeRoute test**: end-to-end through `decomposeTrade` with stubbed deps —
   asserts `reconstructed=true`, trade-level `lpFeeBps` ≈ notional-weighted tier sum,
   maker leg contributes 0 LP fee, `LEG_AMOUNTS_NETTED` flag present, confidence capped
   at `medium`.
3. **RPC e2e** (skip-gated on `TCA_RPC_URL`, exported via `set -a && source .env && set +a`):
   the real tx `0xb020…9e26` analyzes to a reconstructed route with non-null `lpFeeBps`.
4. **Invariant check**: `all_in = LP + Agg + Slippage` holds on the repopulated row
   (venue-attribution repopulation sanity rule).

## Rollout

- Repopulate row 189 **in place** (UPDATE preserving id — never delete+re-POST; the
  paste path is cache-first and id churn breaks links).
- Full-corpus dry run first: expect id 189 and *nothing else* to change (rows without
  round-trip flows are byte-identical by construction). If anything else moves, stop and
  diagnose before writing.

## Expected outcome for id 189

`shape` `complex`/not-reconstructed → `split`/reconstructed (4 legs leave WETH, so
`chainLegs` tags the DAG `split`; note the known deferred quirk that split routes report
`hopCount=1`) with ~7 costed legs + wrap/unwrap;
trade-level LP fee ≈ notional-weighted sum of real tiers (30 bps V3 leg, 100 bps V4 hook
leg, the three USDC→ZORA pool tiers, 0 for the maker leg); History L.P. Fee column
populated; slippage populated; confidence `medium`.
