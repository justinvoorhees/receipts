# Analysis scripts

Read-only measurement scripts backing `docs/attribution-worklist.md`. Nothing
here writes anywhere. They exist so the numbers in that document can be
**re-measured rather than trusted** — several figures in there are from small
samples.

All read from the frozen QA corpus (`docs/qa/corpus.json`, via `loadCorpus()`
in `_env.mjs`) rather than a live table — the database this was once dumped
from is gone. `TCA_RPC_URL` is read the same way, from the repo-root `.env`
directly, because `source .env` does not export by itself.

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
| `rpcProviderAB.mjs` | **yes** | Do two RPC providers produce identical receipts? Re-analyzes the corpus twice on the SAME code, once per provider, and diffs the full `Receipt` — not just the watched columns. Run `--control` first: it A/As one provider against itself, so anything it flags is non-determinism rather than the provider. Needs `TCA_RPC_URL_PREV`. |

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
- **Coverage is defined in core, not here.** `priceImpactCoverage` and
  `isFullyPriced` live in `packages/core/src/receiptPure.ts` and are re-exported
  through `_env.mjs`, so these scripts and the receipt UI can never disagree.
  Run `npx tsc --build packages/core` after editing them.
