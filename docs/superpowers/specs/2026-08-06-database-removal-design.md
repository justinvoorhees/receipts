# Database Removal — Ephemeral Receipts

**Status:** approved, not scheduled
**Depends on:** `docs/superpowers/plans/2026-08-06-multichain-urls.md` Tasks 4–7 must land first

## Why

The database was a QA crutch. It carries a schema, four migrations, a Railway
Postgres instance, a login stack that exists only to protect it, and a standing
correctness hazard: a persisted receipt goes stale silently whenever pricing
code changes, because the cache-hit path never recomputes. That has bitten this
project three times.

Nothing the tool shows a user requires persistence. A mined transaction plus a
fixed pricing code path is a pure function; the receipt is its output. Storing
that output buys deduplication and nothing else, and it buys it at the price of
a datastore that can disagree with the code that produced it.

After this change the only thing the service persists is log lines; a
best-effort contract-name cache is written to the container's ephemeral
filesystem (`configs/contractNames.json`, via `persistCache()` in
`packages/core/src/contractNames.ts`) and does not survive a deploy.

## What the tool becomes

Three routes:

| Route | Behavior |
|---|---|
| `/` | search box only |
| `/tx/<chain>/<hash>` | computes the receipt on the spot, renders it |
| `/qa/tx/<chain>/<hash>,<hash>,…` | comparison table; **404s in production** |

Nothing else. No `/trades`, no `/api/receipts`, no login.

## Architecture

### The seam

`lib/loadReceipt.ts` (added in `bf2ddd4`) was built for exactly this. Its body
changes; its signature does not:

```
loadReceipt(chain, hash):
  receipt = await analyzeTransaction(hash, chain.id, { rpcUrl })
  if (!receipt) return null
  return {
    ...receipt,
    feeSinks: await enrichFeeSinkNames(receipt.feeSinks),
    routeLegs: enrichLegRouters(receipt.routeLegs),
  }
```

Both enrichments already exist — `enrichFeeSinkNames` in core (called today at
persist time), `enrichLegRouters` in `lib/queries.ts` (called today at read
time). They move to one place and run once, on the way out of `loadReceipt`.

`enrichLegRouters` changes signature. Today it is `(row: ReceiptRow) =>
ReceiptRow` — it takes a whole row to reach one field. It becomes
`(legs: unknown[] | null) => EnrichedRouteLeg[] | null`, which is what it always
meant. `lib/legRouterEnrichment.test.ts` already exists and already tests this
function through `lib/queries.ts`; it becomes a direct test of its own module.

`EnrichedFeeSink` and `EnrichedRouteLeg` are the return types of those two
functions, named explicitly rather than inferred, so `ReceiptModel` states its
shape instead of deriving it.

**No caching.** Every view is a fresh analysis, roughly 40 RPC calls. This is a
deliberate scope cut, not an oversight — see *Deferred* below.

### `ReceiptRow` is deleted, not adapted

The UI consumes core's `Receipt` directly. `ReceiptRow` was always a lossy
projection of it: every column in `toNewReceipt` is sourced from an `r.<field>`,
and the only differences are `id` / `createdAt` / `userId` (all DB bookkeeping)
plus Drizzle's `numeric` columns arriving as strings instead of numbers.

```ts
// lib/receiptModel.ts
import type { Receipt } from '@fabric-tca/core/pure';

export type ReceiptModel = Receipt & {
  feeSinks: EnrichedFeeSink[];
  routeLegs: EnrichedRouteLeg[];
};
```

This is safe because the receipt UI was **already written to accept numbers**.
Verified against the current tree:

```
receiptDisplay.tsx:154   row: { slippageBps: string | number | null; … }
receiptDisplay.tsx:541   row: { inputSymbol: string; inputAmount: string | number }
receiptDisplay.tsx:545   row: { outputSymbol: string; outputAmount: string | number }
receiptDisplay.tsx:613   aggFeeBps: string | number | null
receiptDisplay.tsx:638   notionalUsd: string | number | null | undefined
priceFormat.ts:17,143    (marketMid: unknown, realizedPrice: unknown, …)
```

Five signatures already widened, two already taking `unknown`. Every numeric
read goes through `Number(x)`, which is identity on a number. Across 78 numeric
field reads in surviving code, the only genuine `string | null` holdout is
`lib/alerts.ts:125-126` (`ReceiptSummary.notionalUsd`, `.allInCostBps`), which
widens to `number | null`.

`Receipt` must be re-exported from `packages/core/src/receiptPure.ts` as a
type-only re-export. The receipt components are `'use client'`, and the leaf
subpath is the established discipline for that tree — importing from the barrel
drags `analyzeTransaction → tagging → node:fs`. A type-only import is erased and
would work either way, but the discipline should not develop an exception.

Type narrowing that comes for free and must not be fought: `Receipt` declares
`pricingStatus` as `'full' | 'estimated' | 'partial'`, `marketPriceFlags` as
`string[] | null`, and `settlementEventSeen` / `manipulationFlag` as non-null
booleans. All narrower than the DB row. Consumers relying on the wider type get
stricter, not broken.

**Explicitly out of scope:** deleting the now-redundant `Number()` calls. They
are null-guarded and finite-checked, identity on numbers, and removing ~30 of
them is churn in exactly the files under review — the kind of edit where one
dropped `Number.isFinite` guard puts a `NaN` on a receipt. Leave them.

### `/api/receipts` is deleted entirely

Not just `DELETE`. The `POST` exists solely to persist a row before the page
reads it back (`receiptSearch.tsx:66` — POST, then `router.push`). With the page
computing directly, search only needs to navigate.

**This relocates the RPC-bill circuit breaker onto the `/tx` page render.** All
three limiters move: per-IP request, per-IP analysis, and the global hourly
ceiling. This is the most load-bearing part of the change and gets its own task
with its own tests.

Search loses its await-then-navigate loader. It becomes `useTransition` around
`router.push` plus a `loading.tsx` on the `/tx` route, so the spinner is the
route transition — which is what is actually happening.

### `/qa/tx/<chain>/<hash>,<hash>,…`

Stateless — the hashes are in the URL, no checked-in corpus file. Reuses
`resolveChainParam` from `lib/chains.ts`, then splits the hash segment on
commas. Same chain-scoped shape as `/tx`, so the two read as one family.

**Dev-only.** The App Router cannot conditionally register a route file, so the
mechanism is the page's first statement: `if (process.env.NODE_ENV ===
'production') notFound()`. In the deployed app the route answers 404 and never
reaches `loadReceipt` — therefore it needs no auth, therefore the entire login
stack dies with `/trades`. Locally it runs against your own RPC key with no rate
limiting.

That guard is the only thing standing between a public URL and an unmetered
`n × 40` RPC call, so its test is not optional bookkeeping.

Per-hash failures are isolated: one bad hash renders one bad cell, not a 500.

### Logging

`lib/log.ts`, roughly 40 lines, zero dependencies:

- `LOG_LEVEL` env var — `info` in production, `debug` in development
- five methods: `error`, `warn`, `info`, `debug`, `trace`
- one JSON line per event to stdout/stderr: `{level, msg, ...fields}`

Every existing `console.*` in `packages/dashboard` and `packages/core` converts,
with one deliberate carve-out: the 24 `console.*` calls in
`packages/core/src/scripts/` stay as-is — those are human-facing CLI output
(`settlers:refresh`, `reactors:refresh`, `aggregators:coverage`, etc.), not
service logs, and converting them to `log.*` would route operator-facing
output through the same JSON-line format built for Railway's log stream.

Where logs go: nowhere we control. stdout → Railway's log stream → Railway's
retention. No file, no rotation, nothing at rest. Durable logs, if ever wanted,
are a Railway log drain — not code.

## Deletions

| Deleted | Reason |
|---|---|
| `packages/db/` (schema, 4 migrations, `createDb`) | no database |
| `drizzle.config.ts`, `db:generate` / `db:migrate` / `db:check` scripts, `drizzle-kit` + `postgres` deps | ditto |
| `lib/db.ts`, `lib/queries.ts`, `lib/pagination.ts` (+ tests) | ditto — `enrichLegRouters` and `RouteLeg` move to `lib/legRouterEnrichment.ts`, which already has an orphaned test file waiting for it |
| `app/trades/`, `components/tradesTable.tsx` (+ tests) | replaced by `/qa` |
| `app/api/receipts/` (+ 5 test files) | see above |
| `lib/auth.ts`, `app/api/login/`, `components/loginForm.tsx`, `middleware.ts`, `lib/accessDecision.ts` (+ tests) | with `/trades` and `DELETE` gone, `PROTECTED_PAGE_PREFIXES` is empty and `PUBLIC_API_METHODS` has no APIs left to name |
| `TCA_DATABASE_URL`, `APP_SESSION_SECRET`, `APP_ACCESS_PASSWORD` from `.env.example` | nothing reads them |

Security headers live in `lib/securityHeaders.mjs` and are applied via
`next.config`, not middleware — **the plan must verify this before deleting
`middleware.ts`**, not assume it.

Slack alerts stay. Notification is not storage. `receiptCreatedMessage` already
takes a structural `ReceiptSummary` with no `id` and already builds its link via
`receiptPath`, so it survives on two widened field types.

`scripts/smokeDeploy.mjs` must be checked for `/trades` and `/api/receipts`
assertions.

## Corpus freeze

Runs **before** the Railway Postgres instance is deleted. Order matters; there is
no second chance.

`scripts/freezeCorpus.mjs` dumps `receipts` to `docs/qa/corpus.json`, filtered to
`notional_usd >= 5`. Measured against the live table:

**83 rows → 62 kept, 21 dropped.** Zero nulls, so there is no ambiguous middle
case to rule on.

`scripts/analysis/_env.mjs` swaps `connect()` for `loadCorpus()`; each script's
SQL becomes an array filter over the parsed JSON. All eight analysis scripts are
retargeted. `rpcProviderAB.mjs` takes only the hash list from the JSON and
analyzes both sides live, unchanged in spirit.

Baselines quoted in script headers must be re-stated against 62 rows. The
existing "62 receipts", "at 2026-07-30" figures describe a different set and
would silently mislead — they are not the same 62.

## Testing

- **Ceiling relocation:** the `/tx` render consumes global budget; a rejected
  request does not analyze. This is the property protecting the bill.
- **`loadReceipt`:** returns null on an unanalyzable hash; enriches fee-sink
  names and leg routers on success.
- **`/qa`:** comma splitting, per-hash failure isolation, and a test that the
  route 404s when `NODE_ENV === 'production'`.
- **Logging:** `LOG_LEVEL` gates output; each level emits parseable JSON.
- **Corpus:** every entry in `corpus.json` is ≥ $5.
- **Type migration:** `receiptView.test.tsx` fixtures move from string numerics
  to numbers. Not a new test — an existing one that must keep passing on the new
  shape, which is what proves the retype landed.

## Risks and accepted costs

**Corpus-wide regression detection is genuinely lost.** `rpcProviderAB.mjs`
caught an 11-of-63 silent corruption that a green test suite missed. Against a
frozen JSON it can still A/B two RPC providers, but it can no longer answer
"does today's code disagree with last month's" — the frozen file *is* last
month, permanently. This is the real price of the change.

**No caching means no deduplication.** Every view of every receipt is ~40 RPC
calls. A link that reaches fifty people in two seconds fires fifty concurrent
analyses and trips the 500/hour global ceiling on a single popular receipt, at
which point real users get refused. Accepted deliberately: get the database out
first, decide caching with a clear head.

**Both limiters are per-process.** Already true today, but it matters more with
no shared row to deduplicate on: at two Railway replicas the hourly ceiling
silently becomes 1,000/hr.

**A rate-limit refusal now returns HTTP 200, not 429.** The App Router gives a
page no way to set an arbitrary status code, so a throttled request renders
`<CeilingNotice />` inside a normal 200 response instead of the deleted API
route's real 429-with-`Retry-After`. The stated threat model for this limiter
is crawlers, link unfurlers, and bare `<img>` tags — exactly the clients that
honor a 429 and ignore prose in an HTML body. A crawler served 200 keeps
crawling at the same rate; the ceiling caps the RPC spend but not the request
volume. It also removes any status-code signal that would let monitoring tell
"serving" apart from "refusing everyone," and a CDN placed in front of this
later would risk caching a 200 "unavailable" body at a real receipt URL.
Accepted as inherent to moving the limiter from a route handler onto a page
render. If it needs solving, the option is reintroducing `middleware.ts` so a
real status code can be set ahead of the page — not something to do as part of
this change.

**Sequencing.** Multichain Tasks 5 and 6 rewrite `page.tsx` and the link
producers. Doing this first means writing those files twice.

## Deferred

Caching, as its own piece of work. The `loadReceipt` seam means it lands in one
function body. The options surveyed, for whoever picks it up:

- **Single-flight** (cache the in-flight promise, not the result) — attacks the
  thundering herd, which is the failure mode that actually trips the ceiling.
  ~10 lines.
- **In-memory LRU + TTL** — per-instance, dies on deploy, which means a pricing
  change self-invalidates. The property the database never had.
- **CDN in front (Cloudflare)** — zero application code once `s-maxage` is set;
  the real answer at scale. Cannot be invalidated from the app.
- **OG-image caching** — most "viral" traffic is unfurl bots, not humans. A
  hard-cached card means they never reach the analysis path.
- **Graceful ceiling** — render "computing, refresh shortly" instead of 429.

Rejected: Redis/Upstash (re-creates the staleness trap, since it outlives the
deploy that changed pricing) and Next's Data Cache (writes to `.next/cache` —
data at rest).
