# Spec: corpus migration + notional gating

**Status:** decided, not implemented · **Date:** 2026-08-12 · **Decided by:** user, closing out the depth-floor work (`5b67b11`)

Two independent follow-ups. They share no code and should be two plans.

---

## Part A — migrate `corpus.json` into `cases.json`, rot-free

**Decision: move all 62 corpus transactions into `docs/qa/cases.json`, shed every decoded column, keep only fields that cannot rot.**

### Why

`corpus.json` mixes two things with opposite shelf lives: a curated list of interesting transactions (never rots) and a snapshot of decoded output (rots on *every* pricing change). The depth floor just staled **14 of its 62 rows** — 5 changed pricing values, 7 changed `market_price_flags`, 2 changed `route_legs`; the other 48 are unaffected in corpus columns.

Regenerating is not the answer: `scripts/freezeCorpus.mjs` was deliberately deleted with a "do not re-add" note when the database went, and re-adding it also means re-crossing the documented trap that corpus numerics are **strings** while fresh decodes are **numbers**.

### Rot-free field set

Keep only facts about the transaction itself, never about our interpretation of it:

| field | keep? | why |
|---|---|---|
| `hash`, `chainId` | ✅ | immutable |
| `blockNumber` | ✅ | a fact about the tx; saves an RPC round trip and never rots |
| `added`, `tags[]`, `why` | ✅ | curatorial, authored by us |
| everything else | ❌ | decoded output — the rotting half |

⚠️ **`route_shape`, `hop_count`, `tier`, `pricing_status`, `aggregator` all LOOK durable and are not.** Each is a decoder verdict that has already changed at least once this year. Do not smuggle them across as "metadata".

### ⚠️ The blocker to resolve first: 62 entries with no `why`

`cases.json`'s own contract is *"`why` earns the entry its place — a hash with no explanation is impossible to prune later."* A bulk migration has no per-entry rationale, and generating one from decoded output would import exactly the rot we are removing.

Three options, to be decided before writing the plan:

1. **Provenance marker** — a shared `"source": "corpus-v1"` plus a one-line `why` naming what the corpus was for. Honest about the fact that these were bulk-curated, not individually justified. *Recommended.*
2. **Per-entry `why` from durable facts only** — pair symbols and block. Thin, and symbols are themselves a decoder output.
3. **Tag-only** — drop `why` for migrated rows, keeping it required for new ones. Weakens the contract for everyone.

### ⚠️ Ten analysis scripts read the perishable columns

They break silently the moment those columns disappear — each must migrate to live re-decode **in the same change**, or be deleted:

`reconResidual` · `blastRadius` · `attributionCoverage` · `coverageEstimate` · `unpricedCauses` · `referencePoolInRoute` · `preTxRulerError` · `marketMidSnapshot` · `decodeGolden` · `scripts/corpus.test.mjs`

⭐ **`referenceDepthDistribution.mjs` is the reference implementation** — it already reads only hashes and block numbers and re-decodes everything else, and survived the depth floor untouched.

`loadCorpus()` in `scripts/analysis/_env.mjs` goes away or changes shape; `loadCases()` becomes the single loader.

---

## Part B — rank *and* floor the notional path

**Decision: `getTokenUsdcValue` gets ranked, floored discovery, and the `Size` row hides when pricing is unavailable.**

### The finding this rests on

`getTokenUsdcValue` resolves mids through `getPairMidAtBlock` → `discoverPool`, which is **first-match, not even depth-ranked**. So the receipt currently answers "which pool prices this token" two different ways: market price via ranked-and-floored discovery, notional via whichever pool the factory scan hits first. The gap is wider than the depth-floor spec recorded.

It only bites when **neither** side anchors — otherwise `bestEffortNotional` prefers the anchored side, which is why both 2026-08-12 cases were safe. Roughly 3–5% of receipts. But there the `Size` row is the *only* dollar figure on the page, because `receiptDollars` returns null without an anchor.

Precedent, from `bestEffortNotional`'s own docstring: a WARP→ETH swap whose WARP/USDC pool had zero in-range liquidity and a stale mid, *"inflating notional ~7×."*

### Scope

- **Ranking is uncontroversial** — first-match is strictly worse than deepest-wins with no product tradeoff. Do it regardless of the floor.
- **Gate at `bestEffortNotional`**, the receipt-level notional. ⚠️ `getTokenUsdcValue` also feeds per-leg `notionalUsdc`, which **weights price impact** (`weightedPriceImpactBps`); changing it there moves every leg's numbers and needs its own golden diff. Do not do both in one change without measuring.

### ⚠️ Hiding `Size`: the rule as stated removes a *correct* number

Taken literally — "hide `Size` when pricing is Unavailable" — this also hides it on **anchored** floored receipts, where the figure is independently derived and trustworthy. On `0x7e21b6dc` today, `Size ~$81.68` comes from `bestEffortNotional` valuing the anchored ETH side and never touches the dust pool; it is the only dollar the receipt still shows, and it is right.

The case for hiding is consistency: if we refuse the market price, refusing the dollar figure too is simpler to explain. The case against is that we would be discarding a measurement we trust to make a point about one we do not.

**Recommended refinement — hide `Size` when the NOTIONAL is unverified, not when the market price is:**

| receipt | notional source | `Size` |
|---|---|---|
| anchored + floored ruler (`0x7e21b6dc`) | anchored side, trustworthy | **keep** `~$81.68` |
| non-anchored + floored/unranked source | the ungated pool — the actual risk | **hide** |

This targets the row exactly where it is untrustworthy. ⚠️ Note `anchored` in `receiptView.tsx:186` is literally `dollars != null`, so hiding `Size` on a null-mid receipt reintroduces a page with no dollar figure at all — the state the depth-floor work specifically avoided.

**Open for the user:** accept the refinement, or hide `Size` on every unavailable-pricing receipt as originally stated? If hidden, decide whether the row renders `N/A` (interrogable, consistent with the other unavailable rows) or disappears entirely.

---

## Testing both parts

- Part A: the migration is mechanical, but each rewritten script needs its output compared before/after on the same transactions. `npx vitest run` from the **repo root**.
- Part B: golden diff, **captured serially** (`decodeGolden.mjs`) — concurrency produces false differences. Expect changes confined to non-anchored pairs; anything else is a regression.
- Part B RPC e2e: pin a non-anchored pair whose notional currently comes from a first-match pool, and assert the ranked result differs.
