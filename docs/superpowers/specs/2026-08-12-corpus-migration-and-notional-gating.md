# Spec: corpus migration + notional gating

**Status:** decided, ready to plan · **Date:** 2026-08-12 (revised same day, after reading the call sites) · **Decided by:** user, closing out the depth-floor work (`5b67b11`)

Two independent follow-ups. They share no code and should be two plans.

> **Revision note.** The first draft of this spec made two claims about Part B that the code does not support, and one about Part A's reference script. All three are corrected inline below and marked ⛔. Read those before planning — one of them changes which files the change touches.

---

## Part A — migrate `corpus.json` into `cases.json`, rot-free

**Decision: move all 62 corpus transactions into `docs/qa/cases.json`, shed every decoded column, keep only fields that cannot rot.**

### Why

`corpus.json` mixes two things with opposite shelf lives: a curated list of interesting transactions (never rots) and a snapshot of decoded output (rots on *every* pricing change). The depth floor just staled **14 of its 62 rows** — 5 changed pricing values, 7 changed `market_price_flags`, 2 changed `route_legs`; the other 48 are unaffected in corpus columns.

Regenerating is not the answer: `scripts/freezeCorpus.mjs` was deliberately deleted with a "do not re-add" note when the database went, and re-adding it also means re-crossing the documented trap that corpus numerics are **strings** while fresh decodes are **numbers**.

### Rot-free field set

Keep only facts about the transaction itself, or curatorial labels we authored — never our interpretation of the trade:

| field | source | keep? | why |
|---|---|---|---|
| `hash` | `tx_hash` | ✅ | immutable |
| `chainId` | `chain_id` | ✅ | immutable (all 62 are 8453) |
| `blockNumber` | `block_number` | ✅ | a fact about the tx; saves an RPC round trip and never rots. Present on all 62 |
| `added` | `created_at`, date part | ✅ | when *we* added it, not a decoder verdict. Span: 2026-06-30 → 2026-08-06 |
| `corpusId` | `id` | ✅ | **see below** |
| `source: "corpus-v1"` | new | ✅ | provenance marker; distinguishes bulk-migrated from individually justified |
| `why` | new, shared string | ✅ | see "the `why` blocker" |
| everything else | — | ❌ | decoded output — the rotting half |

⚠️ **`route_shape`, `hop_count`, `tier`, `pricing_status`, `aggregator` all LOOK durable and are not.** Each is a decoder verdict that has already changed at least once this year. Do not smuggle them across as "metadata".

⚠️ **`input_token` / `output_token` are decoder output too**, and are less obviously so than the rest — the 7702/ERC-4337 anchoring fixes (`dd831d6`) changed which tokens a receipt calls in and out. They do not migrate. This has a cost; see the `referenceDepthDistribution` note below.

**`corpusId` earns its place** as a curatorial label, not a measurement. "Corpus id 485", "ids 55/207", "354 + 543" is the vocabulary a dozen code comments, prior specs, and memory files already speak. Drop the field and every one of those references dangles with nothing to resolve against. Ids run 36–555 (sparse — the DB's own sequence, with gaps).

### The `why` blocker — resolved

`cases.json`'s contract is *"`why` earns the entry its place — a hash with no explanation is impossible to prune later."* `corpus.json` cannot satisfy it per-entry: it carries **no curatorial fields at all**. It is a raw DB dump — `id`, `user_id`, `created_at`, then 45 decoded columns. There is nothing to say about entry #36 that is not a decoder verdict.

**Decision: shared provenance marker.** Every migrated entry carries `"source": "corpus-v1"` and one identical `why` naming what the corpus was for — the v1 analysis sweep set, retained because the analysis scripts need a transaction list with known-interesting shapes. This is honest that they were bulk-curated, and a reader can tell at a glance which entries carry a real rationale and which inherited one.

Rejected: per-entry `why` synthesized from pair symbols (symbols are themselves decoder output — it would import exactly the rot being removed), and tag-only (makes `why` optional in practice, which is what the contract exists to prevent).

### ⚠️ One hash is already in `cases.json`

**Corpus id 485 (`0x79854af2…`, POD→USDC) is entry #2 of `cases.json` today**, and its hand-written `why` literally cites "Corpus id 485". The migration is therefore **61 new entries + 1 merge**: add `corpusId: 485` to the existing entry and leave its `why` and `tags` alone. A blind append produces a duplicate hash and a `why` regression on the better of the two.

### The scripts that read the perishable columns

Twelve scripts call `loadCorpus()`, plus one test that reads the file directly. Each breaks silently the moment those columns disappear, so each must migrate to live re-decode **in the same change**, or be deleted. They fall into three buckets:

**Bucket 1 — already re-decode; need only the loader swapped and the pair re-derived**
`decodeGolden` · `decodeBench` · `rpcProviderAB` · `marketMidSnapshot` · `preTxRulerError` · `referencePoolInRoute` · `referenceDepthDistribution`

**Bucket 2 — read decoded columns as their actual subject matter; need a full re-decode pass written**
`reconResidual` · `blastRadius` · `attributionCoverage` · `coverageEstimate` · `unpricedCauses`

All five filter on `route_legs != null` and compute over `route_legs`, `slippage_bps`, `recon_residual_bps`, and friends. This is the real work of Part A. They must decode each transaction and read the same quantities off the live result.

**Bucket 3 — asserts on the file's shape**
`scripts/corpus.test.mjs` asserts `tx_hash`, `notional_usd`, `route_legs` exist and that every row clears a $5 notional floor. Two of those three properties are leaving. Rewrite it against `cases.json`'s shape (hash present, `chainId` present, `why` non-empty, no duplicate hashes) or delete it — but do not leave it asserting on a file that no longer exists.

⛔ **Correction to the first draft.** It named `referenceDepthDistribution` the ⭐ reference implementation on the grounds that it "already reads only hashes and block numbers". It does not: it reads `input_token` and `output_token` **as inputs** (they drive `getDeepestPoolWithDepth`), and `tier` / `all_in_cost_bps` / `notional_usd` / `input_symbol` as report annotations. It is still the closest thing to a model — everything material is re-decoded live, which is why it survived the depth floor untouched — but it needs a change too: the pair must come from decoding the transaction, which adds a decode per row where today there is a column read.

`loadCorpus()` in `scripts/analysis/_env.mjs` goes away; `loadCases()` becomes the single loader.

### Sequencing — the part that keeps it from breaking silently

The failure mode here is a script that still runs and quietly reports on nothing. Order the work so that never has a window:

1. Add the 61 entries + the 485 merge to `cases.json` **while `corpus.json` still exists**. Nothing breaks; the two files coexist.
2. Migrate scripts one at a time, comparing each one's output before and after **on the same transactions**. Bucket 2 is where numbers will move — a re-decode at today's code is not obliged to reproduce a snapshot taken weeks ago, and where it differs, the difference is the rot this whole exercise is about. Record it, don't "fix" it.
3. Only once every consumer is migrated: delete `corpus.json`, delete `loadCorpus()`, rewrite or delete `corpus.test.mjs`.

---

## Part B — rank *and* floor the notional path

**Decision: `getTokenUsdcValue` is rebuilt on the depth-floor apparatus, and `bestEffortNotional` returns null when the side it valued was priced by a below-floor pool.**

### The finding this rests on

`getTokenUsdcValue` resolves mids through `getPairMidAtBlock` → `discoverPool`, which is **first-match, not even depth-ranked**, and prefers the **direct token/USDC pool** — the dead-pool trap. So the receipt currently answers "which pool prices this token" two different ways: market price via ranked-and-floored discovery, notional via whichever pool the factory scan hits first.

It only bites when **neither** side anchors — otherwise `bestEffortNotional` prefers the anchored side, which is why both 2026-08-12 cases were safe. Roughly 3–5% of receipts. But there the `Size` row is the *only* dollar figure on the page, because `receiptDollars` returns null without an anchor.

Precedent, from `bestEffortNotional`'s own docstring: a WARP→ETH swap whose WARP/USDC pool had zero in-range liquidity and a stale mid, *"inflating notional ~7×."*

### ⛔ Correction: the per-leg coupling is not where the first draft said

The first draft warned that `getTokenUsdcValue` "also feeds per-leg `notionalUsdc`, which weights price impact". **It does not.** `getTokenUsdcValue` has exactly one production call site — `pricing.ts:445`, wiring `deps.getUsdValue` — consumed only by `bestEffortNotional`. Per-leg notionals come from `valueLegNotionalUsdc` (`legFees.ts:51`), which is **pure**: USDC endpoint → WETH endpoint → else fall back to the trade-level notional. It never discovers a pool.

So "rank everywhere" and "gate at `bestEffortNotional`" are the same one-call-site change. There is no second discovery path to leave behind.

**The coupling is real, but it arrives through a different door and is sharper.** `analyzeTransaction.ts:456` passes `notionalUsdc: notionalUsd ?? 0` into `decomposeTrade`. Null the receipt notional and every leg with *neither* a USDC nor a WETH endpoint falls back to **0**, zeroing its weight in `weightedPriceImpactBps` and the `lpFeeBps` roll-up. Mitigating fact: this is already what happens on every partial-tier receipt today, so it is a trodden path, not a new one — but it is the first thing to look for in the golden diff.

### Design

Reuse what the depth floor already built. `usdRefGated` (`tokenPricing.ts:305`) is exactly the ranked, floored, per-unit USD valuation this path wants:

- prices a volatile token through its **deepest** `token/WETH` pool, **never** the direct `token/USDC` pool;
- returns evidence, not a bare number — `{price, usd, pool, rejected, unverified}`;
- treats USDC / WETH / native as anchored, with no pool to gate.

`bridgeReaders` is already constructed in the same closure as the `getUsdValue` wiring at `pricing.ts:445`, so the change is local. `bestEffortNotional` then returns null when the side it valued came back `rejected` (below `MIN_REFERENCE_DEPTH_USD`, currently $100). `precomputedWethUsd` — the fast path's validated benchmark mid — keeps its override and its precedence.

**Gate on `rejected` only, not on `unverified`.** A depth that could not be valued is recorded as "check not performed" and allowed through, which is exactly what the market-price ruler does with the same signal. If the notional refused where the ruler does not, the two rows would start telling different stories about the same pool.

### Hiding `Size`: what the rule actually resolves to

**Decision (user, 2026-08-12): hide `Size` when the NOTIONAL is unverified, not when the market price is.** Rejected: hiding it on every unavailable-pricing receipt, which would discard a measurement we trust to make a point about one we do not.

⛔ **Correction: `Size` already renders only when `!anchored`** (`receiptView.tsx:256`), and `anchored` is literally `dollars != null` (`receiptView.tsx:186`), which requires a mid. So on `0x7e21b6dc` — floored ruler, null mid — the receipt *is* "non-anchored" by the UI's flag, yet its `~$81.68` comes from the anchored ETH side and is correct. The refinement cannot key off that flag. It has to key off **which side `bestEffortNotional` actually valued**, which is precisely what gating in core delivers.

| receipt | notional source | `Size` |
|---|---|---|
| anchored side valued (`0x7e21b6dc`) | ETH via the WETH/USDC reference — trustworthy | **keep** `~$81.68` |
| non-anchored, valued by a below-floor pool | the ungated pool — the actual risk | **refused in core → row shows the unavailable state** |
| non-anchored, valued by a pool clearing the floor | ranked winner, floor passed | **keep** |

**The UI needs no new branch and no new Receipt field.** `receiptView.tsx:258` already renders an unavailable state when `row.notionalUsd == null`. Gating in core means the untrustworthy number never leaves core, so `lib/alerts.ts` and every other `notionalUsd` reader are protected by the same change.

**One UI change is required.** The null text today is the bare string `UNAVAILABLE` = `'Unavailable for this pair'` (`priceFormat.ts:195`). Under the gate the reason is specific — no pool deep enough to value this trade — and `5b67b11` established that a whole-trade N/A the reader cannot interrogate is a dead end. `Size` gets the same dotted-underline affordance and a reason string of its own.

### Scope boundary

Ranking is uncontroversial and ships regardless: first-match is strictly worse than deepest-wins with no product tradeoff. The floor is the decision, and it applies at the receipt notional. Per-leg valuation is out of scope because there is nothing there to change — see the correction above.

---

## Testing

**Part A**
- Every migrated script's output compared before/after **on the same transactions**. Bucket 2 differences are expected and are the finding, not a regression — record them.
- `npx vitest run` from the **repo root**. Running it from `packages/dashboard` reports roughly half the suite.
- Assert the migration itself: `cases.json` ends at 68 entries (7 existing + 61 new), exactly 62 carry a `corpusId`, no duplicate hashes, `corpusId` values unique, and entry 485 kept its original hand-written `why`.

**Part B**
- Golden diff, **captured serially** (`decodeGolden.mjs`) — concurrency produces false differences. Expect movement confined to non-anchored pairs. Check specifically for legs whose notional fell to 0 via the `notionalUsd ?? 0` path.
- Assert `0x7e21b6dc` still shows `~$81.68` — it is the case the refinement exists to protect.
- RPC e2e: pin a non-anchored pair whose notional currently comes from a first-match pool, and assert the ranked result differs.
- Unit: the gated valuation returns null with `rejected: true` on a below-floor pool, and a number on one that clears it. ⚠️ `unverified` is **structurally unreachable** on this path — `usdRefGated` always prices against WETH, `pickReferenceToken(volatile, WETH)` always returns WETH, so `depthUsd` can only go null when `wethUsd` is invalid, which fails anchor resolution first. Plumb the field for parity with the ruler; do not write a test that has to defeat the types to fire it.
