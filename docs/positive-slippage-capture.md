# Positive Slippage Capture (payout adapters)

Investigation notes from 2026-07-28, recorded because the mechanism is invisible
in the current receipt and is a candidate feature. Trade under the microscope:
receipt **id 326**, tx `0x32b6fdfb3351304de58a8c3eedd0a7e0c1820d4505ea5bdb5d8cdbe764aede68`
(USDC→ETH, $12.07, aggregator recorded as `Nordstern`).

## The mechanism

Some aggregator routes end at a **payout adapter** — a small contract that takes
custody of the route's output token and delivers a **caller-specified amount** to
a recipient, keeping whatever surplus it is holding.

The adapter in this trade is `0x9a972D8C3a8DD27E5811CbCB75EbdaC924FB53a1`
(unverified, 4,663 bytes). Its entry point, decoded from the call trace:

```
48d9eb36(address token, uint256 amount, address recipient, uint256 unwrapNative)
  → uint256 kept
```

It reads its own `balanceOf(token)`, optionally unwraps WETH→ETH
(`unwrapNative = 1`), sends exactly `amount` to `recipient`, and **returns the
amount it retained**. Other selectors on the contract — `balances(address)`,
`withdraw(address,uint256,address)`, `owner()`, `transferOwnership(address)` —
are the owner-side drain path for the accumulated surplus.

### Verified numbers for id 326

Retention confirmed against the raw WETH `Transfer`/`Withdrawal` logs, not just
the return value — they agree to the wei:

| direction | wei | counterparty |
|---|---:|---|
| IN | 3,261,917,386,275,916 | executor `0xe7dc2934…` |
| IN | 1,615,075,516,510,547 | pool `0x37ecd41f…` |
| IN | 1,605,452,779,327,539 | executor `0xe7dc2934…` |
| OUT (unwrap + pay) | 6,481,675,202,184,746 | the trader |
| **retained** | **770,479,929,256** | stays in the adapter |

`770479929256 wei` = 0.00000077 ETH = **$0.001435** = **1.1886 bps** of gross
output — and is exactly the `48d9eb36` return value.

The trader received precisely the quoted output amount. The route over-delivered
by 1.19 bps and the adapter kept the difference. **That is positive slippage
capture, not an explicit fee.**

### It is not a flat rake

Two cross-chain fills through the same adapter were traced; both retained
**zero**:

| tx entry point | `recipient` arg | kept |
|---|---|---:|
| Mayan: Fast MCTP `0xc1062b7c…` | Mayan: Fast MCTP | 0 |
| `0x11523ae8…` | deBridge Crosschain Forwarder `0x663dc15d…` | 0 |
| **id 326** (Nordstern router) | the trader's EOA | **770,479,929,256** |

Two samples is not proof that bridge fills always retain zero, but the surplus
is clearly route-dependent rather than a fixed bps. The adapter held ~7.84 WETH
of accumulated inventory mid-trade, consistent with skimmed surplus piling up.

## Attribution: the adapter is not Mayan

Basescan's internal-txn tab for the adapter is dominated by "Mayan: Fast MCTP"
and "Mayan: Forwarder", which reads at a glance as a Mayan contract. It is not.

- Mayan's own contracts are **verified and name-tagged**: Forwarder
  `0x337685fdaB40D39bd02028545a4FfA7D287cC3E2`, Fast MCTP
  `0xc1062b7c5dc8e4b1df9f200fe360cdc0ed6e7741`. The adapter is unverified and
  untagged.
- Mayan appears as the **`recipient` argument** — the adapter's job on most of
  its volume is handing Base-side swap output to a cross-chain bridge (Mayan,
  deBridge). id 326 is the unusual case where the recipient was a plain EOA.
- `owner()` is EOA `0x2bfd1fc5e25a8F55C2E849492ad7966EA8A0dd9E`. The deployer,
  EOA `0x80091c133dd8b69f08fab033e8ab10271fce0903`, **also deployed the executor
  `0xe7dc2934…`** used in id 326 — sibling contracts, ~16 deploys in 76 days.

So the adapter is aggregator-side infrastructure, and it rotates. Do not label
it "Mayan": that attributes the retained value to the wrong party.

**Consequence for curation:** the adapter is deliberately left unnamed. It is
unverified (no Basescan `ContractName`), it is replaced every few weeks, and any
label would be invented. It renders as a truncated address, which is the
intended "needs curation" cue. See `MANUAL_OVERRIDES` in
`packages/core/src/contractNames.ts` if that decision is ever revisited.

## How the receipt books it today

`buildFeeSinks` collects addresses that retain value and splits `aggFeeBps`
across them proportionally. For id 326 that yields two sinks:

| sink | retained | attributed |
|---|---|---:|
| `0x238a3588…` (`Vault`) | 0.0034 USDC | 2.81 bps |
| `0x9a972d8c…` (adapter) | 0.0014 USDC | 1.19 bps |

Both land under the **aggregator fee** heading. That is defensible — the value
really was retained by the aggregator's infrastructure — but it conflates two
different economics:

- an **explicit fee**, taken as a declared cut, and
- **retained positive slippage**, which exists only because the route beat its
  own quote.

The MVP thesis is that the receipt says *what happened*, not whether the trade
was good. Retained surplus is a distinct thing that happened, and folding it
into "fee" loses that.

## Feature sketch (not built)

Surfacing this as its own concept would need:

1. **Detection.** A payout adapter is recognisable structurally: it receives the
   output token, transfers a smaller amount onward to the trade beneficiary in
   the same call frame, and keeps the remainder. The retained amount is the
   surplus. No new RPC — the callTracer trace `analyzeTransaction` already
   fetches carries all of it.
2. **Distinguishing surplus from fee.** The signal is that the delivered amount
   is a *caller-supplied argument* while the received amount is whatever the
   route produced. A declared fee is usually a bps of notional and is stable
   across trades; surplus is not. Sampling one adapter across several trades
   (zero on bridge fills, 1.19 bps here) separates them empirically.
3. **Receipt surface.** A separate line rather than a fee sink — e.g. surplus
   retained by the router, shown alongside `Execution Delta`. It is part of the
   gap between quoted and mid-market execution, so it belongs near the delta
   rows, not in Cost Breakdown.
4. **Backfill.** Render-layer plus a new persisted column; existing rows would
   need `scripts/repopulateReceipts.mjs`.

Open question worth settling first: whether "the trader got exactly their quote
and the router kept the overage" should be presented as a *cost* at all. It is
not money out of the trader's pocket relative to the quote they accepted — but
it is value the route generated that they did not receive.

## Reproducing

```bash
# decode the payout call + retained amount for any tx
curl -s -X POST "$TCA_RPC_URL" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"debug_traceTransaction",
       "params":["<txhash>",{"tracer":"callTracer"}]}'
# then look for input starting 0x48d9eb36; args are (token, amount, recipient, unwrap),
# and the call's `output` is the wei retained.
```

Note: the free Etherscan V2 key **cannot** read the `account` module on Base
("Free API access is not supported for this chain"), so `txlistinternal` /
`getcontractcreation` are unavailable — use the RPC trace, or read the Basescan
HTML page, for internal transfers and creator lookups.
