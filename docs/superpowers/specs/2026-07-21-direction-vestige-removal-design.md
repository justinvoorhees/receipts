# Remove the Direction / settledIn v1 vestige — design

**Date:** 2026-07-21
**Scope:** Remove the dead `Direction` type and the two vestigial
`DecomposeTradeInput` fields (`direction`, `settledIn`) from `packages/core`.
Behavior-preserving: every removed thing is proven dead.

## Why

`Direction = 'buy_weth' | 'sell_weth'` is a v1 vestige from when the tool priced
only USDC/WETH. It "misdescribes the domain" because it describes nothing real
anymore — investigation showed it is functionally dead:

- `signedDeviationBps(direction, …)` — its only production caller
  (`analyzeTransaction.ts:262`) passes a **hardcoded `'sell_weth'`**. In the v2
  output-per-input convention, cost is always `(mid − realized)/mid`, so the
  direction parameter never varies.
- `DecomposeTradeInput.direction` and `DecomposeTradeInput.settledIn` are declared
  but **never read** in the bodies of `decomposeTrade` or `decomposeRoute` (which
  passes its `input: DecomposeTradeInput` straight through). The code comment at
  `analyzeTransaction.ts:299` already calls them "vestigial … interface-only."
- **Not persisted.** The DB `receipts.direction` column is a *different* field — the
  pair-arrow string `"USDC->WETH"` set at `analyzeTransaction.ts:398`. The
  `'buy_weth'/'sell_weth'` values live only in dead in-memory paths. **No migration.**

The honest fix is removal, not a rename: you cannot rename code into meaning it
does not have.

## Changes

### `packages/core/src/priceMath.ts`
- Drop `import type { Direction } from './tradeEndpoints.js';`.
- `signedDeviationBps` **keeps its name** (still accurate: signed deviation = cost)
  but loses the `direction` parameter:
  ```ts
  export function signedDeviationBps(baselinePrice: number, comparePrice: number): number {
  	return ((baselinePrice - comparePrice) / baselinePrice) * 10_000;
  }
  ```
  This is the exact `'sell_weth'` branch the old code always took. Simplify the doc
  comment to describe the single convention (drop the buy_weth/sell_weth lines).

### `packages/core/src/tradeEndpoints.ts`
- Delete `export type Direction = 'buy_weth' | 'sell_weth';` and its section comment.

### `packages/core/src/decomposeTrade.ts`
- Remove `type Direction` from the `./tradeEndpoints.js` import.
- In `DecomposeTradeInput`, remove `direction: Direction;` and
  `settledIn: 'WETH' | 'ETH';` (both unread by the body).

### `packages/core/src/analyzeTransaction.ts`
- Drop `import type { Direction } from './tradeEndpoints.js';`.
- Line 262: `signedDeviationBps('sell_weth', marketMid, realizedPrice)` →
  `signedDeviationBps(marketMid, realizedPrice)`.
- Remove the now-unused `decompDirection` computation and the `settledIn`
  computation, and remove the `direction:` and `settledIn:` fields from the
  `decomposeRoute({ … })` call.
- **Keep** the receipt's own `direction` pair-string field at line 398 — unrelated.

### `packages/core/src/decomposeRoute.test.ts`
- Remove the `direction: 'buy_weth',` and `settledIn: 'WETH',` lines from all 5
  `DecomposeTradeInput` fixtures (they would become
  "object literal may only specify known properties" errors).

## What stays

- The receipt `direction` field (`inputSymbol->outputSymbol`) and the
  `receipts.direction` DB column — a separate concept, untouched.
- `signedDeviationBps`'s name and its single caller's semantics (identical numeric
  result).

## Testing

Behavior-preserving removal — the existing suite is the safety net. Baseline: **427
pass across 32 files.** Gate with `tsc --build` + `npm run lint` + `vitest run`. tsc
is the primary guard here: removing an interface field surfaces every stale setter,
and dropping a function parameter surfaces every stale call site, as compile errors.
No new tests; the `decomposeRoute.test.ts` fixtures simply lose two dead lines each.

A dev-render check is not required — this is core-only, no rendered-output change —
but a quick `/?tx=…` → 200 after the change confirms the analyzeTransaction path
still produces a receipt.

## Out of scope

- Any change to the persisted `receipts.direction` pair-string or its column.
- Renaming `signedDeviationBps` (its name remains correct once the param is gone).
