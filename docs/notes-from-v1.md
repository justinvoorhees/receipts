# Notes from v1 (Aggregator Benchmark) — for the v2 TCA Decoder

The v1 project (this codebase) actively executed small ($1–$2.50) swaps through 6 aggregators and measured realized vs. quoted accuracy. The v2 project pivots to passive observation of third-party $500k+ swaps, decoding them via `debug_traceTransaction`. Most v1 code does not carry over (different language, framing, infra), but the empirical knowledge below does.

## Confirmed router contracts on Base (verified by live execution)

These three were confirmed by submitting real txs and seeing them confirm. The v2 spec's instruction "verify whether this is a contract or solver EOA on Basescan; detection strategy may differ" is **resolved** for all three — they are all deployed contracts; the `to_address` detection strategy works.

| Aggregator | Router address | Notes |
|---|---|---|
| Fabric | `0x7c137a37742437d2212b7bd873ed135b5c4c61da` | Set `detection: 'to_address'` |
| Nordstern | `0xC87De04e2EC1F4282dFF2933A2D58199f688fC3d` | Set `detection: 'to_address'` |
| Relay | `0xccc88a9d1b4ed6b0eaba998850414b24f1c315be` | Set `detection: 'to_address'` |

The other v2 spec routers (Odos, 0x, KyberSwap, 1inch, Velora) were not exercised by v1 with txs that committed on-chain (Odos consistently no-routed at our size; the rest were untested). Verify those addresses on Basescan as the spec already instructs.

## Methodology learnings

- **`submission_failed` (or its v2 analog) is not the provider's fault.** v1 logged it but explicitly excluded it from per-provider failure counts in aggregates. In v2 terms: if you can't decode a trade because of RPC issues (e.g., archive returned "Requested resource not found"), don't attribute that to the aggregator. Track it separately as a pipeline-health metric.
- **Alchemy free tier rejects archive-state `eth_call`** with "Requested resource not found." v2 spec already calls out the archive node requirement. Confirmed empirically — budget for the paid plan from day one.
- **Aggregator fee captured as positive slippage.** The v2 spec already documents this for `agg_fee_bps`. v1 observed the same phenomenon as a higher-than-expected slippage residual on some providers; useful to flag per-provider in your fee-recipient registry.
- **Per-attempt gas cost dominates at small sizes** ($0.002 gas on a $1 swap is 20 bps; on a $2,000 swap it's 0.001 bps). v2's $500k+ floor makes gas a much smaller fraction of total cost. Display gas in USD/gwei, not just bps — bps was unintuitive even at v1's scale.
- **Slippage is the right name** for what we measured. v1 originally called it "Price Impact"; renamed mid-project. The v2 spec splits this into `lp_fee_bps + agg_fee_bps + execution_quality_bps`, which is the cleaner decomposition.
- **Percentiles > stddev for fat-tailed cost distributions.** v1 used `stddev_samp(degradation_bps)`; consider `percentile_cont(0.5/0.9/0.99)` in v2 aggregates.

## Workflow primitives worth porting

- **`caffeinate -i -w PID`** on macOS keeps the machine awake until a long-running ingest process exits. Useful when the pipeline runs overnight.
- **Chained launch (wait-for-PID → next task)** via shell: `(while kill -0 PID 2>/dev/null; do sleep 30; done; next_step)`.

## What lives in the v1 Postgres DB

If preserved, the v1 DB contains 30+ experiments with ~thousands of executed swaps including raw spanDEX quote payloads, gas costs, and realized amounts. Schema is in `packages/db/src/schema.ts`. Not directly useful to v2 (which observes third-party trades) but available as a reference for future "what does my own controlled trade look like through provider X" analysis.

## Commit anchor

The v1 project is tagged on commit `ada5037c256998cbbd8746bad0bc51ed0ade9110` as `tca-v1-aggregator-benchmark`.
