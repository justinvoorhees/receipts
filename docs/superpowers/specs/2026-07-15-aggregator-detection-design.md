# Aggregator Detection: Surviving Address Rotation

**Date:** 2026-07-15
**Status:** Design — approved, ready for planning

## Problem

`analyzeTransaction.ts:271` identifies the aggregator as `labelAddress(tx.to).label`, which
resolves `tx.to` against a hardcoded address list (`configs/routers.json`). When the address is
unknown, `labelAddress` returns the raw address, and that raw hex is written to the
`receipts.aggregator` column — a column the UI renders as the aggregator's name.

Receipts id 179 and 183 both carry `aggregator = '0x7747f8d2a76bd6345cc29622a946a929647f2359'`.
That address is **0x Settler**, confirmed two independent ways (below). Our registry has 0x's
*previous* generation, the ExchangeProxy at `0xdef1c0de…`.

This is not a missing-entry bug. 0x Settler **rotates its address by design** on every release.
Feature 2 (taker-submitted) has rotated **19 times**. Adding `0x7747f8d2…` to `routers.json`
fixes two rows and breaks again on the next rotation. Hardcoding is the wrong mechanism for
this aggregator.

## Scope

**In:** keep the aggregators we already know correctly identified as they redeploy or rotate.

**Out:** discovering that a never-seen contract *is* an aggregator (structural detection). Out:
the relayer/AA trader-anchoring problem for 0x's gasless feature-3 flow — pre-existing and
tracked separately.

## Evidence

0x publishes a Deployer/registry contract at `0x00000000000004533fe15556b1e086bb1a72ceae`, the
**same address on every chain**. It is an ERC721 where `tokenId` = feature number and the owner
is the live Settler for that feature.

Verified on Base:

```
ownerOf(2) -> 0x7747f8d2a76bd6345cc29622a946a929647f2359   ← tx 0xb02037…9e26's `to`
ownerOf(3) -> 0x68a14203953130ae840e37dbe3d64c1e6858da7b
ownerOf(4) -> 0x6b6e87d2cc438c287a5550a8732c302454e4382b
ownerOf(5) -> 0x8f526001400b4dbc2b05510f95157e748e645c5c
```

Features: 2 = taker-submitted, 3 = gasless/metatransaction, 4 = intents, 5 = bridge.

Because it is an ERC721, every rotation is a `Transfer`. A single unranged `eth_getLogs`
(`address` = Deployer, `topic0` = `Transfer`, `fromBlock` = 0) returns **58 logs** covering the
complete history, and the tail of each feature's chain matches the `ownerOf` results exactly —
two independent methods agreeing. Filtering the zero address yields **57 unique Settler
addresses**: 19 on feature 2, 19 on feature 3, 11 on feature 4, 7 on feature 5.

## Design Decision 1: auto-label only from authoritative identity

```
1. Resolver  — `to` ∈ 0x Deployer registry set   → authoritative, auto-label
2. Address   — `to` ∈ routers.json (curated)     → authoritative, auto-label
3. Unknown   — no guess; emit triage hint
```

### Why topics must not determine identity

The venue chain is `event topic → factory() → address list`, topic-first. The aggregator chain
deliberately **inverts** this and drops topics from identity entirely. `tx.to` is the contract
the taker actually called, and therefore *is* the aggregator they used. Settlement topics are
evidence about who is *inside* the trade — and aggregators nest. Trade 0xb02037…9e26 contains a
Bebop-shaped settlement at `0xbbbbbbb5…` inside a 0x trade; Nordstern's v2 router surfaces a
DeBridge/IceCreamSwap source.

Topic-based identity cannot distinguish these two cases:

- **A:** Nordstern ships router v3. `to` unknown, logs carry Nordstern's settlement topic.
  Correct label: **Nordstern**.
- **B:** A new meta-aggregator X routes through KyberSwap. `to` = X, logs carry Kyber's
  `Swapped`. Correct label: **X**, not Kyber.

Both are "unknown `to` + known inner topic". They are indistinguishable from logs alone. No
discriminator separates them: "does `to` call the aggregator's settlement contract?" is true in
both — Nordstern v2 calls Nordstern v1's settlement contract, and X calls Kyber's router the
same way.

Auto-labeling from topics buys case A at the cost of silently mislabeling case B. A confident
wrong attribution is worse than `unknown`: `unknown` is honest and gets triaged; a wrong label
never does.

The resolver tier is exempt from this ambiguity **not because it is cleverer but because it is
not inference**. 0x itself declares which addresses are its Settlers. That is why it is safe to
auto-label from and topics are not.

Corollary: `AGGREGATOR_SIGNATURES.velora` currently sets `detectBy: 'event_anywhere'`, which is
exactly the risky shape. It is retained, but confined to verification/hints — never identity.

## Design Decision 2: identity is a set, not a timeline

We only ever ask *"is this address 0x?"*, never *"is this the current Settler?"*. So the table
is the **set of every address ever registered to a Deployer feature**. Historical correctness
comes free: a tx from before a rotation resolves against the same set.

This dissolves the dwell-time problem. 0x documents a lag between deploying a Settler and the
API targeting it, and provides `prev(uint128)` to cope. We need neither: an address that was
ever a Settler is permanently identifiable as one. `fromBlock` is recorded for audit only and
is not consulted at lookup.

## Design Decision 3: precomputed table, synchronous lookup

`labelAddress` is synchronous (`tagging.ts:65`) and `analyzeTransaction.ts:271` calls it that
way. A live `eth_call` resolve would force it async and ripple outward. A refresh script writes
a generated config; lookup stays a pure set membership test with zero RPC at decode time.

Rotation happens a few times a year, so a committed generated file — diffable and reviewable in
PR — is the right cadence. No DB table.

## Components

| Component | Responsibility |
|---|---|
| `configs/settlers.json` | Generated, committed. `{aggregator, feature, address, fromBlock, source}` per entry, where `source` is the config-entry provenance (e.g. `'deployer-transfer-scan'`) — distinct from the runtime `detectedVia` tier below. |
| `scripts/refresh-settlers.ts` | Scans Deployer `Transfer` logs → writes the config. Idempotent. |
| `packages/core/src/aggregatorResolver.ts` | Sync set lookup. Loads `settlers.json` at module load, mirroring `tagging.ts`'s existing top-level-await pattern. |
| `packages/core/src/aggregatorSignatures.ts` | Topic backfill; mark 0x anonymous-log. |
| `analyzeTransaction.ts:271` | Call `resolveAggregator(tx.to, logs)` → `{label, detectedVia}`. |

### Refresh script details

- One unranged `eth_getLogs`; no block-chunking needed (verified: 58 logs).
- **Filter the zero address** from the address set. Feature 1 was minted at block 12723120 and
  burned at 14859201 — retired features exist. The burn target is not a Settler; the pre-burn
  address `0x109969447f…` *is*, and stays in the set.
- Scan all features present, not a hardcoded 2–5 list, so a future feature 6 needs no code
  change.
- Deployer unreachable → **fail loudly, leave the config untouched** (last-known-good). Never
  silently write an empty set.

## Design Decision 4: bounded topic backfill

Topics are excluded from identity but retain two jobs: verification (`settlement_event_seen`)
and triage hints. The backfill is worth doing because the current state is weaker than it looks
— `settlementEventPresent` falls back to "any non-noise event emitted by the router" when
`eventTopic0` is null, so `settlement_event_seen = true` for **Odos** today is *vacuous*: a
check that cannot fail. Backfilling converts it into one that can.

**Method:** for each aggregator with a null topic, take a real tx — one of ours if we have one,
otherwise one found on-chain — and diff events emitted by the settlement contract against the
noise set (`Transfer`/`Deposit`/`Withdrawal`), via the existing `findSettlementEvents`.

**Stop rule:** if no sample tx is found in one pass, leave the topic null and record why in the
inline comment. Do not open-endedly hunt.

Per aggregator:

- **Odos** — 2 receipts exist; discoverable now.
- **1inch** — zero receipts; on-chain sample or defer per the stop rule.
- **0x** — **excluded by construction.** Its Settler log is *anonymous* (`topics: []`):

  ```
  topics: []
  data: 0x00000000000000000000000000000000
        2f4cfeac329da49098e034f534fe4f6c000000000000321206cd5f7792511c2a
  ```

  `findSettlementEvents` does `if (!topic0) continue`, so 0x is invisible to topic machinery by
  construction. The resolver covers it. Record this in the registry so nobody retries.

## Data flow

```
tx.to, logs ─► resolveAggregator
                 ├─ settlers.json set hit      → {label: '0x',    detectedVia: 'resolver'}
                 ├─ routers.json hit           → {label: 'Kyber', detectedVia: 'address'}
                 └─ miss                       → {label: raw hex, detectedVia: 'unknown'}
                                                  + AGGREGATOR_UNKNOWN_HINT flag if a known
                                                    settlement topic appears in logs
```

`detectedVia` is recorded in `normalize_flags`, not a new column — no migration. Revisit if it
needs to be queryable.

## Error handling

- Refresh: Deployer unreachable → fail loudly, config untouched.
- Runtime: `settlers.json` unloadable → degrade to an empty set, never throw. Mirrors
  `tagging.ts`'s existing contract.
- Unknown `to` with **multiple** known settlement topics in logs → emit the hint listing all
  candidates; label nothing.

## Testing

- **Precedence:** known `to` + foreign inner topic → `to` wins. This is the nesting guard and
  the single most important test; trade 0xb02037…9e26 (0x outer, Bebop inner) is the fixture.
- **Resolver:** a historical Settler address (e.g. feature 2's `0xdc5d8200…`, retired at block
  44438102) resolves to `0x` — proves Decision 2's set-not-timeline claim.
- **Zero-address filter:** feature 1's burn does not put `0x0` in the set.
- **Unknown + hint:** unknown `to` carrying Nordstern's topic → `unknown` label, hint emitted.
  Asserts we do *not* auto-label — the case-B guard.
- **Regression:** the 41 currently-labeled receipts keep their labels.
- **Refresh script:** against a recorded Deployer-logs fixture, not live RPC.

## Expected outcome

- ids 179 and 183 → `0x` on repopulate.
- All 57 historical Settler addresses recognized, so older 0x trades resolve on first paste.
- Future rotations need a `refresh-settlers` run and a config diff — no code change.
- A future Nordstern-style redeploy surfaces as `unknown` + hint rather than silently passing
  through as raw hex.

## Open / deferred

- 1inch topic backfill may defer per the stop rule.
- 0x feature-3 (gasless) trades are relayer-submitted: `tx.from` is not the taker. Aggregator
  identity is still correct; trader anchoring is the pre-existing relayer/AA earmark.
- Other aggregators with published registries could reuse the resolver tier. None known today —
  do not build the abstraction for N=1.
