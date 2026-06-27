# Follow-ups — Robust benchmark + oracle validation

Filed 2026-06-27, after the feature landed (`feat/cost-model-v2` `b71519b..6f8a50e`).
Whole-branch review verdict: ready-to-merge, no must-fixes. None of the below are blocking.

Spec: `docs/superpowers/specs/2026-06-26-robust-benchmark-oracle-validation-design.md`
Plan: `docs/superpowers/plans/2026-06-26-robust-benchmark-oracle-validation.md`

## 1. Pool-divergence flag is over-sensitive (NEEDS DECISION) — priority

`pool_divergence_bps` is computed as `(max − min)/median × 1e4` across **all** valid pools
(`packages/ingest/src/benchmarkPrice.ts`, `computeBenchmark`). Because the thin Uni V3 30bps
WETH/USDC pool can drift, it inflates the spread and trips the `>15 bps` → `POOL_DIVERGENCE`
→ low-confidence path **even though the median benchmark value is unaffected** (the median
already discards the outlier). On the smoke set this downgraded exactly one trade
(`0x12adf9d1`, 15.5 bps) whose benchmark was itself fine.

Candidate fixes (pick one):
1. **(preferred)** Measure divergence relative to the median — e.g. `max(|pool − median|)/median`,
   or only across the pools straddling the median — so a pool the median already rejects can't
   trip the flag.
2. Widen `DIVERGENCE_TOL_BPS` from 15 to ~25–30.
3. Exclude the thinnest pool (30bps) from the divergence calc only, keeping it in the median.

Note: this is a confidence-flag tuning issue, not a correctness bug in the benchmark value.

## 2. Type cast in `getBenchmarkMid` (minor)

`benchmarkPrice.ts` passes `client as never` to the local slot0 reader; `as PublicClient` is the
clean cast that preserves type-checking.

## 3. Missing unit-test coverage (minor)

`benchmarkPrice.test.ts` has no case for the exactly-2-valid-pool median path, and the 1-valid
case doesn't assert that `perPool` passthrough preserves the nulls. Logic is correct; only the
tests are missing.

## 4. Single-pool `getReferencePrice` still used outside the 3 production sites (out of scope)

The plan converted the 3 named call sites (`reextract-gated`, `extract-router-trades`,
`normalizeSmokeTrade`). Single-pool `POOL_5BPS`/`getReferencePrice` still remains in, and was
never in scope for:
- `packages/ingest/src/spotcheck-outlier.ts` — manual diagnostic, no DB write.
- `packages/ingest/src/validate-allin-cost.ts` — read-only diagnostic.
- `packages/ingest/src/processSwap.ts` — **writes the `swaps` table** (separate v2.0 TCA-ledger
  pipeline, not read by the gated/smoke dashboard). Migrate to `getBenchmarkMid` only if/when
  that pipeline is revisited.

The plan's final-verification step (`grep POOL_5BPS packages/ingest/src → no matches`) is therefore
not literally satisfied; that gate was too broad.

## 5. `pool_divergence_bps` is audit-only in the UI (minor)

The dialog surfaces `chainlink_dev_bps` + the manipulation badge; `pool_divergence_bps` is stored
but not shown (its effect reaches the UI via the `decomp_confidence='low'` downgrade for smoke
rows). On the deferred `router_trades_gated` path there is no confidence/flags column, so bench
`flags`/`lowConfidence` are dropped there (only `manipulation_flag` persists). Acceptable given the
smoke pivot + gated deferral.

## 6. Deferred — 165-row `router_trades_gated` backfill

Dropped by user decision (2026-06-27): gather fresh data later. The 4 validation columns exist on
the table but stay null until then.

## 7. Pre-existing (NOT this feature)

`npm run build --workspace packages/ingest` exits 1 from 6 pre-existing tsc errors in unrelated
scripts: `backfill-scanner-routing`, `check-single-swap`, `debug-aggregator`, `prove-aggfee`,
`validate-trader-id`, `validate-trader-id-singlehop`. These predate this work.

## 8. Earmarked upgrade — TWAP manipulation detector

A short Uni V3 `observe()` TWAP vs the slot0 median, as a second oracle-independent manipulation
signal. Adds a signal; does not change the benchmark value. See the design spec's "Future upgrade".
