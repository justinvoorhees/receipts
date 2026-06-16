# Spec

The authoritative specification for this project is `Fabric_TCA_MVP_Spec.docx`. Transcribe its sections here as Markdown when you have a moment so the spec is version-controlled alongside the code. Below is a summary of the headline decisions this scaffold implements.

## Highlights

- **Chain**: Base mainnet
- **Pair**: USDC/WETH only (both directions)
- **Trade source**: aggregator-routed swaps matching `configs/routers.json`
- **Size filter**: P99 of 30-day rolling notional; cold-start floor $500,000 USD
- **Reference price**: `slot0()` on the Uniswap V3 USDC/WETH 0.05% pool at block N-1
- **TCA components** (per trade, normalized to bps):
  - `lp_fee_bps` — pool fee tier / 1e4
  - `agg_fee_bps` — sum of transfers to known fee recipients / notional
  - `gas_cost_bps` — gas cost USD / notional
  - `execution_quality_bps` — residual (total_cost − lp_fee − agg_fee − gas)
  - `total_cost_bps` — (reference_price − executed_price) / reference_price × 10000
- **Infra**: archive RPC (Alchemy archive plan or equivalent) — `debug_traceTransaction` + historical `eth_call` both require it

## Deviations from the original spec

| Spec choice | This project | Why |
|---|---|---|
| SQLite (MVP) | **Postgres** | Dashboard is a near-term deliverable; Postgres avoids the migration tax. |
| Python 3.11+ | **TypeScript** | Single language end-to-end avoids schema drift between ingest and dashboard. `debug_traceTransaction` works fine via viem's raw `request()`. |
| No dashboard in MVP | **Dashboard scaffolded** | UI shell salvaged from v1; design pending. |

## Open items

- [ ] Transcribe the full spec from `Fabric_TCA_MVP_Spec.docx` into this file.
- [ ] Verify the Odos / 0x / KyberSwap / 1inch / Velora router addresses on Basescan (the spec calls this out; Fabric / Nordstern / Relay are already confirmed — see `notes-from-v1.md`).
- [ ] Build out the fee-recipient registry per aggregator (currently empty in `configs/routers.json`).
- [ ] Decide v2.1 dashboard column lineup once a handful of swaps have been decoded.
