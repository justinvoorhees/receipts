# Granular Receipt Errors — Design

**Date:** 2026-07-13
**Status:** Approved (brainstorm), pre-implementation

## Problem

Every failure of the on-demand receipt path collapses to a single UI state:
the terse red string **"Transaction not found."** This is wrong or unhelpful for
most real failures:

- A **Relay / relayer trade** (e.g. `0xd6bb5ae0…`) is a valid, mined swap — it
  just executed for a beneficiary that isn't `tx.from`, so `extractEndpoints`
  (which anchors on `tx.from`) finds no clean 1-in/1-out swap and
  `analyzeTransaction` returns `null`.
- A **non-swap** (transfer, approval, LP add, multi-hop batch) also returns
  `null`, but for an entirely different reason.
- A genuinely **absent / wrong-chain hash** is the only case the current copy
  actually describes.

Two structural facts drive this:

1. `analyzeTransaction` wraps its whole body in `try/catch → null` — the reason
   is computed then discarded. Its only hard failure point for a real on-chain
   tx is `if (!endpoints) return null` (`analyzeTransaction.ts`), i.e.
   `extractEndpoints` returning null (`endpoints.ts:78`).
2. The UI derives the error **purely from DB presence**:
   `ReceiptView` sets `error = trade === null ? 'Transaction not found.' : undefined`
   (`ReceiptView.tsx:322`). The page (`receipts/page.tsx`) only reads the DB
   (`getReceiptByHash`); on a miss it has no reason to show.

## Goals

- Surface a **targeted set** of distinguishable failure reasons, each with
  purpose-written copy, in place of the single generic error.
- Render failures as a **diagnostic card in the receipt panel** (not just a
  one-line field error), including case-specific detail (the detected
  beneficiary address for a relayer trade).
- Keep the success path and its persistence behavior unchanged.

## Non-Goals / Out of Scope

- **Beneficiary-anchored decoding.** We detect and *name* the relayer
  beneficiary but do NOT compute a receipt for it. That remains the earmarked
  fast-follow (see `memory/open-fast-follows.md`). The card explicitly says
  beneficiary-anchored decoding isn't supported yet.
- **Persisting failures.** No new table or rows for un-decodable txns. (The one
  manually-restored stopgap row, receipts id 119, is unrelated and stays.)
- Multi-chain: chain stays Base (8453) as today.

## Reason Taxonomy

A closed set of reason codes. The first four are the user-facing "targeted set";
`ANALYZE_ERROR` is an honest infra bucket so an RPC/trace hiccup is never
mislabeled as a property of the transaction.

| Reason code | Card title | Body copy | Detail |
|---|---|---|---|
| `INVALID_HASH` | Invalid transaction hash | "That doesn't look like a transaction hash — expected a 66-character `0x…` value." | — |
| `NOT_FOUND_ONCHAIN` | Not found on Base | "No transaction with this hash exists on Base (chain 8453). Check the hash and that it's a Base transaction." | — |
| `RELAYER_THIRD_PARTY` | Relay / third-party trade | "The sender relayed this swap on behalf of another address. Beneficiary-anchored decoding isn't supported yet." | beneficiary address + resolved pair (e.g. `WETH → USDC`) |
| `NOT_DECODABLE` | Not a decodable swap | "We couldn't find a clean token-in / token-out swap for the sender. It may be a transfer, approval, LP action, or a multi-hop batch we don't decompose yet." | — |
| `ANALYZE_ERROR` | Couldn't analyze | "Couldn't analyze this transaction — try again." | — |

## Detection

New function in `packages/core/src/endpoints.ts`, next to `extractEndpoints`
so the relayer-detection rule can't drift from the extraction rule it mirrors.

### Public entry (RPC-touching)

```ts
export type FailureReason =
  | 'INVALID_HASH'
  | 'NOT_FOUND_ONCHAIN'
  | 'RELAYER_THIRD_PARTY'
  | 'NOT_DECODABLE'
  | 'ANALYZE_ERROR';

export interface RelayerDetail {
  beneficiary: string;
  inputToken: string;
  outputToken: string;
  inputSymbol?: string;
  outputSymbol?: string;
}

export interface AnalyzeFailure {
  reason: FailureReason;
  detail?: RelayerDetail; // populated only for RELAYER_THIRD_PARTY
}

export async function classifyTransaction(
  hash: string,
  chainId: number,
  opts: { rpcUrl: string },
): Promise<AnalyzeFailure>;
```

Flow:

1. **Format check** (no RPC): not `^0x[0-9a-fA-F]{64}$` → `INVALID_HASH`.
2. **Fetch**: `getTransaction` rejects → `NOT_FOUND_ONCHAIN`. `debug_traceTransaction`
   rejects (or any unexpected throw) → `ANALYZE_ERROR`.
3. `extractEndpoints({ trace, trader: tx.from })`:
   - non-null → this wasn't actually a failure; return `ANALYZE_ERROR` as a
     defensive fallback (callers only invoke `classifyTransaction` on a known
     miss, so this branch is not expected in practice).
   - null → delegate to `classifyEndpointFailure(trace, tx.from)`.
4. Symbol resolution for the relayer `detail` is best-effort (`readSymbol`);
   an unresolved symbol is omitted and the UI falls back to a short address.

### Pure inner function (no RPC — the unit-tested core)

```ts
export function classifyEndpointFailure(
  trace: TraceNode,
  trader: string,
): { reason: 'RELAYER_THIRD_PARTY' | 'NOT_DECODABLE'; detail?: RelayerDetail };
```

- Reuse the existing signed net-delta math from `extractEndpoints` /
  `collectNativeEthDeltas`. Extract the shared per-address delta computation into
  a helper (e.g. `perAddressTokenDeltas(trace)`) rather than duplicating the
  transfer/native summing — `extractEndpoints` is refactored to consume the same
  helper so the two stay in lockstep.
- Apply the same "exactly one negative token and exactly one positive token"
  test (`endpoints.ts:78`) to **every address other than `trader`**:
  - Exactly one qualifying address → `RELAYER_THIRD_PARTY` with
    `detail = { beneficiary, inputToken, outputToken }` (input = the negative
    leg, output = the positive leg).
  - Zero, or more than one, qualifying address → `NOT_DECODABLE`.
- The known Relay router (`0xccc88a9d…`, RelayApprovalProxyV3) is a corroborating
  signal only; the net-flow scan is the general detector and works for any
  relayer / account-abstraction / P2P sender.

## Plumbing (Option A — page classifies on DB miss)

The success path is unchanged: `ReceiptSearch` awaits the POST (persists on
success) then navigates; the page reads the now-persisted row. Therefore, at
page-render time a **success is already in the DB and only failures miss it.**

Changes:

1. **`receipts/page.tsx`** — on a `getReceiptByHash` miss, and only when a `tx`
   was explicitly supplied (skip for the default-hash landing view), call
   `classifyTransaction(hash, 8453, { rpcUrl })` and pass the result as a
   `diagnosis` prop to `ReceiptView`. `TCA_RPC_URL` is read the same way the API
   route reads it; if unset, degrade to `ANALYZE_ERROR`.
2. **`ReceiptView`** — signature becomes
   `{ trade, hash, diagnosis? }`. When `trade == null`:
   - `diagnosis` present → render `<DiagnosticCard failure={diagnosis} />` and
     pass a matching short field-error string to `ReceiptSearch`.
   - `diagnosis` absent (e.g. default landing) → current behavior.
3. **New `DiagnosticCard` component** — server component, styled to match the
   receipt panel (same border/spacing tokens). Renders title + body from a
   reason→copy map; for `RELAYER_THIRD_PARTY` also renders the beneficiary
   address (monospace, `formatters` address shortener) and the resolved pair.

Because classification runs in the server render, a failing `/receipts?tx=`
URL is **shareable** — the card appears on a cold load, no client state needed.

Notes:
- Classification only runs on a genuine miss and is the *cheap prefix* of
  analyze (fetch + trace + endpoint scan; no pricing/decomposition), so the
  success path pays nothing extra.
- The API `POST /api/receipts` is left as-is for now (fire-and-navigate). It may
  later also return the structured failure, but that is not required for this
  feature and is out of scope.

## Copy source of truth

A single `REASON_COPY: Record<FailureReason, { title: string; body: string }>`
map lives with `DiagnosticCard` in the dashboard. Core emits only the machine
`reason` + `detail`; all human copy is dashboard-side (keeps core presentation-free).

## Testing

- **`classifyEndpointFailure` (pure, no RPC):** the substance of the feature.
  - Relayer fixture (the `0xd6bb5ae0…` shape): `tx.from` has no clean swap; a
    single other address (`0xbee3…`) nets WETH→USDC → `RELAYER_THIRD_PARTY` with
    the right beneficiary + tokens.
  - Plain transfer / approval (no address with a clean 1-in/1-out) →
    `NOT_DECODABLE`.
  - Two independent swappers (two qualifying addresses) → `NOT_DECODABLE`
    (ambiguous, not a single beneficiary).
  - `trader` itself excluded from the scan.
  - Build fixtures from trimmed real traces where practical, mirroring existing
    `__fixtures__` usage.
- **`classifyTransaction` (RPC e2e, gated on `TCA_RPC_URL`):** `0xd6bb5ae0…`
  → `RELAYER_THIRD_PARTY` beneficiary `0xbee3211ab312a8d065c4fef0247448e17a8da000`;
  a known good swap hash → the not-expected `ANALYZE_ERROR` fallback (endpoints
  resolve). Skips cleanly when the RPC env var is unset (mirror the existing
  `analyzeTransaction.test.ts` gating).
- **Format check:** `INVALID_HASH` for malformed input without any RPC call.
- **`DiagnosticCard`:** renders each reason's title/body; relayer variant shows a
  shortened beneficiary + pair (React Testing Library, mirror `ReceiptView.test.tsx`).
- **Refactor safety:** `extractEndpoints` existing tests must stay green after it
  is re-pointed at the shared `perAddressTokenDeltas` helper.

## Edge cases

- **Native ETH legs:** the delta helper already folds native ETH; a beneficiary
  whose clean swap involves native ETH resolves symbol `ETH` (decimals 18) via
  the same rule `analyzeTransaction`/pricing use.
- **RPC without `debug_traceTransaction`:** `ANALYZE_ERROR`, not a mislabel.
- **Default landing view (no `tx` param):** no classification, no card — the
  page shows its default receipt as today.
- **Beneficiary symbol unresolved:** omit symbols; show shortened addresses.

## Future (explicitly deferred)

- Beneficiary-anchored *decoding* for `RELAYER_THIRD_PARTY` — reuse the detected
  beneficiary to actually build a receipt (the earmarked fast-follow). The card's
  "isn't supported yet" copy becomes a computed receipt when that lands.
- Having the API `POST` also return `AnalyzeFailure` so non-page callers get the
  reason.
