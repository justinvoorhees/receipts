# Fabric TCA Decoder

On-demand TCA (transaction cost analysis) for aggregator-routed swaps on Base. Paste a transaction hash, get a receipt: who routed it, which venues actually filled it, and what each leg cost.

The receipt answers **"what happened in this trade"** — not "was this a good trade". It makes no fair-value claim. See `docs/spec.md` for the MVP spec and its intentional deviations.

## What a receipt contains

- **Route** — the trade decomposed into legs, each tagged with its venue (Uniswap V3/V4, Aerodrome, Algebra forks, RFQ market makers…) and, where a leg was executed by another aggregator, that aggregator's name.
- **Cost breakdown** — aggregator fee (one linked Basescan line per fee sink), LP fee, price impact, gas.
- **Execution Delta** — realized price vs. a single pool-relative Market Price ruler, in USD and bps.
- **Pricing tier** — `full` / `estimated` / `none`, with a methodology descriptor saying how the Market Price was derived. Legs that can't be priced (RFQ fills, fee-on-transfer tokens) are left unpriced rather than guessed at.

Paste a hash, get a receipt — computed fresh from chain data every time. Nothing is stored, so there is no history view.

## Stack

All TypeScript. Monorepo via npm workspaces.

```
fabric-tca-decoder/
├── configs/                 Curated registries — identity comes from here, never from event topics
│   ├── routers.json         Aggregator router addresses (Odos, 0x, KyberSwap, 1inch, Relay, …)
│   ├── settlers.json        Rotating-address settlers (0x Settler deploys)
│   ├── makers.json          RFQ market makers
│   ├── reactors.json        UniswapX reactors (human-curated; the Fill topic is not UniswapX-exclusive)
│   └── contractNames.json   Cached verified-contract names for fee sinks
├── docs/
│   ├── spec.md              The MVP specification this project implements
│   ├── known-issues.md      Live defect list
│   └── superpowers/         Per-feature design docs and implementation plans
├── packages/
│   ├── core/                Analysis engine — trace decoding, route decomposition, pricing
│   └── dashboard/           Next.js app (App Router)
└── scripts/
    └── marketMidSnapshot.mjs    A/B live-compute market mids (pricing regression checks)
```

## How it works

1. Navigating to `/tx/<chain>/<hash>` calls core's `analyzeTransaction` — a fresh analysis, every time.
2. Core pulls the transaction, its receipt logs, and one `debug_traceTransaction` callTracer trace via viem.
3. It resolves the aggregator (registry lookup on `tx.to`, then settler resolvers), and the trader — re-anchoring on the trade beneficiary when `tx.from` is a relayer or solver.
4. It reconstructs the route as a conserved DAG, splits it into legs, and classifies each leg's venue by event topic → `factory()` → curated address.
5. It reads a Market Price per pair from the deepest qualifying pool, corroborated (never moved) by an oracle, and derives per-leg fees and price impact.
6. The receipt is returned and rendered. Nothing is stored — a second paste of the same hash re-runs the whole analysis.

Aggregator and venue identity live in `configs/`, resolved **at read time** — growing a registry retroactively attributes existing history with no repopulation.

## Quick start

```bash
cp .env.example .env          # TCA_RPC_URL is required
npm install
npm run dev                   # dashboard on http://localhost:3000
```

| Script | |
|---|---|
| `npm test` | vitest, whole monorepo |
| `npm run typecheck` | `tsc --build` across workspaces |
| `npm run lint` | eslint (flat config) |
| `npm run aggregators:coverage` | print the registry's coverage gap against DefiLlama's Base aggregator volume |
| `npm run settlers:refresh` | regenerate `configs/settlers.json` from the 0x Deployer's Transfer logs (writes; review the diff) |
| `npm run reactors:refresh` | list UniswapX reactor candidates for curation (reports only — never writes) |

### Environment

| Var | |
|---|---|
| `TCA_RPC_URL` | Base archive endpoint. Required. |
| `RATE_LIMIT_ANALYSES_PER_MIN` | Optional, default 20. Fresh analyses per IP — the expensive path (~40 RPC calls each). Every hit is a fresh analysis now; there is no cache. |
| `RATE_LIMIT_ANALYSES_GLOBAL_PER_HOUR` | Optional, default 500. Circuit breaker across **all** clients — the only limit a distributed flood cannot walk around. |
| `RATE_LIMIT_DIAGNOSIS_PER_MIN` | Optional, default 30. Covers the diagnosis path on `GET /tx/<chain>/<hash>` when a hash doesn't decode as a swap, which spends RPC to explain why. |
| `ETHERSCAN_API_KEY` | Optional. Names verified fee-sink contracts on the receipt; without it those lines fall back to a generic label. |
| `DUNE_API_KEY` | Currently inert — `DUNE_ETH_USD_QUERY_ID` in `duneOracle.ts` is still `0`. |
| `ALERT_WEBHOOK_URL` | Optional. Slack/Discord incoming-webhook URL for incidents (the global spend ceiling), debounced to one message/hour. Unset ⇒ log-only. **Set on the deployment, not locally** — if this points at the same webhook production uses, a local receipt posts to the same channel as production traffic. |
| `ACTIVITY_WEBHOOK_URL` | Optional. Separate webhook URL, one message per newly generated receipt, not debounced. Independent of `ALERT_WEBHOOK_URL` — an unset URL never falls back to the other stream's URL. Same local-vs-production caveat as above. |
| `APP_BASE_URL` | Optional. Base URL used to build the receipt link in the activity webhook message. Without it the link is derived from the request's `Host` header, which is caller-controlled on this public endpoint. |

## Gotchas

- **Never run `next build` over a live dev server.** The root `npm run build` writes into the same `.next` that `next dev` owns; the app then renders unstyled and looks like a CSS bug. To compile core, use `npx tsc --build`.
- **Archive node + Trace Mode required.** `debug_traceTransaction` and historical `eth_call` need an archive plan. We run QuickNode, where the trace methods additionally require the paid **Trace Mode** add-on — it is off by default, and without it the decoder yields no receipts at all rather than degrading. Free tiers return "Requested resource not found".
- **QuickNode caps `eth_getLogs` at a 10,000-block range.** Past that it returns HTTP 413 regardless of how few logs match — a range limit, not a size limit. Any new log scan must page in ≤10k chunks; see `CHUNK_BLOCKS` in `refreshReactors.ts`.
- **Registry edits need a server restart**, not a browser refresh — configs are read from disk at module load.
- **RPC e2e tests skip without `TCA_RPC_URL` exported.** `source .env` alone does not export — use `set -a && source .env && set +a`. A bare `npm test` is a weaker gate than it looks.
- **The receipt tool is entirely public — there is no login, no gate, no protected route.** `GET /tx/<chain>/<hash>` is the only path that spends RPC, and it is open to anyone with the URL.
- **⚠️ Rate limiting is the only thing between an anonymous visitor and the RPC bill**, since every receipt is a fresh ~40-call analysis and needs no password. Per-IP limits are walkable by using more IPs — `RATE_LIMIT_ANALYSES_GLOBAL_PER_HOUR` is the circuit breaker that actually caps spend, and when it trips new analyses pause for *everyone*.
- **⚠️ Rate-limit counters live in process memory.** Correct on a single container (Railway). On a multi-instance or serverless deploy each instance keeps its own counters, so every limit — including the global ceiling — multiplies by the instance count and the protection quietly weakens. Swap the store in `lib/rateLimit.ts` for Redis before scaling out; the interface exists so call sites do not change.
- **`/qa/tx/<chain>/<hashes>` is dev-only and has no rate limiting at all.** It relies entirely on a `NODE_ENV !== 'development'` guard being the first statement in the route — deny-by-default, so a misconfigured `NODE_ENV` (anything other than exactly `'development'`, including an unset one defaulting to `'production'`) closes the route rather than opening it. It is also capped at 20 hashes per request. If the guard ever fails open regardless, it is an unmetered door to the RPC bill — run `scripts/smokeDeploy.mjs <url>` after every deploy for exactly that reason (manual; there is no CI wiring).

## v1 carryover

The previous project (Fabric aggregator benchmark) is tagged `tca-v1-aggregator-benchmark` in the sibling `fabric-tca` repo; `docs/notes-from-v1.md` records what carried over — verified router contracts, methodology learnings, workflow primitives. No v1 code is imported. The dashboard chrome (Header, NavTabs, ThemePicker, theme, fonts, table patterns) was copied as a starting point.

## Architecture notes

- **Receipts are computed on demand and never stored.** A mined transaction plus fixed pricing code is a pure function, so there is no state to keep — the trade-off is that a link shared with fifty people triggers fifty analyses, bounded only by the rate limits above. The only thing the service persists is log lines; a best-effort contract-name cache is written to the container's ephemeral filesystem and does not survive a deploy.
- **TypeScript end-to-end.** The spec defaulted to Python; a single language keeps the analysis engine and the dashboard sharing types directly. `debug_traceTransaction` is a raw viem `request()` call.
- **Core is RPC-pure.** `analyzeTransaction` talks to the chain and nothing else. Anything needing a third-party API (verified contract names) is enriched afterward, in `loadReceipt`.
- **Client components import pure helpers from `@fabric-tca/core/pure`,** not the barrel — the barrel reaches `fs` and breaks the webpack build.
