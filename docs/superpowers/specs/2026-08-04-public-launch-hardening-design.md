# Public-Launch Hardening — Design

**Date:** 2026-08-04
**Status:** Approved, ready for implementation planning
**Context:** Follow-ups from the pre-launch security hardening (merged `2f7028d`), scoped to what a *public* launch actually requires.

## Scope

Three changes, in the order they should be built:

1. **Receipt lookup index** (§1) — make `getReceiptByHash` index-usable.
2. **Webhook notifications** (§2) — one notifier module serving two independently-configured streams: *alerting* when the global analysis ceiling is approached or hit (§2a), and *activity* each time a receipt is newly generated (§2b).
3. **Security headers** (§3) — static headers including a non-nonce CSP.

Explicitly **out of scope**, with reasons recorded below: response caching, per-user data scoping (`user_id`), password revocation, the drizzle major bump.

## Background: what a public launch does and does not change

The earlier audit deferred four items on the theory that they mattered "before widening access." Re-examining that for an anonymous public launch:

- **`user_id` scoping is not a launch blocker.** A receipt row stores no submitter identity — no `user_id` populated, no IP, no session reference (`packages/db/src/schema.ts:29-37`). The corpus is an undifferentiated pool of analyzed transactions, not attributable to whoever pasted them. The privacy leak is real but only materializes once real accounts exist.
- **Password revocation is not a launch blocker either.** Anonymous users never hold the `/trades` password; a public launch adds nobody to that set.
- What a public launch *does* sharpen is load on the read path, blindness to the spend ceiling, and the absence of basic browser-level protections. Hence this spec.

## 1. Receipt lookup index

### Problem

`lib/queries.ts:39-47` looks up receipts with:

```sql
SELECT * FROM receipts WHERE lower(tx_hash) = lower($1) LIMIT 1
```

Wrapping the column in `lower()` makes every existing index unusable. Verified against the live database on 2026-08-04:

```
rows: 67
--- current query: lower(tx_hash) = lower($1) ---
  Seq Scan on receipts  (cost=0.00..22.95)
        Filter: (lower(tx_hash) = '0xabc'::text)
--- hypothetical: tx_hash = $1 ---
  Index Scan using receipts_user_tx_chain_uq  (cost=0.14..3.92)
        Index Cond: (tx_hash = '0xabc'::text)
```

Only two indexes exist on the table: `receipts_pkey` on `id`, and `receipts_user_tx_chain_uq` on `(user_id, tx_hash, chain_id)`. Postgres *will* use the composite index for a bare `tx_hash` match despite `tx_hash` not being the leading column — the `lower()` wrapper alone is what forces the sequential scan.

At 67 rows this costs microseconds and is invisible. It grows linearly with the table, and a public launch means anonymous users adding rows without bound. This is the read-path cost that actually degrades under virality.

### Decision: add a functional index, do not add a cache

A response cache was considered and **rejected**. Reasons, in order of weight:

- **The database already is the cache.** Every receipt is persisted on generation, and a cache hit costs zero RPC. A second copy in process memory buys a few milliseconds of query time while introducing TTLs, invalidation, and staleness after a repopulation.
- **The stated risk did not survive inspection.** The earlier note claimed virality threatened Supabase pooler connections. `packages/db/src/index.ts:11` uses postgres.js, which defaults to `max: 10` connections — concurrent viewers queue on a bounded pool rather than exhausting anything.
- **A cache introduces a correctness surface the index does not.** Because `components/receiptSearch.tsx:69-72` pushes to `/?tx=…` from a `finally` block, a failed POST still navigates, so misses render routinely. A cached miss would survive a subsequent successful analysis and show "not found" to the user who just paid for it — worst under exactly the load a cache exists to handle. The index has no equivalent failure mode.
- **The index is permanent.** It keeps the lookup fast at any table size, with no tuning.

### Change

Add to the `receipts` table definition in `packages/db/src/schema.ts`:

```sql
CREATE INDEX receipts_tx_hash_lower_idx ON receipts (lower(tx_hash));
```

- The application query is **unchanged**. Keeping `lower(tx_hash) = lower($1)` preserves case-insensitive matching against any mixed-case rows already stored; normalizing hashes on write would need a backfill and would not be more correct.
- Declare the index in `schema.ts` and generate migration `0002` via `npm run db:generate`.
- **If drizzle-kit 0.33 cannot express the functional index** (expression support in `.on()` is version-sensitive), fall back to hand-writing `packages/db/drizzle/0002_<name>.sql` and registering it in `_journal.json`. The migration is one statement; a hand-written file is a legitimate outcome, not a workaround.
- ⚠️ **The fallback carries a drift trap.** An index present in the database but absent from `schema.ts` will make a future `drizzle-kit generate` emit a `DROP INDEX` for it. If the index cannot be declared in the schema, leave a comment in `schema.ts` at the table definition recording that `receipts_tx_hash_lower_idx` exists and is intentional, so the next person to run `generate` does not silently accept a drop.
- Use plain `CREATE INDEX`, not `CONCURRENTLY`. Drizzle runs migrations inside a transaction, which forbids `CONCURRENTLY`, and at this table size the brief write lock is irrelevant.

### Verification

Re-run the `EXPLAIN` above after migrating; the plan must change from `Seq Scan` to an index scan on `receipts_tx_hash_lower_idx`. This is the acceptance test — a passing unit suite does not demonstrate a query plan.

## 2. Webhook notifications (alerts + activity)

Two notification streams share one module but are configured, routed, and rate-shaped independently.

### 2a. Rate-limit alerting

#### Problem

When the global hourly ceiling trips, the only signal is a `console.warn` (`app/api/receipts/route.ts:185`). New analyses then pause for **everyone** — a deliberate hard spend cap over availability — with no notification. The limit's default of 500/hour is an untuned guess, so week one needs both incident alerts and enough signal to tune it.

#### Design

A new `packages/dashboard/lib/alerts.ts`, following the same discipline as `lib/rateLimit.ts`: a factory taking its dependencies so it is unit-testable without network or wall-clock.

```ts
createAlerter({ webhookUrl, fetch, now, minIntervalMs }) => (event: AlertEvent) => Promise<void>
```

Two event kinds, alerted independently:

| Kind | Trigger |
|---|---|
| `budget_warning` | A global analysis leaves `remaining <= limit * 0.2` |
| `ceiling_reached` | The global limiter denies a request |

Warning at 80% matters as much as the trip itself: once the ceiling is hit the tool is already down, so the warning is the only actionable signal.

Behavioural requirements:

- **Debounced per kind.** At most one alert per kind per `minIntervalMs` (default: the 1-hour global window). Without this, a sustained flood sends one webhook per rejected request — turning the alert into its own outage.
- **Fire-and-forget.** Never awaited in the request path; a slow webhook must not add latency to a user response. Correct on a long-lived Railway container. Errors are caught and logged — a webhook failure must never turn a 429 into a 500.
- **Timed out.** `AbortSignal.timeout(3000)` so a hung endpoint cannot leak a pending request.
- **Degrades to log-only.** `ALERT_WEBHOOK_URL` unset ⇒ structured `console.warn`, no throw. Matches the existing fail-soft posture for optional configuration.
- **Carries no secrets.** Payload is limited to event kind, limit, remaining, window reset time, and host. No env values, no hashes, no connection strings.
- **Slack and Discord compatible.** The body sets both `text` (Slack) and `content` (Discord); each service ignores the key it does not recognise, so one env var works with either.

#### Call site

In `app/api/receipts/route.ts`:

- Instantiate the alerter once at module scope from `process.env.ALERT_WEBHOOK_URL`, alongside the existing limiters, so the debounce state is shared across requests. A per-request alerter would never debounce anything.
- The global limiter's configured limit is currently inline inside `envInt(...)` at line 57. Extract it to a named constant so the limiter and the 80% threshold read the same number — a threshold derived from a second, independently-computed limit is a bug waiting to happen.
- Both alert checks read the `RateLimitResult` already returned at line 183; no second call to the limiter, which would consume budget.

### 2b. Activity notifications

#### Goal

A Slack message each time a receipt is **newly generated**, as an early-traction signal during launch.

#### Design

Reuses the notifier from §2a with a third event kind, `receipt_created`, but differs from the alert stream in three deliberate ways:

- **Separate destination: `ACTIVITY_WEBHOOK_URL`,** independent of `ALERT_WEBHOOK_URL` and independently optional. Sharing a channel would bury the ceiling warning under activity messages *during a flood* — precisely when the warning matters. Two variables also let routing be a configuration choice: same URL for one channel, different URLs for two. Unset ⇒ no activity notifications, no fallback to the alert webhook (silently redirecting activity into an incident channel would be a surprise).
- **Not debounced.** Debouncing would defeat the purpose. No safeguard is needed because **the existing rate limits already cap the volume**: activity messages cannot exceed the global ceiling of 500/hour (~8/min sustained), comfortably within Slack's incoming-webhook throughput. The spend cap doubles as the notification cap.
- **Fires only on a genuine new analysis.** Placement is immediately after a successful `insertReceipt` (`route.ts:206`). The cache-hit return (line 166) and the conflict-resolution path (line 209) must stay silent — otherwise every view of a shared link notifies, so one viral receipt generated once would produce thousands of messages for the same trade, and the conflict loser would duplicate a message its twin already sent.

Payload: transaction hash, aggregator, input/output symbols and amounts, notional, all-in cost bps, and a link to the receipt at `/?tx=<hash>`.

Shared with §2a: fire-and-forget, 3-second timeout, errors caught and logged. A Slack outage must never fail a receipt.

⚠️ Note this streams trader addresses and trade details into Slack. All of it is public on-chain data already visible on `/trades`, so it is not new exposure — but aggregating it into a feed is a new posture and should be a conscious choice.

## 3. Security headers

### Problem

No security headers are set; `next.config.mjs` has no `headers()` block. Clickjacking is possible, and there is no defence-in-depth against script injection.

### Decision: static headers, CSP without nonces

A strict nonce-based CSP was considered and rejected. The nonce must be minted per request in middleware, which opts every page into dynamic rendering and forecloses ever moving the receipt page into Next's full-route cache — a door worth leaving open, since that is the escalation path if container CPU ever becomes the real ceiling. The realistic threat here is thin: there is no `dangerouslySetInnerHTML` anywhere and no user-controlled HTML, so inline injection is already a narrow vector.

### Headers

Applied to all paths via `headers()` in `next.config.mjs`:

| Header | Value |
|---|---|
| `Content-Security-Policy` | see below |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=()` |

CSP:

```
default-src 'self';
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
font-src 'self' data:;
connect-src 'self';
frame-ancestors 'none';
base-uri 'self';
form-action 'self';
object-src 'none';
upgrade-insecure-requests
```

Notes on specific directives:

- **`'self'` suffices for fonts.** All faces are self-hosted `@font-face` rules in `styles/fonts.css`; there are no external font, script, or image origins anywhere in the app.
- **`style-src 'unsafe-inline'` is required, not laziness.** The components style extensively via React inline `style={{…}}` attributes (e.g. `components/receiptSearch.tsx:90-93`), which CSP governs under `style-src`. Removing it would break rendering.
- **`X-Frame-Options` is redundant with `frame-ancestors`** and is included anyway for browsers that do not honour the latter.
- **HSTS omits `preload`** deliberately: preload is effectively irreversible and should not be committed to before a stable domain is settled.
- **Dev needs `'unsafe-eval'`.** Next's dev-mode HMR evaluates code, so the policy must add `'unsafe-eval'` to `script-src` when `NODE_ENV !== 'production'`. Production must not carry it.

## Testing

| Area | Test |
|---|---|
| Index | `EXPLAIN` shows an index scan post-migration (manual, against the real DB — the acceptance criterion). Plus a static assertion that the index is not silently lost: on the schema declaration if drizzle can express it, otherwise on the migration SQL. |
| Alerts (§2a) | Unit tests with injected `fetch` and clock: debounce suppresses a second alert inside the window and permits one after it; unset webhook URL performs no fetch and does not throw; a rejecting `fetch` does not propagate; payload contains no environment values; warning fires at the 80% boundary and not below it. |
| Activity (§2b) | A cache hit sends nothing; a conflict-resolved insert sends nothing; a successful new insert sends exactly one message. These are the three paths that distinguish "generated" from "viewed", and getting them wrong is the difference between a useful feed and thousands of duplicate messages — so assert on each explicitly. Also: activity is not debounced, and an unset `ACTIVITY_WEBHOOK_URL` does not fall back to `ALERT_WEBHOOK_URL`. |
| Headers | Unit test over the `headers()` output asserting each header and the absence of `'unsafe-eval'` in a production-mode policy. |
| Live | Extend `scripts/smokeDeploy.mjs` (118 lines, already gates the access boundary and exits non-zero) to assert the security headers are present on a real deployment. |

## Rollout

Ordering and hazards, drawn from prior incidents in this repo:

1. **Local and production share one Supabase database.** Running `npm run db:migrate` locally applies migration `0002` to production. This is expected here — it is the same instance by deliberate choice — but it must be a conscious act, not a side effect of a local test run.
2. **Rebuild `@fabric-tca/db` dist after the schema edit**, or drizzle silently omits the change downstream.
3. **Run a real `next build` before pushing.** `next build` runs ESLint and a lint error fails the build; `next dev` does not lint. A broken CSP also only surfaces in a production build. Kill any dev server first — a root build writes into the same `.next` that `next dev` owns.
4. **Push auto-deploys to Railway.** Set `ALERT_WEBHOOK_URL` and `ACTIVITY_WEBHOOK_URL` in the service variables *before* pushing, so the first deploy is already instrumented. ⚠️ Do **not** set either locally unless you want local testing to post into the same Slack channels — local and production share one database, and a local receipt is a real receipt.
5. **Run `scripts/smokeDeploy.mjs <url>`** against the live deployment afterwards. It is read-only and costs no RPC.

## Deferred, with reasons

| Item | Why not now |
|---|---|
| Response caching / CDN | The index removes the real cost. Revisit only if measurement shows container CPU is the ceiling; the answer then is full-route caching or a CDN, and the non-nonce CSP keeps that door open. |
| `user_id` scoping | Not a public-launch blocker — receipts carry no submitter identity. Required before real accounts. |
| Password revocation | Anonymous users never hold the `/trades` password. |
| drizzle 0.33 → 0.45 | Advisory GHSA-gpj5-g38j-94v9 was checked and is not reachable (no `sql.raw`/`sql.identifier`; the only `orderBy` is a static column). A major bump touching every query needs its own pass. |
