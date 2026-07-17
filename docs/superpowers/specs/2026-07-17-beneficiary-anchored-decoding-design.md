# Beneficiary-anchored decoding

**Date:** 2026-07-17
**Status:** Design approved; plan pending
**Branch:** `feat/beneficiary-anchored-decoding`

## Problem

`analyzeTransaction` anchors the trade on `tx.from`. For a **relayer / solver / intent** transaction the party who submitted the tx is not the party who traded: the submitter has ~zero net token movement, and the swap's real endpoints belong to a separate **beneficiary** address. `extractEndpoints({trader: tx.from})` returns `null` for these, so `analyzeTransaction` returns `null` and **no receipt is produced** — e.g. the Relay trade `0xd6bb5ae0…` (`tx.from = 0x370a7e2d…` has zero net flow; the real trade is EOA `0xf70da978…`, USDC→native-ETH), and UniswapX single fills (the `swapper` trades, the filler submits).

This is the "the counterparty is a party, not a venue" thread. Detection already shipped (`classifyTransaction` → `RELAYER_THIRD_PARTY` DiagnosticCard); this spec adds **decoding**: re-anchor on the beneficiary and produce a real receipt.

## Scope

**In:**
- Single-beneficiary re-anchoring for relayer/solver txns where `tx.from` is not the trader.
- **UniswapX** single fills, identified authoritatively from the reactor's `Fill` event.
- Generic relayers via the already-proven net-flow beneficiary detector (covers the Relay id57 case and unseen relayers).

**Out (deferred):**
- **Multi-beneficiary batch settlements** (CoW `settle()`, multi-order UniswapX fills). Needs a batch UI and a `(userId, txHash, chainId)` key change to hold N receipts per hash; also, much batch fulfilment is private/inventory liquidity that decomposes to null cost, so the payoff is unproven. A multi-order tx returns `null` from `resolveTrader` (stays detected-only) until this is picked up.
- **Full cost decomposition of private-inventory legs.** Where the counterparty is a solver's own book (common in UniswapX), the LP/slippage decomposition benchmarks against a pool mid it has no basis for — the deferred **RFQ-benchmark pricing** question. Those receipts still ship with endpoints + realized price + gas (valuable under the receipt-MVP "what happened" thesis); the LP/slippage fields come back null/low-confidence, which is honest and pre-existing behavior.

## Core invariant (load-bearing)

Re-anchoring is **fail-closed and strictly additive**:

- **Additive** — it runs *only* when the current `tx.from` anchor returns `null` (today's no-receipt path). It never touches a tx that already produces a receipt, so no existing full-txn receipt can change, and no receipt can regress to describing a single leg.
- **Fail-closed** — it anchors only on a party identified as the **end-beneficiary** (net input→output of the whole trade, with intermediate hops collapsed by netting). It never anchors on an intermediary/leg counterparty. When identification is ambiguous, it returns `null` (→ no receipt / detected-only DiagnosticCard), never a guess.

This is the direct guard against the id-119 class of bug, where a receipt was wrongly anchored on the WETH→USDC *intermediary contract* `0xbee3211a…` instead of the true beneficiary EOA `0xf70da978…`. A leg is never separately addressable (all legs share the parent txn hash); the only failure mode to prevent is picking the *wrong party*, and the invariant prevents it structurally.

## Architecture

A single new orchestrator, **`resolveTrader`**, decides whose trade the receipt describes. `analyzeTransaction` calls it once, replacing `const trader = tx.from.toLowerCase()` (the sole `tx.from`-derived anchor — verified: `tx.from` appears at exactly one line, everything downstream flows from the `trader` variable; `router_address` independently uses `tx.to`).

```
resolveTrader(trace, tx, receiptLogs, rpc) → { trader, anchor } | null

anchor =
  | { kind: 'self' }                            // tx.from is the trader (today's path)
  | { kind: 'beneficiary', method }             // re-anchored; method = 'uniswapx' | 'net-flow'
```

> **Reconciled with implementation (2026-07-17):** the shipped `Anchor` carries only
> `method`, not a `via` field. The solver EOA (`tx.from`) is deliberately **not**
> persisted — `router_address` (= `tx.to`, the reactor/relayer) plus the anchor method
> already give the receipt everything it needs to disclose provenance (YAGNI).

**Precedence** (mirrors `resolveAggregator`'s resolver → address → unknown tiering):

1. **Self.** If `extractEndpoints({trader: tx.from})` resolves → `{ trader: tx.from, anchor: { kind: 'self' } }`. Short-circuits; **zero behavior change for every tx that works today.** This ordering (self before protocol) is what guarantees the additive invariant. Its one consequence: a UniswapX **filler that itself nets a clean 1-in/1-out** swap anchors `self` (the filler's own trade), not the `swapper` — see Limitations. In practice fillers do not net user-shaped clean swaps; preserving the no-regression guarantee is worth this edge.
2. **Protocol tier.** A known settlement decoder recognizes the tx (seeded: UniswapX). Beneficiary comes straight from the protocol event (`Fill.swapper`). Authoritative — handles smart-contract-wallet swappers that the net-flow EOA heuristic would miss.
3. **Net-flow tier.** The proven `findCleanSwapCandidates` + `selectBeneficiary` (already used by `classifyTransaction`), with `DENYLIST`/venue filtering to exclude settlement infra and pools. Covers generic/unseen relayers.
4. **`null`.** No confidently-identified end-beneficiary → no receipt (detected-only path via `classifyTransaction` is unchanged).

## Components

- **`resolveTrader.ts`** (new, `packages/core/src`). The precedence orchestrator. One exported function; returns effective trader + anchor provenance. Depends on `endpoints.ts` (tiers 1 & 3) and `settlementDecoders.ts` (tier 2). Never throws.
- **`settlementDecoders.ts`** (new, `packages/core/src`). A registry of protocol recognizers, **seeded with UniswapX only**. Each entry:
  ```
  { name: string;
    matches(tx, logs): boolean;          // by reactor address + Fill topic0
    beneficiary(tx, logs): string | null // decoded swapper; null if multi-order/ambiguous
  }
  ```
  UniswapX: `matches` = the tx carries a `Fill` log whose **emitter address is a known reactor** (matching on the log emitter, not `tx.to`, so a filler contract that is itself `tx.to` and calls the reactor internally still matches); `beneficiary` = decoded `swapper` from the single `Fill`, or `null` if the tx carries more than one `Fill` (multi-order → out of scope). The reactor address set and the verified `Fill` topic0 are pinned in `configs/reactors.json`. **Reconciled with implementation (2026-07-17):** the `Fill(bytes32,address,address,uint256)` topic0 is **not UniswapX-exclusive** — other protocols emit an identically-signatured event — so an on-chain scan of topic0 emitters yields false positives (the first scan returned 9 emitters; only 2 are genuine Base reactors). The allowlist is therefore **human-curated** against Uniswap's official published deployments (Base: PriorityOrderReactor `0x000000001Ec5656…De729` + DutchV3OrderReactor `0x000000008a8330B5…27ba0`), exactly the "never ingest a page wholesale, per-entry human filter stays" discipline `routers.json` already uses. `refreshReactors.ts` is a candidate **lister** (prints emitters for verification); it never writes the curated config. Adding CoW / 1inch Fusion / 0x gasless later = one registry entry; the orchestrator does not change.
- **`endpoints.ts`** (existing). `findCleanSwapCandidates` / `selectBeneficiary` gain a second consumer (`resolveTrader` tier 3) alongside `classifyTransaction`. No logic change.
- **`analyzeTransaction.ts`** (existing). Swap the one anchor line for a `resolveTrader` call; on `null` return `null` as today; on success write anchor provenance into `normalizeFlags`.
- **`ReceiptView.tsx`** (existing, dashboard). A light provenance line when the receipt is beneficiary-anchored ("executed on your behalf via UniswapX / a solver"). No structural change.

## Data flow & persistence

1. `analyzeTransaction` calls `resolveTrader`.
2. `null` → return `null` (unchanged; paste path shows the `RELAYER_THIRD_PARTY` DiagnosticCard via `classifyTransaction`).
3. Success → `trader` = resolved address; the **entire existing pipeline runs unchanged** (pricing, `decomposeRoute`, decomposition). `decomposeRoute` uses `trader` only to exclude it from settlement-proxy/venue detection, so feeding it the beneficiary is strictly more correct — the relayer/reactor then correctly falls into the settlement-proxy bucket.
4. **Persistence — no migration.** The `trader` column stores the beneficiary (its meaning was already "the party whose trade this is"). Provenance goes into the existing `normalizeFlags` — which is a **`string[]`**, not a free-form object, so provenance is stored as enum-style flag tokens (reconciled with implementation 2026-07-17):
   ```
   'BENEFICIARY_ANCHORED: …'        // always, when re-anchored
   'ANCHOR_VIA_UNISWAPX: …'         // additionally, when the UniswapX decoder fired
   ```
   The solver EOA is not stored (see the Architecture reconciliation note). `router_address` already holds `tx.to` (the reactor/relayer). The dashboard reads these tokens via `beneficiaryAnchorNote(row)` and keeps them out of the warning-flag display (`getFlagLabel`). So the receipt renders provenance from data it already stores.

## Error handling / fail-closed semantics

- `resolveTrader` **never throws**. An RPC failure inside a tier yields nothing from that tier; fall through.
- **Tier 3 fails closed:** sole-EOA → sole-candidate → else `null`. An AA-wallet beneficiary alongside a contract intermediary (two clean-swap contracts, no sole EOA, two candidates) → `null` → no receipt (DiagnosticCard instead). Correct, not a gap: better no receipt than a wrong-party receipt.
- **Tier 2 multi-order:** a `Fill` batch with more than one `swapper` → `beneficiary` returns `null` → falls through to `null` (detected-only). Single-fill is the supported shape this pass.
- **Consistency:** the detector (`classifyTransaction`) and tier 3 share `selectBeneficiary`, so the DiagnosticCard's "who" and a would-be receipt's "who" cannot disagree.

## Testing

- **Unit (pure, no RPC):**
  - `resolveTrader` precedence: self short-circuits; UniswapX `Fill` fixture → swapper; net-flow sole-EOA; ambiguous two-contract → `null`; multi-`Fill` batch → `null`.
  - UniswapX decoder against a captured `Fill` log fixture (single and multi-order).
- **Fail-closed regression pin:** the intermediary-contract + beneficiary-EOA shape (`0xbee3211a…` + `0xf70da978…`) resolves to the **EOA**, never the intermediary — guards the id-119 bug class.
- **No-regression pin:** a normal user swap anchors `self` and produces a byte-identical receipt.
- **e2e (RPC, gated on `TCA_RPC_URL`; source with `set -a && source .env && set +a`):**
  - Relay id57 `0xd6bb5ae0…` now produces a receipt anchored on `0xf70da978…` (USDC→native-ETH).
  - A real UniswapX Base fill produces a swapper-anchored receipt.
  - Assert the tests actually **ran** ("2 passed") — never trust a silent skip (aggregator-detection lesson: RPC e2e skips silently without the env var).

## Out-of-scope / follow-ups

- Multi-beneficiary batch decoding (CoW, multi-fill UniswapX) — needs batch UI + receipts keyed by beneficiary.
- RFQ-benchmark pricing for private-inventory legs — entangled with the planned pricing overhaul; deferred deliberately.
- Additional protocol decoders (CoW `Trade`, 1inch Fusion, 0x gasless) — one registry entry each when wanted.

### Limitations (deliberate)

- **Filler-nets-clean edge.** Because tier 1 (self) precedes tier 2 (protocol), a UniswapX filler that itself nets a clean 1-in/1-out swap anchors on the filler, not the `swapper`. Chosen consciously to preserve the additive/no-regression invariant. Revisit only if a real corpus tx surfaces it; the fix would be a narrow "protocol beats self when tx.from is a known reactor/filler" carve-out, which must be weighed against the invariant.
