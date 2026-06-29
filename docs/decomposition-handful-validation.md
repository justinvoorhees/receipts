# Cost Decomposition v2.1 — Hand-Validation Worksheet

> **Purpose:** checklist for manually confirming the 7 curated decomposition
> results against Basescan before scaling into the pipeline. Each claim has a
> "Confirmed?" checkbox. Walk through on Basescan, check each box, note
> discrepancies. The decomposition is NOT trusted until every box is checked or
> an explicit exception is documented.
>
> **Units:** all decomposition values are in **absolute ETH** (6 decimal places).
> Gas is `gasUsed × effectiveGasPrice` from the transaction receipt, with the
> USD equivalent in parentheses.
>
> **How to use:** open each Basescan link, switch to the "Logs" or "Internal Txns"
> tab as needed, and verify each claim against on-chain data. For fee-vault
> transfers, search the ERC-20 Transfers for the vault address. For pool fee
> tiers, check the pool contract's `fee()` view on Basescan (Read Contract).

---

## Txn #1 — 1inch (RFQ, beat mid)

**Basescan:** https://basescan.org/tx/0x55513d402ecdbc00fea0eaf68642442193aeff6385b48e9339745fedd66e965a

**Size:** 0.696490 WETH / 1162.17 USDC (mid 1665.53) — sell_weth, settled WETH, PURE

| Claim | Expected | Confirmed? |
|-------|----------|------------|
| Aggregator | 1inch | [ ] |
| Route purity | PURE (no third token through hub) | [ ] |
| Trader USDC leg | Trader sends or receives USDC (RFQ fill, no pool swap) | [ ] |
| Trader WETH/ETH leg | Trader sends or receives WETH (opposite direction) | [ ] |
| Agg-fee vault transfer | None (clean RFQ fill; ROBA in-tx is a co-settled batch leg, not on the trade path) | [ ] |
| Pool fee tier(s) | None — pure RFQ, no V3/V4 Swap events | [ ] |
| LP fee | 0.000000 ETH | [ ] |
| Agg fee | 0.000000 ETH | [ ] |
| Slippage | −0.001290 ETH (negative = beat mid, valid for RFQ) | [ ] |
| Gas | 0.000002 ETH ($0.0041) | [ ] |
| all-in cost | −0.001290 ETH | [ ] |
| Reconciliation | LP + Agg + Slip = 0.000000 + 0.000000 + (−0.001290) = −0.001290 = −0.001290 all-in | [ ] |

**Notes:**
_________________________________________________

---

## Txn #2 — Odos (stableswap venue, ETH-settled)

**Basescan:** https://basescan.org/tx/0x89628ee8e6b3a1b7c4c8ab8af5a5752c6de2ba7024ea0ff78a155a044c59aa8c

**Size:** 15.032583 WETH / 25400.00 USDC (mid 1681.79) — buy_weth, settled ETH, PURE

| Claim | Expected | Confirmed? |
|-------|----------|------------|
| Aggregator | Odos | [ ] |
| Route purity | PURE (third tokens stay internal to venues, not through hub) | [ ] |
| Trader USDC leg | Trader sends ~$25,400 USDC | [ ] |
| Trader WETH/ETH leg | Trader receives ETH (buy-side, ETH-settled) | [ ] |
| Agg-fee vault transfer | None — `0xe093…` is a stableswap venue (receives USDC, pays USDT), NOT a fee sink. The all-token gate excludes it because it has a nonzero USDT delta. Confirm on Basescan that `0xe093…` emits a USDT transfer out. | [ ] |
| Key verification: `0xe093…` third-token delta | Confirm `0xe093…` (`0xe093c7056f1d5f46f88de7bf366b3569e1839778`-area) has both USDC inflow AND a third-token (USDT) outflow in the Transfer logs | [ ] |
| Pool fee tier(s) | V3 pool(s) — verify fee tier via `fee()` on each pool contract | [ ] |
| LP fee | 0.000075 ETH | [ ] |
| Agg fee | 0.000000 ETH (the stableswap venue is correctly excluded) | [ ] |
| Slippage | 0.070277 ETH (positive = worse than mid) | [ ] |
| Gas | 0.000024 ETH ($0.0403) | [ ] |
| all-in cost | 0.070368 ETH | [ ] |
| Reconciliation | LP + Agg + Slip = 0.000075 + 0.000000 + 0.070277 = 0.070352 ≈ 0.070368 all-in | [ ] |

**Notes:**
_________________________________________________

---

## Txn #3 — Velora (explicit fee vault, multi-hop V3, ETH-settled)

**Basescan:** https://basescan.org/tx/0xce4dbac465b0538d1d484f2c1c0553861301248dbb6596dd448adfbfc6d31686

**Size:** 7.996000 WETH / 12830.30 USDC (mid 1609.48) — sell_weth, settled ETH, PURE

| Claim | Expected | Confirmed? |
|-------|----------|------------|
| Aggregator | Velora | [ ] |
| Route purity | PURE (third tokens like cbBTC stay internal to venues) | [ ] |
| Trader USDC leg | Trader sends ~$12,830 USDC (sell direction) | [ ] |
| Trader WETH/ETH leg | Trader receives ETH (ETH-settled) | [ ] |
| Agg-fee vault transfer | 17.59 USDC → `0x00700052c0608f670705380a4900e0a8080010cc` (= 0.010963 ETH). The ~$0.77 routing dust at `0x6652` is excluded (below the dust floor = max($1.00, 1 bps of notional)) and surfaced as a NEEDS REVIEW flag. | [ ] |
| Pool fee tier(s) | Multiple V3 pools — verify fee tier(s) via `fee()` on each pool contract | [ ] |
| LP fee | 0.010195 ETH | [ ] |
| Agg fee | 0.010963 ETH (known vault only; $0.77 routing dust at `0x6652` excluded — NEEDS REVIEW) | [ ] |
| Slippage | 0.003150 ETH | [ ] |
| Gas | 0.000952 ETH ($1.5325) | [ ] |
| all-in cost | 0.024316 ETH | [ ] |
| Reconciliation | LP + Agg + Slip = 0.010195 + 0.010963 + 0.003150 = 0.024308 ≈ 0.024316 all-in | [ ] |

**Notes:**
_________________________________________________

---

## Txn #4 — Fabric (V3 + V4, IMPURE route)

**Basescan:** https://basescan.org/tx/0x5bd00e22bab13fdf083525bb68633e6bf5dd581ae00a0f8b89329ada7065c2e9

**Size:** 0.895788 WETH / 1403.71 USDC (mid 1567.01) — sell_weth, settled WETH, **IMPURE**

| Claim | Expected | Confirmed? |
|-------|----------|------------|
| Aggregator | Fabric | [ ] |
| Route purity | IMPURE — third token (CLAWD `0x9f86db9f…`) passes through the Fabric hub router `0x7c137a37742437d2212b7bd873ed135b5c4c61da`. Route: WETH→CLAWD→USDC (or reverse). | [ ] |
| Third token through hub | Confirm Fabric router (`0x7c137a37…`) has a CLAWD transfer (in or out) in the logs | [ ] |
| Trader USDC leg | Trader sends/receives USDC (~$1,404) | [ ] |
| Trader WETH/ETH leg | Trader sends/receives WETH | [ ] |
| Agg-fee vault transfer | None (agg fee = 0) | [ ] |
| Pool fee tier(s) | V3 pool + V4 PoolManager (`0x498581ff…`) — both participate. LP/slippage not separable for IMPURE routes. | [ ] |
| LP fee | n/a (IMPURE — not separable) | [ ] |
| Agg fee | 0.000000 ETH | [ ] |
| Slippage | n/a (IMPURE — not separable) | [ ] |
| Execution | 0.000002 ETH (= all-in − agg) | [ ] |
| Gas | 0.000004 ETH ($0.0069) | [ ] |
| all-in cost | 0.000002 ETH | [ ] |
| Reconciliation | Agg + Exec = 0.000000 + 0.000002 = 0.000002 = 0.000002 all-in | [ ] |

**Notes:**
_________________________________________________

---

## Txn #5 — KyberSwap (multi-hop V3, dynamic fees)

**Basescan:** https://basescan.org/tx/0x850df6157d218bfb6cdfc2bb35cb59da640c6795447c0a89484b781a12a5cfcf

**Size:** 8.096850 WETH / 13304.40 USDC (mid 1640.93) — sell_weth, settled WETH, PURE

| Claim | Expected | Confirmed? |
|-------|----------|------------|
| Aggregator | KyberSwap | [ ] |
| Route purity | PURE (third tokens like EURC stay internal to venues) | [ ] |
| Trader USDC leg | Trader sends/receives USDC (~$13,300) | [ ] |
| Trader WETH/ETH leg | Trader sends/receives WETH | [ ] |
| Agg-fee vault transfer | None (agg fee = 0) | [ ] |
| Pool fee tier(s) | Multiple V3 pools — KyberSwap uses dynamic-fee pools (Algebra-style), so `fee()` at the trade block returns the fee at execution time, not a static tier. Verify by calling `fee()` on each pool at the block number. | [ ] |
| LP fee | 0.004170 ETH | [ ] |
| Agg fee | 0.000000 ETH | [ ] |
| Slippage | −0.015182 ETH (negative = venues beat mid, valid) | [ ] |
| Gas | 0.000011 ETH ($0.0172) | [ ] |
| all-in cost | −0.011004 ETH | [ ] |
| Reconciliation | LP + Agg + Slip = 0.004170 + 0.000000 + (−0.015182) = −0.011012 ≈ −0.011004 all-in | [ ] |

**Caveat (a):** trader may be mis-identified as the pool itself in the upstream
extraction — a selection issue, not a decomposition bug. Verify the trader address
is the actual EOA, not a pool contract.

**Notes:**
_________________________________________________

---

## Txn #6 — Relay (ETH-settled buy, highest agg fee)

**Basescan:** https://basescan.org/tx/0x8503cccf97055770c778183859da64a19983a9014185a29b0a30f6845cc1d86e

**Size:** 0.792541 WETH / 1320.46 USDC (mid 1659.06) — buy_weth, settled ETH, PURE

| Claim | Expected | Confirmed? |
|-------|----------|------------|
| Aggregator | Relay | [ ] |
| Route purity | PURE | [ ] |
| Trader USDC leg | Trader sends/receives USDC | [ ] |
| Trader WETH/ETH leg | Trader receives ETH (buy-side, ETH-settled) | [ ] |
| Agg-fee vault transfer | 5.41 USDC → `0xf70da97812cb96acdf810712aa562db8dfa3dbef` (= 0.003249 ETH) | [ ] |
| Pool fee tier(s) | V3 pool(s) — verify fee tier via `fee()` | [ ] |
| LP fee | 0.000032 ETH | [ ] |
| Agg fee | 0.003249 ETH (Relay's fee is the largest in the handful) | [ ] |
| Slippage | 0.000085 ETH | [ ] |
| Gas | 0.000005 ETH ($0.0079) | [ ] |
| all-in cost | 0.003366 ETH | [ ] |
| Reconciliation | LP + Agg + Slip = 0.000032 + 0.003249 + 0.000085 = 0.003366 = 0.003366 all-in | [ ] |

**Notes:**
_________________________________________________

---

## Txn #7 — 1inch (clean single-V3 hop, WETH-settled)

**Basescan:** https://basescan.org/tx/0x15290f78247cf614f0531f8075d0949f572ae7ae22fd7bb19409f21435b9e282

**Size:** 0.810170 WETH / 1409.10 USDC (mid 1739.30) — sell_weth, settled WETH, PURE

| Claim | Expected | Confirmed? |
|-------|----------|------------|
| Aggregator | 1inch | [ ] |
| Route purity | PURE (clean single-V3 hop, 1 bps pool) | [ ] |
| Trader USDC leg | Trader sends/receives USDC (sell direction) | [ ] |
| Trader WETH/ETH leg | Trader sends/receives WETH (WETH-settled) | [ ] |
| Agg-fee vault transfer | None (agg fee = 0). Clean single-V3 hop. | [ ] |
| Pool fee tier(s) | Single V3 pool — verify `fee()` returns 100 (= 1 bps). | [ ] |
| LP fee | 0.000009 ETH | [ ] |
| Agg fee | 0.000000 ETH | [ ] |
| Slippage | 0.000011 ETH | [ ] |
| Gas | 0.000005 ETH ($0.0081) | [ ] |
| all-in cost | 0.000020 ETH | [ ] |
| Reconciliation | LP + Agg + Slip = 0.000009 + 0.000000 + 0.000011 = 0.000020 = 0.000020 all-in | [ ] |

**Notes:**
_________________________________________________

---

## Summary checklist

| # | Agg | Reconciled? | All claims confirmed? |
|---|-----|-------------|----------------------|
| 1 | 1inch | [ ] | [ ] |
| 2 | Odos | [ ] | [ ] |
| 3 | Velora | [ ] | [ ] |
| 4 | Fabric | [ ] | [ ] |
| 5 | KyberSwap | [ ] | [ ] |
| 6 | Relay | [ ] | [ ] |
| 7 | 1inch | [ ] | [ ] |

**Sign-off:** all 7 confirmed → decomposition method is validated for pipeline
integration. Any unchecked box or discrepancy must be resolved before proceeding.

**Reviewer:** ______________________  **Date:** _______________
