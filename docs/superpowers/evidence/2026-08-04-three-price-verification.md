# Three-price receipt — corpus verification (2026-08-04)

Three-arm protocol from the design spec §7. Both RPC arms are DRY RUNS; nothing
was written to the database by either.

| Arm | Code | Result |
|---|---|---|
| 0 — backup | live DB as-is | 70 receipts snapshotted (restore point) |
| 1 — control | `main` @ `2836e37`, isolated worktree | 70 rows · changed=0 · skipped=0 · errors=0 |
| 2 — treatment | `feat/three-price-receipt` | 70 rows · changed=0 · skipped=0 · errors=0 |

Arm 1 ran `main`'s compiled core (verified: 0 occurrences of `getPairMidTriple`
in its `packages/core/dist/pricing.js`, versus 4 on the branch) against the same
70 receipts and the same RPC provider, so only the code differs between arms.

## Gate: Arm 1 → Arm 2

```
rows changed: 26 / 70
per-column:
    26  marketMidBefore
    26  marketMidAfter
```

**PASS.** Only the two intended columns moved. No movement in `all_in_cost_bps`
(Task 9 changed rendering, not persistence), none in `market_mid` (the ruler did
not move), no tier or `pricingStatus` transitions. Skip counts identical (0/0), so
no receipt silently stopped resolving.

Arm 1's `changed=0` is also a useful negative result in its own right: the corpus
carried **no** pre-existing staleness on the watched columns, so nothing in the
Arm 2 diff is attributable to earlier unrepopulated fixes.

## Coverage limitation (not a defect)

The three-block table renders only where a DIRECT pool exists for the pair. The
correlation across the 64 priced receipts is exact:

| Mid source | n | wings |
|---|---|---|
| direct-pool | 24 | yes |
| WETH/USDC fast path (benchmark) | 2 | yes |
| WETH-derived (bridged) | 38 | **no** |

`getPairMidTriple` resolves the deepest direct pool for the pair; a bridged mid
has no direct pool by construction, so there is nothing to sample. Those receipts
degrade as designed — `–` in both wing rows, dispersion sentence omitted.

**Practical coverage is 26/64 = 41% of priced receipts.** Extending it would mean
sampling the bridge legs (token→WETH, WETH→USDC) at three blocks and composing
them, which is a separate piece of work with its own correctness questions.
