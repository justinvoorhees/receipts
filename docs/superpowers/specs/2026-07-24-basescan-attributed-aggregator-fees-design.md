# Basescan-Attributed Aggregator Fees — Design

**Date:** 2026-07-24
**Status:** Approved (design), pending implementation plan

## Motivation

Trigger: "please attribute the Nordstern Fee on this receipt, and all other
Aggregator fees, to their basescan contract link" (tx
`0xb169b2e5…9b8bf536`, receipt id 53).

Today the receipt renders a single **Aggregator Fee** row. Its label/link come
from `getAggregatorFeeAttribution` (`receipt/receiptDisplay.tsx`), which uses a
hardcoded **curated `vaults` map** of three canonical fee vaults (Velora →
Augustus Fee Vault, Relay → Solver, KyberSwap → Fee Sink). Any aggregator not in
that map (Nordstern, 0x, OpenOcean, …) renders an **unlinked** `"[Provider] Fee"`
label.

Two problems:

1. **Uncurated aggregators get no link.** Nordstern's fee has no Basescan link
   even though we already persist its recipient.
2. **The curated addresses are wrong for the actual trade.** The curated map
   points at canonical vaults that the trades never touched. e.g. curated Velora
   → Augustus Fee Vault `0x0070…10CC`, but the real per-receipt Velora recipients
   are `0x0847…1aa1` ("PoolFees") and `0x3dbe…0aae`. The map masks the real sink.

The data to fix this already exists: **every fee-bearing receipt already persists
a `feeRecipient`** (the dominant fee sink, `feeSinkSource = 'retained_balance'`),
and core already computes the **full `feeSinks[]` array** internally before
discarding all but the dominant one.

## Desired behavior (user-specified flow)

For each aggregator-fee line:

1. If the fee contract is **named on Basescan**, use that name verbatim.
2. If there is **no name**, use a generic `"[Aggregator] Fee"` label.
3. If a trade has **multiple fee sinks**, the **first (dominant)** sink follows
   rules 1–2; every **subsequent** sink is labeled as its **truncated address**
   (`0x1234…abcd`, our standard truncation) — a deliberate visual cue for
   curation / investigation.
4. **All** fee lines link to their Basescan **address** page.
5. The current curated list is a **test case**: break entries out of it wherever
   the automated system reproduces an acceptable result. Curated = true last
   resort.

### Name source decision (locked)

Basescan **Public Name Tags** ("Augustus Fee Vault") are **Pro-API only**; our
`ETHERSCAN_API_KEY` is free-tier (verified: `nametag`/`metadata` endpoints return
"API Exclusive endpoint, upgrade your plan").

**Chosen:** the **free** Etherscan V2 `getsourcecode` → `ContractName` (the
verified-source contract name). Empty (unverified contract / EOA) → generic
label. This is supported and reliable; the tradeoff is the name is the camelCase
source name (`"AugustusFeeVault"`, `"PoolFees"`, `"Vault"`), not the human tag,
and unverified contracts fall to the generic label.

Evidence gathered (chainid 8453):

| Address | Role | `ContractName` |
|---|---|---|
| `0x00700052…10CC` | curated Augustus vault | `AugustusFeeVault` |
| `0x0847…1aa1` | real Velora recipient | `PoolFees` |
| `0x4f82…eb29` | curated KyberSwap sink | *(empty)* |
| `0xf70d…3dbEF` | curated Relay solver | *(empty)* |
| `0x3dbe…0aae` | **Nordstern recipient (id 53)** | *(empty)* → `"Nordstern Fee"` |
| `0x238a…e6c4` | Nordstern recipient (id 326) | `Vault` |
| `0x7d94…/0xbee3…/0xf606…` | real KyberSwap recipients | *(empty)* → `"KyberSwap Fee"` |
| `0x8dd9…1861` | real OpenOcean recipient | *(empty)* |

Consequence: all three curated entries can be **broken out**. KyberSwap/Relay
real recipients are unverified → clean generic labels on the *real* recipient
(more correct than the never-touched canonical address). Velora → `"PoolFees"`
or generic. The curated map ends up **empty** (manual-override structure only).

## Architecture

Five layers. Core stays RPC-pure; Etherscan lookups live only in the persist
path.

### 1. Core — expose the full fee-sink array

`decomposeRoute.ts` already builds `base.feeSinks[]` (`FeeSink = { address,
usdcRetained, wethRetained, totalUsdc, source }`) and reduces to the dominant
sink. Change:

- Surface the **full array, sorted dominant-first** (by `totalUsdc` desc).
- Attach a derived **`feeBps`** per sink: `totalUsdc / notionalUsdc × 1e4`
  (notional is already in scope in the fee step). Per-sink bps sum ≈ `aggFeeBps`.
- Keep `feeRecipient` / `feeSinkSource` (= `feeSinks[0]`) unchanged for
  back-compat.
- Plumb the array through `analyzeTransaction`'s output route.
- **No Etherscan calls in core.**

Persisted shape per sink: `{ address, feeBps, source }` (name added in the
persist layer, see §2).

### 2. Name resolver (new module)

`address → verified ContractName`, resolved in the **persist path** (Next API
route `app/api/receipts/route.ts` + `scripts/repopulateReceipts.mjs`), never in
core analysis and never at render time.

- Etherscan V2 `getsourcecode`, chainid 8453, guarded by `ETHERSCAN_API_KEY`.
- **Persisted JSON cache** (address → name-or-null), mirroring the `routers.json`
  curation pattern. **Negative-caches** unverified addresses (store `null`) so we
  never refetch known empties.
- **Graceful degradation:** no API key, or a fetch/parse failure → treat as
  unnamed (generic label). Never throws into the persist path.
- The **manual-override map** (the "curated list, last resort") lives here and
  starts **empty** after the three existing entries are broken out. An override,
  when present, wins over the fetched name.

Placement: a module importable by both the Next API route (TS) and the `.mjs`
repopulation script — i.e. `packages/core/src/…` exported and NOT invoked inside
`analyzeTransaction`, or a small server-side lib both entry points import from.
(Final placement decided in the plan; constraint: reachable from both callers,
core analysis remains RPC-pure.)

### 3. DB

- New JSONB column `fee_sinks` on `receipts`: `[{ address, feeBps, source, name
  }]`, dominant-first. `name` is `string | null`.
- Keep `feeRecipient` / `feeSinkSource` / `aggFeeBps` (back-compat;
  `feeRecipient = fee_sinks[0].address`).
- Drizzle migration + `schema.ts` update.
- Rows persisted before this column exists render from the legacy single
  `feeRecipient` (see §4 fallback).

### 4. Dashboard UI

Replace the single `getAggregatorFeeAttribution` with a **per-sink builder** →
ordered array of `{ label, href }`:

- `href` = `https://basescan.org/address/{address}` for every sink.
- Label:
  - sink 0 → `name || "[Aggregator] Fee"`
  - sink 1+ → truncated address (`0x1234…abcd`, existing truncation helper)
- **Fabric special-case preserved:** when the aggregator is `fabric` and the fee
  exceeds Fabric's protocol-fee cap (existing `integratorFee` condition), sink-0
  label = `name || "Integrator Fee"` (not `"Fabric Fee"`), keeping the existing
  neutral-integrator semantics.
- **Legacy fallback:** a row with no persisted `fee_sinks` falls back to a
  single synthetic sink from `feeRecipient` (label = `name?`—not available
  legacy → generic; href = recipient). Repopulation removes this case for
  existing rows.

`receiptView.tsx` renders the fee lines under the existing **Aggregator Fee**
heading — `feeLines.map(...)`, one `BkdRow` per sink, each with its per-sink bps
value (`agg.text` becomes per-sink). Delete the curated `vaults` map.

### 5. Repopulation

Re-run `scripts/repopulateReceipts.mjs` (bg — >5min for the full set; see
memory) so `fee_sinks` + names populate for all fee-bearing rows. Add the
`fee_sinks` column to the script's computed-column WATCH/UPDATE set. Verify:

- id 53 Nordstern → `"Nordstern Fee"` linked to `0x3dbe…0aae`.
- The three ex-curated aggregators render cleanly on their real recipients.

## Testing

- **Core:** `decomposeRoute` returns `feeSinks[]` dominant-first; per-sink `feeBps`
  sums ≈ `aggFeeBps`; single-sink and multi-sink fixtures.
- **Resolver:** cache hit / miss / negative-cache / no-key degradation
  (mocked fetch); override wins over fetched name.
- **UI:** attribution builder — single named, single unnamed→generic, multi-sink
  (first named/generic, rest truncated), Fabric→Integrator, legacy fallback.
- **e2e:** id 53 renders `"Nordstern Fee"` → `basescan.org/address/0x3dbe…`.

## Non-goals

- Basescan Public Name Tags (Pro-only) — explicitly out; free ContractName only.
- Re-deriving `feeSinks` detection logic — reuse core's existing detection
  unchanged; only surface the full array + per-sink bps.
- HTML scraping — rejected in favor of the supported free API.

## Risks / notes

- Free `ContractName` ≠ human name tag; many real recipients are unverified →
  generic labels. Accepted.
- Persisted receipts go stale silently on core changes (project-wide gotcha) —
  repopulation is mandatory, run in background (full set exceeds the 5-min tool
  timeout).
- Etherscan free-tier rate limits — the persisted cache + negative-cache keep
  live calls to first-sighting only.
