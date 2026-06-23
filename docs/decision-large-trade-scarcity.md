# Decision Needed: Large aggregator trades are scarce on Base

**For:** founding engineer · **From:** TCA build · **Date:** 2026-06-18
**TL;DR:** We implemented the tx-centric model you specified, validated it on-chain,
and ran router-centric discovery across all aggregators for the past 2 weeks.
Result: **large (≥$10k) USDC↔WETH/ETH aggregator trades essentially don't exist on
Base** (~900 in the whole 2-week window, near-zero for half the aggregators). This
is market structure, not a bug. We need a scope decision before spending more.

---

## What we built (per your guidance)

- **Tx-centric extractor**, not pool-centric. For each tx we take the trader's true
  input/output from the transfer set (net token deltas), ignore the pool, and
  compare realized price to the **market mid at that block** → all-in cost in bps.
  Spot-checked against Basescan (e.g. a $43.6k 1inch buy reconciles to the exact
  wei). Receipt-based, so cheap.
- **Router-centric discovery** (you asked for this): every tx that called each
  aggregator router over the last 2 weeks, via Blockscout (free; Etherscan v2 no
  longer covers Base on the free tier). Blocks 46,905,592–47,510,392.
- **Genuine-trade filter:** keep only txns whose true endpoints are USDC↔WETH (or
  USDC↔ETH); drop routing-hops (WETH mid-route), batches, and MM/JIT.

## What we found

**Discovery — 790,921 unique router calls in 2 weeks:**

| Aggregator | router calls |
|---|---|
| Velora | 294,368 |
| KyberSwap | 276,063 |
| Relay | 167,049 |
| 1inch | 26,974 |
| Fabric | 14,421 |
| Odos | 10,014 |
| Nordstern | 2,068 |
| 0x | 0 (inactive at registered Base address) |

**Pilot — 500/aggregator (3,500 txns) classified:**

| Class | n | share |
|---|---|---|
| Genuine USDC↔WETH | 957 | 27.3% |
| Genuine USDC↔ETH (aggregator unwraps WETH) | 180 | 5.1% |
| Routing-hop (WETH is a mid-route leg) | 1,450 | 41.4% |
| Ambiguous (batch / split / MM) | 184 | 5.3% |
| Other | 729 | 20.8% |

**The problem is size, not survival.** Genuine trades are ~32% of router calls —
but they're overwhelmingly dust. Median genuine trade size per aggregator: 1inch
**$11**, Fabric **$0**, Odos **$10**, Nordstern **$1**, Relay **$18**, KyberSwap
**$100**, Velora **$256**.

| Min size | genuine in sample (of 3,500) | extrapolated to full 2wk set |
|---|---|---|
| ≥ $1k | 55 (1.57%) | ~12,400 |
| ≥ $10k | **4 (0.11%)** | **~900** |

- The cost signal is only usable **≥ ~$1k**; below $100 the bps are garbage
  (notional too small — observed ±9,000 bps).
- We confirmed the obvious blind spot (users buying native ETH, where the
  aggregator unwraps WETH so our WETH filter would miss it). It's real (+5% of
  trades) but **also tiny — zero of those 180 ETH trades are ≥$10k.** It does not
  recover the large-trade population.
- At ≥$10k, only Velora/KyberSwap/Odos/1inch have *any* trades; Nordstern, Fabric,
  and Relay are dust-only and could never populate a trust matrix.

## The decision

The original thesis — rank aggregators by execution quality on meaningful USDC↔WETH
trades — doesn't have the data on Base at the $10k threshold. Pick a direction:

1. **Lower the threshold to ~$1k, stay on Base.** Real, clean-signal dataset
   (~12k trades/2wk), but effectively only 4 rankable aggregators, and trade sizes
   are small (execution differences will be tiny, gas-dominated). Harvest cost: the
   genuine ≥$1k trades are needles (1.6%), so either sample per aggregator or
   process most of the 790k (~12M CU) to collect them all.
2. **Pivot to Ethereum mainnet.** Large aggregator WETH flow lives on mainnet, not
   Base. If the product is about *large-trade* execution quality / aggregator trust,
   this is where the data is. Cost: re-point discovery + pricing at mainnet; same
   code, new addresses/pools.
3. **Extend the Base window** (e.g. 8–12 weeks) to accumulate more ≥$10k trades.
   Linear: ~900 per 2 weeks. CU-inefficient given the 0.11% hit rate.
4. **Reframe the product to the Base small-trade market** as it actually is.
   Honest to the data, but per-trade TCA below ~$1k is noisy and the "aggregator
   quality" story weakens.

## Recommendation

If the thesis is **large-trade execution quality**, Base can't support it now —
**pivot to mainnet (2)**, or accept **~$1k on Base with only ~4 aggregators (1)** as
an interim. (3) and (4) look weak: the former burns CU for a trickle, the latter
measures noise. We held all further CU spend pending your call.

## Specific questions
1. Which chain — stay on Base, or pivot to Ethereum mainnet for real large-trade volume?
2. What minimum trade size defines a "trade" worth scoring? ($10k is empirically dead on Base; ~$1k is the floor where the cost signal is clean.)
3. Should the extractor also count USDC↔native-ETH trades? (+5% of genuine volume; priceable from the WETH `Withdrawal` amount, no extra CU. Only worth building if we lower the threshold.)
4. Harvest strategy once scoped: sample per aggregator (cheap, representative) vs full-process the candidate set (complete, ~12M CU on Base).
