# Receipts Tool — Salvage-and-Reset Design

**Date:** 2026-07-07
**Status:** Approved (design), pending implementation plan
**Supersedes the product surface of:** the batch analytics pipeline (v1 pool-centric → v2.2 smoke). The decomposition core and receipt UI are salvaged; everything else is retired.

## 1. Context & motivation

The product scope has narrowed sharply based on new feedback. We are moving from a **batch analytics pipeline** (discover → sample → gate → decompose → load thousands of trades → rate aggregators) to an **on-demand single-transaction tool**:

> Paste any transaction hash → get an itemized cost receipt. Save receipts to a History tab for later review and deletion.

This reframing — from "process a corpus" to "analyze one transaction on request" — is the reason for a reset rather than an in-place refactor. The current tree carries five layers of superseded pivots (~16k LOC in `ingest`, ~30 one-off scripts, whole dead pipelines). A hygiene pass would mean deleting ~80% of a tree while inheriting its batch mental model. Instead we stand up a small, intentional structure and deliberately port in the validated crown jewels.

## 2. Goals

- Two tabs only: **Receipts** (paste any hash → computed receipt) and **History** (review/delete saved receipts).
- **Cost only.** Decompose a transaction into Execution Quality → {LP Fee, Agg Fee, Price Impact, Slippage}, rendered as an itemized receipt. (Quality is explicitly deferred — a much more data-intensive problem.)
- **Any token pair**, not just USDC/WETH.
- On-demand: computing a receipt happens synchronously in response to a paste; no batch process, no corpus.
- Preserve the validated decomposition math, the manual pool/fee-sink/vendor tagging, and the existing receipt UI.

## 3. Non-goals (explicitly retired)

- The Trust Matrix and any cross-aggregator performance rating. **Dead.**
- Mass ingestion of transactions into a database (discovery funnel, sampling, gates, backfills, pollers).
- Automated vendor / pool / fee-sink attribution — attribution stays **manual** (curated registries).
- Quality analysis (deferred to a later, separate effort).
- Auth / login — single user for now. `user_id` is designed into the schema but unused.

## 4. Architecture — the reset

```
packages/
  db/          Drizzle + Postgres. Schema reduced to a single `receipts` table
               (plus a future `users` table). All pipeline tables dropped.
  core/        (renamed from `ingest`) The decomposition LIBRARY. No batch
               scripts, no long-running process. Single public entry point:
                 analyzeTransaction(hash, chainId) => Receipt
  dashboard/   Next.js. Two tabs (Receipts, History) + one API route:
                 POST /api/receipts  (paste hash → compute → persist → return)
```

**Why Postgres (not SQLite):** the product will eventually serve many users, each with their own receipts. Multi-user + per-user rows + hosted-with-auth is the conventional Postgres sweet spot, and Postgres + Drizzle is *already wired*. Keeping it is less work than switching and avoids a migration when auth lands. This does not violate the "no mass ingestion into a DB" rule — a per-user receipts store is legitimate user data, not a data lake.

**Why `core` is a library, not a service:** on-demand analysis runs inside a Next.js route handler. There is no standalone ingest process anymore. Collapsing `ingest` from a batch service into an imported library is what deletes the batch mental model and shrinks the tree back to something that fits in your head.

### 4.1 Ported into `core` (the crown jewels, with their tests)

- **Trace fetch:** `decoder.ts` (`debug_traceTransaction`) + net-delta endpoint anchoring (`tradeEndpoints.ts`).
- **Decomposition:** `routeGraph.ts`, `legFees.ts`, `decomposeRoute.ts`, `priceMath.ts`, `decompose-trade.ts`.
- **Pricing (generalized per §5):** `tokenPricing.ts`, `benchmarkPrice.ts`, `poolDiscovery.ts`, `referencePrice.ts`, oracles (`duneOracle.ts` and Chainlink logic).
- **Tagging:** `routerRegistry.ts`, `aggregatorSignatures.ts`, and the pool-identity / fee-sink naming currently living inside `selectionGate.ts` (extracted into a tagging module; the *gating* half is discarded).

### 4.2 Left behind (deleted)

- The entire funnel: `discover-router-trades`, `extract-router-trades`, `load-router-trades`, `reextract-gated`, `decompose-gated`, all `backfill-*`, the gating half of `selectionGate`, the `$1k floor` / `±100 bps gate` / sampling logic (obsolete once each hash is hand-picked).
- v1 pool-centric pipeline: `poller`, `promoter`, `quoter`, `tcaCalculator`, `processSwap`.
- Smoke-set machinery, the funnel/smoke dataset toggle (`lib/datasets.ts`, `DatasetToggle`), v1 provenance fields.
- All ~30 one-off scripts: `inspect-*`, `investigate-*`, `patch-*`, `fix-*`, `diagnose-*`, `spotcheck-*`, `survey-*`, `check-*`, `list-*`, `sample-*`, `orient-*`, `revalue-*`, `prove-*`, etc.
- Dashboard: `TrustMatrix`, `AggregatorSummaryTable`, `IngestStatus`, the hidden Dashboard tab.

## 5. Any-token pricing (best-effort with graceful degradation)

Three of the four line items generalize cleanly to arbitrary pairs:

- **LP Fee** — from the pool fee tier on each leg (pool identity is tagged/manual). Works for any pair.
- **Agg Fee** — net token deltas across all tokens. Works for any pair.
- **Price Impact + Slippage** — need a **reference mid for the actual traded pair at block N-1**, plus USD valuation for the receipt. This is the only WETH/USD-specific machinery today.

**Policy (Option 1):** for the traded pair, use the deepest on-chain pool we can find as the reference mid; value the receipt in USD when at least one leg touches an anchorable token (stablecoin or WETH). If we cannot obtain a reliable mid or USD anchor, still produce a receipt showing **LP Fee + Agg Fee**, and mark **Price Impact / Slippage as unavailable for this pair** rather than guessing. No transaction is rejected for being an exotic pair; some simply produce a *partial* receipt.

Each receipt carries `pricing_status: 'full' | 'partial'`. Partial = LP + Agg only.

## 6. Data model — `receipts` table

The row mirrors the existing `smoke_trades` / `TradeRow` decomposition shape (so `ReceiptView` and the dialog render with minimal change) with three deltas: (a) generalized token identity instead of hardcoded USDC/WETH fields, (b) `created_at` + `user_id`, (c) v1 provenance and batch/dataset fields dropped.

**Kept (decomposition + benchmark validation, unchanged semantics):**
`aggregator`, `trader`, `direction`, `realized_price`, `market_mid`, `all_in_cost_bps`, `block_number`, `execution_bps`, `lp_fee_bps`, `agg_fee_bps`, `slippage_bps`, `gas_cost_usd`, `route_pure`, `route_shape`, `hop_count`, `route_legs` (jsonb), `recon_residual_bps`, `decomp_confidence`, `settlement_event_name`, `settlement_event_topic0`, `settlement_event_seen`, `normalize_flags`, and the benchmark-validation columns (`chainlink_price`, `chainlink_dev_bps`, `pool_divergence_bps`, `manipulation_flag`, `offchain_price`, `offchain_dev_bps`, `chainlink_staleness_secs`).

**Generalized (replacing USDC/WETH-specific fields):**
`input_token` / `output_token` (addresses), `input_symbol` / `output_symbol`, `input_amount` / `output_amount`, `notional_usd`. (The old `usdc_amount` / `weth_amount` / `settled_in` are subsumed by these.)

**New:**
`id` (surrogate PK), `tx_hash` (the pasted transaction, no longer the PK), `user_id` (nullable, unused for now), `chain_id`, `pricing_status` (`'full' | 'partial'`), `created_at` (timestamptz, default now).
Uniqueness: `unique(user_id, tx_hash, chain_id)` — a receipt is per-user-per-transaction, ready for multi-user without reshaping.

**Dropped:** `experiment_slug`, `run_id`, `v1_status`, `v1_quote_amount_usd`, `v1_realized_amount_usd`, `batch`.

We store the **computed** receipt denormalized. We do not recompute on view.

## 7. Flows

### 7.1 Receipts tab
- Reuses `ReceiptSearch` (paste / Enter / "Create Receipt" button) and `ReceiptView`.
- On submit: `POST /api/receipts { hash, chainId }`. The route handler:
  1. If a receipt for `(user_id, hash, chainId)` already exists, return it (no recompute — cheap and deterministic for MVP).
  2. Otherwise call `core.analyzeTransaction(hash, chainId)`, persist the result, return it.
- **Key behavioral change vs. today:** the current `/receipts` page only does `getTradeByHash` over the 25 curated rows — it computes nothing and silently fails for any hash not already in the DB. The new page *computes on demand*, and a newly computed receipt is saved, so it appears in History.
- `ReceiptView` must be generalized from hardcoded USDC/WETH display to arbitrary input/output token symbols/amounts (modest, real work — the 25 USDC/WETH seed rows render either way).

### 7.2 History tab
- Reuses today's `/trades` page, `TradesTable`, and the row-click → `TransactionDetailsDialog` receipt dialog **as-is** — this is the primary interaction and is preserved.
- Data source changes from the curated smoke query to `SELECT * FROM receipts ORDER BY created_at DESC`.
- **New feature: delete.** A delete affordance on each row (and/or in the dialog) removes the receipt. This is the only genuinely new History capability.
- Remove smoke/trust-matrix vestiges: the `DatasetToggle`, the "N trades / populates from smoke_trades" empty-state copy (replace with a receipts-appropriate empty state), and any aggregator-summary links.

### 7.3 Error states
- One state for now, reusing the existing `error` prop on `ReceiptSearch` (red border + message): **"Transaction not found."** Used when analysis cannot produce a receipt (hash not found / undecodable / not a swap / RPC failure all collapse to this single message for MVP). Nothing is persisted on a failed analysis.

## 8. Seed data — the 25 receipts

The 25 curated smoke trades become **seed rows in `receipts`** (your 25 past receipts), reshaped into the new schema on migration — same data, new home, no dataset toggle. After seeding, the old `smoke_trades` / `router_trades*` / `swaps` / `*_backup` / `poll_state` / `ingest_heartbeats` tables are dropped. Because the seed rows are USDC/WETH, they populate History and render in the dialog immediately, giving the UI real content on day one.

## 9. Risks & open questions

1. **Any-token reference mid reliability.** Finding the deepest reference pool for an arbitrary pair, and USD-anchoring it, is the main new technical risk. Mitigated by the graceful-degradation policy (partial receipts) — but the "how do we pick / trust the reference pool for a long-tail pair" logic is where implementation effort concentrates.
2. **`ReceiptView` generalization.** Current view assumes USDC/WETH. Generalizing token display is modest but must be done before non-WETH pairs render correctly.
3. **`analyzeTransaction` latency.** A synchronous trace + multi-pool reads + oracle calls per paste. For a single user this is fine; worth confirming the p50 is a few seconds, not tens.
4. **Manual tagging coverage.** Arbitrary hashes will hit routers/pools/fee-sinks not yet in the registries; those surface as untagged (addresses shown raw) rather than failing. Acceptable — attribution is explicitly manual.
5. **Multi-user readiness is schema-only.** `user_id` exists but no auth wires it; when auth lands, queries must filter by it. Called out so it isn't forgotten.

## 10. Out of scope for this reset

Auth/login, Quality analysis, automated attribution, any batch/corpus tooling, cross-aggregator rating, and multi-chain beyond passing `chainId` through (Base remains the tested chain).
