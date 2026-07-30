# Analysis scripts

Read-only measurement scripts backing `docs/attribution-worklist.md`. None of
them write to the database. They exist so the numbers in that document can be
**re-measured rather than trusted** — the corpus grows, and several figures in
there are from small samples.

All read `TCA_DATABASE_URL` / `TCA_RPC_URL` from the repo-root `.env` directly
(via `_env.mjs`), because `source .env` does not export by itself.

Some need `packages/core/dist` — run `npx tsc --build packages/core` first.
⚠️ Never `npm run build` while a dev server is running; it writes into the same
`.next` and the app renders unstyled.

| script | needs RPC | answers |
|---|:-:|---|
| `attributionCoverage.mjs` | no | What fraction of each route did we actually price? Both dimensions, plus the `.some()`/`.every()` subtraction bug. **The prototype for worklist item 1.** |
| `unpricedCauses.mjs` | no | *Why* is each leg unpriced? Splits RFQ / not-decomposed / clamped / unexplained, and groups unpriced legs by venue — this is what surfaced the V4 PoolManager reader bug. |
| `reconResidual.mjs` | no | How far apart are the reference-pool and route-relative rulers, and why `reconResidualBps ≈ slippage_bps` is algebra rather than coincidence. |
| `blastRadius.mjs` | no | If every fix on the worklist landed, how many bps actually move? (Answer: almost none.) |
| `referencePoolInRoute.mjs` | **yes** | Is the Market Price ruler even measuring a pool this trade touched? |
| `preTxRulerError.mjs` | **yes** | Is the N−1 block lag costing us anything (no), and what did the trade itself move (the free "own footprint" number)? |

## Baselines at 2026-07-30 (62 receipts with `route_legs`)

```
coverage        LP fee 76.6% · price impact 83.5% (notional-weighted)
subtraction     13 receipts no leg priced · 7 SILENTLY WRONG · 42 correct
recon residual  median 17.41 · p90 183.75   |slippage| p90 183.68  ← same quantity
blast radius    4 receipts / $2,913 can shift; RFQ $74,969 can never
ruler error     median 0.00 bps (the N−1 lag is NOT the problem)
own footprint   median 2.96 bps, max 586.7
reference pool  in the route only ~20% of the time
```

## Reading them honestly

- **Small samples.** The reference-pool and pre-tx figures came from 20-receipt
  and 75-leg samples. Raise `--limit` before quoting a percentage.
- **The tail is contaminated.** The worst rows are `conf=low` and several carry
  `notional_usd` of $0–$3. Trust medians, not maxima.
- **Test `feeTierBps > 0`, never `!= null`.** A zero tier passes a null check and
  reads as "measured" — that artifact once produced a false "coverage is
  saturated" conclusion. Prefer the persisted `feeResolved` flag where present.
