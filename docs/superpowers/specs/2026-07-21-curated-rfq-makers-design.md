# Curated RFQ makers — design

**Date:** 2026-07-21
**Scope:** Add a curated maker-address list so RFQ makers that are unprovable by
the two on-chain tiers can still be identified. Resolves the `0x3dbe077e7986…`
maker (rows 53, 208, 210, 236). Follows the `configs/{routers,settlers,reactors}.json`
precedent.

## Why

RFQ maker detection (`decomposeRoute` Step 4b) is two-tier and fail-closed:
- Tier 1: the venue emitted a known maker-fill event in this tx (`RFQ_FILL_TOPICS`).
- Tier 2: a block-pinned probe finds it is an EOA or EIP-1967 proxy.
A plain contract that matches neither stays `unknown` → "Unknown Pool".

`0x3dbe077e7986657e95e1cc50089f17a5a4af0aae` is exactly that gap, and investigation
(2026-07-21) shows it is genuinely unprovable yet behaviorally a clear market maker:
- Appears as an `unknown` counterparty leg in **4 receipts across 3 aggregators**
  (Nordstern id 53, KyberSwap id 236, Velora ids 208/210) — aggregators route fills to it.
- Moves the trade's tokens via transfers but **emits zero logs** in the tx (no fill
  event → Tier 1 cannot fire). NB: "emits no logs" is a *backwards* maker signal in
  general (a real pool emits a Swap; a maker often emits its own fill event) and must
  never become an automated heuristic — here it simply means Tier 1 has nothing to match.
- 4084-byte plain contract, EIP-1967 impl slot zero (→ Tier 2 cannot fire), no
  `fee()`/`getReserves` pool interface.
- Basescan shows no label; holds diversified multi-chain token inventory (MM pattern).

The tagging precedent (event-topic > factory > address-list, last resort) makes a
curated address list the honest fallback here — and, per that precedent, a human
decision. This spec builds the minimal mechanism and adds the one attested entry.

## The mechanism

### `configs/makers.json`
A curated list, **hand-maintained** — unlike `settlers.json`/`reactors.json` there is
no refresh script, because makers cannot be discovered by an on-chain scan; identity
is human-attested. A leading `_comment` states this. Shape:

```json
{
  "_comment": "Curated RFQ market-maker addresses on Base. HAND-MAINTAINED — makers are not scan-discoverable; each entry is a human attestation with provenance. Consulted ONLY as a last-resort tier for `unknown` legs that neither RFQ tier proves (see decomposeRoute Step 4b). Identity is a SET (lookup ignores everything but `address`).",
  "chainId": 8453,
  "makers": [
    {
      "address": "0x3dbe077e7986657e95e1cc50089f17a5a4af0aae",
      "label": "Market Maker",
      "provenance": "Cross-aggregator RFQ counterparty (Nordstern/KyberSwap/Velora); silent value-mover (emits no logs), no pool interface / fill event / EIP-1967 slot; 4084-byte plain contract; diversified multi-chain inventory; Basescan unlabeled. Unprovable by the two on-chain tiers — human-attested.",
      "addedBy": "justin@withfabric.xyz",
      "date": "2026-07-21"
    }
  ]
}
```

### `packages/core/src/makerRegistry.ts`
Models `settlerRegistry.ts`. Loads `configs/makers.json` and exposes:
```ts
export function isCuratedMaker(address: string): boolean;
```
A lowercased `Set` membership test over the `makers[].address` values (identity is a
set, per the settlers precedent). `isCuratedMaker` is **synchronous** — the Step-4b
loop calls it inline — so the registry loads `makers.json` once with a memoized
`readFileSync` at first use (the established config-load pattern, e.g. `tagging.ts`),
not `settlerRegistry`'s async `readFile`. This runs only in the server-side core path
(`analyzeTransaction` → `decomposeRoute`), never the client bundle, so `fs` is safe
here (unlike the `receiptPure` client-leaf constraint). A malformed/missing file
degrades to an empty set (fail-closed: no crash, nothing gets mislabeled a maker).

### `decomposeRoute.ts` Step 4b
Add the curated list as a **last-resort tier** — checked only when the two on-chain
tiers do not prove the leg, so on-chain proof always takes precedence:

```ts
for (const leg of graph.legs) {
	if (leg.type !== 'unknown') continue;
	const proven = fillEmitters.has(leg.venue) || (await rfqProbe(leg.venue)) !== 'contract';
	const curated = !proven && isCuratedMaker(leg.venue);
	if (!proven && !curated) continue;
	leg.type = 'rfq';
	routeFlags.push(
		proven
			? `RFQ_LEG_UNPRICED: leg ${leg.venue.slice(0, 10)} — off-chain quote, no on-chain mid exists`
			: `RFQ_LEG_CURATED: leg ${leg.venue.slice(0, 10)} — curated market maker (human-attested), no on-chain mid exists`,
	);
}
```

The curated match yields the **identical** `rfq` treatment as a proven one — "Market
Maker" label, deliberate-null pricing, no confidence downgrade — because every
downstream consumer keys off `leg.type === 'rfq'`, not the flag string (verified:
`decomposeRoute.ts:501`, `hasRfqLeg` gate). The only difference is the audit flag:
`RFQ_LEG_CURATED` records that this leg's maker identity was human-attested, not
on-chain-proven.

## Deliberately NOT done

- **No DB retype/backfill.** The 4 existing rows (53, 208, 210, 236) keep their
  persisted `type=unknown` and will show "Unknown Pool" until re-analyzed on demand
  (paste the hash / recompute). The capability is correct going forward; no migration
  is run. (User decision — "Market Maker is good enough.")
- **No new UI treatment.** Curated makers reuse the existing "Market Maker" label and
  `RFQ_LEG_TOOLTIP`. The provenance lives in `makers.json` and the audit flag.
- **No auto-discovery.** `makers.json` is hand-maintained; there is no `makers:refresh`
  script (makers are not scan-discoverable — that is the whole reason this list exists).

## Testing

- `makerRegistry.test.ts`: `isCuratedMaker` returns true for the listed address (any
  case), false for an unlisted address.
- A `decomposeRoute` test: an `unknown` leg whose venue is the curated address, with a
  `rfqProbe` stub returning `'contract'` (neither tier fires), is retyped `rfq` and the
  route flags contain `RFQ_LEG_CURATED` (not `RFQ_LEG_UNPRICED`). Confirms curated is a
  genuine last-resort tier and the flag distinguishes provenance.
- Full suite stays green (baseline: 427 pass / 32 files). Gate with `tsc --build` +
  `npm run lint` + `vitest run`.
- Verify the mechanism end-to-end without a DB write: re-analyze row 53's tx on demand
  (`/?tx=0xb169b2e5…`) in dev and confirm the `0x3dbe077e7986…` leg renders "Market
  Maker" rather than "Unknown Pool".

## Out of scope

- ids 56 (V4 multi-pool leg-splitting) and 134 (input-token mid-chain recurrence) —
  different problem classes, not maker identity.
- Any change to the two on-chain tiers or the fail-closed philosophy.
