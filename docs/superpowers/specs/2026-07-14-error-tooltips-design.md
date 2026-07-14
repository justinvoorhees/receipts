# Error States as Tooltips — Design

**Date:** 2026-07-14
**Status:** Approved (brainstorm), pre-implementation
**Figma:** https://www.figma.com/design/f9uYixaSgpkV1lEvN8Ie01/TCA?node-id=357-886

## Problem

The granular receipt-error feature ([[granular-receipt-errors]]) renders each
failure as a `DiagnosticCard` in the receipt panel (title + body + relayer
detail). The Figma reference reformats this: **remove the card**; each failure
becomes a short red reason **label** directly under the search field, with a
**dotted underline** when static that goes **solid on hover**, revealing a dark
**tooltip** above it with the longer explanation. The relayer state shows only
the generic message (no beneficiary/pair). One state (`NOT_FOUND_ONCHAIN`) is a
plain red label with no underline and no tooltip.

The Figma frames are a compilation of all 5 states stacked; only one is ever
shown at a time (one search field, one failure).

## Goals

- Replace the receipt-panel card with an inline red reason label under the
  search field.
- Static = dotted underline; hover = solid underline + dark tooltip above (for
  states that have a tooltip).
- Field border + label are red in every failure state.
- Adopt the Figma copy verbatim.

## Non-Goals

- No change to the failure taxonomy or detection logic (the 5 `FailureReason`
  codes and the classify flow stay).
- No change to plumbing (`page.tsx` still classifies on a DB miss and passes
  `diagnosis` through).
- Relayer beneficiary/pair is intentionally NOT displayed (dropped to match
  Figma).

## Copy (verbatim from Figma)

`REASON_COPY: Record<FailureReason, { label: string; tooltip: string | null }>`:

| Reason | `label` (red) | `tooltip` |
|---|---|---|
| `INVALID_HASH` | Invalid transaction hash | "Input does not look like a transaction hash, please try a 66-character 0x… value" |
| `NOT_FOUND_ONCHAIN` | Transaction not found on Base | `null` (plain label, no underline/tooltip) |
| `RELAYER_THIRD_PARTY` | Relay / third-party trade | "Sender relayed this swap on behalf of another address. Beneficiary-anchored decoding not yet supported" |
| `NOT_DECODABLE` | Not a swap | "Could not find a token-in / token-out swap for this transaction (transfer, approval, LP action, etc)" |
| `ANALYZE_ERROR` | Analysis failed, try again | "RPC error, unavailable trace, or other unexpected infrastructure error" |

## UI components

### `FailureNotice.tsx` (new; replaces `DiagnosticCard.tsx`)

- Exports `REASON_COPY` and `function FailureNotice({ failure }: { failure: AnalyzeFailure }): JSX.Element`.
- Reads `REASON_COPY[failure.reason]`.
- `tooltip == null` → render the label as plain red text (`text-[var(--color-red)]`), no underline, no hover behavior.
- `tooltip` present → render the label as the established tooltip idiom already
  used in `ReceiptView.tsx` (lines ~262, ~318), recolored red:
  ```
  <span class="group relative cursor-default text-[var(--color-red)] underline decoration-dotted underline-offset-[3px] [text-decoration-skip-ink:none] hover:decoration-solid w-fit">
    {label}
    <span class="pointer-events-none absolute bottom-full left-0 z-10 mb-[8px] w-max max-w-[320px] rounded-[2px] bg-[var(--color-primary)] p-[10px] text-left text-[12px] leading-[20px] font-normal whitespace-normal text-[var(--color-surface-base)] invisible group-hover:visible">
      {tooltip}
    </span>
  </span>
  ```
- Font matches the existing error label idiom (`font-['Sohne_Breit'] text-[12px] leading-[12px]`) for the label text; the dark bubble uses the same classes as the ReceiptView tooltips.
- Pure/presentational; unit-tested with `renderToStaticMarkup` (mirror the
  deleted `DiagnosticCard.test.tsx`).

### `ReceiptSearch.tsx` (modified)

- Prop changes from `error?: string` to `failure?: AnalyzeFailure` (import the
  type from `@fabric-tca/core`, type-only).
- `hasError = failure != null` drives the red border / red label / red button
  (same visual states as today).
- Below the input, render `{failure && <FailureNotice failure={failure} />}`
  (replaces the current bare `{error}` span). This retires the old magic single-
  space `error=' '` field-error workaround.

### `ReceiptView.tsx` (modified)

- Remove the `DiagnosticCard` import, its render branch, and the
  `error`/`fieldError` string derivation.
- `ReceiptView` keeps its `diagnosis?: AnalyzeFailure` prop and passes it straight
  through: `<ReceiptSearch hash={hash} {...(trade == null && diagnosis ? { failure: diagnosis } : {})} />`.
- A present receipt (`trade != null`) renders `<Receipt>` as today and passes no
  failure.

### `page.tsx` (unchanged)

Still computes `diagnosis` via `classifyTransaction` on an explicit-hash DB miss
and passes it to `ReceiptView`.

## Core cleanup (`classifyTransaction.ts`, `endpoints.ts`)

Because the beneficiary detail is no longer displayed, remove the now-dead
best-effort symbol resolution:

- `classifyTransaction.ts`: delete the `readSymbol`/`sym`/`withSymbols` block
  (lines ~71-86); the `RELAYER_THIRD_PARTY` branch returns
  `{ reason: 'RELAYER_THIRD_PARTY', detail }` directly. Remove the now-unused
  `createDefaultPricingDeps` import and the `RelayerDetail` type import and the
  `NATIVE` const if they become unused.
- `endpoints.ts`: drop `inputSymbol?`/`outputSymbol?` from `RelayerDetail` (it
  becomes `{ beneficiary; inputToken; outputToken }`). `selectBeneficiary`
  already only sets those three.
- This also removes the second viem client (a prior known Minor) and one RPC
  round-trip on the relayer path. EOA candidate detection is untouched — it is
  what distinguishes `RELAYER_THIRD_PARTY` from `NOT_DECODABLE`.

## Testing

- **`FailureNotice.test.tsx`** (renderToStaticMarkup): for a tooltip-bearing
  reason (e.g. `NOT_DECODABLE`), the rendered HTML contains the label, the
  tooltip text, and the `decoration-dotted` / `hover:decoration-solid` classes;
  for `NOT_FOUND_ONCHAIN`, it contains the plain label and NO tooltip text and
  no `decoration-dotted` class. Also assert all 5 reasons have a non-empty label
  (the `Record<FailureReason,…>` typing enforces exhaustiveness at compile time).
- **`ReceiptView.test.tsx`**: update the two diagnosis tests — a `null` trade
  with `diagnosis={{ reason: 'NOT_DECODABLE' }}` renders "Not a swap" (new copy)
  and the tooltip text; the no-diagnosis + null-trade case renders neither a
  failure label nor a receipt.
- **Delete** `DiagnosticCard.test.tsx`.
- **`classifyTransaction.test.ts`**: unchanged and still green (it asserts
  `beneficiary`/`inputToken`/`outputToken`, never symbols).

## Edge cases

- Success (`trade != null`): no failure passed; field renders normally.
- Default landing view (no `tx`): `page.tsx` sets no `diagnosis`; no failure
  label. (Same as today.)
- A reason whose `tooltip` is `null` never renders a hover target — plain label.
