# ETL Seed layer — follow-ups after v0.1

From the final whole-branch review and its fix wave (branch `etl/seed-layer`,
`d2f2e13..221b60c`). Nothing here blocks merge; all were adjudicated as
follow-ups. File:line refer to `221b60c` and will drift.

## Residuals from the fix-wave re-review

- **R1 — the `--span` path spends one RPC call before `--source` and `eth_chainId`
  are validated.** `cli.ts:58` calls `finalizedWindow` before `ingestRange`, so on
  the default path `--source "$TCA_RPC_URL"` costs one call before refusal, and the
  finalized head is fetched twice per run. No data admitted, no secret leaked.
  Fixing it means restructuring the CLI's control flow.
- **R2 — `ingest.ts:247-249` echoes provider-controlled `block.number` into a thrown
  error.** Same class as the S1 leak the wave closed, but it needs a *hostile*
  provider rather than the routine auth-error echo, so severity is much lower.
  Demonstrated: a stub returning a URL as `block.number` reproduces it. Closing the
  class properly is not one line — `buildSeedRows.ts` interpolates `block.number`
  into ~10 pre-existing messages. Dropping the `(${JSON.stringify(...)})`
  parenthetical at `ingest.ts:249` is a cheap partial win.
- **R3 — `assertSourceLabel` only screens `://`.** `--source sk_live_abc` or a
  `user:pass@host` form still lands in every row. This is what was asked for; the
  gap is recorded, not a defect.
- **R4 — `assertEndpointChain` assumes `eth_chainId` returns a hex string.** A
  spec-violating provider returning a JSON number would trip a false mismatch.
  Fails safe (aborts rather than corrupts).
- **R5 — `parseTxStatus` turns a missing `status` into a whole-run abort.** Correct
  direction for an immutable archive; no realistic Base exposure.
- **R6 — `finalizedHead` can return `NaN`** on a malformed `block.number`
  (`finality.ts:135`). Without `--allow-unfinalized`, `classifyRange` throws (safe);
  with it, output routes to `provisional/`, so the canonical glob is never
  corrupted. Pre-existing, outside the wave.

## Deferred minors from the task reviews

- `writeSeedParquet.ts` — the non-masking cleanup (nested try/catch) has **zero test
  coverage**; reverting it fails nothing. A reviewer demonstrated a deterministic
  ~20-line `vi.mock('node:fs')` test that discriminates. Lowest value of the
  unpinned items: a regression loses cleanup of a gitignored temp file, not data.
- `finality.ts` — the try block spans `JSON.stringify(params)`, so a circular-params
  throw would be mislabelled "network error". Cannot leak; `params` are always
  constructed internally.
- `finality.test.ts` — `Retry-After` clamping and non-400 4xx codes are verified
  correct by review but not pinned in the committed suite.
- `ingest.ts` / `cliValidation.ts` — two implementations of "must be a positive
  integer", for different input types at different boundaries.
- `cli.ts` — `--chain` (filename slug) and `--chain-id` (stamped data) remain
  independent operator assertions, now backstopped by the `eth_chainId` check.

## Structural, worth doing before v0.2 adds callers

- **Extract `rpcCall` out of `finality.ts`.** Roughly half that file is a generic
  JSON-RPC transport (retry, jittered backoff, `Retry-After`, secret sanitization)
  with nothing to do with finality. `fetchBlock.ts` imports it from `./finality.js`,
  which reads wrong, and `index.ts` does not export it. Deliberately kept out of the
  fix wave as a refactor; do it before the repair pass and Derived-file fetchers
  become callers.
- **Share the guarded hex parser.** `buildSeedRows.ts:52-58` rejects non-finite
  results with a named field; `finality.ts:117` uses a bare `Number.parseInt` on the
  value that gates the entire admission rule. Asymmetry, not a defect — the bare one
  currently fails closed.

## v0.2 hazards recorded now

1. **Volume.** The pilot produced **155,732 rows / 145 MB from 300 blocks** — 4.6x the
   estimate, which had been extrapolated from a single unrepresentative sample block
   (113 txs; the real window averaged 519, max 1,293). At that rate a **full day of
   Base is ~21 GB**. The spec's likely 1,000-block chunk is ~500k rows and ~2 GB of
   NDJSON held as a row array under all-or-nothing in-memory assembly. Measure before
   fixing the chunk size.
2. **`ROW_GROUP_SIZE 4096` was reasoned against ~17 KB/row; the pilot measured ~945
   bytes/row.** The tuning premise has already moved.
3. **The "no JSON numbers" losslessness guarantee is pinned to one frozen Base
   fixture.** A second chain, a second provider, or a client upgrade can break spec §3's
   argument with no test failing. Run that walk against live payloads at least once
   per provider when the second chain lands.
4. **`writeSeedParquet` never closes the DuckDB instance or connection.** Harmless for
   a one-shot CLI; a native-memory leak the moment Derived-file builds call it in a
   loop. Same omission in two test files.
5. **`Finality` has three members, `classifyRange` produces two, and `seedFilePath`
   collapses them to a boolean** (`ingest.ts:135`). When the v0.2 repair pass starts
   stamping `'safe'`, that boolean is where the three-way distinction is lost.
6. **`data/seeds/provisional/` has never existed on disk.** No run has created it; only
   the wiring test exercises the path.
7. **Railway.** `packages/dashboard` correctly has no dependency on `packages/etl`, but
   `railway.json` runs `npm run build` from the root of an npm workspace, so
   `@duckdb/node-api` plus its linux-x64 bindings install into the deploy image
   regardless, and root `tsc --build` now compiles `packages/etl` on every deploy.
   It typechecks clean, but given this repo's history of silently broken deploys,
   **verify the first Railway build after merge rather than assuming.**
8. **Full-suite runs with `TCA_RPC_URL` set need `--no-file-parallelism`** — four e2e
   files otherwise trip genuine QuickNode 429s. Also note `ingest.e2e.test.ts` calls
   dotenv `config()` itself, so it cannot be opted out of while a `.env` exists; it
   issues real RPC calls.
