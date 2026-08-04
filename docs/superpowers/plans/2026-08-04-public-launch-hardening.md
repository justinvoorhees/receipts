# Public-Launch Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the receipt read path index-usable, add Slack/Discord webhook notifications for both the global spend ceiling and each newly generated receipt, and set static security headers — the three things a public launch actually needs.

**Architecture:** Three independent changes. A functional Postgres index on `lower(tx_hash)` replaces a sequential scan with an index scan. One notifier module (`lib/alerts.ts`) serves two independently-configured webhook streams, wired into the existing rate-limit and insert paths of `POST /api/receipts`. Security headers live in a plain `.mjs` module so both `next.config.mjs` and vitest can import them.

**Tech Stack:** Next 15 (App Router), drizzle-orm 0.33 / drizzle-kit 0.24, postgres.js, Postgres 17.6 (Supabase), vitest.

**Spec:** `docs/superpowers/specs/2026-08-04-public-launch-hardening-design.md`

## Global Constraints

- **The application query is unchanged.** `lib/queries.ts:44` keeps `lower(tx_hash) = lower($1)`. Do not normalize hashes on write — that would need a backfill and is not more correct.
- **A webhook failure must never affect a user response.** All notification calls are fire-and-forget (`void notify(...)`), the notifier never rejects, and it has a 3-second timeout.
- **Payloads carry no secrets.** Event kind, limits, counts, and public on-chain receipt fields only. No env values, no connection strings.
- **An unset webhook URL degrades to a log line**, never to the other stream's URL.
- **Local and production share one Supabase database.** `npm run db:migrate` run locally applies to production. Do not set `ALERT_WEBHOOK_URL` or `ACTIVITY_WEBHOOK_URL` in the local `.env` — local receipts are real receipts and would post to the same channel.
- **Run tests with `npm test`** (vitest run) from the repo root.
- **Before any push:** kill any dev server, then run a real `next build`. `next build` runs ESLint and a lint error fails the build; `next dev` does not lint. A broken CSP also only surfaces in a production build. A push auto-deploys to Railway.

---

### Task 1: Functional index on `lower(tx_hash)`

Replaces the sequential scan on every receipt lookup. Verified on the live DB (2026-08-04, 67 rows): the current query plans as `Seq Scan (cost=0.00..22.95)`.

**Files:**
- Modify: `packages/db/src/schema.ts:99-108` (the table's extra-config callback)
- Create: `packages/db/drizzle/0002_<generated_name>.sql`
- Modify: `packages/db/drizzle/meta/_journal.json` (drizzle-kit writes this; verify it)

**Interfaces:**
- Consumes: nothing.
- Produces: index `receipts_tx_hash_lower_idx`. No TypeScript surface — `getReceiptByHash` is untouched.

- [ ] **Step 1: Declare the index in the schema**

In `packages/db/src/schema.ts`, add `index` and `sql` to the existing imports from `drizzle-orm/pg-core` and `drizzle-orm` respectively, then add to the extra-config callback alongside `byUserTxChain`:

```ts
	(t) => ({
		// ... byUserTxChain stays as-is ...

		// getReceiptByHash matches on `lower(tx_hash)` so a pasted hash resolves
		// regardless of case. A plain B-tree on tx_hash cannot serve a query that
		// wraps the column in a function, so without THIS index every lookup is a
		// sequential scan — verified against the live DB. Invisible at 67 rows,
		// linear in table size, and public users grow the table without bound.
		byTxHashLower: index('receipts_tx_hash_lower_idx').on(sql`lower(${t.txHash})`),
	}),
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`
Expected: a new `packages/db/drizzle/0002_*.sql` and a third entry in `meta/_journal.json`.

- [ ] **Step 3: Verify the generated SQL is correct — do not skip this**

Read the generated `0002_*.sql`. It MUST contain the expression:

```sql
CREATE INDEX "receipts_tx_hash_lower_idx" ON "receipts" USING btree (lower("tx_hash"));
```

drizzle-kit 0.24 has known gaps emitting expression indexes. **If the file is empty, omits the `lower(...)` call, or emits `ON "receipts" ()`**, delete it, revert the `_journal.json` entry, and hand-write the migration instead:

```bash
cat > packages/db/drizzle/0002_tx_hash_lower_idx.sql <<'SQL'
CREATE INDEX "receipts_tx_hash_lower_idx" ON "receipts" USING btree (lower("tx_hash"));
SQL
```

Then add this entry to the `entries` array in `packages/db/drizzle/meta/_journal.json` (use the current epoch-millis for `when`):

```json
    {
      "idx": 2,
      "version": "7",
      "when": 1785999999999,
      "tag": "0002_tx_hash_lower_idx",
      "breakpoints": true
    }
```

Keep the schema declaration from Step 1 either way. An index in the database but absent from `schema.ts` makes a future `drizzle-kit generate` emit a `DROP INDEX` for it.

Do NOT use `CREATE INDEX CONCURRENTLY` — drizzle runs migrations inside a transaction, which forbids it, and at this table size the brief write lock is irrelevant.

- [ ] **Step 4: Apply the migration**

⚠️ This writes to the shared Supabase instance that production uses. That is expected and correct here, but it is a deliberate act.

Run: `set -a && source .env && set +a && npm run db:migrate`
Expected: reports applying `0002_tx_hash_lower_idx`.

- [ ] **Step 5: Verify the query plan actually changed — this is the acceptance test**

A green unit suite does not demonstrate a query plan. Run:

```bash
set -a && source .env && set +a && node --input-type=module -e "
import postgres from './node_modules/postgres/src/index.js';
const sql = postgres(process.env.TCA_DATABASE_URL, { prepare: false });
for (const r of await sql.unsafe(\"EXPLAIN SELECT * FROM receipts WHERE lower(tx_hash) = lower('0xabc') LIMIT 1\")) console.log(r['QUERY PLAN']);
await sql.end();
"
```

Expected: the plan names `receipts_tx_hash_lower_idx` and no longer says `Seq Scan`. At 67 rows Postgres may still prefer a seq scan on cost grounds; if so, confirm the index exists and is usable by re-running the same `EXPLAIN` after `SET enable_seqscan = off;` in the same statement batch, and record that in the commit message.

- [ ] **Step 6: Rebuild the db package**

Run: `npm run build --workspace packages/db`
Expected: succeeds. (Skipping this makes drizzle silently omit schema changes downstream.)

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all pass, no new failures.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle/
git commit -m "perf(db): index lower(tx_hash) so receipt lookup stops seq-scanning

getReceiptByHash matches on lower(tx_hash), which no plain B-tree can
serve — verified on the live DB as Seq Scan (cost=0.00..22.95). Costs
microseconds at 67 rows and grows linearly on a table anonymous users
can extend without bound."
```

---

### Task 2: The notifier module

Pure module, no framework coupling, tested in isolation. Task 3 and 4 wire it up.

**Files:**
- Create: `packages/dashboard/lib/alerts.ts`
- Test: `packages/dashboard/lib/alerts.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type AlertKind = 'budget_warning' | 'ceiling_reached' | 'receipt_created'`
  - `type Notify = (kind: AlertKind, text: string) => Promise<void>` — never rejects
  - `createNotifier(opts: NotifierOptions): Notify`
  - `NotifierOptions = { webhookUrl?: string | undefined; debounceMs?: number; fetchImpl?: typeof fetch; now?: () => number; log?: (m: string) => void }`
  - `ceilingReachedMessage(limit: number, retryAfterSecs: number): string`
  - `budgetWarningMessage(limit: number, remaining: number): string`
  - `receiptCreatedMessage(r: ReceiptSummary, baseUrl: string): string`
  - `originFrom(req: Request): string`

- [ ] **Step 1: Write the failing tests**

Create `packages/dashboard/lib/alerts.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import {
	createNotifier,
	ceilingReachedMessage,
	budgetWarningMessage,
	receiptCreatedMessage,
	originFrom,
} from './alerts';

/** A controllable clock, matching the pattern in rateLimit.test.ts. */
function fakeClock(start = 1_000_000) {
	let t = start;
	return { now: () => t, advance: (ms: number) => (t += ms) };
}

const okFetch = () => vi.fn(async () => new Response(null, { status: 200 }));

describe('createNotifier', () => {
	it('posts the message to the webhook', async () => {
		const fetchImpl = okFetch();
		const notify = createNotifier({ webhookUrl: 'https://hook.test/x', fetchImpl });
		await notify('receipt_created', 'hello');
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0]!;
		expect(url).toBe('https://hook.test/x');
		expect(JSON.parse(init!.body as string)).toEqual({ text: 'hello', content: 'hello' });
	});

	it('does not fetch when no webhook url is configured', async () => {
		const fetchImpl = okFetch();
		const log = vi.fn();
		const notify = createNotifier({ fetchImpl, log });
		await notify('ceiling_reached', 'nobody is listening');
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalled();
	});

	it('never rejects when the webhook fails', async () => {
		const fetchImpl = vi.fn(async () => { throw new Error('connect ECONNREFUSED'); });
		const log = vi.fn();
		const notify = createNotifier({ webhookUrl: 'https://hook.test/x', fetchImpl, log });
		await expect(notify('ceiling_reached', 'boom')).resolves.toBeUndefined();
		expect(log).toHaveBeenCalled();
	});

	it('suppresses a second message of the same kind inside the debounce window', async () => {
		const clock = fakeClock();
		const fetchImpl = okFetch();
		const notify = createNotifier({
			webhookUrl: 'https://hook.test/x', fetchImpl, now: clock.now, debounceMs: 60_000,
		});
		await notify('ceiling_reached', 'first');
		clock.advance(30_000);
		await notify('ceiling_reached', 'second');
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('sends again once the debounce window has elapsed', async () => {
		const clock = fakeClock();
		const fetchImpl = okFetch();
		const notify = createNotifier({
			webhookUrl: 'https://hook.test/x', fetchImpl, now: clock.now, debounceMs: 60_000,
		});
		await notify('ceiling_reached', 'first');
		clock.advance(60_001);
		await notify('ceiling_reached', 'second');
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('debounces each kind independently', async () => {
		const clock = fakeClock();
		const fetchImpl = okFetch();
		const notify = createNotifier({
			webhookUrl: 'https://hook.test/x', fetchImpl, now: clock.now, debounceMs: 60_000,
		});
		await notify('ceiling_reached', 'a');
		await notify('budget_warning', 'b');
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	// The activity stream must NOT debounce, or a launch-day burst of real
	// receipts would silently report only the first one.
	it('sends every message when debouncing is disabled', async () => {
		const fetchImpl = okFetch();
		const notify = createNotifier({ webhookUrl: 'https://hook.test/x', fetchImpl });
		await notify('receipt_created', 'one');
		await notify('receipt_created', 'two');
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});
});

describe('message formatting', () => {
	it('names the limit and the pause in the ceiling message', () => {
		const msg = ceilingReachedMessage(500, 900);
		expect(msg).toContain('500');
		expect(msg).toContain('15 min');
	});

	it('reports consumed and remaining in the warning message', () => {
		const msg = budgetWarningMessage(500, 100);
		expect(msg).toContain('400/500');
		expect(msg).toContain('100');
	});

	it('summarises a receipt and links to it', () => {
		const msg = receiptCreatedMessage(
			{
				txHash: '0xdead',
				aggregator: '0x',
				inputSymbol: 'WETH',
				outputSymbol: 'USDC',
				notionalUsd: '4210.44',
				allInCostBps: '12.37',
			},
			'https://app.test',
		);
		expect(msg).toContain('WETH');
		expect(msg).toContain('USDC');
		expect(msg).toContain('0x');
		expect(msg).toContain('$4210');
		expect(msg).toContain('12.4 bps');
		expect(msg).toContain('https://app.test/?tx=0xdead');
	});

	it('tolerates a receipt with nothing resolved', () => {
		const msg = receiptCreatedMessage(
			{
				txHash: '0xbeef', aggregator: null, inputSymbol: null,
				outputSymbol: null, notionalUsd: null, allInCostBps: null,
			},
			'https://app.test',
		);
		expect(msg).toContain('https://app.test/?tx=0xbeef');
		expect(msg).not.toContain('null');
	});
});

describe('originFrom', () => {
	it('uses the forwarded protocol behind a proxy', () => {
		const req = new Request('http://internal/api/receipts', {
			headers: { host: 'app.up.railway.app', 'x-forwarded-proto': 'https' },
		});
		expect(originFrom(req)).toBe('https://app.up.railway.app');
	});

	it('falls back to http for localhost', () => {
		const req = new Request('http://internal/api/receipts', { headers: { host: 'localhost:3000' } });
		expect(originFrom(req)).toBe('http://localhost:3000');
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/dashboard/lib/alerts.test.ts`
Expected: FAIL — cannot resolve `./alerts`.

- [ ] **Step 3: Write the implementation**

Create `packages/dashboard/lib/alerts.ts`:

```ts
/**
 * Outbound webhook notifications.
 *
 * Two streams share this module and differ only in configuration:
 *   ALERT_WEBHOOK_URL     — incidents (the global spend ceiling), debounced
 *   ACTIVITY_WEBHOOK_URL  — one message per newly generated receipt, not debounced
 *
 * They are deliberately separate destinations. During a flood, activity volume
 * would bury the ceiling warning if both landed in one channel — precisely when
 * that warning matters most. An unset URL degrades to a log line and never
 * falls back to the other stream's URL, which would silently redirect activity
 * into an incident channel.
 *
 * Every send is fire-and-forget and nothing here rejects: a Slack outage must
 * not turn a 429 into a 500, nor fail a receipt that is already computed and
 * persisted.
 */

export type AlertKind = 'budget_warning' | 'ceiling_reached' | 'receipt_created';

/** Never rejects. Callers use `void notify(...)` and do not await. */
export type Notify = (kind: AlertKind, text: string) => Promise<void>;

export interface NotifierOptions {
	/** Unset ⇒ log-only. */
	webhookUrl?: string | undefined;
	/** Minimum gap between two messages of the SAME kind. 0 disables debouncing. */
	debounceMs?: number;
	fetchImpl?: typeof fetch;
	now?: () => number;
	log?: (message: string) => void;
}

const TIMEOUT_MS = 3_000;

export function createNotifier(opts: NotifierOptions = {}): Notify {
	const {
		webhookUrl,
		debounceMs = 0,
		fetchImpl = fetch,
		now = Date.now,
		log = (m: string) => console.warn(m),
	} = opts;

	// Per-kind, so a ceiling alert never suppresses a budget warning. Held in
	// the closure, so the notifier must be created ONCE at module scope — a
	// per-request notifier would have nothing to debounce against.
	const lastSent = new Map<AlertKind, number>();

	return async (kind, text) => {
		if (debounceMs > 0) {
			const previous = lastSent.get(kind);
			if (previous != null && now() - previous < debounceMs) return;
		}
		lastSent.set(kind, now());

		if (!webhookUrl) {
			log(`[notify:${kind}] ${text}`);
			return;
		}

		try {
			// `text` is what Slack reads and `content` is what Discord reads; each
			// ignores the other's key, so one URL works with either service.
			await fetchImpl(webhookUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ text, content: text }),
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
		} catch (err) {
			log(`[notify:${kind}] webhook failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	};
}

export function ceilingReachedMessage(limit: number, retryAfterSecs: number): string {
	const mins = Math.ceil(retryAfterSecs / 60);
	return (
		`🚨 Global analysis ceiling reached (${limit}/hour). ` +
		`New receipt generation is paused for ALL visitors for ~${mins} min.`
	);
}

export function budgetWarningMessage(limit: number, remaining: number): string {
	return (
		`⚠️ Analysis budget at ${limit - remaining}/${limit} this hour (${remaining} left). ` +
		`Raise RATE_LIMIT_ANALYSES_GLOBAL_PER_HOUR if this is real traffic.`
	);
}

/** The receipt fields the activity message reads. Structural, so a ReceiptRow satisfies it. */
export interface ReceiptSummary {
	txHash: string;
	aggregator: string | null;
	inputSymbol: string | null;
	outputSymbol: string | null;
	notionalUsd: string | null;
	allInCostBps: string | null;
}

export function receiptCreatedMessage(r: ReceiptSummary, baseUrl: string): string {
	const pair = `${r.inputSymbol ?? '?'} → ${r.outputSymbol ?? '?'}`;
	const via = r.aggregator ? ` via ${r.aggregator}` : '';
	const notional = r.notionalUsd ? ` · $${Number(r.notionalUsd).toFixed(0)}` : '';
	const cost = r.allInCostBps ? ` · ${Number(r.allInCostBps).toFixed(1)} bps all-in` : '';
	return `New receipt: ${pair}${via}${notional}${cost}\n${baseUrl}/?tx=${r.txHash}`;
}

/**
 * The public origin of this request. Derived from headers rather than an env
 * var so it is correct in local dev and behind Railway's proxy without config.
 */
export function originFrom(req: Request): string {
	const host = req.headers.get('host') ?? 'localhost:3000';
	const proto = req.headers.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
	return `${proto}://${host}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/dashboard/lib/alerts.test.ts`
Expected: PASS, all 13 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/lib/alerts.ts packages/dashboard/lib/alerts.test.ts
git commit -m "feat(dashboard): add a webhook notifier for alerts and activity

One module, two independently-configured streams. Never rejects and
carries a 3s timeout, so a webhook outage cannot fail a user request."
```

---

### Task 3: Wire ceiling alerts into the receipts route

**Files:**
- Modify: `packages/dashboard/app/api/receipts/route.ts:56-60` (extract the limit), `:183-187` (the global check)
- Test: `packages/dashboard/app/api/receipts/ceilingAlerts.test.ts` (create)

**Interfaces:**
- Consumes: `createNotifier`, `ceilingReachedMessage`, `budgetWarningMessage` from Task 2.
- Produces: module-scope `alertNotify`. Task 4 adds a sibling `activityNotify` in the same file.

- [ ] **Step 1: Write the failing test**

Create `packages/dashboard/app/api/receipts/ceilingAlerts.test.ts`. Note the env-before-import pattern — the limits and webhook URLs are read at module scope, and each vitest file gets its own module registry.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.RATE_LIMIT_ANALYSES_PER_MIN = '100';
process.env.RATE_LIMIT_ANALYSES_GLOBAL_PER_HOUR = '10';
process.env.TCA_RPC_URL = 'http://rpc.test';
process.env.ALERT_WEBHOOK_URL = 'https://hook.test/alert';

const notified: Array<{ kind: string; text: string }> = [];
const created: Array<{ webhookUrl?: string; debounceMs?: number }> = [];

vi.mock('../../../lib/alerts.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../lib/alerts')>();
	return {
		...actual,
		createNotifier: (opts: { webhookUrl?: string; debounceMs?: number } = {}) => {
			created.push(opts);
			return async (kind: string, text: string) => { notified.push({ kind, text }); };
		},
	};
});
vi.mock('@fabric-tca/core', () => ({
	analyzeTransaction: vi.fn(),
	enrichFeeSinkNames: vi.fn(async (s: unknown[]) => s),
}));
vi.mock('../../../lib/queries.js', () => ({
	getReceiptByHash: vi.fn(),
	insertReceipt: vi.fn(),
	deleteReceipt: vi.fn(),
	enrichLegRouters: vi.fn((row: unknown) => row),
}));

const { analyzeTransaction } = await import('@fabric-tca/core');
const { getReceiptByHash, insertReceipt } = await import('../../../lib/queries.js');
const { POST } = await import('./route.js');

const mockAnalyze = vi.mocked(analyzeTransaction);
const mockGet = vi.mocked(getReceiptByHash);
const mockInsert = vi.mocked(insertReceipt);

const post = (ip: string) =>
	new Request('http://x/api/receipts', {
		method: 'POST',
		headers: { 'x-forwarded-for': ip, host: 'app.test' },
		body: JSON.stringify({ hash: '0xabc' }),
	});

beforeEach(() => {
	notified.length = 0;
	mockGet.mockResolvedValue(null);
	mockAnalyze.mockResolvedValue({ txHash: '0xabc', chainId: 8453 } as never);
	mockInsert.mockResolvedValue({
		id: 1, txHash: '0xabc', aggregator: '0x', inputSymbol: 'WETH',
		outputSymbol: 'USDC', notionalUsd: '100', allInCostBps: '5',
	} as never);
});

/**
 * ⚠️ The global limiter lives at module scope, so its counter ACCUMULATES
 * across the tests in this file — it is one hour-long window and nothing
 * resets it. These tests therefore run as a deliberate progression from a
 * healthy budget to an exhausted one, and the request counts below are
 * cumulative. Reordering them will produce vacuous passes: a "no warning yet"
 * assertion trivially holds once the ceiling is already spent, because the
 * request is rejected before the warning check is ever reached.
 *
 * Ceiling is 10 and the warning fraction is 0.2, so the threshold is
 * `remaining <= 2` — the 8th analysis warns.
 */
describe('ceiling alerting', () => {
	it('configures the alert stream with a debounce', () => {
		const alert = created.find((c) => c.webhookUrl === 'https://hook.test/alert');
		expect(alert).toBeDefined();
		expect(alert!.debounceMs).toBeGreaterThan(0);
	});

	it('stays quiet while the budget is healthy', async () => {
		await POST(post('10.0.0.1')); // cumulative: 1 of 10, remaining 9
		expect(notified).toHaveLength(0);
	});

	it('warns before the ceiling is reached, not only after', async () => {
		for (let n = 0; n < 7; n++) await POST(post(`10.1.0.${n}`)); // cumulative: 8 of 10, remaining 2
		expect(notified.some((n) => n.kind === 'budget_warning')).toBe(true);
		expect(notified.some((n) => n.kind === 'ceiling_reached')).toBe(false);
	});

	it('alerts when the ceiling is actually reached', async () => {
		for (let n = 0; n < 3; n++) await POST(post(`10.2.0.${n}`)); // cumulative: 11 of 10 — over
		const alert = notified.find((n) => n.kind === 'ceiling_reached');
		expect(alert).toBeDefined();
		expect(alert!.text).toContain('10');
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/dashboard/app/api/receipts/ceilingAlerts.test.ts`
Expected: FAIL — no `budget_warning` is ever recorded.

- [ ] **Step 3: Implement**

In `packages/dashboard/app/api/receipts/route.ts`, add to the imports:

```ts
import {
	budgetWarningMessage,
	ceilingReachedMessage,
	createNotifier,
} from '../../../lib/alerts.js';
```

Replace the `globalAnalysisLimiter` declaration (currently lines 56-59) so the limit is a named constant — the limiter and the threshold must read the same number, since a threshold derived from a second, independently-computed limit is a bug waiting to happen:

```ts
const GLOBAL_ANALYSES_PER_HOUR = envInt('RATE_LIMIT_ANALYSES_GLOBAL_PER_HOUR', 500);
const globalAnalysisLimiter = createRateLimiter(createMemoryStore(), {
	limit: GLOBAL_ANALYSES_PER_HOUR,
	windowMs: 60 * 60 * 1000,
});
const GLOBAL_KEY = 'global';

/** Warn with a fifth of the hourly budget left. Once the ceiling trips the tool is already down, so the warning is the only actionable signal. */
const BUDGET_WARNING_FRACTION = 0.2;

/**
 * Debounced to one message per kind per window: without it, a sustained flood
 * sends a webhook per rejected request and the alert becomes its own outage.
 * Created once at module scope so that state survives across requests.
 */
const alertNotify = createNotifier({
	webhookUrl: process.env.ALERT_WEBHOOK_URL,
	debounceMs: 60 * 60 * 1000,
});
```

Then replace the global-budget check (currently lines 183-187):

```ts
	const globalBudget = await globalAnalysisLimiter(GLOBAL_KEY);
	if (!globalBudget.allowed) {
		console.warn('[api/receipts] global analysis ceiling reached — pausing new analyses');
		void alertNotify(
			'ceiling_reached',
			ceilingReachedMessage(GLOBAL_ANALYSES_PER_HOUR, globalBudget.retryAfterSecs),
		);
		return tooMany(globalBudget.retryAfterSecs);
	}
	if (globalBudget.remaining <= GLOBAL_ANALYSES_PER_HOUR * BUDGET_WARNING_FRACTION) {
		void alertNotify(
			'budget_warning',
			budgetWarningMessage(GLOBAL_ANALYSES_PER_HOUR, globalBudget.remaining),
		);
	}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/dashboard/app/api/receipts/ceilingAlerts.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass. `globalCeiling.test.ts` and `ceilingCacheHits.test.ts` must still pass — they do not set the webhook env vars, so their notifier is log-only.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/app/api/receipts/route.ts packages/dashboard/app/api/receipts/ceilingAlerts.test.ts
git commit -m "feat(dashboard): alert on the global analysis ceiling

Warns at 80% as well as on the trip: once the ceiling is hit the tool is
already paused for everyone, so the warning is the only actionable
signal. Debounced per kind so a flood cannot turn the alert into its own
outage."
```

---

### Task 4: Notify on each newly generated receipt

**Files:**
- Modify: `packages/dashboard/app/api/receipts/route.ts` (module scope + the insert path around line 206)
- Test: `packages/dashboard/app/api/receipts/activityNotify.test.ts` (create)

**Interfaces:**
- Consumes: `createNotifier`, `receiptCreatedMessage`, `originFrom` from Task 2; the `alertNotify` pattern from Task 3.
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing test**

Create `packages/dashboard/app/api/receipts/activityNotify.test.ts`. These three paths are the whole point: getting them wrong is the difference between a useful feed and thousands of duplicate messages for one trade.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.RATE_LIMIT_ANALYSES_PER_MIN = '100';
process.env.RATE_LIMIT_ANALYSES_GLOBAL_PER_HOUR = '100';
process.env.TCA_RPC_URL = 'http://rpc.test';
process.env.ALERT_WEBHOOK_URL = 'https://hook.test/alert';
process.env.ACTIVITY_WEBHOOK_URL = 'https://hook.test/activity';

const notified: Array<{ kind: string; text: string }> = [];
const created: Array<{ webhookUrl?: string; debounceMs?: number }> = [];

vi.mock('../../../lib/alerts.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../lib/alerts')>();
	return {
		...actual,
		createNotifier: (opts: { webhookUrl?: string; debounceMs?: number } = {}) => {
			created.push(opts);
			return async (kind: string, text: string) => { notified.push({ kind, text }); };
		},
	};
});
vi.mock('@fabric-tca/core', () => ({
	analyzeTransaction: vi.fn(),
	enrichFeeSinkNames: vi.fn(async (s: unknown[]) => s),
}));
vi.mock('../../../lib/queries.js', () => ({
	getReceiptByHash: vi.fn(),
	insertReceipt: vi.fn(),
	deleteReceipt: vi.fn(),
	enrichLegRouters: vi.fn((row: unknown) => row),
}));

const { analyzeTransaction } = await import('@fabric-tca/core');
const { getReceiptByHash, insertReceipt } = await import('../../../lib/queries.js');
const { POST } = await import('./route.js');

const mockAnalyze = vi.mocked(analyzeTransaction);
const mockGet = vi.mocked(getReceiptByHash);
const mockInsert = vi.mocked(insertReceipt);

const row = {
	id: 1, txHash: '0xabc', aggregator: '0x', inputSymbol: 'WETH',
	outputSymbol: 'USDC', notionalUsd: '4210', allInCostBps: '12.3',
};

const post = (hash = '0xabc') =>
	new Request('http://x/api/receipts', {
		method: 'POST',
		headers: { 'x-forwarded-for': '10.9.0.1', host: 'app.test', 'x-forwarded-proto': 'https' },
		body: JSON.stringify({ hash }),
	});

beforeEach(() => {
	notified.length = 0;
	vi.clearAllMocks();
	mockAnalyze.mockResolvedValue({ txHash: '0xabc', chainId: 8453 } as never);
	mockInsert.mockResolvedValue(row as never);
});

describe('activity notification', () => {
	// The two streams must not share a destination: activity volume would bury a
	// ceiling warning in the same channel, exactly when that warning matters. And
	// activity must not debounce, or a launch-day burst reports only the first.
	it('routes activity to its own webhook, undebounced, separate from alerts', () => {
		const alert = created.find((c) => c.webhookUrl === 'https://hook.test/alert');
		const activity = created.find((c) => c.webhookUrl === 'https://hook.test/activity');
		expect(alert).toBeDefined();
		expect(activity).toBeDefined();
		expect(activity!.debounceMs ?? 0).toBe(0);
		expect(alert!.debounceMs).toBeGreaterThan(0);
	});

	it('sends exactly one message when a receipt is newly generated', async () => {
		mockGet.mockResolvedValue(null);
		await POST(post());
		const events = notified.filter((n) => n.kind === 'receipt_created');
		expect(events).toHaveLength(1);
		expect(events[0]!.text).toContain('WETH');
		expect(events[0]!.text).toContain('https://app.test/?tx=0xabc');
	});

	// A shared link is viewed far more often than it is generated. Notifying on
	// a cache hit would report one trade thousands of times.
	it('sends nothing when the receipt is served from the database', async () => {
		mockGet.mockResolvedValue(row as never);
		await POST(post());
		expect(notified.filter((n) => n.kind === 'receipt_created')).toHaveLength(0);
	});

	// The winner of the insert race already notified; the loser must not repeat it.
	it('sends nothing when a concurrent insert won the race', async () => {
		mockGet.mockResolvedValueOnce(null).mockResolvedValueOnce(row as never);
		mockInsert.mockRejectedValue(new Error('duplicate key value violates unique constraint'));
		const res = await POST(post());
		expect(res.status).toBe(200);
		expect(notified.filter((n) => n.kind === 'receipt_created')).toHaveLength(0);
	});

	it('does not fail the request when analysis produced nothing', async () => {
		mockGet.mockResolvedValue(null);
		mockAnalyze.mockResolvedValue(null as never);
		const res = await POST(post());
		expect(res.status).toBe(404);
		expect(notified.filter((n) => n.kind === 'receipt_created')).toHaveLength(0);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/dashboard/app/api/receipts/activityNotify.test.ts`
Expected: FAIL — the first test records no `receipt_created`.

- [ ] **Step 3: Implement**

In `packages/dashboard/app/api/receipts/route.ts`, extend the alerts import to add `originFrom` and `receiptCreatedMessage`:

```ts
import {
	budgetWarningMessage,
	ceilingReachedMessage,
	createNotifier,
	originFrom,
	receiptCreatedMessage,
} from '../../../lib/alerts.js';
```

Add below `alertNotify` at module scope:

```ts
/**
 * Deliberately NOT debounced — a launch-day burst of real receipts should all
 * be reported. Volume needs no separate cap because the global ceiling above
 * already bounds it (~8/min at the default), comfortably inside Slack's
 * incoming-webhook throughput.
 *
 * Its own URL, independent of ALERT_WEBHOOK_URL: sharing a channel would bury
 * a ceiling warning under activity during a flood.
 */
const activityNotify = createNotifier({ webhookUrl: process.env.ACTIVITY_WEBHOOK_URL });
```

Then, in the persist block, notify **only** on a successful insert (leave the cache-hit return at line 166 and the conflict path untouched):

```ts
	try {
		const inserted = await insertReceipt(await toNewReceipt(receipt));
		// Only here. A cache hit is a VIEW, not a generation, and the conflict
		// path below belongs to a request whose twin already notified.
		void activityNotify('receipt_created', receiptCreatedMessage(inserted, originFrom(req)));
		return NextResponse.json(enrichLegRouters(inserted), { status: 200 });
	} catch (err) {
		const winner = await getReceiptByHash(hash);
		if (winner) return NextResponse.json(winner, { status: 200 });
		console.error('[api/receipts] insert failed', err);
		return NextResponse.json({ error: 'Could not store the receipt.' }, { status: 500 });
	}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/dashboard/app/api/receipts/activityNotify.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/app/api/receipts/route.ts packages/dashboard/app/api/receipts/activityNotify.test.ts
git commit -m "feat(dashboard): notify Slack when a receipt is generated

Fires only after a successful insert. The cache-hit and conflict paths
stay silent, or one viral receipt generated once would notify on every
view. Not debounced — the global ceiling already caps the volume."
```

---

### Task 5: Security headers

**Files:**
- Create: `packages/dashboard/lib/securityHeaders.mjs`
- Test: `packages/dashboard/lib/securityHeaders.test.ts`
- Modify: `packages/dashboard/next.config.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `securityHeaders(isProduction: boolean): Array<{ key: string; value: string }>`.

Plain `.mjs`, not `.ts`, because `next.config.mjs` cannot import a TypeScript module. Vitest imports `.mjs` without ceremony, so the list stays unit-testable.

- [ ] **Step 1: Write the failing test**

Create `packages/dashboard/lib/securityHeaders.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs so next.config.mjs can import it too
import { securityHeaders } from './securityHeaders.mjs';

const asMap = (isProd: boolean) =>
	Object.fromEntries(
		(securityHeaders(isProd) as Array<{ key: string; value: string }>).map((h) => [h.key, h.value]),
	);

describe('securityHeaders', () => {
	it('sets the headers that stop framing and sniffing', () => {
		const h = asMap(true);
		expect(h['X-Frame-Options']).toBe('DENY');
		expect(h['X-Content-Type-Options']).toBe('nosniff');
		expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
		expect(h['Permissions-Policy']).toContain('geolocation=()');
	});

	it('blocks framing via CSP as well', () => {
		expect(asMap(true)['Content-Security-Policy']).toContain("frame-ancestors 'none'");
	});

	// HSTS preload is effectively irreversible; not before the domain is settled.
	it('sets HSTS without preload', () => {
		const hsts = asMap(true)['Strict-Transport-Security']!;
		expect(hsts).toContain('max-age=');
		expect(hsts).not.toContain('preload');
	});

	// React inline style={{…}} attributes are governed by style-src; removing
	// 'unsafe-inline' there would break rendering.
	it("keeps 'unsafe-inline' in style-src", () => {
		expect(asMap(true)['Content-Security-Policy']).toMatch(/style-src[^;]*'unsafe-inline'/);
	});

	// Dev needs eval for HMR. Production must never carry it.
	it("allows 'unsafe-eval' only outside production", () => {
		expect(asMap(false)['Content-Security-Policy']).toContain("'unsafe-eval'");
		expect(asMap(true)['Content-Security-Policy']).not.toContain("'unsafe-eval'");
	});

	it('restricts default-src and object-src', () => {
		const csp = asMap(true)['Content-Security-Policy']!;
		expect(csp).toContain("default-src 'self'");
		expect(csp).toContain("object-src 'none'");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/dashboard/lib/securityHeaders.test.ts`
Expected: FAIL — cannot resolve `./securityHeaders.mjs`.

- [ ] **Step 3: Write the implementation**

Create `packages/dashboard/lib/securityHeaders.mjs`:

```js
/**
 * Static security headers, applied to every path from next.config.mjs.
 *
 * Plain .mjs rather than .ts so next.config.mjs can import it directly while
 * vitest can still unit-test the list.
 *
 * The CSP deliberately uses no nonces. A nonce must be minted per request in
 * middleware, which opts every page into dynamic rendering and forecloses ever
 * moving the receipt page into Next's full-route cache — the escalation path if
 * container CPU ever becomes the ceiling. The residual risk is thin: there is
 * no dangerouslySetInnerHTML anywhere and no user-controlled HTML.
 *
 * All fonts, scripts and images are self-hosted (see styles/fonts.css), so
 * 'self' needs no exceptions.
 */
export function securityHeaders(isProduction) {
	const csp = [
		"default-src 'self'",
		// 'unsafe-eval' is required by Next's dev-mode HMR and must never ship.
		`script-src 'self' 'unsafe-inline'${isProduction ? '' : " 'unsafe-eval'"}`,
		// Required: the components style via React inline style={{…}} attributes.
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data:",
		"font-src 'self' data:",
		"connect-src 'self'",
		"frame-ancestors 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"object-src 'none'",
		'upgrade-insecure-requests',
	].join('; ');

	return [
		{ key: 'Content-Security-Policy', value: csp },
		// Redundant with frame-ancestors, kept for browsers that ignore it.
		{ key: 'X-Frame-Options', value: 'DENY' },
		{ key: 'X-Content-Type-Options', value: 'nosniff' },
		{ key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
		// No `preload`: it is effectively irreversible and the domain is not settled.
		{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
		{ key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
	];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/dashboard/lib/securityHeaders.test.ts`
Expected: PASS, all 7 tests.

- [ ] **Step 5: Wire it into next.config.mjs**

Add the import at the top of `packages/dashboard/next.config.mjs`, after the existing imports:

```js
import { securityHeaders } from './lib/securityHeaders.mjs';
```

Add to the `config` object, alongside `typedRoutes`:

```js
	async headers() {
		return [{ source: '/:path*', headers: securityHeaders(process.env.NODE_ENV === 'production') }];
	},
```

- [ ] **Step 6: Verify against a real production build**

A broken CSP does not surface under `next dev`. Kill any dev server first — a root build writes into the same `.next` that `next dev` owns and the app will render unstyled.

```bash
npm run build
PORT=3200 npm start
```

In another shell:

```bash
curl -sI http://localhost:3200/ | grep -i -E 'content-security-policy|x-frame-options|strict-transport'
```

Expected: all three present, and the CSP contains no `'unsafe-eval'`.

Then open `http://localhost:3200/` in a browser, paste a known hash, and confirm the receipt renders with styles and fonts intact and the console shows **no CSP violations**. Stop the server when done.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add packages/dashboard/lib/securityHeaders.mjs packages/dashboard/lib/securityHeaders.test.ts packages/dashboard/next.config.mjs
git commit -m "feat(dashboard): set static security headers

CSP without nonces: a per-request nonce would force dynamic rendering
and foreclose full-route caching later, for thin benefit in an app with
no dangerouslySetInnerHTML. 'unsafe-eval' is dev-only; HSTS omits
preload until the domain is settled."
```

---

### Task 6: Assert the headers on a live deployment

**Files:**
- Modify: `scripts/smokeDeploy.mjs:29-36` (`req` must expose headers) and the check list

**Interfaces:**
- Consumes: the header names from Task 5.
- Produces: nothing.

- [ ] **Step 1: Make `req` return response headers**

In `scripts/smokeDeploy.mjs`, change `req` to carry the headers through:

```js
async function req(path, init = {}) {
	try {
		const res = await fetch(`${base}${path}`, { redirect: 'manual', ...init });
		return { status: res.status, headers: res.headers, body: await res.text() };
	} catch (e) {
		return { status: 0, headers: new Headers(), body: String(e.message) };
	}
}
```

- [ ] **Step 2: Add the header checks**

The existing `const home = await req('/')` already holds the response. Add directly after the two existing anonymous checks that use it:

```js
console.log('\nsecurity headers:');
const csp = home.headers.get('content-security-policy') ?? '';
check('CSP is set', csp.length > 0);
check("CSP blocks framing", csp.includes("frame-ancestors 'none'"), csp.slice(0, 60));
// 'unsafe-eval' is a dev-only allowance; finding it here means a dev build shipped.
check("CSP has no 'unsafe-eval'", !csp.includes("'unsafe-eval'"));
check('X-Content-Type-Options: nosniff', home.headers.get('x-content-type-options') === 'nosniff');
check('X-Frame-Options: DENY', home.headers.get('x-frame-options') === 'DENY');
check('HSTS is set', (home.headers.get('strict-transport-security') ?? '').includes('max-age='));
```

- [ ] **Step 3: Verify against a local production build**

With the production build from Task 5 still available:

```bash
npm run build && (PORT=3200 npm start &) && sleep 5
node scripts/smokeDeploy.mjs http://localhost:3200
```

Expected: the six new header checks PASS. Access-boundary checks that require the `APP_` vars may fail locally if they are unset — that is unrelated to this task; confirm only that the header checks pass and the script still exits with a meaningful code. Kill the server afterwards.

- [ ] **Step 4: Commit**

```bash
git add scripts/smokeDeploy.mjs
git commit -m "test(scripts): assert security headers in the deploy smoke test

Catches a dev-mode CSP reaching production, which is invisible from
inside the app."
```

---

## Deployment (after all tasks are green)

Not a code task — the operator runs this.

- [ ] Create two Slack incoming webhooks (or one, used twice) — an incident channel and an activity channel.
- [ ] Set `ALERT_WEBHOOK_URL` and `ACTIVITY_WEBHOOK_URL` in the **Railway** service variables. ⚠️ Not in the local `.env`: local and production share one database, so a local test receipt is a real receipt and would post to the same channel.
- [ ] Confirm migration `0002` is applied (it was, in Task 1 — the same Supabase instance serves both).
- [ ] Kill any dev server, run `npm run build`, confirm it succeeds. A lint error fails the build.
- [ ] Push. This auto-deploys to Railway.
- [ ] Run `node scripts/smokeDeploy.mjs https://<railway-url>` and confirm every check passes.
- [ ] Generate one receipt on the live site and confirm exactly one Slack message arrives; reload the receipt and confirm **no** second message.
