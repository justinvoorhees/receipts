# Fabric TCA Decoder

On-demand TCA (transaction cost analysis) for aggregator-routed swaps on Base. Paste a transaction hash, get a receipt: who routed it, which venues actually filled it, and what each leg cost.

The receipt answers **"what happened in this trade"** — not "was this a good trade". It makes no fair-value claim. See `docs/spec.md` for the MVP spec and its intentional deviations.

## What a receipt contains

- **Route** — the trade decomposed into legs, each tagged with its venue (Uniswap V3/V4, Aerodrome, Algebra forks, RFQ market makers…) and, where a leg was executed by another aggregator, that aggregator's name.
- **Cost breakdown** — aggregator fee (one linked Basescan line per fee sink), LP fee, price impact, gas.
- **Execution Delta** — realized price vs. a single pool-relative Market Price ruler, in USD and bps.
- **Pricing tier** — `full` / `estimated` / `none`, with a methodology descriptor saying how the Market Price was derived. Legs that can't be priced (RFQ fills, fee-on-transfer tokens) are left unpriced rather than guessed at.

Two tabs: **Receipts** (the search + receipt) and **History** (every receipt persisted so far, sortable).

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
│   ├── db/                  Drizzle schema + migrations for Postgres
│   └── dashboard/           Next.js app (App Router)
└── scripts/
    ├── repopulateReceipts.mjs   Re-analyze persisted receipts in place
    └── marketMidSnapshot.mjs    A/B live-compute market mids (pricing regression checks)
```

## How it works

1. The dashboard POSTs the hash to `/api/receipts`, which calls core's `analyzeTransaction`.
2. Core pulls the transaction, its receipt logs, and one `debug_traceTransaction` callTracer trace via viem.
3. It resolves the aggregator (registry lookup on `tx.to`, then settler resolvers), and the trader — re-anchoring on the trade beneficiary when `tx.from` is a relayer or solver.
4. It reconstructs the route as a conserved DAG, splits it into legs, and classifies each leg's venue by event topic → `factory()` → curated address.
5. It reads a Market Price per pair from the deepest qualifying pool, corroborated (never moved) by an oracle, and derives per-leg fees and price impact.
6. The result is persisted to the `receipts` table. A second paste of the same hash is served from the cache.

Aggregator and venue identity live in `configs/`, resolved **at read time** — growing a registry retroactively attributes existing history with no repopulation.

## Quick start

```bash
cp .env.example .env          # TCA_DATABASE_URL + TCA_RPC_URL are required
npm install
npm run db:migrate            # apply Drizzle migrations
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
| `TCA_DATABASE_URL` | Postgres. Required by the dashboard and the scripts. |
| `TCA_RPC_URL` | Base archive endpoint. Required. |
| `APP_ACCESS_PASSWORD` | **Required.** Shared password for the access gate. Without it the app serves nothing (503). |
| `APP_SESSION_SECRET` | **Required.** Signs the session cookie. Rotate to log every session out. `openssl rand -base64 32`. |
| `RATE_LIMIT_ANALYSES_PER_MIN` | Optional, default 20. Fresh receipt analyses per IP — the one that guards the RPC bill (~40 calls each). |
| `RATE_LIMIT_REQUESTS_PER_MIN` | Optional, default 120. Cheaper ceiling covering cache hits. |
| `RATE_LIMIT_DIAGNOSIS_PER_MIN` | Optional, default 30. Covers `GET /?tx=`, which spends RPC on a cache miss. |
| `ETHERSCAN_API_KEY` | Optional. Names verified fee-sink contracts on the receipt; without it those lines fall back to a generic label. |
| `DUNE_API_KEY` | Currently inert — `DUNE_ETH_USD_QUERY_ID` in `duneOracle.ts` is still `0`. |

## Gotchas

- **Never run `next build` over a live dev server.** The root `npm run build` writes into the same `.next` that `next dev` owns; the app then renders unstyled and looks like a CSS bug. To compile core, use `npx tsc --build`.
- **Archive node + Trace Mode required.** `debug_traceTransaction` and historical `eth_call` need an archive plan. We run QuickNode, where the trace methods additionally require the paid **Trace Mode** add-on — it is off by default, and without it the decoder yields no receipts at all rather than degrading. Free tiers return "Requested resource not found".
- **QuickNode caps `eth_getLogs` at a 10,000-block range.** Past that it returns HTTP 413 regardless of how few logs match — a range limit, not a size limit. Any new log scan must page in ≤10k chunks; see `CHUNK_BLOCKS` in `refreshReactors.ts`.
- **Registry edits need a server restart**, not a browser refresh — configs are read from disk at module load.
- **Persisted receipts go stale silently.** The API route never recomputes a cache hit, so a change to pricing or decomposition leaves old rows on the old logic. Run `scripts/repopulateReceipts.mjs` after any such change; never patch columns onto stale rows.
- **RPC e2e tests skip without `TCA_RPC_URL` exported.** `source .env` alone does not export — use `set -a && source .env && set +a`. A bare `npm test` is a weaker gate than it looks.
- **The access gate fails closed.** `middleware.ts` covers pages *and* API routes; with `APP_ACCESS_PASSWORD` or `APP_SESSION_SECRET` unset, every request returns 503. That is deliberate — a missing env var must not silently degrade into a public app. Gating only a page would leave `/api/receipts` open, which is where both the cost and the destructive `DELETE` live.
- **⚠️ Rate-limit counters live in process memory.** Correct on a single container (Railway). On a multi-instance or serverless deploy each instance keeps its own counters, so the effective limit multiplies by the instance count and the gate quietly weakens. Swap the store in `lib/rateLimit.ts` for Redis before scaling out — the interface exists so call sites do not change.
- **`user_id` is NULL on every row, and that used to void the unique index.** Postgres treats NULLs as distinct, so `UNIQUE(user_id, tx_hash, chain_id)` never fired. It is now `NULLS NOT DISTINCT` (migration `0001`), which means concurrent inserts of the same hash now *conflict* instead of duplicating — the API route resolves that to the winning row.

## v1 carryover

The previous project (Fabric aggregator benchmark) is tagged `tca-v1-aggregator-benchmark` in the sibling `fabric-tca` repo; `docs/notes-from-v1.md` records what carried over — verified router contracts, methodology learnings, workflow primitives. No v1 code is imported. The dashboard chrome (Header, NavTabs, ThemePicker, theme, fonts, table patterns) was copied as a starting point.

## Architecture notes

- **Postgres over SQLite.** The spec calls SQLite "MVP", but a dashboard makes concurrent reads desirable from day one.
- **TypeScript end-to-end.** The spec defaulted to Python; a single language keeps the analysis engine and the dashboard sharing types via Drizzle. `debug_traceTransaction` is a raw viem `request()` call.
- **Core is RPC-pure.** `analyzeTransaction` talks to the chain and nothing else. Anything needing a third-party API (verified contract names) lives on the persist path, not in the analysis.
- **Client components import pure helpers from `@fabric-tca/core/pure`,** not the barrel — the barrel reaches `fs` and breaks the webpack build.
