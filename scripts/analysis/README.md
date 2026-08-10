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
| `decodeProfile.mjs` | **yes** | Where does one decode's wall-clock go? Proxies the endpoint and reports total vs **distinct** calls, how much of the wall-clock had only one request in flight, and a timeline. The two numbers that matter: repeats are waste, and time-at-depth-1 is a serial loop. Needs no code change, so it profiles `main` as easily as a branch. |
| `decodeBench.mjs` | **yes** | How long does a decode take, end to end, serially — the number a visitor to `/tx` actually waits for. ⚠️ Noisy; confirm any conclusion with `decodeProfile.mjs`'s exact call count. |
| `decodeGolden.mjs` | **yes** | Does this refactor change any receipt? Captures all 62 corpus receipts to a file; run on two git refs and `diff` them. Fills the gap named below — `rpcProviderAB.mjs` A/Bs two *providers*, this A/Bs two *codebases*. ⚠️⚠️ Capture **serially** or the diff is fiction (see below). |
| `rpcCapacity.mjs` | **yes** | Should this endpoint be talked to with concurrency or batching? ⚠️⚠️ Answers "concurrency, and **do not batch**" — re-run after any provider change. |
| `rpcProviderAB.mjs` | **yes** | Do two RPC providers produce identical receipts? Re-analyzes the corpus twice on the SAME code, once per provider, and diffs the full `Receipt` — not just the watched columns. Run `--control` first: it A/As one provider against itself, so anything it flags is non-determinism rather than the provider. Needs `TCA_RPC_URL_PREV`. |

## Baselines at 2026-07-30 (62 receipts with `route_legs`)

Superseded 2026-08-06 — re-measure against the frozen 62-receipt corpus
(`docs/qa/corpus.json`); the "62" below is a coincidence, not the same set.
The old figures describe a 62-row live-table snapshot from 2026-07-30, not
today's frozen file — do not quote this block as current.

```
coverage        LP fee 76.6% · price impact 83.5% (notional-weighted)
subtraction     13 receipts no leg priced · 7 SILENTLY WRONG · 42 correct
recon residual  median 17.41 · p90 183.75   |slippage| p90 183.68  ← same quantity
blast radius    4 receipts / $2,913 can shift; RFQ $74,969 can never
ruler error     median 0.00 bps (the N−1 lag is NOT the problem)
own footprint   median 2.96 bps, max 586.7
reference pool  in the route only ~20% of the time
```

## Decode performance, 2026-08-10

Measured with the four `decode*`/`rpcCapacity` scripts above, then fixed on
`perf/decode-latency`. Numbers here are re-measurable — do not trust them, re-run.

```
before   62-receipt corpus, serial   7m41s      10-leg trade  10.3s   290 calls (121 distinct)
after    62-receipt corpus, serial   3m29s      10-leg trade   1.9s   130 calls
```

Three findings worth keeping, because each one contradicts an obvious guess:

- **"~40 RPC calls per receipt" was fiction** — it appears in `loadReceipt.ts`,
  `receiptBody.tsx` and the database-removal spec, and the real figure was 290.
  If you quote a per-receipt RPC cost (e.g. to size the global hourly ceiling),
  measure it with `decodeProfile.mjs` first.
- **Batching is slower than concurrency here.** See `rpcCapacity.mjs`. The
  intuition that fewer HTTP requests must be faster is wrong for this provider.
- **The expensive serial loop was not where it looked.** Four per-leg loops in
  `decomposeRoute` were the obvious suspects and were worth ~0.2s; the actual
  long pole was `decomposeTrade`'s `fee()`→`getReserves()` probe over
  retained-balance addresses, worth 2.3s on its own. `decodeProfile --timeline`
  is what identified it, by selector.

## ⚠️⚠️ Concurrent decodes produce different receipts

Capturing the corpus at concurrency 4 produced **different receipts for the same
transaction**, three times in one session, on unmodified `main` — a venue
mislabelled `aerodrome_cl`→`univ3`, and one receipt going tier `full`→`estimated`
with `allInCostBps` 101→5012. All were stable and correct when re-run serially.

The cause is that a transient RPC failure is swallowed as *evidence*: `catch →
null` means "no such pool" / "fee tier unreadable" / "no mid" throughout the
decomposition path, so a transport blip becomes a confident, different number
with no flag admitting it. This is an OPEN defect in the product, not just a
measurement artifact — `/tx` is public and uncached, so concurrent decodes are
the normal case.

For these scripts it means: **a concurrent capture over-reports**, exactly like a
raw `rpcProviderAB.mjs` run without `--control`. Re-run anything a diff flags
serially, on both refs, before believing it.

## Reading them honestly

- **Small samples — historically.** The reference-pool and pre-tx figures in
  the superseded baseline above came from 20-receipt and 75-leg samples, back
  when `--limit` defaulted small. `--limit` now defaults to the full frozen
  corpus (`referencePoolInRoute.mjs`, `preTxRulerError.mjs`), so a bare re-run
  measures everything; it is a convenience for spot checks, not something you
  need to raise before quoting a percentage.
- **The tail is contaminated.** The worst rows are `conf=low` and several carry
  `notional_usd` of $0–$3. Trust medians, not maxima.
- **Test `feeTierBps > 0`, never `!= null`.** A zero tier passes a null check and
  reads as "measured" — that artifact once produced a false "coverage is
  saturated" conclusion. Prefer the persisted `feeResolved` flag where present.
- **Coverage is defined in core, not here.** `priceImpactCoverage` and
  `isFullyPriced` live in `packages/core/src/receiptPure.ts` and are re-exported
  through `_env.mjs`, so these scripts and the receipt UI can never disagree.
  Run `npx tsc --build packages/core` after editing them.
