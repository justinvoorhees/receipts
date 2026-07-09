# Estimated Pricing Tier — Execution / Market / Delta for illiquid & multi-hop trades

Date: 2026-07-09
Status: Approved design (pre-implementation)

## Problem

The receipt shows **Execution Price**, **Market Price**, and **Price Delta** only
for trades that reach `pricingStatus: 'full'` — today just the oracle-validated
USDC/WETH benchmark path, or a generic pair where the *direct* pool has a mid and
one side anchors to USD. For everything else (`partial`) all three render as
"Unavailable for this pair".

The WARP→ETH transaction
`0xa21e4d82b961726614ce6f310e30e29a4b55b8eca1d6a46621c3adaf8edf6ab1` is the
motivating case: it is `partial` because pricing looked for a *direct* WARP/ETH
(or WARP/USDC) pool and found only a **dead** WARP/USDC pool (0 in-range
liquidity, stale mid) — the same root cause as the notional bug fixed on
`main` (commit 1ba9a32). Yet the trade is perfectly analyzable: WARP has a
*liquid* WARP/WETH pool (`0x53932cbd…`), and the output is native ETH.

### Key reframing (from reading the code)

- **Execution Price is already computed.** `realizedPrice = outputAmount /
  inputAmount` (`analyzeTransaction.ts:206`) is derived purely from the trade
  amounts and needs no market reference. It is merely *nulled* on non-`full`
  tiers by the `isFull ? … : null` gate (`analyzeTransaction.ts:308`).
- **Price Delta falls out trivially** once a Market Price exists
  (`signedDeviationBps(marketMid, realizedPrice)`).
- **The only genuinely missing input is Market Price** (`marketMid`) for pairs
  whose *direct* pool is illiquid.

So the work is narrow: derive a trustworthy-enough Market Price for illiquid /
multi-hop pairs, ungate Execution Price, and let Price Delta follow — while
clearly distinguishing validated numbers from best-effort ones.

## Goals

- Show Execution Price on **every** analyzable trade (it is always known).
- Show Market Price + Price Delta for illiquid/long-tail pairs (e.g. WARP) via
  an on-chain, block-N-1-consistent, reproducible reference.
- Clearly distinguish **oracle-validated** numbers from **best-effort** ones so a
  user can tell how much to trust each figure.

## Non-goals (deferred)

- **Route-leg chaining (Approach B):** multiplying the trade's own decomposed
  legs' prior-block mids. Higher fidelity for trades that fully decompose, but it
  fails on the motivating txn (`ROUTE_NOT_DECOMPOSED`) and compounds error across
  hops. Revisit as a higher-fidelity refinement for `full`/`estimated` trades
  that decompose.
- **External oracle / aggregator (Approach C)** for long-tail tokens. Off-chain,
  not block-consistent, not independently verifiable, adds a dependency.
- Oracle-grade validation (Chainlink cross-check / multi-pool consensus /
  staleness) for arbitrary tokens. Long-tail tokens simply land in the
  best-effort tier.

## Design

### 1. Three-tier pricing model

Extend the existing `pricingStatus` **text** column from `full | partial` to:

| Tier | Meaning | Market Price source |
|------|---------|---------------------|
| `full` | Oracle-validated (unchanged) | USDC/WETH benchmark + Chainlink cross-check |
| `estimated` | Best-effort, on-chain | Approach A, backing pool(s) above the liquidity floor |
| `partial` | No usable reference | none |

`pricingStatus` is a `text` column, so adding the `estimated` value needs **no DB
migration** — only type/logic changes. The tiers are mutually exclusive, so no
separate confidence field is introduced.

### 2. Execution Price — ungate

`realizedPrice` is computed from amounts regardless of tier. Remove the `isFull ?
… : null` gate so it renders on **all three tiers**. It is a fact, not an
estimate, so it always renders solid (no best-effort treatment). The USD-per-base
display convention already works because `notionalUsd` is now populated
best-effort from the anchored side (commit 1ba9a32).

### 3. Market Price — Approach A (per-token deepest-pool bridging)

New helper computing an output-per-input reference mid:

```
marketMid = usdRef(inputToken) / usdRef(outputToken)
```

where `usdRef(token)` prices one unit of the token in USD by **reusing the
already-fixed `getTokenUsdcValue`** (`tokenPricing.ts`), which resolves
USDC → 1:1, native/WETH → WETH/USDC, else the token's deepest pool → WETH →
USDC. This works without the trade's route decomposing.

**Liquidity floor (the tier gate).** The deepest pool backing each *non-anchor*
side must clear a minimum liquidity threshold. This is exactly what prevents
reusing a dead pool like WARP/USDC. Outcome:

- Both sides price AND every backing non-anchor pool clears the floor →
  `marketMid` populated, tier `estimated` (unless it qualifies for `full` via the
  existing oracle path, which is unchanged and takes precedence).
- A required backing pool is below the floor, or a side cannot be priced →
  `marketMid` stays null, tier `partial`.

The floor metric reuses whatever `poolDiscovery` already computes for pool depth
(in-range liquidity); the exact numeric threshold is an implementation detail to
be pinned in the plan, with a conservative tunable default.

For WARP→ETH: `usdRef(WARP)` resolves via the liquid WARP/WETH pool
`0x53932cbd…` (clears the floor); `usdRef(native ETH)` via WETH/USDC. Tier
becomes `estimated`, `marketMid` ≈ the WARP/WETH pool price.

### 4. Price Delta

`allInCostBps = signedDeviationBps(marketMid, realizedPrice)` is computed whenever
`marketMid` exists — i.e. on `full` and `estimated`. The stored display-convention
transform (`toDisplayPrice`, `baseIsOutputLeg`) and the UI helpers (`formatDelta`,
`priceDeltaComparison`) are reused unchanged.

### 5. Tier classification & data flow

- `pricing.ts` (`priceReceipt`) gains the Approach-A branch: after the existing
  USDC/WETH (`full`) and generic-anchored-pair branches, attempt the per-token
  bridged `marketMid` under the liquidity floor; on success return
  `status: 'estimated'` with the best-effort `marketMid` and null oracle fields.
- `analyzeTransaction.ts`:
  - `realizedPrice`, `marketMid`, `allInCostBps` are emitted whenever available;
    the `isFull` gate is replaced by a `marketMid != null` ("priced") gate for
    the market-derived rows, while Execution Price is always emitted.
  - `pricingStatus` passes through the new tri-state value.
- No schema migration. `pricingStatus` remains `text`; consumers already read it
  as a string.

### 6. UI treatment (dashboard)

Tier is **derivable at display time** — `estimated` ⇔ `marketMid` present AND
`chainlinkPrice` null (long-tail has no Chainlink), or simply
`pricingStatus === 'estimated'`. The receipt renders:

- `full`: exactly as today (solid, oracle-backed).
- `estimated`: the same Execution / Market / Delta rows, but Market Price and
  Price Delta carry a distinct treatment — an "est." marker + tooltip: *"Best-
  effort reference from the deepest on-chain pool at block N-1; not oracle-
  validated."* Execution Price renders solid.
- `partial`: Market Price and Price Delta remain "Unavailable for this pair";
  Execution Price now renders (previously blank).

No new persisted field beyond the `pricingStatus` value.

## Testing

- **Unit (core, injected pools — mirrors `pricing.test.ts`):**
  - `usdRef` / per-token bridging returns the correct ratio for a WARP-like
    volatile → native-ETH pair.
  - Liquidity floor: a below-floor backing pool yields `partial` (no `marketMid`);
    an above-floor pool yields `estimated` with a `marketMid`.
  - Tier classifier: oracle path → `full`; bridged path → `estimated`; no pool →
    `partial`.
  - Execution Price is emitted on all three tiers; Market/Delta only when
    `marketMid` present.
- **End-to-end (real tx):** WARP→ETH now returns `pricingStatus: 'estimated'`
  with a non-null `realizedPrice`, `marketMid` (via WARP/WETH), and
  `allInCostBps`; sanity-check `marketMid` against the WARP/WETH pool price.
- **UI:** `estimated` receipt renders Execution/Market/Delta with the best-effort
  treatment and tooltip; `partial` still shows Execution Price only.

## Rollout / compatibility

- No migration; `pricingStatus` gains a value existing rows never used.
- Existing `full` and `partial` behavior is unchanged; `estimated` is purely
  additive (trades that were `partial` and now clear the floor become
  `estimated`).
- Historical `partial` rows are unaffected until recomputed.

## Open implementation details (for the plan)

- Exact liquidity-floor metric and threshold (reuse `poolDiscovery` depth;
  conservative tunable default).
- Whether `estimated` should still surface any of the oracle passthrough fields
  (default: null, same as generic non-WETH/USDC pairs today).
