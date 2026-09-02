# Feasibility: Ethereum mainnet receipts

**Status:** ANALYSIS ONLY — 2026-08-31. Read-only spike, no code written, nothing
built. Findings are file:line accurate as of `177f682` and will drift; re-check
before acting.

**Verdict:** Feasible. The URL/UI layer was genuinely built for this and is ~80%
done. The decode core was not — it is Base-baked at ~15 module-level constants
and 4 process-wide config singletons, and `chainId` is decorative below
`analyzeTransaction`. Separately there is a real venue-coverage gap that belongs
to mainnet's market, not to this code.

---

## Seam 1 — URL / UI layer: mostly done, and the tripwire is stale

`app/tx/[chain]/[hash]/` exists. `resolveChainParam` (`lib/chains.ts:44`) handles
slug, numeric alias and case canonicalization in one redirect. `loadReceipt(chain,
hash)` already takes the chain. Registering mainnet in `CHAINS` is one line.

The `CHAINS.length === 1` tripwire in `lib/chains.test.ts` names three debts.
**All three have drifted:**

1. **Debt 1 is dead.** `lib/queries.ts` no longer exists — the database removal
   took it. The failure message still tells you to fix `getReceiptByHash`.
2. **Debt 2 undercounts, and misses one.** It says 8 explorer links; there are
   **9**: `receiptView.tsx:230`, `receiptDisplay.tsx:386,400,697`,
   `receiptRows.tsx:162,335,361,541,617`. It does not name a 10th `DEFAULT_CHAIN`
   leak: `lib/alerts.ts:174` builds the **Slack receipt URL** with
   `DEFAULT_CHAIN`, so a mainnet alert would link to a Base receipt path. That
   site documents its own shortcut in a comment (`alerts.ts:171`).
   (`receiptUrl.ts:59,82` also use `DEFAULT_CHAIN`, but legitimately — they are
   the search box's default, not a row's chain.)
3. **Debt 3 is already satisfied.** `NAMED_CHAINS`
   (`components/receipt/priceFormat.ts:159`) already contains `1: 'Ethereum'`.

Cost: roughly half a day, threading `chain` through helper signatures. Mechanical
but wide.

⚠️ Update the tripwire message when these are paid — it is currently misleading
in both directions.

## Seam 2 — config registries: chain-blind singletons

All six `configs/*.json` are Base-only by content. Four load at **module scope
with top-level await** into process-wide constants:

| Singleton | Site |
|---|---|
| `REACTORS`, `ENTRY_POINTS` | `analyzeTransaction.ts:41-42` |
| `BRIDGES` | `classifyTransaction.ts:18` |
| `ROUTERS` | `tagging.ts:52` |
| `SETTLERS` | `resolveAggregator.ts:48` |

Each JSON carries a `chainId: 8453` field that **nothing reads**. These must
become chain-keyed. Mechanical, but it is a load-order change across five files
and every `load*Registry` takes a bare path today.

Content splits cleanly:

- `settlers.json` is **generated** (`npm run settlers:refresh`) — repoint at
  mainnet's 0x Deployer and re-run.
- `reactors` / `entrypoints` / `bridges` / `makers` are human-curated
  attestations needing per-entry mainnet verification, exactly as their
  `_comment` blocks demand.
- `routers.json` is partly free: 1inch (`0x1111...2a65`) and KyberSwap
  (`0x6131...37b5`) use the same address on every chain. Odos, Velora and others
  differ.

⚠️ **CoW Protocol is not a config row.** It is a top-tier mainnet aggregator that
settles in *batches* — one `GPv2Settlement` tx fills many users' orders.
`extractEndpoints` (`endpoints.ts`) anchors on a single trader under a strict
clean-2-token net-flow rule; a batch tx has N traders and will not produce a
clean 1-in/1-out for any beneficiary. This is a beneficiary-anchoring design
problem, not an allowlist entry. Likely the single largest new decode risk.

## Seam 3 — decode core: the actual work

### What is already portable (do not "fix" these)

- `marketPrice.ts` — pure reducer over estimators, no chain awareness.
- `routeGraph.ts` / `decomposeRoute.ts` — DAG reconstruction.
- `endpoints.ts` — net-flow beneficiary anchoring.
- `tradeFees.ts`.
- Route decomposition is driven by **9 topic0 constants**
  (`routeVenueScan.ts:18-44`), and topic0 is chain-independent by construction.
- Curve is already **topic-detected** (`CURVE_TOKEN_EXCHANGE_TOPIC`) rather than
  address-listed — a real head start for mainnet.

### What is baked

| Site | What |
|---|---|
| `receiptPure.ts:18-21` | `USDC`/`USDBC`/`DAI`/`WETH` as bare exported consts, feeding `STABLECOINS`, `isStable`, `anchorRank` — the depth-floor ruler and anchor ranking. Consumers import the constant, not a lookup. |
| `poolFamilies.ts:47-52` | `POOL_FAMILIES` — 4 Base factories, module-level array, **no chain axis**. |
| `poolDiscovery.ts:33-45` | The *same* four factories again (duplicated), plus `V4_STATE_VIEW`, `V4_POOL_MANAGER`; `:225` `INFINITY_CL_POOL_MANAGER`. |
| `venueClassification.ts:3-33` | 11 factory→`VenueType` entries, all Base. |
| `benchmarkPrice.ts:24-31` | Three hardcoded Base WETH/USDC pools + Base Chainlink ETH/USD feed. |
| `tokenOracle.ts:25` | One entry — Base WBTC → BTC/USD. |
| `aggregatorSignatures.ts:12` | A Base `WETH` const. |
| 14 sites, 8 modules | `createPublicClient({ chain: base, … })` — `routeReaders` ×7, `pricing` ×2, `decomposeTrade`, `tokenOracle`, `benchmarkPrice`, `analyzeTransaction`, `classifyTransaction`. Every one takes only `rpcUrl: string`. |

⭐ **The architecture for fixing this already exists in the repo.**
`rpcSession.ts` solved exactly this shape — its own docstring describes
"fourteen `createPublicClient` sites across eight modules, none of which should
have to know they are part of a larger decode" — by putting the memo in an
`AsyncLocalStorage` scope instead of twenty signatures. A `ChainConfig` (anchors,
pool families, venue table, singletons, benchmark pools, oracle feeds, RPC URL)
resolved once inside `runInDecodeSession` and read ambiently is the same move,
already proven here, and far cheaper than threading `chainId` through the call
graph.

Note `analyzeTransaction` **already receives** `chainId` and passes it to
`priceReceipt` — but pricing only stamps it onto the `Receipt`. Nothing
downstream reads it.

⚠️ Anchor tokens genuinely change shape on mainnet: no USDbC, and USDT is
dominant in a way it is not on Base.

## Seam 4 — RPC and cost

`TCA_RPC_URL` is a single string with no per-chain map.

Mainnet needs its own endpoint at the **expensive tier**: `debug_traceTransaction`
with `callTracer` + `withLog` (paid Trace Mode) **and** archive state for the
slot0 / `getReserves` / `fee()` reads at block N−1. Mainnet archive+trace costs
materially more than Base's.

Against that cost model: a receipt is **~130 RPC calls / ~1.9s** for a 10-leg
trade (post-`perf/decode-latency`, merged as `710d2cb`; the pre-fix figures were
290 calls / 10.3s, and the "~40 calls" still quoted in several docstrings was
always fiction). Nothing is cached — `loadReceipt` re-analyzes on every view —
and the global hourly ceiling on `/tx` is the only thing bounding the bill.
Mainnet does not change the call count; it changes the unit price, on a model
that is already uncapped per transaction.

⚠️ QuickNode's 10,000-block `eth_getLogs` range cap already silently broke V4
pool-key resolution once, and only `scripts/analysis/rpcProviderAB.mjs` caught
it. Mainnet's block density makes range-scanning strictly worse.

## The mainnet market gap

The 18 `VenueType`s are Base's order book. Mainnet's differs:

- **Balancer v2/v3 — zero support.** Vault-based: one contract custodies
  everything and emits `Swap(bytes32 poolId, …)`. Structurally the V4 / Pancake
  Infinity pattern, so the `replacesVenue` machinery applies — but it is a new
  family needing its own `getLegMidAtBlock` branch. ⚠️ Adding a `VenueType`
  *without* that branch silently **nulls price impact** (the Pancake Infinity
  lesson).
- **Curve crypto pools** (tricrypto / twocrypto) — `routeVenueScan.ts:40`
  already notes these emit a different event than the StableSwap `TokenExchange`
  it scans. Negligible on Base; not on mainnet.
- **CoW Protocol** — see Seam 2.
- Aerodrome / BaseSwap / Hydrex become dead weight. Harmless, but the factory
  tables go chain-conditional.

⚠️ Balancer, CoW and Curve-crypto prevalence here are **general knowledge, not
measured against this decoder**. They are the hypothesis the probe below exists
to test.

---

## Recommendation

Do not frame the first move as "add mainnet." Frame it as **make the chain a
parameter, still shipping Base only** — `ChainConfig` on the decode session,
chain-keyed registries, tripwire intact, zero behaviour change verified with
`decodeGolden.mjs` against the case set. That is the honest prerequisite, it is
independently valuable, and it is verifiable *because* there is a Base baseline
to regress against. Rough shape: 1–2 weeks. Mainnet is then a second
`ChainConfig` plus registry curation plus the venue gaps.

**But first, a one-day decode-rate probe.** Point a throwaway script at ~50
mainnet aggregator transactions with a mainnet RPC and count `analyzeTransaction`
outcomes bucketed by `FailureReason`. This repo's history is emphatic that
inferring from shape lies — Relay was "inferred 48%, measured 18%", and the
QuickNode migration passed a green suite while 11 of 63 receipts were wrong. The
probe is the difference between "the venue gap costs 5%" and "it costs 40%", and
that number decides whether this is a two-week job or a quarter.

### Sequencing against the batch-analysis idea (2026-08-31)

Asked whether a large-scale "decode many txs, analyse for trends" system should
come before or after mainnet. Recommendation: **determinism → analysis on Base →
mainnet.**

- ⚠️⚠️ **`transient-rpc-silently-degrades-receipts` blocks the analysis idea far
  harder than it blocks mainnet.** Concurrent decodes of the same tx produce
  different receipts with no flag (`allInCostBps` 101 → 5012; leg type
  `aerodrome_cl` → `univ3`). A batch system reaches for concurrency immediately
  (serial is ~3.4s/receipt), the corruption is a silent outlier generator, and
  aggregate statistics are exactly what outliers destroy. Not filterable
  post-hoc — there is no `DEGRADED_READ` flag.
- The analysis layer is what **measures** whether mainnet is worth doing. Build
  it second and every chain-blindness debt gets paid once, informed by what it
  actually needs; build it after mainnet and it gets built twice.
- Mainnet receipts will have systematically **worse attribution coverage** than
  Base ones. Aggregating two chains with different coverage profiles, before the
  tooling exists to see coverage, yields a trend that is really a chain-mix
  artifact.
- Counter-argument, unresolved: if the question being asked is only interesting
  at mainnet liquidity, Base alone may not be a compelling dataset.

## Not investigated

- Whether mainnet's aggregator mix is actually covered by `routers.json` — no
  addresses were verified on-chain.
- Concrete mainnet addresses for any factory, singleton, feed or anchor token.
  None are recorded here on purpose; the repo's convention is "confirmed
  on-chain" and nothing here was.
- Whether the `/qa` and rate-limiting surfaces need per-chain treatment.
- Cost modelling beyond "mainnet archive+trace is more expensive."
