# TCA ETL Pipeline v0.1 — Seed Parquet schema

**Status:** DESIGN — 2026-09-03. No code written. Measurements in this document
were taken against Base mainnet via the QuickNode archive endpoint on
2026-09-02/03 around block 50.83M and will drift; re-measure before relying on a
number.

**Goal:** build a small, durable, local copy of exactly what *finalized* Base
told us,
transaction by transaction, performing *no* blockchain analysis while creating
it. Once that archive is trustworthy, all Fabric/TCA work becomes disposable
transformations on top of it.

---

## 1. Architecture

```
Base RPC ──ingest──▶  Seed Parquet  ──DuckDB SQL──▶  Derived Parquet
(3 methods)          (immutable,                    (versioned,
                      canonical)                     disposable)
```

The invariant the whole design exists to protect:

> **A Seed file contains only what the chain said. Anything requiring a
> judgment call lives in a Derived file.**

Derived files are free to be wrong, because they rebuild from Seeds in seconds
with no network access. Seed files are not, because rebuilding them means
re-fetching from an endpoint that may no longer agree.

Two properties make a Seed file trustworthy, and both are load-bearing:

1. **Semantic losslessness** — the payload we store means exactly what the RPC
   said (§3).
2. **Canonicality** — the blocks we store are on the chain permanently (§6).

Neither is negotiable. A Seed layer with only the first is a durable archive of
possibly-reorged data.

## 2. Grain

One row per transaction, self-sufficient: trace, receipt, transaction envelope
and block header all reachable from a single row without a join.

This was chosen over one-file-family-per-RPC-method. The cost is accepted
knowingly: the block header is identical across every transaction in a block, so
it is denormalized rather than normalized, and a fourth RPC source added later
is a schema change to this family rather than a new family alongside it. Parquet
dictionary encoding makes the storage cost of the duplication negligible
(§4, `block_json`).

## 3. The payload standard: semantically lossless, not byte-identical

Payload columns hold `JSON.stringify(parsedRpcResult)` — the RPC response parsed
by Node and re-serialized.

**Guaranteed preserved:** every key; every value, string-for-string; nesting
structure; nulls; booleans; hex casing.

**Not preserved:** insertion whitespace, and in principle key ordering (V8
preserves insertion order for non-integer string keys, so in practice this holds
— but it is not guaranteed and nothing may depend on it).

**Why this is safe here, specifically.** Byte-preservation would additionally
protect against numeric coercion — a large JSON number round-tripping through an
IEEE-754 double and losing precision. That risk is absent in this data. Every
scalar in all three payloads was walked on block 50795977: `trace`, `receipt`
and `tx/block` contain **zero JSON numbers**. Every value is a hex string,
boolean, or null. There is no float to lose precision through.

⚠️ This is a property of these three methods' current output, not a law. A new
RPC method or a client upgrade that emits a bare JSON number breaks the
guarantee silently. The ingest asserts it (§8, test 4).

**The one sanctioned transformation.** `block_json` has its `transactions` key
removed, because those transactions are the rows. This is a deletion of a
duplicate, it is the *only* field-level change made anywhere in the Seed layer,
and it is declared here so it is never rediscovered as a surprise.

Beyond that: no field is added, renamed, reordered, lowercased, widened,
narrowed, or coerced.

## 4. Schema — 17 columns

File: `traces.base.[block-range].parquet`

| # | Column | Type | Role | Source |
|---|---|---|---|---|
| 1 | `chain_id` | `INTEGER` | identity | constant 8453 |
| 2 | `block_number` | `BIGINT` | identity | block |
| 3 | `block_position` | `INTEGER` | identity | `transactionIndex` |
| 4 | `tx_hash` | `VARCHAR` | identity | `txHash` |
| 5 | `block_timestamp` | `TIMESTAMP` | pruning | header `timestamp`, UTC |
| 6 | `tx_from` | `VARCHAR` | pruning | tx `from` |
| 7 | `tx_to` | `VARCHAR` | pruning | tx `to`; NULL on deploy |
| 8 | `tx_status` | `BOOLEAN` | pruning | receipt `status` |
| 9 | `block_hash` | `VARCHAR` | integrity | header `hash` |
| 10 | `trace_json` | `VARCHAR` | payload | `debug_traceBlockByNumber[i].result` |
| 11 | `receipt_json` | `VARCHAR` | payload | `eth_getBlockReceipts[i]` |
| 12 | `tx_json` | `VARCHAR` | payload | `eth_getBlockByNumber.transactions[i]` |
| 13 | `block_json` | `VARCHAR` | payload | header, `transactions` stripped |
| 14 | `finality` | `VARCHAR` | provenance | `finalized`\|`safe`\|`unsafe` at ingest |
| 15 | `ingested_at` | `TIMESTAMP` | provenance | wall clock, UTC |
| 16 | `source` | `VARCHAR` | provenance | provider label |
| 17 | `schema_version` | `INTEGER` | provenance | starts at 1 |

### The promotion rule

A field becomes a column only if it is used for **pruning** (deciding which rows
to read), **identity**, or **integrity**. Anything used for **computation** stays
in a blob, because computation is what Derived files are for.

This is why `tx_to` and `tx_status` are columns (you filter on them) while
`gas_used`, `l1_fee` and `tx_value` are not (you compute with them). It is also
the test to apply to any future proposal to add a column.

### Decisions inside the schema

- **`block_json` earns its place.** Without it the row is not self-sufficient —
  `baseFeePerGas`, `gasLimit` and `miner` would require going back to chain,
  defeating the cache. It is identical across all ~113 transactions in a block,
  so Parquet dictionary-encodes the column to ~300 distinct values ≈ **0.4 MB**
  for the pilot. Self-sufficiency at that price is worth it.
- **Hex is lowercase `0x…` VARCHAR, not 32-byte BLOB.** BLOB is roughly half the
  size, but every address in `packages/core` is already lowercase hex, and
  addresses dictionary-encode to near-nothing. Consistency with the decoder beats
  the bytes.
- **`source` is a provider label** (`"quicknode-base-mainnet"`), never the URL.
  `TCA_RPC_URL` carries an API key; a data file is the wrong place for it.
- **`schema_version` starts at 1** and bumps only on a *breaking* column change.
  Adding a nullable column is not a bump.
- **`tx_value` is deliberately absent.** uint256 has no native Parquet type, so
  promoting it would force a representation choice (VARCHAR vs DECIMAL(38,0))
  into the immutable layer. It stays in `tx_json`.

## 5. Naming and layout

```
data/seeds/traces.base.0050830910-0050831209.parquet
                       └────┬───┘ └────┬───┘
                          from       to (inclusive)
```

Zero-padded to 10 digits so lexical sort equals numeric sort — a DuckDB glob
returns files in block order for free. 10 digits reaches block 9,999,999,999,
about 630 years of Base at 2s blocks.

The filename encodes the *actual* range ingested, so any chunking convention
adopted later (aligned 1,000-block chunks being the likely one) requires no
renaming.

Parquet files are gitignored (~60 MB zstd for the pilot alone).

## 6. Finality and reorg policy

**The problem, measured.** On 2026-09-03:

```
latest     50831779
safe       50831750   ←  29 blocks behind  (~58s)
finalized  50831209   ← 570 blocks behind  (~19 min)
```

Base `finalized` lags head by **~570 blocks**. A pilot anchored to `head` would
therefore sit *entirely* inside the unfinalized window — 100% of its rows
non-canonical by policy, not a fraction of them.

**So the pilot anchors to `finalized`, not to `head`:**

> Pilot range = `[F - 299, F]`, where
> `F = eth_getBlockByNumber('finalized').number`, resolved **once** at ingest
> start and pinned for the whole run.

This satisfies the admission rule by construction, so the pilot lands in
`data/seeds/` as a first-class member of the canonical archive rather than in
`provisional/`. Every row carries `finality = 'finalized'`.

⚠️ `F` advances continuously, so re-running the pilot with no arguments produces
a *different* 300-block range and a different filename — it is not idempotent
across time. Explicit `--from`/`--to` arguments are the reproducible path, and
the range actually ingested is recorded in the filename.

**Pilot range as actually run (2026-09-03):** blocks 50842630–50842929 (300
distinct blocks, `to - from == 299`), 155,732 rows, 145 MB, ingested in 37.0s
at `--concurrency 4` from `quicknode-base-mainnet`. Block timestamps span
2026-09-03T22:30:07Z–2026-09-03T22:40:05Z. `finality` is `finalized` on every
row (`count(DISTINCT finality) = 1`).
File: `data/seeds/traces.base.0050842630-0050842929.parquet`.

⚠️ The row count is materially higher than the ~34,000 estimated from the
2026-09-02/03 measurement of ~113 tx/block — this range averaged ~519
tx/block instead. That estimate was a rough measurement taken on different
blocks at a different time, not a target; the actual number is simply what
Base's transaction volume was during this range. File size (145 MB) came in
under a proportional scale-up of the original 50–80 MB estimate, since
average bytes/row (~945) is lower than the estimate implied — worth watching
if it recurs, but not adjusted here.

This was also the third pilot attempt. The first died writing the Parquet
file (`rows.map(...).join('\n')` exceeded Node's 512 MiB max string length —
fixed in `bb1fa3c` by streaming the NDJSON instead of building one monolithic
string). The second died on an `HTTP 429` from the RPC endpoint at block
50/300, because the default `--concurrency 8` sustains ~24 simultaneous RPC
calls (3 per block) — fixed in `5a1ef6f` by adding bounded retry with
jittered backoff to `rpcCall`, and this run was additionally made at
`--concurrency 4` to halve the sustained request rate — now the default, since
the value that failed had no business remaining the one you get by not
choosing. Both fixes are
upstream of this task's file list; this run is the first to reach a written
file.

**Admission rule for the permanent Seed layer:**

> A block may enter `data/seeds/` only when
> `block_number <= eth_getBlockByNumber('finalized').number`.

This is an L1-derived guarantee the OP Stack already exposes, not a chosen
confirmation count.

**Enforcement is physical, not remembered:**

| Path | Contents |
|---|---|
| `data/seeds/*.parquet` | finalized only — the canonical archive |
| `data/seeds/provisional/*.parquet` | anything below the bar |

`read_parquet('data/seeds/*.parquet')` is therefore by construction the
canonical archive. The non-recursive glob is the guarantee.

**Ingest gates by default.** Ingesting a block above the finalized head requires
an explicit `--allow-unfinalized`, which also forces the output into
`provisional/` and stamps `finality` accordingly.

**The rule is a property of the ROW, so it is checked on the DELIVERED block.**
The range check compares the REQUESTED range against the finalized head, but
`block_number` is derived from the RESPONSE, and a tag is only a request: an
endpoint answering every request with the same block would otherwise yield a
correctly-named, `finalized`-stamped file whose rows had never been tested
against the head at all. Ingest therefore reconciles the two, aborting the run
when a delivered block is not the one asked for. For the same reason it makes
one `eth_chainId` call per run and refuses to proceed when the endpoint
disagrees with `--chain-id`: `chain_id` is otherwise a pure operator assertion,
and `chain` is an uncorrelated filename slug, so a misdirected `TCA_RPC_URL`
would put another chain's blocks in the canonical archive undetectably.

**The v0.1 pilot does not use this flag.** The gate and the `provisional/` path
are built and tested in v0.1, but nothing in the pilot exercises them — they
exist so that the first unfinalized ingest is refused by default rather than
discovered later.

**Repair pass — specified here, built in v0.2.** For a given file: re-fetch
canonical block hashes across its range, compare against stored `block_hash`,
re-ingest any block whose hash disagrees. With the admission rule enforced this
is a smoke alarm rather than a workhorse; it exists so that `provisional/` files
have a defined path to promotion, and so a Seed built during an incident is
detectable rather than silently trusted.

## 7. Ingest

Three calls per block, issued in parallel, blocks processed with bounded
concurrency. Rows stream to NDJSON in a temp file; one DuckDB `COPY` produces
the Parquet; the result is moved into place atomically (`atomicWrite.ts` already
exists in the repo).

```sql
COPY (SELECT * FROM read_json('seed.ndjson', columns := {...},
                              format := 'newline_delimited')
      ORDER BY block_number, block_position)
TO 'traces.base.0050830910-0050831209.parquet'
  (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 4096);
```

**`ORDER BY` at write time is load-bearing** — it is what makes row-group
min/max statistics useful. Without it, block-range pruning does nothing.

**`ROW_GROUP_SIZE 4096`** gives roughly 8 groups of ~70 MB at the measured
~17 KB/row. DuckDB's default of 122,880 would put all 34k pilot rows in a single
row group and defeat pruning entirely. This is a tuning knob to revisit with
measurement, not a settled number.

**Idempotence.** Re-running the same range writes the same path and atomically
replaces it.

**Alignment across the three payloads.** The three responses are three
independent orderings of the same block. Rows are assembled by joining on
`transactionHash`, never by array index, and ingest asserts all three payloads
report the same transaction count for the block before writing any row. A
mismatch aborts the block rather than emitting a misaligned row — a Seed row
that pairs one transaction's trace with another's receipt is the single worst
failure this layer can produce, because everything downstream would trust it.

Blocks with zero transactions produce zero rows and are not an error.

Note that `debug_traceBlockByNumber` includes system transactions (the L1
attributes deposit at index 0, `0xdead…0001` → `0x4200…15`). These are kept:
the pilot is defined as *all* transactions, and filtering is a Derived-file
concern.

**Measured cost of the pilot** (300 blocks, block 50795977 as the sample):

| Method | Grain | ms/blk | Raw JSON, 300 blk |
|---|---|---|---|
| `debug_traceBlockByNumber` | per tx | 220 | ~400 MB |
| `eth_getBlockReceipts` | per tx | 210 | ~126 MB |
| `eth_getBlockByNumber(true)` | block + tx | 105 | ~56 MB |

~900 calls, ~2.5 min serial, ~580 MB raw JSON, ~60 MB zstd Parquet, ~34,000
rows at 113 tx/block. Trace size per tx: mean 11.7 KB, median 1.2 KB, max
182 KB — a heavy tail worth remembering when sizing row groups.

## 8. Code location

New workspace package **`packages/etl`**, not `scripts/`.

It depends on `@duckdb/node-api`, which ships a native binary, and that binary
must stay out of the dashboard's Railway/Nixpacks build.

⚠️ Seed paths resolve from a CLI argument or environment variable **at
runtime**. Never `import.meta.url`. The six existing `configs/*.json` paths bake
the build machine's absolute path and work only because Nixpacks builds
in-container; this package must not repeat that.

## 9. Testing

1. **Unit — row building.** `(traceBlock, receipts, block) → SeedRow[]` is a pure
   function over a committed fixture from block 50795977. Covers transaction-index
   alignment across three independently-ordered payloads, `tx_to` NULL on
   contract deploys, and header/tx-list stripping.
2. **Round-trip through DuckDB.** Write a small Parquet from fixture rows, read
   it back with DuckDB, assert every column's type and value survives. This is
   the only way to *prove* "extensible to DuckDB" rather than assert it.
3. **Schema tripwire.** A frozen column list; the test fails if any Seed column
   is added, removed, renamed or retyped. This is the test that enforces "we do
   not change the data model". Its failure message must state why the Seed is
   frozen and point at §4's promotion rule, so whoever trips it is told how to
   decide rather than just told no.
4. **Payload-standard assertion.** Walk the fixture payloads and assert no scalar
   is a JSON number, pinning the §3 guarantee. Failure means the losslessness
   argument no longer holds and the payload standard must be revisited.
5. **Finality gate.** Assert ingest refuses an unfinalized block without
   `--allow-unfinalized`, and that the flag routes output to `provisional/`.

⚠️ Vitest runs from the repo root. Running from a package subdirectory silently
reports roughly half the suite.

## 10. Out of scope for v0.1

No Derived files, no manifest, no repair pass implementation, no multi-chain, no
incremental or resumable ingest, no promotion of `provisional/` files.

The `provisional/` path and the `--allow-unfinalized` gate *are* built in v0.1,
but only the gate's refusal behaviour is exercised — the pilot itself is
finalized-only.

The first Derived file — flattened call frames addressed by `trace_address` — is
v0.2, and it validates the Seed by being the first thing to consume it.

## 11. Open questions deferred, not forgotten

- **Chunk size for the durable archive.** The pilot is 300 blocks because that
  is what was asked for. A production convention (likely aligned 1,000-block
  chunks) is a v0.2 decision; the filename convention already accommodates it.
- **`ROW_GROUP_SIZE`.** 4096 is reasoned, not measured. Measure against real
  Derived-file query patterns before fixing it.
- **Promotion path for `provisional/` files.** The repair pass makes it possible;
  whether promotion rewrites the file in place or re-ingests from chain is
  undecided.
