# Three-price receipt — re-verification after option D (2026-08-05)

Supersedes the 2026-08-04 run's coverage figures. Arm 1 (control, `main` in an isolated worktree)
was NOT re-run — `main` is unchanged — so this compares the same control against a new treatment.

## Gate: Arm 1 → Arm 2b (option D)

```
rows changed: 64 / 70
per-column:
    64  marketMidBefore
    64  marketMidAfter
id 534  ⚠ ONLY-IN-B (new row)
id 535  ⚠ ONLY-IN-B (new row)
```

**PASS.** Only the two intended columns moved. Skipped=0, errors=0.

Ids 534/535 are receipts created through the dev server while the runs were in flight, not a
regression — and the diff surfacing them rather than silently absorbing them is the ONLY-IN
guard working as designed.

## C1 resolved — measured

The eight receipts that previously printed movement while their sampled pool was provably static:

| id | pair | before D | after D |
|---|---|---|---|
| 401 | USDC→RIPS | 1521.01bps | **0.00bps** |
| 400 | USDC→RIPS | 1517.54bps | **0.00bps** |
| 253 | KEYCAT→AERO | 292.29bps | 69.52bps |
| 485 | POD→USDC | 67.44bps | **0.00bps** |
| 252 | USDC→BENJI | 34.94bps | **0.00bps** |
| 251 | USDC→BRIAN | 11.64bps | 29.83bps |
| 248 | USDC→TIBBIR | 8.42bps | 19.37bps |
| 504 | DEGEN→USDC | 6.07bps | **0.00bps** |

Corpus-wide: **0 receipts** now have identical wings alongside a non-zero dispersion figure. Where
the number moved rather than zeroing (253, 251, 248), it is now the composite's genuine
block-to-block movement rather than a comparison between two different price sources.

## Coverage

**66 / 66 priced receipts = 100%** (was 26/64 = 41%). Every bridged "WETH-derived" mid now
composes at three blocks like any other, because the wings run the same composition function as
the centre. §7's 41% figure and §11.2's "toward 100%" projection are both superseded by this
measurement.
