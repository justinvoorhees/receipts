# Spec

Transcribed from `Fabric_TCA_MVP_Spec.docx` (June 2026). The deviations
section below records the intentional differences between this transcript
and the as-built code.

## Deviations from the spec (intentional)

| Spec choice | This project | Why |
|---|---|---|
| SQLite (MVP), Postgres (v2) | **Postgres from day one** | Dashboard is a near-term deliverable; Postgres avoids the migration tax. |
| Python 3.11+ | **TypeScript** | Single language end-to-end avoids schema drift between ingest and dashboard. `debug_traceTransaction` works fine via viem's raw `request()`. |
| No dashboard in MVP. Files only. | **Dashboard shipped** | The receipt is the product: paste a tx hash, get its decomposition. A 2×2 trust matrix was scaffolded early and removed in the 2026-07-07 reset — the tool rates trades, not aggregators. |

## Open items

_None._ Both items originally recorded here were superseded rather than completed:

- ~~Populate a fee-recipient registry per aggregator in `configs/routers.json`~~ — **superseded 2026-07-24.** Fee sinks are detected from the trace (addresses that retain value) instead of curated ahead of time. `buildFeeSinks` splits `aggFeeBps` across the detected sinks proportionally to retained value, and each sink renders as its own line labelled with its verified contract name (Etherscan `getsourcecode`), falling back to a truncated address. `aggFeeBps` no longer reads 0. The spec's §3 `fee_recipients` array (transcribed below) was never populated and was removed from `routers.json` and from `RouterEntry` on 2026-07-28; a `_removed_fee_recipients` note in the config records why, so it doesn't get re-added from the schema below.
- ~~Dashboard column lineup + size/time cross-cuts~~ — **superseded by the 2026-07-07 reset.** The size/time cross-cuts belonged to the funnel / trust-matrix framing that the reset removed. The dashboard is two tabs: Receipts (paste a hash) and History (persisted receipts, sortable).

Router coverage has grown past the original list: `configs/routers.json` now holds 15 entries across Odos, 0x, KyberSwap, 1inch, Velora, Fabric, Nordstern, Relay, OpenOcean, and OKX, all verified as deployed contracts on Base via `eth_getCode`. `detection: 'to_address'` is correct for all of them; aggregators that rotate their settlement addresses (0x's Settlers) are resolved separately through `configs/settlers.json`.

---

# Fabric TCA Engine — MVP Specification

*For handoff to Claude Code · June 2026*

## 1. Objective

Build a pipeline that discovers large USDC/WETH swaps on Base routed through known aggregators, decodes their on-chain execution, fetches pre-trade reference prices, and produces a per-trade TCA ledger. Every trade is decomposed into five cost components normalized to basis points (bps):

| Component | Short Name | Derivation Source |
|---|---|---|
| Aggregator fee | `agg_fee_bps` | Transfer events to known fee recipients |
| LP fees | `lp_fee_bps` | Pool fee tier × amountIn, per hop |
| Price impact + slippage (combined) | `execution_quality_bps` | Reference price vs executed price, minus known fees |
| Gas cost (USD and bps) | `gas_cost_bps` | `gasUsed × effectiveGasPrice`, normalized via ETH/USD |
| Total transaction cost | `total_cost_bps` | Sum of all above; or `(ref - executed) / ref * 10000` |

**Note:** Price impact and slippage are reported as a combined residual (`execution_quality_bps`) in the MVP. Separating them cleanly requires storing the aggregator quote at execution time, which is deferred to v2.

## 2. Scope Constraints (MVP)

| Dimension | Constraint |
|---|---|
| Chain | Base mainnet only |
| Pair | USDC/WETH exclusively (both buy and sell directions) |
| Token addresses | USDC: `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` · WETH: `0x4200000000000000000000000000000000000006` |
| Primary pool | Uniswap V3 USDC/WETH 0.05% on Base |
| Secondary pool | Uniswap V3 USDC/WETH 0.3% on Base (lower liquidity, include) |
| Trade source | Aggregator-routed only (see router registry below) |
| Size filter | P99 of observed swap notional, rolling 30-day window |
| P99 cold-start floor | $500,000 USD notional (override until 30 days of data accumulate) |
| Analysis mode | Post-hoc only. No live quoting, no simulation, no trades executed. |
| Multi-hop routes | Out of scope for MVP. Single-hop USDC ↔ WETH only. |

## 3. Aggregator Router Registry

The router registry is the source of truth for trade discovery and aggregator attribution. Only transactions whose `to` address matches a registered router are ingested. The registry must be maintained as a versioned config file, not hardcoded, because routers are upgraded over time.

### 3.1 Confirmed Routers (Base Mainnet)

| Aggregator | Contract Label | Address | Notes |
|---|---|---|---|
| Odos | OdosRouter V2 | `0x19cEeAd7105607Cd444F5ad10dd51356436095a1` | Confirmed on Basescan. Primary Base aggregator by volume. |
| 0x / Matcha | 0x Exchange Proxy | `0xdef1c0ded9bec7f1a1670819833240f027b25eff` | Canonical 0x proxy, same across most EVM chains. Verify on Basescan before deploy. |
| KyberSwap | MetaAggregation Router V2 | `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5` | Confirmed KyberSwap aggregation router on Base. |
| 1inch | Aggregation Router V5 | `0x1111111254eeb25477b68fb85ed929f73a960582` | V5 confirmed on Basescan. Also check V6: `0x111111125421ca6dc452d289314280a0f8842a65` |
| Velora (ex-Paraswap) | Augustus V6.2 | `0x6a000f20005980200259b80c5102003040001068` | Confirmed on Basescan. Velora rebranded from ParaSwap in April 2025. |
| Velora (ex-Paraswap) | Augustus V5 (legacy) | `0x59C7C832e96D2568bea6db468C1aAdcbbDa08A52` | Older router still active. Include for historical coverage. |
| Fabric | Fabric Router | `0x7c137a37742437d2212b7bd873ed135b5c4c61da` | Confirmed. Provided by operator. |
| Nordstern | Nordstern Router | `0xC87De04e2EC1F4282dFF2933A2D58199f688fC3d` | Confirmed. Provided by operator. |
| Relay | Relay Router | `0xccc88a9d1b4ed6b0eaba998850414b24f1c315be` | Confirmed. Provided by operator. Note: verify whether this is a contract or solver EOA on Basescan; detection strategy may differ (see §3.2). |

### 3.2 Settlement Architecture Note (Fabric, Nordstern, Relay)

All three addresses above were provided by the operator and should be verified on Basescan before deployment. Specifically, confirm whether each address is a deployed contract or a solver/relayer EOA, as this determines the detection strategy:

- **Contract router:** match on the transaction `to` address. Standard approach used for Odos, 0x, KyberSwap, 1inch, Velora.
- **Solver EOA:** the `to` address will vary per transaction. Detection requires matching on emitted event signatures from settlement contracts, or on token flow patterns combined with a known integrator/referrer field in the trade event.

If any of the three prove to be solver EOAs rather than fixed contract routers, flag them in the router config with `detection: 'solver_eoa'` and implement the appropriate detection path before including them in ingestion.

### 3.3 Router Config File Structure

Implement as a JSON config file loaded at runtime, not hardcoded in source:

```json
{
  "routers": [
    {
      "name": "Odos",
      "address": "0x19cEeAd7105607Cd444F5ad10dd51356436095a1",
      "version": "V2",
      "fee_recipients": [],
      "detection": "to_address",
      "active": true
    }
  ]
}
```

## 4. Reference Price

The reference price is the theoretical zero-cost execution price: what the trade would have received with no fees, no price impact, and no slippage. For USDC/WETH, this is the Uniswap V3 pool's marginal spot price at block N-1 (the block immediately before the trade settled).

### 4.1 Method

- Call `slot0()` on the canonical Uniswap V3 USDC/WETH 0.05% pool at `block_number - 1`
- Extract `sqrtPriceX96` from the returned tuple
- Compute spot price: `price = (sqrtPriceX96 / 2^96)^2 * (10^6 / 10^18)` (USDC per WETH, accounting for decimal difference)
- This is the pre-trade marginal price. It represents the best possible execution with zero market impact.

### 4.2 Uniswap V3 Pool Addresses on Base

| Fee Tier | Pool Address | Use |
|---|---|---|
| 0.05% (500) | `0xd0b53D9277642d899DF5C87A3966A349A798F224` | Primary reference. Deepest USDC/WETH liquidity on Base. |
| 0.3% (3000) | Verify on Basescan before deploy | Secondary. Use `slot0` of whichever pool the trade actually routed through. |

**Note:** Always use block N-1, not block N. At block N the pool state already reflects the trade's price impact. Block N-1 is the clean pre-trade snapshot.

## 5. TCA Ledger Computation

Per trade, compute all components in USD and bps. `bps = component_usd / notional_usd * 10000`.

### 5.1 Notional

```
notional_usd = amount_in_usdc                        # if selling USDC
notional_usd = amount_in_weth * reference_price      # if selling WETH
```

### 5.2 Total Cost

```
executed_price = amount_out / amount_in              # decimal-adjusted
total_cost_bps = (reference_price - executed_price) / reference_price * 10000
```

**Note:** Negative `total_cost_bps` means execution was BETTER than the reference price (surplus returned to user). This is valid and should be preserved as a signed value, not clamped to zero.

### 5.3 Gas Cost

```
gas_cost_eth   = gas_used * effective_gas_price / 1e18
eth_price_usd  = slot0_price at block N (same block, contemporaneous)
gas_cost_usd   = gas_cost_eth * eth_price_usd
gas_cost_bps   = gas_cost_usd / notional_usd * 10000
```

### 5.4 LP Fees

```
lp_fee_bps     = pool_fee_tier / 1e4                 # 500 -> 5 bps, 3000 -> 30 bps
```

**Note:** LP fee is deterministic from the pool's `fee()` function. Call once at startup per pool and cache. For the 0.05% pool this is always exactly 5 bps.

### 5.5 Third-Party Fee

```
agg_fee_usd    = sum of value RETAINED by non-infra addresses (excl. counterparties)
agg_fee_bps    = agg_fee_usd / notional_usd * 10000
```

⚠️ **The per-aggregator fee-recipient registry described below was never built.**
`configs/routers.json` records that its `fee_recipients` array "was never populated
and was REMOVED 2026-07-28". What ships instead is `computeAggFee`
(`packages/core/src/tradeFees.ts`): any address that ends the transaction holding a
small amount of USDC/WETH — above a dust floor, below `COUNTERPARTY_THRESHOLD` —
becomes a fee sink. Nothing verifies the sink belongs to the aggregator.

A 2026-07-31 corpus sweep found 15 of 28 receipts whose entire "Aggregator Fee" was
demonstrably not an aggregator's: integrator wallets, RFQ maker spread, an Aerodrome
`PoolFees` accumulator, and a token launchpad's creator fee. The row was therefore
renamed **Third-Party Fee**, and the UI no longer names a collector it cannot verify
— see the anti-re-add note on `getAggregatorFeeLines`. Do not restore an
"[Aggregator] Fee" label without first populating a verified recipient registry.

Original design, retained for context: fee recipient addresses maintained per
aggregator in the router config; if no known fee recipient transfer is detected,
`agg_fee_bps = 0` (aggregator may capture fee as positive slippage — indistinguishable
without the original quote).

### 5.6 Execution Quality (Price Impact + Slippage, Combined)

```
execution_quality_bps = total_cost_bps - lp_fee_bps - agg_fee_bps - gas_cost_bps
```

**Note:** This residual captures both price impact and any slippage vs the aggregator's quote. The two cannot be cleanly separated without storing the original quote. Label this field `execution_quality_bps` in the schema to avoid implying false precision.

## 6. Transaction Decoding

### 6.1 Data Sources Per Transaction

| RPC Call | Returns | Used For |
|---|---|---|
| `eth_getLogs` (Swap event) | Raw log: `amount0`, `amount1`, `sqrtPriceX96` | Trade discovery, amountIn/Out |
| `eth_getTransactionReceipt` | `gasUsed`, `effectiveGasPrice`, logs array | Gas cost, Transfer events |
| `eth_getTransaction` | `to` (router), `input` (calldata) | Aggregator identification, quoted amount if decodable |
| `eth_call slot0()` at block N-1 | `sqrtPriceX96`, tick, … | Reference price |
| `debug_traceTransaction` (callTracer) | Full call tree + logs | Fee recipient detection, hop analysis |

### 6.2 `debug_traceTransaction` Parameters

```json
{
  "tracer": "callTracer",
  "tracerConfig": {
    "withLog": true,
    "onlyTopCall": false
  }
}
```

Parse the call tree for: (1) all Transfer events on USDC and WETH token contracts, (2) recipient addresses of each transfer classified as user / pool / aggregator fee wallet / other, (3) pool contracts called (match against known factory registries to confirm they are legitimate Uniswap V3 pools).

### 6.3 Archive Node Requirement

`debug_traceTransaction` and `eth_call` at historical block heights both require an archive node. Public RPCs do not support this. We run QuickNode on Base with an archive-enabled endpoint plus the paid Trace Mode add-on (the trace methods are gated behind it and off by default); Alchemy's archive plan is an equivalent fallback. Budget ~2-3 compute units per trade for the trace call.

## 7. Data Storage Schema

```sql
CREATE TABLE swaps (
  tx_hash               TEXT PRIMARY KEY,
  block_number          INTEGER NOT NULL,
  block_timestamp       INTEGER NOT NULL,
  aggregator            TEXT,           -- from router registry
  direction             TEXT,           -- 'buy_weth' | 'sell_weth'
  amount_in_raw         TEXT,           -- wei-level, stored as string
  amount_out_raw        TEXT,
  notional_usd          REAL,
  reference_price       REAL,           -- USDC per WETH, slot0 at N-1
  executed_price        REAL,           -- amount_out / amount_in, decimal-adj
  total_cost_bps        REAL,           -- signed
  lp_fee_bps            REAL,
  agg_fee_bps           REAL,
  gas_cost_usd          REAL,
  gas_cost_bps          REAL,
  execution_quality_bps REAL,           -- residual: impact + slippage
  gas_used              INTEGER,
  effective_gas_price   TEXT,
  pool_fee_tier         INTEGER,        -- 500 | 3000
  raw_trace             TEXT,           -- JSON blob
  processing_status     TEXT            -- 'pending'|'complete'|'failed'|'skipped'
);

CREATE TABLE p99_thresholds (
  computed_at     INTEGER PRIMARY KEY,  -- unix timestamp
  threshold_usd   REAL,
  sample_count    INTEGER,
  window_days     INTEGER DEFAULT 30
);
```

## 8. P99 Size Filter

- On startup: if fewer than 30 days of data exist, apply the $500,000 USD cold-start floor.
- Once 30 days accumulate: compute P99 of `notional_usd` from the staging table; store result in `p99_thresholds`.
- Refresh weekly (every 7 days). The threshold applies prospectively; do not retroactively re-filter historical data.
- Staging table: store all discovered swaps regardless of size. Only promote to the main `swaps` table if `notional_usd >= current threshold`. This allows threshold recomputation without re-scanning.

## 9. System Architecture

### 9.1 Component Overview

| Component | Responsibility |
|---|---|
| Ingestion Poller | Poll `eth_getLogs` every 2s for Swap events on USDC/WETH pools. Filter to known router addresses. Write to staging table. |
| P99 Filter | Evaluate notional against current threshold. Promote qualifying trades to main swaps table. |
| Reference Price Fetcher | For each qualifying tx: `eth_call slot0()` at block N-1. Write `reference_price`. |
| Transaction Decoder | `eth_getTransactionReceipt` + `eth_getTransaction` + `debug_traceTransaction`. Extract all TCA inputs. |
| TCA Calculator | Compute all ledger components. Write complete row to swaps table. Set `status = 'complete'`. |
| P99 Scheduler | Weekly cron: recompute threshold from staging table. Update `p99_thresholds`. |
| Output Writer | On demand: export swaps table to JSON/CSV. No dashboard in MVP. |

### 9.2 Processing Pipeline (Per Trade)

1. Swap event detected via `eth_getLogs` poll.
2. Check `to` address against router registry. If no match: discard.
3. Compute notional. Check against P99 threshold. If below: write to staging only.
4. Fetch `slot0()` at block N-1 for reference price.
5. Fetch receipt + transaction data.
6. Run `debug_traceTransaction`. Parse call tree.
7. Compute TCA ledger. Write complete row. `Status = 'complete'`.

### 9.3 Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | Python 3.11+ | Better for numeric/data work; cleaner for RPC client libraries |
| RPC client | web3.py | Archive node support, `eth_call` at block height, debug namespace |
| RPC provider | QuickNode (Base) archive plan + Trace Mode | `debug_traceTransaction` requires archive, and on QuickNode the paid Trace Mode add-on. Alchemy's archive plan is an equivalent fallback. Superseded Alchemy 2026-08-03. |
| Database | SQLite (MVP), Postgres (v2) | Zero-ops for POC. Migrate when concurrent writes or dashboard queries are needed. |
| Scheduler | APScheduler or simple `threading.Timer` | No external queue needed at MVP throughput. |
| Config | `.env` + JSON router registry | RPC URL, poll interval, router registry path, P99 floor, DB path |
| Output | JSON per trade + summary CSV export | No dashboard in MVP. Files only. |

## 10. Key Implementation Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Fabric / Nordstern / Relay: contract vs solver EOA | Medium | Addresses are confirmed by operator. Before starting ingestion, verify each on Basescan to confirm whether it is a deployed contract (`to` address matching works) or a solver EOA (requires event-based detection). Update the router config `detection` field accordingly. |
| `debug_traceTransaction` rate limits | Medium | At P99 volume on Base, expect tens of qualifying trades per day, not thousands. Monitor RPC compute unit usage. Add per-call delay if needed. |
| Aggregator fee obfuscation via positive slippage capture | Medium | If the aggregator captures fees as positive slippage rather than explicit transfer, `agg_fee_bps = 0` and the fee appears in `execution_quality_bps`. This is a known MVP limitation; document it per aggregator. **Observed 2026-07-28, and the failure mode is the opposite of the one predicted here:** `buildFeeSinks` (added 2026-07-24) detects retained value, so surplus capture does *not* vanish into `execution_quality_bps` — it is counted, but booked as an aggregator **fee**. Confirmed on receipt id 326, where a payout adapter delivered the caller-specified amount and kept the 1.19 bps overage. So the open gap is now mislabelling, not undercounting. Full write-up: `docs/positive-slippage-capture.md`. |
| Multi-hop routes mis-attributed to single-hop | Low (MVP) | Scope excludes multi-hop. If a qualifying USDC/WETH trade routes through an intermediate token, the hop detection will fail. Log these as `'skipped'` with reason. |
| P99 cold-start period | Low | Cold-start floor of $500k USD is manually set. Document the date it was set and when it was replaced by computed P99. |
| Pool address staleness | Low | Uniswap V3 pool addresses are immutable once deployed. Verify once at setup; no ongoing risk. |

## 11. Suggested Build Order

1. Verify Fabric, Nordstern, and Relay addresses on Basescan. Confirm contract vs solver EOA. Set `detection` field in router config.
2. Ingestion poller: `eth_getLogs` for Swap events on USDC/WETH pools. Persist raw log to staging table. No filter yet.
3. Router matching: filter staging table by `to` address against router registry.
4. Reference price fetch: `slot0()` at block N-1. Verify math against known trades.
5. Basic TCA: `total_cost_bps` only (reference vs executed price). Independently testable.
6. Gas cost component: from receipt data only. No trace required.
7. LP fee component: deterministic from pool fee tier. Verify against `pool.fee()`.
8. `debug_traceTransaction` integration: parse call tree, detect fee recipient transfers.
9. Aggregator fee detection: match Transfer recipients against known fee wallet registry.
10. P99 filter: threshold logic, staging promotion, cold-start floor.
11. Output: JSON per trade + CSV export. End of MVP.

## 12. Out of Scope (MVP)

- Multi-hop routes
- Non-USDC/WETH pairs
- Quote capture / live slippage measurement (separates price impact from slippage)
- MEV / sandwich detection
- Dashboard or visualization
- Multi-chain support
- Counterfactual simulation (what would aggregator B have returned on aggregator A's trade)
- Real-time alerting

---

> Verify all router addresses on Basescan before production deployment. Confirm contract vs solver EOA for Fabric, Nordstern, and Relay. Wrong detection strategy silently excludes trades.
