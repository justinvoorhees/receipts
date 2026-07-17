# UniswapX Filler Display (Aggregator row replacement)

## Problem

Since beneficiary-anchored decoding landed (`resolveTrader`, `ANCHOR_VIA_UNISWAPX`), a UniswapX-filled receipt still shows an "Aggregator" row driven by `resolveAggregator(tx.to, logs)`. For these trades `tx.to` is the UniswapX reactor contract, which is not in `routers.json`/`settlers.json` — so the row renders a bare, unlabeled reactor address under the "Aggregator" heading. That label no longer makes sense: there is no aggregator here, there's a filler (solver/relayer) who submitted the fill on the swapper's behalf.

Figma (`node-id=418-1448`) specifies a replacement: a two-line label — **"Filler"** (primary) over **"via UniswapX"** (secondary) — paired with the filler's address, right-aligned, dotted-underline, linking out.

## Scope

Receipt detail view (`ReceiptView.tsx`) only. The `TradesTable` list's "Aggregator" column is untouched — out of scope.

## Data flow

`tx.from` (the filler) is read today in `resolveTrader()` only to test tier-1 self-anchoring, then discarded — never persisted. Add a new field, populated only when the trade is UniswapX-anchored:

- **`packages/core/src/analyzeTransaction.ts`**: add `fillerAddress: string | null` to the `Receipt` interface. Populate as `resolved.anchor.kind === 'beneficiary' && resolved.anchor.method === 'uniswapx' ? tx.from.toLowerCase() : null`.
- **`packages/db/src/schema.ts`**: new nullable column `fillerAddress: text('filler_address')`, adjacent to `routerAddress`. New drizzle migration.
- **`packages/dashboard/app/api/receipts/route.ts`** (`toNewReceipt`): pass `fillerAddress` through unchanged (plain nullable string, no `num()` conversion needed).
- **No backfill** of already-persisted UniswapX-anchored receipts — they keep `fillerAddress: null` and the UI falls back gracefully (below).

## UI

New `FillerValue`/row rendering in `ReceiptView.tsx`, used in place of `<DetailRow label="Aggregator"><AggregatorValue row={row} /></DetailRow>` when `row.normalizeFlags` contains an `ANCHOR_VIA_UNISWAPX` token **and** `row.fillerAddress` is non-null:

- Same grid shell as `DetailRow` (`grid-cols-[180px_1fr]`, `gap-x-[24px]`), so it lines up with every other detail row.
- Label cell: two stacked lines — `Filler` in `var(--color-primary)`, `via UniswapX` in `var(--color-secondary)` below it — matching the Figma mock.
- Value cell: `row.fillerAddress`, full lowercase address, dotted-underline (`underline decoration-dotted decoration-[8%] underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid`), linking to `https://basescan.org/address/${fillerAddress}` in a new tab — same convention `AggregatorValue` uses today. Plain primary-color text (no `providerColor` styling — there's no provider identity here, just a raw EOA).

**Fallback**: if the `ANCHOR_VIA_UNISWAPX` flag is present but `row.fillerAddress` is null (legacy pre-migration row), render exactly what renders today — the normal `AggregatorValue` under "Aggregator" — so nothing regresses for historical rows.

**Redundant note removal**: `beneficiaryAnchorNote()` (`TradesTable.tsx`) currently renders `"Executed on your behalf via UniswapX"` as a separate `<p>` below the Aggregator row whenever `ANCHOR_VIA_UNISWAPX` fires. Once the new row renders, that note says the same thing the row already conveys — suppress it in that case. It continues to render for the generic net-flow/solver case (`"Executed on your behalf by a solver"`) and for the UniswapX case when we've fallen back to the old Aggregator row (`fillerAddress` null), so no disclosure is silently dropped.

## Testing

- **Core**: extend/add a UniswapX e2e fixture test asserting `fillerAddress === tx.from` on a UniswapX-anchored receipt, and `fillerAddress === null` on self- and net-flow-anchored receipts.
- **Dashboard** (`ReceiptView.test.tsx`):
  - `ANCHOR_VIA_UNISWAPX` flag + `fillerAddress` set → expect "Filler" / "via UniswapX" text, Basescan link to the filler address, and absence of the old note text.
  - `ANCHOR_VIA_UNISWAPX` flag + `fillerAddress: null` → expect today's unchanged output (Aggregator row + note).
  - Non-UniswapX beneficiary-anchored row (net-flow) → unaffected, Aggregator row + generic solver note as today.

## Out of scope

- `TradesTable.tsx` Aggregator column (list view).
- Backfilling `fillerAddress` for historical rows.
- Any change to `resolveAggregator`/`resolveTrader` resolution logic itself — this is purely a new pass-through field + display change.
