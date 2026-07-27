# Per-Leg Router Attribution — Design

**Date:** 2026-07-27
**Status:** Approved (design), pending implementation plan

## Motivation

Trigger: "some swaps route through multiple aggregators via a meta-aggregator
(who is attributed at the top of the receipt). I would like to attribute the
other aggregators used in the txn … in this txn Fabric did perform some of the
routing on Relay's behalf, and I would like to see that in the receipt." (tx
`0x42fab3cd…99869a5`, receipt id 328.)

Today the receipt names exactly one aggregator — the top-line **Aggregator**
row, resolved by `resolveAggregator.ts` from `tx.to`. That is correct as far as
it goes (it is who the taker traded with), but it is not the whole story: a
meta-aggregator can hand individual legs to another aggregator, and the receipt
currently attributes those legs to nobody.

### Evidence

`analyzeTransaction.ts:203` **already fetches** `debug_traceTransaction` with
`callTracer` + `withLog` and threads it into `decomposeRoute`. The call-frame
nesting we need is sitting in a payload we already pay for — this feature needs
**zero new RPC calls**.

Verified on id 328: `to` = Relay's ApprovalProxy → `RelayRouterV3` → **Fabric's
`Executor` (`0x7c137a37…`, already in `configs/routers.json`)** → both pool
swaps (Uniswap V4 `PoolManager`, PancakeV3 `0x345825a9…`). Both legs are
Fabric's.

Trace logs also carry a global **`index`** field (the RPC returns it; our
`TraceNode` in `tradeEndpoints.ts:68` does not yet declare it), so
log→frame association is a lookup, not an inference.

Full-corpus survey (48 receipts, 0 trace errors), chain of **known** routers
enclosing each swap log:

```
id307  top=Relay   0xa41bc0af, 0x498581ff  ::  Relay > 0x
id328  top=Relay   0x498581ff, 0x345825a9  ::  Relay > Fabric
id216  top=Relay   0x4e962bb3, 0xb94b2233  ::  Relay > Fabric
id250  top=0x5f693aa7… (unattributed)      ::  Fabric   (4 legs)

distinct known routers per leg (max in receipt) → receipts
  0: 14      1: 31      2: 3
```

4 of 48 receipts have a leg executed by a named router that is not the top-line
aggregator — the 3 at depth 2, plus id 250, whose chain is depth 1 only because
its top-line address is not in the registry. Note what that means for id 250:
the top line is a bare unattributed address, so Fabric is the *only* nameable
party in that trade.

Caveat on the table above: it was produced by an ad-hoc script whose swap-topic
set omitted QuickSwap v4's Algebra topic, so id 307's third leg
(`0xd30b9fa9`, `quickswapv4`) is missing from its row. Leg *counts* here are
therefore lower bounds; the receipt-level conclusions are not affected. See §1
on reusing `routeVenueScan`'s topic set in production.

## Decision: only the curated registry attributes

23 further receipts have an *unnamed* contract frame between the aggregator and
the pool. Resolved through `getsourcecode`:

| frame | legs | `ContractName` |
|---|---|---|
| `0xf599d515…` | 30 | `Executor` — 0x's own, inside `0x` trades |
| `0x8f10b468…` | 12 | *(unverified)* — in every KyberSwap receipt |
| `0xe7dc2934…` | 10 | *(unverified)* — in every Nordstern receipt |
| `0x1b2b6ce8…` | 6 | **`VelodromeSlipstreamRouter`** |
| `0x33a47a12…`, `0x698cb2b6…` | 2, 1 | **`SwapRouter`** |

None are sub-aggregators. They are the aggregator's own internal executor, or a
**DEX periphery router**. `0x1b2b6ce8…` is the worst case: the leg it wraps is
*already labeled "Aerodrome SlipStream" as its venue*, so tagging it would state
the venue twice and imply a third party who does not exist.

There is no cheap structural test separating "another aggregator" from "the
aggregator's own helper" from "a DEX's periphery router". **The curated registry
is the test.** Surfacing unknowns as truncated addresses would fire on 23/48
receipts and mislead on most — precisely the failure `resolveAggregator.ts:14-17`
exists to prevent ("a wrong attribution is worse than `unknown`").

**Locked:** tag a leg only when its enclosing frame is in `routers.json` /
`settlers.json` *and* resolves to a different aggregator than the top line.
Coverage is 4/48 today and grows with the registry — see §5.

## Decision: containment, not authorship

Frame nesting proves whose contract the pool call executed *inside*. It cannot
distinguish "B handed this leg to C and **C** chose the pool" from "**B** chose
the pool and used C purely as an execution contract". `Relay > 0x` (id 307) is
exactly this ambiguity: 0x's Settler is a contract many parties call.

**Consequence:** the tag means **executed by**, never "chose this route", and
the tooltip must say so rather than implying authorship.

## Desired behavior (user-specified)

Per-leg, to the right of the token pair, in the existing context slot
(Figma `524:1653` / `524:1654`; tooltip `529:2048`):

1. Render the **innermost** known router — `Uniswap v3   WETH/cbBTC • Fabric`.
2. **Quaternary** color, not per-provider accent ("the colors could get really
   noisy").
3. **Linked** to the router contract's Basescan address page.
4. The label group **flexes to the value column and wraps** if still too long.
5. When the known-router chain is **deeper than 2**, the innermost router also
   carries a tooltip with the **full path including the top-line aggregator**,
   arrow-joined: `Relay → SpanDEX → Fabric`.
6. Rendering in both the "Liquidity Provider Fee" and "Pools Touched" lists is
   **acceptable** (`LegRow` backs both).

## Decision: raw chain persisted, name resolved on read

The alternative — persisting the resolved name, as `feeSinks` does — makes every
`routers.json` addition require a 48-row repopulate before any historical
receipt benefits.

**Locked:** persist the **raw frame addresses**; resolve to a name at read time.
Adding a router to the registry then lights up every historical receipt that
ever touched it, with no repopulate.

This is a deliberate departure from the `feeSinks` precedent. The difference: a
fee sink's name is a fact about *that address* which will not change, whereas
router attribution is a fact about *our registry*, which is actively growing.

Two consequences to hold:

- **One repopulate is still required**, once, to capture chains for the existing
  48 rows.
- **"Restart", not "refresh"** — `tagging.ts:55` resolves `routers.json` at
  module load via top-level await, as does `settlers.json` at
  `resolveAggregator.ts:49`. An edited config takes effect on process restart.

Because the chain is raw, every display decision below (innermost-vs-path, the
depth-2 tooltip threshold) is reversible by editing a render function.

## Architecture

Four layers. Core stays RPC-pure and interpretation-free; the registry lookup
happens server-side on read; display naming happens on the client.

### 1. Core — extract frame chains (new pure module)

`packages/core/src/legFrameChains.ts`. Given the `callTracer` trace and the set
of venue addresses → `Map<venueAddressLower, string[]>`, enclosing `CALL` frames
outermost→innermost.

Filtering rules, all mechanical:

- `CALL` frames only — `DELEGATECALL` / `STATICCALL` have no frame of their own.
- Skip reverted frames (`node.error`).
- Exclude the pool addresses themselves.
- Collapse **consecutive** repeats — the V4 callback re-enters
  `PoolManager → Executor → PoolManager` and would otherwise double-count.
- Cap at 12 entries (bounds `route_legs` growth; observed max is 3).

**No registry lookup and no naming in this module.** Raw addresses only. This is
what makes it a pure, fixture-driven, RPC-free function, and it is the property
retroactivity depends on.

Swap-topic recognition reuses `routeVenueScan`'s existing topic set — not a
private copy. (An ad-hoc survey copy missed QuickSwap v4's Algebra topic; the
production path must not.)

Wired in at `analyzeTransaction.ts:349`, where `routeLegsBase` is built and both
the trace and the legs are in scope.

**Leg→frame join is by venue address**, not by threading a per-leg log index
(`scanVenues` returns `Map<address, VenueInfo>`; the index is not there today).
Verified exact: 0 of 48 receipts have two *pool* legs sharing an address.

**Fail-closed guard:** if one venue address's swap logs resolve to differing
chains, emit **no** `frameChain` for that leg rather than guess. The latent case
is the V4 `PoolManager` singleton hosting two pools in one route; threading the
log index is the upgrade if V4 multi-pool leg splitting lands.

### 2. DB

`route_legs` gains `frameChain?: string[]`. Already `jsonb` — **no migration**.
Absent on rows persisted before this change, which read as "no attribution"
until backfilled.

### 3. Resolution — server-side, on read

Core exports `resolveLegRouter(frameChain, topLevelSlug)` →
`{ slug, address, path: string[] } | null`:

- Walk the chain, keep entries hitting `routers.json` / `settlers.json` (via
  `labelAddress`), dedupe.
- `slug` / `address` = the **innermost** hit.
- `path` = the full kept chain **including the top-line aggregator**.
- Return `null` when the innermost equals `topLevelSlug`. This covers plain
  trades *and* the `Relay > Fabric > Relay` **re-entry** case, which renders
  blank by rule — a decision, not an oversight: a real participant (Fabric) goes
  unmentioned there.
- Return `null` on an empty/absent chain.

Called from `lib/queries.ts` (`getReceiptByHash`, `listReceipts`), so both the
receipt page (`app/page.tsx`, server) and the client `TradesTable` dialog get
resolved data, and the fs-touching registry never crosses to the client — the
barrel/leaf webpack trap from the single-ruler work.

It returns a **slug, not a display name**. The client formats it with the
existing `formatProvider`, so a leg tag and the top-line Aggregator row can
never disagree about what to call someone.

### 4. Dashboard UI

- **`BkdRow.context`** widens from `string` to `React.ReactNode` — required
  because the router segment is a link, and above depth 2 also a tooltip
  trigger.
- **`LegRow`** composes `{pair} • {router}`. The router is an `<a>` to
  `basescan.org/address/{address}`, quaternary
  (`var(--color-quaternary)`), with the dotted-underline treatment used
  elsewhere on the receipt.
- **Tooltip:** when `path.length > 2`, that same `<a>` carries `group relative`
  and a `TooltipBubble align="left"` containing
  `path.map(formatProvider).join(' → ')`. Link and tooltip coexist on one
  element. Reuses the existing `TooltipBubble` (`receiptRows.tsx:26`) — the
  Figma bubble (12px / `leading-[20px]` / `max-w-[320px]` / `rounded-[2px]` /
  `p-[10px]`) already matches it. Wording states **executed by**, per §"Decision:
  containment, not authorship".
- **Width:** no work beyond verification. `BkdRow` (`receiptRows.tsx:266`) is
  already `grid-cols-[1fr_92px]` with a `min-w-0` label cell and no
  `nowrap`/`truncate` anywhere in the receipt; the fixed `w-[268px]` is a
  Figma-frame artifact. Confirm the wrapped second line reads correctly.
- **Step rows** (wrap/unwrap) render no tag — their context slot holds
  `stepContext`, and wrapping is not a routing decision.
- **RFQ/maker legs** follow the normal rule; no special case.

## Repopulation

One `scripts/repopulateReceipts.mjs` pass over the 48 rows to capture
`frameChain`. Add it to the script's computed-column WATCH/UPDATE set. Run in
**background** — the full set exceeds the 5-min tool timeout.

Verify after: id 328 and id 216 both legs → `Fabric`; id 250 all four legs →
`Fabric` (no tooltip — chain length 1, the unattributed top-level party cannot
appear in the path); id 307 → `0x`; no tag anywhere on the 44 others.

## Testing

- **Core (pure, fixtures):** frame-chain extraction over saved traces for the
  three real cases (`Relay > Fabric` ×2, `Relay > 0x`) plus a **synthetic
  3-deep** for the tooltip path. Rule coverage: `DELEGATECALL`/`STATICCALL`
  excluded, reverted frames skipped, V4 consecutive-repeat collapse, 12-entry
  cap, pool addresses excluded.
- **Join guard:** two legs sharing a venue address with differing chains → no
  `frameChain` on either.
- **Resolution:** innermost wins; differs-from-top required; re-entry → `null`;
  unknown-only chain → `null`; empty chain → `null`; `path` includes the top-line
  aggregator.
- **UI:** link `href`; quaternary styling; tooltip present iff `path.length > 2`;
  tooltip text arrow-joined through `formatProvider`; no tag on step rows;
  legacy rows without `frameChain` render exactly as today.

## Non-goals

- **Surfacing unnamed frames** on the receipt (truncated address or
  `ContractName`) — rejected above. If the unknowns should be visible, the place
  is a triage script that *lists* candidates and never writes config, mirroring
  `refreshSettlers` / `refreshReactors`.
- **Threading a per-leg log index** through `scanVenues` — deferred behind the
  fail-closed guard until V4 multi-pool leg splitting makes it necessary.
- **Changing the top-line Aggregator row.** Per-leg is the whole point.
- **Claiming route authorship.** Executed-by only.

## Risks / notes

- Coverage is 4/48 (8%) at launch. A leg routed by an uncurated meta-aggregator
  is indistinguishable from a leg the top-line aggregator executed itself.
  Accepted; this is the cost of the "no wrong attribution" rule.
- Persisted receipts go stale silently on core changes (project-wide gotcha) —
  the one-time repopulation is mandatory.
- Registry edits need a **process restart**, not just a page refresh.
- `route_legs` grows by one short string array per leg. The 12-entry cap bounds
  it; observed max chain depth is 3.

## Follow-on

Frame chains in the DB turn `routers.json` triage into a SQL query — "which
unnamed contracts sit between aggregators and pools, ranked by leg count" — the
standing version of the one-off survey in §Motivation. That is the input to the
aggregator-attribution work this feature precedes.
