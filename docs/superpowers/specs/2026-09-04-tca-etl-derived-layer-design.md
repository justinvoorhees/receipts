# TCA ETL Pipeline v0.2 — Derived layer

**Status:** DESIGN — 2026-09-04. No code written. Every measurement below was
taken on 2026-09-04 against the committed pilot Seed file
(`data/seeds/traces.base.0050842630-0050842929.parquet`, 155,732 rows, 300
blocks) or against Base mainnet via QuickNode. Numbers taken from one seed file
and one profiled transaction; re-measure before relying on any of them.

**Goal:** turn the Seed archive into a research dataset that can be queried
ad-hoc in SQL. No UI, no API, no persistence beyond Parquet on disk.

**Predecessor:** `2026-09-03-tca-etl-seed-schema-design.md` (the Seed layer).
That spec's §10 named "flattened call frames addressed by `trace_address`" as
the first Derived file. **This spec supersedes that**, deliberately rather than
by drift: the grain that serves ad-hoc research is the trade and the leg, not
the call frame.

---

## 1. Architecture

```
data/seeds/traces.base.<range>.parquet          (immutable, exists)
        |
        +-- zero RPC --> candidates.base.<range>.parquet    one row per candidate swap tx
        |
        +-- zero RPC --> pool_state.base.<range>.parquet     one row per (pool, block, log_index)
        |                (Tier 3 -- v0.3, see section 8)
        |
        +-- RPC -------> receipts.base.<range>.parquet       one row per enriched tx
                     +-> legs.base.<range>.parquet           one row per leg, joins on tx_hash

data/cache/{pools,tokens,v4_poolkeys}.base.parquet          immutable chain facts
```

The Seed spec's invariant still governs: a Seed file contains only what the
chain said, and everything requiring a judgment call lives here. Derived files
are free to be wrong because they rebuild from Seeds. They are **not** free to
be *silently* wrong, which is what section 9 is about.

### Layout

```
data/derived/<build>/candidates.base.0050842630-0050842929.parquet
data/derived/<build>/receipts.base.0050842630-0050842929.parquet
data/derived/<build>/legs.base.0050842630-0050842929.parquet
data/cache/pools.base.parquet
```

Family first, then chain, then zero-padded block range — matching
`traces.base.<range>.parquet` so a glob still returns files in block order.
**The Seed spec's section 5 rationale is load-bearing and must not be broken:**
lexical sort equals block order. Nothing varying may precede the family name.

`<build>` is a directory tag (a date-suffix like `2026-09-04a`, or a short git
sha). A bad build is discarded with `rm -rf` on one directory. Build identity
is *also* carried inside every row (`derived_at`, `core_git_sha`,
`derived_schema_version`, `seed_file`) so provenance is queryable rather than
parsed out of a filename.

**Caches live outside `<build>`.** They hold facts about the chain, not about a
build, and their entire value is surviving rebuilds. A cache entry is only ever
added, never invalidated (section 6).

Derived Parquet is gitignored, like the Seeds.

---

## 2. Measurements this design rests on

### The candidate population (pilot Seed file, 300 blocks)

| Filter | txs |
|---|---|
| all Seed rows | 155,732 |
| `tx_to` in active `routers.json` | 665 |
| ...of those, emitting >= 1 Swap log | **535** |
| ...of those, emitting none | 130 |
| any tx emitting a v2/v3/v4 Swap log | **13,511** |

Router-address selection captures **4%** of the window's swap activity. The
registry is also incomplete for this purpose, because it was curated for
aggregator *identity*, not population selection: Uniswap's UniversalRouter
(`0x2626664c2603336e57b271c5c0b26f421741e481`, 391 swap txs, the largest named
router in the window) is absent from it, while Odos, 0x, OKX and fly.trade have
zero transactions in this window.

Router breakdown of the 665: Relay 266, Uniswap V2Router02 201, KyberSwap 108,
1inch V6 42, LI.FI 25, Velora V6.2 11, Velora V5 4, Nordstern v1 4, OpenOcean 4.

### Leg and pool structure

| Quantity | whole window | router subset |
|---|---|---|
| swap legs | 20,560 | 816 |
| distinct non-v4 pool addresses | 1,385 | 240 |
| distinct v4 poolIds | 485 | 73 |
| **distinct pools (correct identity)** | **1,870** | 313 |
| **distinct (pool, block) pairs** | **11,494** | -- |

Composition of the 20,560 legs: 13,738 v3/CL, 5,700 v4, 1,122 v2.

> WARNING: a v4 pool's identity is its `poolId` (`topics[1]`), **not** the log's
> emitter. Every v4 leg in the window is emitted by one of just two singletons
> (`0x498581ff718922c3f8e6a244956af099b2652b2b`, the Uniswap V4 PoolManager, and
> `0x60b393a76cea4a3afff00e1fb08d0f63a8f4a314`). Counting `DISTINCT emitter`
> therefore collapses all 485 v4 pools onto two rows and understates both the
> pool count and the (pool, block) count. Every figure in this spec uses
> `CASE WHEN topic0 = <v4 Swap> THEN topic1 ELSE emitter END` as the pool key.

Pool coverage by family: 822 v3 pools, 563 v2 pools, 485 v4 poolIds. 550 of the
563 v2 pools also emit `Sync`. Only **42** v4 `Initialize` logs fall inside the
window, so ~443 of the 485 poolIds were born before it.

### Where a decode's RPC calls actually go

Profiled `0x602a6c5e9ff9f0aad0965e5414a21bc4a8c0fa99dd7b07bdebfeb91259660cab`
(KyberSwap, block 50842671, 9 legs) through
`scripts/analysis/decodeProfile.mjs`:

```
wall: 10,045ms   RPC calls: 175   distinct: 131   repeats: 44
79.3% of wall-clock had exactly ONE request in flight
```

| Bucket | calls | Addressed by |
|---|---|---|
| v4 poolId -> currencies bisection (`extsload`) | 51 | persistent cache (section 6) |
| `@latest` metadata (`getPool`, `decimals`, `symbol`, `token0/1`) | 39 | persistent cache (section 6) |
| ruler-block state reads (N-1 = 50842670) | 41 | irreducible |
| "after" wing (N+1 = 50842671) | 28 | dropped (section 4) |
| "before" wing (N-2 = 50842669) | 6 | dropped (section 4) |
| `eth_getTransactionReceipt` + `...ByHash` + `debug_traceTransaction` | 3 | seed injection (section 7) |
| misc (`eth_getLogs`, `eth_getCode`, `eth_getStorageAt`) | 7 | -- |

Two facts drive most of this design:

1. **Seed injection is not the efficiency story.** It removes 3 calls of 175
   (1.7%). It is still worth doing, for reproducibility and to drop the archive
   dependency, but it is not where the time is.
2. **`findInitializeLogByBisect` is.** `routeReaders.ts:496` resolves a v4
   poolId to its currencies with ~25 *serial* round-trips, binary-searching
   `extsload` from the PoolManager's deploy block. This trade paid 51 calls and
   6.5s of a 10s wall for two poolIds, and threw the result away at the end of
   the decode. The result is immutable forever.

> WARNING: 44 of 175 calls were repeats *despite* `rpcMemo`, including
> `balanceOf` on USDC 13x at one block. All 14 client constructions in
> `packages/core` do use `sessionHttp`, and `memoizeRequest` evicts only on
> rejection -- so the most likely explanation is retries of failing calls. This
> is the same shape as the open `transient-rpc-silently-degrades-receipts`
> hazard. **Not diagnosed.** Section 9 makes it a deliverable of the 535-tx run.

### What the ceiling on the 13,511 run looks like

Naive, at today's per-decode cost: ~1.7M calls, 13+ hours serial. With the
Tier-1 caches populated and the wings dropped: on the order of 400k calls and a
~5-hour run. **Both figures are extrapolations from a single 9-leg profile**,
which is heavier than a median trade. They exist to establish that the caches
are load-bearing rather than an optimization, not as a schedule.

---

## 3. `candidates` -- selection, made auditable

**Grain:** one row per transaction that emits at least one v2/v3/v4 Swap log
**or** whose `tx_to` is an active address in `routers.json`. For the pilot Seed
that is 13,511 + 130 = **13,641 rows**. Zero RPC; pure DuckDB SQL over
`receipt_json`.

Keeping the 130 router transactions that emit no Swap log is deliberate. They
are the approvals, bridge calls and reverts, and omitting them would make their
absence invisible — a research table needs to be able to count what it excluded.

| Column | Type | Source |
|---|---|---|
| `chain_id` | INTEGER | seed |
| `block_number` | BIGINT | seed |
| `block_position` | INTEGER | seed |
| `tx_hash` | VARCHAR | seed |
| `block_timestamp` | TIMESTAMP | seed |
| `tx_from` | VARCHAR | seed |
| `tx_to` | VARCHAR | seed |
| `tx_status` | BOOLEAN | seed |
| `selected_via` | VARCHAR | `router` \| `swap_log` \| `both` |
| `router_name` | VARCHAR | `routers.json`, NULL when `tx_to` is not a known router |
| `router_version` | VARCHAR | `routers.json` |
| `swap_log_count` | INTEGER | count of Swap logs |
| `v2_legs` / `v3_legs` / `v4_legs` | INTEGER | by topic0 |
| `distinct_pools` | INTEGER | distinct non-v4 Swap emitters |
| `distinct_v4_poolids` | INTEGER | distinct v4 Swap `topics[1]` |
| `log_count` | INTEGER | `receipt_json` |
| `erc20_transfer_count` | INTEGER | Transfer topic0 count |
| `gas_used` | BIGINT | `receipt_json` |
| `effective_gas_price` | VARCHAR | `receipt_json`, uint256 decimal string |
| `l1_fee` | VARCHAR | `receipt_json`, uint256 decimal string |
| `tx_value` | VARCHAR | `tx_json`, uint256 decimal string |
| `seed_file` | VARCHAR | provenance |
| `derived_at` | TIMESTAMP | provenance |
| `derived_schema_version` | INTEGER | provenance |

**uint256 columns are VARCHAR decimal strings.** This is the same choice the
Seed spec made when it kept `tx_value` out of its columns entirely: uint256 has
no native Parquet type, and DECIMAL(38,0) cannot hold the range. VARCHAR is
lossless and casts on demand in DuckDB. Human-scaled DOUBLEs appear only where a
decimals lookup makes them meaningful, which is in `receipts` and `legs`.

`candidates` is both the work list for the RPC pass and a standalone research
table: venue mix, router market share, and the census of what a router-only
filter misses are all answerable from it with no network access.

---

## 4. `receipts` -- one row per enriched transaction

**Grain:** one row per `candidates` row that the RPC pass attempted. This
includes rows that failed to decode (see `failure_reason` below).

The column set is `packages/core`'s `Receipt` interface (`analyzeTransaction.ts:226`)
with three deliberate changes.

### Dropped

- `market_mid_before`, `market_mid_after` — the wings. `pricing.ts:699` runs the
  entire market-price apparatus three times (`refBlock`, `refBlock-1`,
  `refBlock+1`). Measured cost 34 of 175 calls (19%) in the profile above; treat
  19% as a ceiling, since some of the 28 calls at N+1 may be per-leg reads
  rather than the wing, and 6 at N-2 as the floor. The stronger reason is
  correctness: each wing is an independent opportunity for a transient failure,
  and with no UI there is no consumer.
- `chainlink_price`, `chainlink_dev_bps`, `chainlink_staleness_secs`,
  `offchain_price`, `offchain_dev_bps`, `pool_divergence_bps`,
  `manipulation_flag` — the benchmark-validation block. Populated on 4 of 82
  corpus receipts, costs 3 `latestRoundData` calls per decode, and the Dune
  oracle path is inert until `DUNE_ETH_USD_QUERY_ID` is set. Re-adding them is a
  nullable-column addition, not a breaking change.

### Added

| Column | Type | Meaning |
|---|---|---|
| `failure_reason` | VARCHAR | NULL on success; otherwise why no receipt exists |
| `decode_stable` | BOOLEAN | NULL when not double-decoded; see section 9 |
| `decode_unstable_fields` | VARCHAR[] | fields that moved between decodes |
| `core_git_sha` | VARCHAR | provenance |
| `rpc_source` | VARCHAR | provider label, never a URL (Seed spec section 4) |
| `derived_at` / `derived_schema_version` / `seed_file` | | provenance |

**`failure_reason` means failures get rows.** The removed `receipts` table
simply omitted a transaction it could not decode, which makes coverage
unmeasurable from the dataset itself. A research table must carry its own
denominator.

### Retained

Identity (`tx_hash`, `chain_id`, `block_number`, `block_position`,
`block_timestamp`), trade (`aggregator`, `router_address`, `trader`,
`filler_address`, `direction`, `input_token`, `output_token`, `input_symbol`,
`output_symbol`, `input_amount`, `output_amount`), pricing (`notional_usd`,
`realized_price`, `market_mid`, `all_in_cost_bps`, `pricing_status`, `tier`,
`methodology`, `market_price_flags`, `reference_depth_usd`,
`reference_pool_address`), decomposition (`execution_bps`, `lp_fee_bps`,
`agg_fee_bps`, `slippage_bps`, `gas_cost_usd`, `route_pure`, `route_shape`,
`hop_count`, `route_reconstructed`, `recon_residual_bps`, `decomp_confidence`),
fees (`fee_recipient`, `fee_sink_source`, `fee_sinks`, `integrator_fee_bps`,
`fabric_fee_bps`) and tagging (`settlement_event_name`,
`settlement_event_topic0`, `settlement_event_seen`, `normalize_flags`).

`fee_sinks` stays a nested `LIST(STRUCT(address, fee_bps, source, name))`
rather than becoming a third file. There are 0-3 per trade and they are rarely
the grouping key; a leg file earns its keep, a fee-sink file does not.

`route_legs` is **not** carried here. It is the `legs` file.

> WARNING: `route_legs.length` does not tell you whether a route decomposed —
> `route_reconstructed` does. A transaction can have legs recorded and still be
> un-decomposable. See the `no-route-receipt-state` note and
> `RouteDecomposeResult.reconstructed`.

---

## 5. `legs` -- one row per leg

**Grain:** one row per decomposed leg. Joins to `receipts` on `tx_hash`;
`(tx_hash, leg_index)` is unique.

Columns are what `toPersistedLeg` emits (`analyzeTransaction.ts:114`) plus the
raw amounts:

| Column | Type | Note |
|---|---|---|
| `tx_hash` | VARCHAR | join key |
| `leg_index` | INTEGER | position within the route |
| `venue` | VARCHAR | address, or `v4:<poolId>` for a synthesized v4 leg |
| `v4_emitter` | VARCHAR | the singleton that emitted the Swap; NULL elsewhere |
| `type` | VARCHAR | pool family, `rfq`, etc. |
| `token_in` / `token_out` | VARCHAR | lowercase addresses |
| `symbol_in` / `symbol_out` | VARCHAR | best-effort; NULL when `symbol()` reverts |
| `amount_in_raw` / `amount_out_raw` | VARCHAR | uint256 decimal strings |
| `amount_in` / `amount_out` | DOUBLE | decimals-scaled, NULL when decimals unknown |
| `fee_tier_bps` | DOUBLE | |
| `lp_fee_bps` | DOUBLE | |
| `fee_resolved` | BOOLEAN | |
| `price_impact_bps` | DOUBLE | |
| `notional_usdc` | DOUBLE | |
| `frame_chain` | VARCHAR[] | router attribution; NULL means none |

`amount_in_raw` / `amount_out_raw` come from `routeGraph.Leg`
(`routeGraph.ts:19-20`), which carries them as `bigint`. `toPersistedLeg` drops
them because the UI never needed them; the ETL path must not.

Two traps to state in the schema comments, because both have already caused
defects in this repo:

> WARNING: `notional_usdc` is normalized by the **whole-trade** notional, not
> the leg's own value. Any change to trade notional moves every leg. It is not a
> per-leg dollar amount. See the `notional-depth-gating` note.

> WARNING: `fee_resolved = false` is not the same as a 0 bps pool. A failed
> `fee()` read used to be byte-identical to a free pool. Never aggregate
> `lp_fee_bps` without filtering on `fee_resolved`.

---

## 6. Caches -- the Tier-1 collapse

Three cache files under `data/cache/`, keyed on the fact and never invalidated,
because every fact in them is immutable on-chain:

| File | Key | Value | Why immutable |
|---|---|---|---|
| `v4_poolkeys.base.parquet` | `pool_id` | `currency0`, `currency1`, `init_block` | a pool's Initialize block never changes |
| `tokens.base.parquet` | `address` | `decimals`, `symbol` | ERC-20 metadata is set at deploy |
| `pools.base.parquet` | `address` | `token0`, `token1`, `fee`, `factory` | immutable for v2/v3-family pools |

Sizing against the pilot window: 485 poolIds, ~1,385 pools, and the token set
those imply. Populating `v4_poolkeys` costs 485 x ~25 = ~12k calls **once,
ever**, after which `findInitializeLogByBisect` never runs again for a seen
pool. The 42 v4 `Initialize` logs inside the window seed 42 of the 485 entries
for free out of the Seed itself.

> WARNING: `fee` is immutable for v3-family pools but **not** for a v4 pool with
> a dynamic-fee hook. `pools.base.parquet` must never cache a fee for a pool
> whose family permits dynamic fees. If the family cannot be established, do not
> cache the fee.

> WARNING: this cache must not be reachable from `rpcMemo`'s `@latest`
> `getPool` path. `rpcMemo.ts`'s header warning is correct and specific: a
> process-global memo would pin a factory's answer and never observe a
> newly-deployed fee tier. The `FactCache` interface therefore exposes only the
> three immutable lookups above, and `getPool` is not one of them.

### Block-pinned reads have a different floor

The 20,560 legs touch 1,870 distinct pools, but `slot0()`, `getReserves()`,
`liquidity()` and `balanceOf()` are read *at a block*, and each leg has its own.
The measured floor is **11,494 distinct (pool, block) pairs** — a **1.8x**
collapse, not 11x. Do not budget for the pool count.

**Multicall3 is the lever for this tier**, not caching. viem's
`batch: { multicall: true }` collapses same-block `eth_call`s into a single
on-chain aggregate call.

> This is NOT the thing the `decode-latency-profile` note warns about. That
> warning concerns JSON-RPC **array batching**, which lost because the endpoint
> parallelizes ~26x and batching re-serialized the work. Multicall3 is one
> `eth_call`, one round trip, aggregation on-chain. Different mechanism —
> but still measure it before believing it, on an archive block, where the
> aggregate call is heavier than at head.

Multicall3 is specified here and **built in v0.3**, after the 535-tx run has
established a real per-decode call profile to measure it against.

---

## 7. Re-rigging `analyzeTransaction`

Strictly additive. Every new option defaults to today's behaviour, so the
dashboard's receipt is byte-identical and no existing caller changes.

```ts
analyzeTransaction(hash, chainId, {
  rpcUrl,
  prefetched?: { receipt, tx, trace },  // from the Seed row
  includeWings?: boolean,               // default true; the ETL passes false
  factCache?: FactCache,                // default undefined; section 6
})
```

- **`prefetched`** replaces the three calls at `analyzeTransaction.ts:336-344`.
  Worth 1.7% of calls, and considerably more than that in reproducibility: with
  it, a derived build reads the trace from disk and needs no archive node for
  that step. The injected values must be shape-compatible with what viem
  returns, which is a translation layer the plan must specify — the Seed stores
  the raw RPC JSON, and viem's `getTransactionReceipt` returns parsed types.
- **`includeWings: false`** skips the two `getMarketPriceForPair` calls at
  `pricing.ts:701-706` and nulls `marketMidBefore` / `marketMidAfter`. The
  centre call is untouched, including its deliberate lack of a `.catch` — a
  failed ruler must still degrade the whole receipt.
- **`factCache`** is consulted before the three immutable lookups and written
  through on a miss.

---

## 8. Staging

**v0.2 — this spec.**

1. `candidates` builder (zero RPC) over the pilot Seed.
2. The three caches and the `FactCache` interface.
3. The `analyzeTransaction` re-rig (section 7).
4. The **535-tx run** — router-selected *and* actually swapping, i.e.
   `selected_via = 'both'`. (`selected_via = 'router'` is the 130 that emit no
   Swap log; `'swap_log'` is the remaining 12,976.)
5. The determinism harness (section 9), run against those 535.
6. The **13,511-tx run** once determinism is understood.

**Instrumented during step 4, for a v0.3 decision:** record which pool the
market-price ruler binds to on every one of the 535 decodes, and what fraction
of those pools have in-window Swap-log coverage.

**v0.3 — Tier 3 (`pool_state`), gated on that measurement.**

Every v3/v4 `Swap` log carries post-swap `sqrtPriceX96` and `liquidity` in its
payload, and the Seed already holds all of them. Verified against the pilot
file: all **13,738** v3 Swap payloads are exactly 5 words (322 hex characters,
uniform, no variants), and word 3 decodes to sane values
(`75197597709693802777377373706356` -> raw price 900842.29;
`6928334514604575635098` -> 7.65e-15). 550 of 563 v2 pools emit `Sync`, giving
reserves directly. For any pool that traded in the window, its price at that
block is a DuckDB expression rather than an RPC call.

Four reasons it is staged rather than built now:

1. It is **post-swap** state. Pre-swap state for the first swap of a block needs
   the prior observation, which for early-window pools falls outside the file.
   Boundary rows need an RPC backfill.
2. `balanceOf`-based depth — which the reference-pool depth floor depends on —
   is **not** recoverable from v3 logs. `Sync` covers v2 only.
3. **The ruler may not be a route pool.** `marketPrice.ts` ranks candidate
   reference pools by depth, and the winner can be a pool that never traded in
   the window, so it has no log coverage at all. This is the measurement step 4
   exists to take, and it decides how much Tier 3 is actually worth.
4. Only 42 of the 485 v4 poolIds have an in-window `Initialize` log.

Building it before taking that measurement would be building the clever thing
before knowing whether it pays.

---

## 9. Failure policy and determinism

**The governing rule:** a degraded read is flagged in the row, never written as
a bare number.

This exists because of an open, unfixed hazard in `main`: concurrent decodes of
the *same* transaction have produced different receipts — `tier` moving
full -> estimated, `allInCostBps` moving 101 -> 5012, venue mislabelled — with
no flag on the row. Serial decoding was stable. A 13,511-row research table
carrying an unknown subset of such rows is worse than no table, because it would
be queried in good faith.

**The determinism harness.** Decode all 535 twice, serially, and diff. For each
transaction record `decode_stable` and, when false, `decode_unstable_fields`.
The fields to watch first are `tier`, `pricing_status`, `all_in_cost_bps`,
`market_mid`, and the per-leg `venue`.

The harness is expected to also explain the 44 repeat calls seen in section 2's
profile; they are the same investigation.

**Output of the harness is a rule, not just a number.** If instability is
traced to a transient read, the fix is that the affected quantity is nulled and
flagged rather than recorded — the same shape as the `feeResolved: false` fix
for unread fee tiers.

**Two runs are serial by policy.** The 535-tx and 13,511-tx runs decode one
transaction at a time until the harness says otherwise.

---

## 10. Testing

Following the Seed layer's conventions:

1. **Unit — `candidates` derivation.** The SQL runs against a committed
   small-Seed fixture with known counts, including a router tx with no Swap log
   and a v4 tx, so `selected_via` and the per-family leg counts are pinned.
2. **Unit — pure transforms.** Row shaping for `receipts` and `legs` is pure
   over a `Receipt`, testable with no RPC. Covers the uint256-as-VARCHAR
   round trip and `fee_resolved` / `frame_chain` absence semantics.
3. **Round-trip through DuckDB.** Write each derived family from fixture rows,
   read back, assert every column's type and value survives.
4. **Schema tripwire per family.** A frozen column list for `candidates`,
   `receipts` and `legs`, mirroring the Seed's. Unlike the Seed's, these are
   *versioned*, not frozen forever — the failure message must say so and point
   at `derived_schema_version`, since a Derived file is disposable by design.
5. **Cache semantics.** A `FactCache` hit issues no RPC; a miss writes through;
   a dynamic-fee-capable pool never has its fee cached.
6. **`analyzeTransaction` back-compat.** With no new options, output is
   unchanged. With `includeWings: false`, only the two wing fields change.
   With `prefetched`, the receipt matches the un-prefetched one.
7. **E2E**, gated on `TCA_RPC_URL`.

> WARNING: vitest runs from the **repo root**. Running from a package
> subdirectory silently reports roughly half the suite.

> WARNING: full-suite runs with `TCA_RPC_URL` set need
> `--no-file-parallelism`, or the e2e files trip genuine QuickNode 429s.

---

## 11. Out of scope for v0.2

Multi-chain. Incremental or resumable derived builds. Any UI, API or HTTP
surface. Re-adding the benchmark/Chainlink columns. `pool_state` (v0.3).
Multicall3 (v0.3). Promotion of `provisional/` Seed files. Any change to the
Seed layer's schema or ingest.

---

## 12. Open questions deferred, not forgotten

- **Does the ruler bind to in-window pools?** Section 8's step-4 measurement.
  Everything about Tier 3's value depends on the answer.
- **What causes the 44 repeat calls?** Section 2's warning. Retries are the
  leading hypothesis; nothing is proven.
- **Chunking for a durable derived archive.** The pilot is one Seed file. A
  build spanning many Seed files needs a convention for whether derived files
  mirror Seed chunk boundaries. The filename accommodates either.
- **Is `routers.json` the right registry to extend?** Uniswap's UniversalRouter
  is absent because the registry serves aggregator *identity*. Adding routers
  for population selection may want a separate list rather than a widened one,
  since `resolveAggregator` reads this file.
- **Cache growth across chains.** `pools.base.parquet` is chain-scoped by name.
  Whether a second chain gets a second file or a `chain_id` column is undecided.
