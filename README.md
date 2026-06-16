# Fabric TCA Decoder

Passive TCA (transaction cost analysis) for aggregator-routed USDC/WETH swaps on Base. Discovers large third-party swaps, decodes them via `debug_traceTransaction`, and produces a five-component per-trade cost ledger.

## Stack

All TypeScript. Monorepo via npm workspaces.

```
fabric-tca-decoder/
├── configs/routers.json     Router registry (source of truth for trade discovery)
├── docs/
│   ├── spec.md              The MVP specification this project implements
│   └── notes-from-v1.md     Lessons learned from the v1 aggregator-benchmark project
├── packages/
│   ├── db/                  Drizzle schema for Postgres
│   ├── ingest/              eth_getLogs poller, transaction decoder, TCA calculator
│   └── dashboard/           Next.js — table-anchored UI salvaged from v1
```

## Quick start

```bash
cp .env.example .env          # fill in TCA_DATABASE_URL + TCA_RPC_URL
npm install
npm run db:migrate            # apply Drizzle migrations
npm run ingest                # start the poller (foreground; wrap in caffeinate for overnight)
npm run dev                   # dashboard (separate terminal)
```

## v1 carryover

The previous project (Fabric aggregator benchmark) is tagged `tca-v1-aggregator-benchmark` in the sibling `fabric-tca` repo. See `docs/notes-from-v1.md` for what carries over: verified router contracts, methodology learnings, workflow primitives. None of the v1 code is imported here — the dashboard chrome (Header, NavTabs, ThemePicker, theme, fonts, table patterns) was copied as a starting point.

## Architecture notes

- **Postgres over SQLite.** The spec calls SQLite "MVP" but a near-term dashboard makes concurrent reads desirable from day one. Postgres avoids the migration tax later.
- **TypeScript end-to-end.** Spec defaulted to Python; we chose TS so the ingest pipeline and the dashboard share types via Drizzle and don't drift. `debug_traceTransaction` is a raw viem `request()` call.
- **Archive node required.** `debug_traceTransaction` and historical `eth_call` need Alchemy archive (or QuickNode equivalent). The free tier returns "Requested resource not found" on either.
