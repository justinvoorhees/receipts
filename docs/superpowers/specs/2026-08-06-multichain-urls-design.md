# Multi-Chain Receipt URLs — Design

**Date:** 2026-08-06
**Status:** Approved, ready for implementation planning
**Context:** Receipts are currently addressed by a query param on the index (`/?tx=0x…`) with the chain hardcoded to Base. Moving the chain into the path makes a receipt's URL self-describing and is a prerequisite for the database removal planned immediately after this work.

## Scope

Four changes:

1. **Route restructure** (§1) — `/tx/<chain-slug>/<hash>` becomes the canonical receipt URL; `/` becomes a search-only landing page.
2. **Chain registry** (§2) — one module owning the slug ↔ id ↔ explorer mapping, absorbing today's scattered chain constants.
3. **Load seam** (§3) — a single `loadReceipt(chain, hash)` function the DB removal can re-implement without touching routing. The existing chain-blind receipt query is left alone, guarded by a tripwire test rather than fixed.
4. **Link producers** (§4) — every place that mints a receipt URL moves to the new shape.

Explicitly **out of scope**, with reasons in §8: enabling a second chain, per-chain RPC configuration, the database removal itself, and a chain picker in the search UI.

## Background: why the chain belongs in the path

Three facts make this more than cosmetics.

**The database is already chain-aware; the read path is not.** `receipts` carries a `chain_id` column and a unique key on `(user_id, tx_hash, chain_id)` (`packages/db/src/schema.ts:114`), so it can legitimately hold the same transaction hash on two chains. But `getReceiptByHash` matches on `lower(tx_hash)` alone with `.limit(1)` (`packages/dashboard/lib/queries.ts:39-47`). The moment a second chain exists, that query returns whichever row Postgres happens to hand back first. The URL is the only place a chain can come from, so nothing downstream can be made correct until it is in the URL. This spec puts it in the URL but does **not** fix the query — see §3 for why that is safe today and what guards it.

**The database is being removed next.** Without persistence, a receipt URL stops pointing at a stored row and becomes the complete input to the computation: `(chain, hash)` is exactly what `analyzeTransaction` needs. Getting the chain into the path now is what lets that change be a swap of one function body rather than a routing rewrite.

**The chain is currently a constant in four places.** `DEFAULT_CHAIN_ID` is declared independently in `app/page.tsx:9` and `app/api/receipts/route.ts:25`, `SUPPORTED_CHAIN_IDS` in `app/api/receipts/route.ts:29`, and `basescan.org` is hardcoded in `components/receiptView.tsx:159` and again in `components/tradesTable.tsx`. Any second chain would have to find all of them.

## 1. Route restructure

### Shape

```
/                          search box only
/tx/base/0x<64 hex>        the receipt  ← canonical
```

The chain slug sits **under** `/tx` rather than at the root. A root-level `/<chain>/tx/<hash>` reads marginally better but permanently reserves the root namespace: every current and future top-level route (`/trades`, `/methodology`, `/api`, `/login`) becomes a word no chain slug may ever collide with, enforced by a catch-all segment that has to not-match them. Nesting under `/tx` costs one reserved segment and closes the question.

The slug is human-readable rather than numeric. `/tx/8453/0x…` is unambiguous and needs no registry, but a shared link that says `8453` is worse than the one being replaced. The numeric form is accepted as an alias (below) so programmatic callers and the existing `/api/receipts` numeric `chainId` contract stay coherent.

### Page responsibilities

`app/page.tsx` sheds the receipt entirely. It keeps reading `searchParams.tx` for exactly one purpose — redirecting legacy links — and never renders a receipt from it. Its `diagnosisLimiter` and the `classifyTransaction` call move to the new route unchanged.

`app/tx/[chain]/[hash]/page.tsx` gains the receipt render, the not-found state, the failure diagnosis, and the moved limiter.

### Canonicalization

The route resolves the chain and normalizes the hash **first**, compares the result against the incoming path, and issues **one** `permanentRedirect` (308, available in Next 15) if either differs. It must not chain two hops — a mixed-case hash under a numeric chain alias resolves to the final canonical form in a single redirect.

| Request | Response |
|---|---|
| `/?tx=0xAbC…` | `308 → /tx/base/0xabc…` |
| `/tx/8453/0xAbC…` | `308 → /tx/base/0xabc…` |
| `/tx/base/0xAbC…` | `308 → /tx/base/0xabc…` |
| `/tx/base/0xabc…` | `200` |
| `/tx/BASE/0xabc…` | `308 → /tx/base/0xabc…` |
| `/tx/arbitrum/0x…` | `404` |
| `/tx/base/0xnothex` | `404` |
| `/tx/base/0xabc` (short) | `404` |
| `/tx`, `/tx/base` | `404` |

The chain slug is matched case-insensitively but canonicalized to lowercase, so `/tx/BASE/…` redirects rather than 404s. The partial paths `/tx` and `/tx/base` have no page and 404 by Next's own routing — no handler is added for them.

Validation order is load-bearing. The hash is checked against `^0x[0-9a-fA-F]{64}$` and the chain slug resolved **before** any RPC call, any database query, and before a rate-limiter slot is consumed. A malformed URL costs one regular expression.

Rejection is a bare `notFound()`. Pre-declaring unsupported chains (`/tx/arbitrum/…` → "not supported yet") was considered and rejected: it adds a `supported: false` branch to carry, test, and keep truthful for chains that may never ship.

## 2. Chain registry — `packages/dashboard/lib/chains.ts`

```ts
export interface Chain {
  id: number;
  slug: string;
  name: string;
  explorer: string;
}

export const CHAINS: readonly Chain[];        // one entry: Base
export const DEFAULT_CHAIN: Chain;            // Base

/** Resolves 'base' or '8453'. `canonical` is false for the numeric alias. */
export function resolveChainParam(param: string): { chain: Chain; canonical: boolean } | null;
export function chainById(id: number): Chain | null;

export function explorerTx(chain: Chain, hash: string): string;
export function explorerAddress(chain: Chain, address: string): string;
```

The single Base entry is `{ id: 8453, slug: 'base', name: 'Base', explorer: 'https://basescan.org' }`.

**Placement.** This lives in the dashboard, not core. Core already accepts `chainId: number` throughout (`analyzeTransaction.ts:239`, `classifyTransaction.ts:17`) and has no use for slugs or explorer hosts, both of which are presentation concerns.

**What it absorbs.** Both `DEFAULT_CHAIN_ID` declarations, `SUPPORTED_CHAIN_IDS`, and both `basescan.org` literals. Adding chain #2 later touches this file and nothing else.

**Explorer links become row-derived.** `receiptView.tsx` and `tradesTable.tsx` resolve `chainById(row.chainId)` at render rather than assuming Base. If a stored row carries a chain id the registry does not know, the affected element renders **without a link** rather than a confidently wrong Basescan URL — the same "absent is not measured" rule applied elsewhere in this codebase to unresolved fees and unreadable mids.

## 3. Load seam — `packages/dashboard/lib/loadReceipt.ts`

```ts
export async function loadReceipt(chain: Chain, hash: string): Promise<ReceiptRow | null>;
```

The route calls only this. Today the body delegates to `getReceiptByHash(hash)`. The database-removal spec replaces the body with an on-demand `analyzeTransaction` call and changes no routing, no redirect logic, and no link producer.

`chain` is therefore accepted but unused by the current body. That is deliberate: it fixes the signature the DB removal needs, so that change edits one body rather than one body plus every caller.

### The unscoped read stays — and why that is safe *only* while `CHAINS` has one entry

`getReceiptByHash` matches on `lower(tx_hash)` with `.limit(1)` and ignores `chain_id` entirely (`lib/queries.ts:39-47`), even though the table's unique key is `(user_id, tx_hash, chain_id)` (`packages/db/src/schema.ts:114`). Adding the filter was considered and **cut**: the database is being removed next, and the query cannot currently return a wrong row, because §2 declares exactly one chain and every URL that resolves at all resolves to Base. There is no second chain's row for it to pick up.

**Tripwire.** That safety is a property of the registry, not of the query. Adding a second entry to `CHAINS` while Postgres is still in the picture makes `/tx/<newchain>/<hash>` silently serve the Base receipt for the same hash — a wrong receipt rendered with full confidence, not an error. Whichever comes first:

- **DB removed first** (the plan) — the question dissolves; `loadReceipt` computes from `(chain, hash)` and there is no row to mismatch.
- **Second chain first** — `getReceiptByHash` must take `chainId` and filter on it *in that same change*. It is a one-line `and(…)` needing no migration; `receipts_tx_hash_lower_idx` still serves the `lower(tx_hash)` predicate with `chain_id` applied as a filter on the result.

A comment on `CHAINS` in `chains.ts` records this, so the constraint is found by whoever adds the second chain rather than remembered from this document.

## 4. Link producers

| Site | Change |
|---|---|
| `components/receiptSearch.tsx:76` | `router.push` targets `/tx/<DEFAULT_CHAIN.slug>/<hash>` |
| `components/tradesTable.tsx:362` | `sharePath` derives its slug from `row.chainId` |
| `lib/alerts.ts:131` | Slack receipt link uses the new path |
| `lib/alerts.test.ts:171,182` | assertions updated |
| `app/api/receipts/activityNotify.test.ts:83` | assertion updated |

`next.config.mjs` sets `typedRoutes: true`, so template-literal hrefs against the new dynamic route continue to need their existing `as Route` casts.

The search flow itself is otherwise unchanged: `receiptSearch.tsx` still awaits `POST /api/receipts` to compute and persist, then navigates. Only the navigation target moves. The `finally` block that navigates even on a failed POST stays — a miss then renders the diagnosis on the new route, as it does today on the index.

## 5. Access policy and spend profile

`/tx/…` is public. `lib/accessDecision.ts:29` uses an explicit protected-list model in which **any route added later is public unless listed**, so this requires no change — and public is correct for a paste-a-hash receipt tool. A test will pin `/tx/base/<hash>` as `allow`, so it reads as a decision rather than as the default it currently is.

The RPC spend profile is unchanged by this work. The diagnosis limiter moves file but not behavior: the same single GET, the same per-IP window, the same global ceiling. The comment at `app/page.tsx:12-16` — that this is the cheapest path in the app to trigger, reachable by crawlers, link unfurlers and an `<img>` tag with no JS and no CORS preflight — moves with it and stays accurate.

The database removal will make every GET of `/tx/<chain>/<hash>` a full analysis rather than a row read. That is a real change in the spend profile, and it belongs to that spec. This design must not make it worse, which is why §1 validates before spending.

## 6. Testing

- **Canonicalization table** driving the full §1 matrix of redirects and 404s.
- **Single-hop assertion** — a mixed-case hash under the numeric alias reaches the canonical form in exactly one redirect. This is the specific thing that is easy to get wrong.
- **Cheap rejection** — a malformed hash and an unknown slug each return 404 having made no RPC call and consumed no limiter slot.
- **Registry** — slug and numeric resolution, `canonical` flag correctness, unknown input → `null`.
- **Explorer helpers** — correct host per chain; a row with an unregistered `chainId` renders no link at all.
- **Access** — `/tx/base/<hash>` decides `allow`.
- **Single-chain tripwire** — a test asserting `CHAINS.length === 1`, whose failure message states that `getReceiptByHash` ignores `chain_id` and must be filtered before a second chain ships (§3). A comment can be skipped; a red test cannot. It is expected to fail loudly when someone adds a chain — that is the whole point, and its message tells them what to do about it.
- **Updated assertions** in the four existing test sites listed in §4.

New tests are verified **by mutation**: break the route deliberately and confirm each test fails. This repo has a recorded history of positionally-defective assertions that pass vacuously (`docs/superpowers/plans/2026-07-28-receipt-ui-figma-v3.md`), and a redirect test that silently asserts nothing is exactly that failure shape.

## 7. Manual verification

With the dev server already running (never run `next build` over a live dev server — it writes into the same `.next`):

```
curl -sI "http://localhost:3000/?tx=<hash>"          # 308 → /tx/base/<hash lowercased>
curl -sI "http://localhost:3000/tx/8453/<HASH>"      # 308 → /tx/base/<hash lowercased>
curl -so /dev/null -w "%{http_code}\n" "http://localhost:3000/tx/base/<hash>"   # 200
curl -so /dev/null -w "%{http_code}\n" "http://localhost:3000/tx/arbitrum/<hash>"  # 404
```

Then load a receipt in a browser and confirm the Basescan links still resolve, and that `/trades` share links open the new path.

## 8. Out of scope

- **No second chain is enabled.** `CHAINS` has one entry. `/tx/arbitrum/…` returns 404, not a placeholder.
- **No per-chain RPC configuration.** `TCA_RPC_URL` remains a single environment variable. Multi-chain RPC config belongs with the work that actually analyzes a second chain.
- **`/api/receipts` is unchanged.** It keeps its numeric `chainId` JSON contract, its validation, and its rate limiting. The slug is a URL concern only.
- **No database removal.** That is the next spec; this one exists partly to make it cheap.
- **No chain picker in the search UI.** The search box submits to `DEFAULT_CHAIN`. A picker is unjustifiable while there is one chain to pick.
