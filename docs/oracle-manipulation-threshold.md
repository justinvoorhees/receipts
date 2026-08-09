# Oracle Manipulation Threshold (`MANIPULATION_TOL_BPS`)

Investigation notes from 2026-08-05/06, prompted by a proposal to reduce the
oracle manipulation tolerance from 50bps to 10bps. Recorded because the
recommendation (25bps, not 10) rests on reasoning and corpus data that would
otherwise be lost. No code was changed as part of this investigation.

## Two thresholds, same name, different jobs

The codebase has two independently-defined 50bps "oracle" tolerances. They are
easy to conflate but govern different things:

| Constant | File | Governs |
|---|---|---|
| `MANIPULATION_TOL_BPS` | `packages/core/src/benchmarkPrice.ts:17` | Chainlink ETH/USD cross-check against the 3-pool WETH/USDC benchmark median. Sets `manipulationSuspect` / `MANIPULATION_SUSPECT` and `ORACLE_DISAGREE` (dual-oracle path). |
| `CORROBORATE_TOL_BPS` | `packages/core/src/marketPrice.ts:32` | Per-trade cross-class agreement (`direct` / `bridged` / `oracle` estimators) that sets each receipt's tier (`full` vs `estimated`) and its `ORACLE_DISAGREE` flag. |

This doc is about `MANIPULATION_TOL_BPS`, the one the original design spec
(`docs/superpowers/specs/2026-06-26-robust-benchmark-oracle-validation-design.md`)
calls "oracle validation." The reasoning below likely generalizes to
`CORROBORATE_TOL_BPS` but that constant wasn't re-derived here.

## Why 50bps was chosen, and why 10bps is too tight

Chainlink reports ETH/**USD**. The benchmark's `marketMid` comes from on-chain
WETH/**USDC** pools — i.e. ETH priced in the USDC token, not in fiat USD. USDC
wobbles a few bps around $1.00 under entirely normal conditions (redemption
friction, minor supply/demand — distinct from an actual depeg event like March
2023's SVB scare, which was ~1200bps). The original design spec estimated that
normal wobble at `<10bps` and picked 50bps for ~5x headroom above it
(`docs/superpowers/specs/2026-06-26-robust-benchmark-oracle-validation-design.md:105,110-112`).

That `<10bps` figure is a stated engineering estimate in the spec, **not**
something this codebase measured empirically — there is no historical
USDC/USD peg time series captured anywhere in the corpus (the off-chain
oracle that could provide one is inert, see below).

Setting the threshold *at* 10bps removes the headroom entirely: an ordinary
moment where USDC prints $0.9992 or $1.0008 could push `devBps` over 10 and
mark an unmanipulated trade `MANIPULATION_SUSPECT`.

## Internal-consistency argument for a floor above 15bps

`DIVERGENCE_TOL_BPS = 15` (same file) is the tolerance for the three benchmark
pools disagreeing *with each other* before that's flagged as suspicious. A
`MANIPULATION_TOL_BPS` below 15 would make the oracle cross-check stricter
than the pool-internal-agreement check it depends on — flagging "Chainlink
disagrees" at a tighter band than the pools are allowed to disagree among
themselves. Any revised value should sit meaningfully above 15, not at 10.

## Corpus impact (measured 2026-08-05, 82-row corpus)

Read-only queries against `receipts` (no writes):

- **Chainlink cross-check coverage is narrow**: `chainlink_dev_bps` is
  populated on only **4 of 82** receipts — the check only runs on the
  WETH/USDC fast path (`packages/core/src/pricing.ts:495-534`), not on the
  general route.
- Those 4 values: **0.28 – 7.96bps** (median ~4bps) — all comfortably under
  even 10bps.
- **Off-chain (Dune) oracle is completely inert**: `offchain_dev_bps` is null
  on all 82 rows (`DUNE_API_KEY` unset in `.env`), so the dual-oracle
  `ORACLE_DISAGREE` path is dead code in practice today.
- **Per-trade corroboration** (`CORROBORATE_TOL_BPS`, marketPrice.ts):
  `ORACLE_DISAGREE` fires on **0 of 82** receipts corpus-wide. The DB persists
  only the pass/fail flag, not the underlying deviation, so near-boundary
  cases (e.g. a receipt sitting at 42bps that a 10bps cut would flip) can't be
  ruled out without re-running pricing.

**Conclusion: reducing 50→10bps would be a no-op against the current stored
corpus** (nothing is close to either boundary in the one place with real
measured data), but it's a landmine for *future* WETH/USDC trades during
ordinary stablecoin noise — the corpus data can't prove it's safe because that
narrow fast path is the only place variance is even being measured.

## Recommendation: 25bps, not 10

- Sits above `DIVERGENCE_TOL_BPS` (15), preserving the internal-consistency
  ordering above.
- ~1.5–2x margin above the stacked USDC-noise + pool-divergence floor, less
  generous than the original 5x but still meaningfully tighter than 50.
- Comfortably clears the 4 measured live data points (max 7.96bps).
- Achieves the evident goal (more sensitivity than 50bps) without landing on
  the noise floor.

This is a starting point, not a calibrated number — 4 data points, none from
a real depeg or manipulation event, isn't enough to derive a threshold with
confidence.

## What would make this a real number instead of a guess

1. Widen Chainlink cross-check coverage beyond the WETH/USDC fast path so
   `chainlink_dev_bps` populates on more of the corpus.
2. Configure `DUNE_API_KEY` so the off-chain oracle leg stops being inert —
   currently the dual-oracle `ORACLE_DISAGREE` path can never fire.
3. Once coverage is wider, look at the natural spread of `chainlink_dev_bps`
   over a longer window (ideally spanning at least one real USDC wobble) before
   locking in a replacement constant.
4. Persist the underlying deviation for `CORROBORATE_TOL_BPS` too (currently
   only the boolean flag survives), so its threshold could be evaluated the
   same way.

Not built. No threshold value has been changed in code.
