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

	// `log` is caller-supplied, so it can throw. Nothing in this module may reject:
	// a broken logger must not turn a 429 into a 500.
	const safeLog = (message: string) => {
		try {
			log(message);
		} catch {
			/* deliberately swallowed — see above */
		}
	};

	// Per-kind, so a ceiling alert never suppresses a budget warning. Held in
	// the closure, so the notifier must be created ONCE at module scope — a
	// per-request notifier would have nothing to debounce against.
	const lastSent = new Map<AlertKind, number>();

	return async (kind, text) => {
		if (debounceMs > 0) {
			const previous = lastSent.get(kind);
			if (previous != null && now() - previous < debounceMs) return;
		}
		const previousSent = lastSent.get(kind);
		lastSent.set(kind, now());

		if (!webhookUrl) {
			safeLog(`[notify:${kind}] ${text}`);
			return;
		}

		try {
			// `text` is what Slack reads and `content` is what Discord reads; each
			// ignores the other's key, so one URL works with either service.
			const res = await fetchImpl(webhookUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ text, content: text }),
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			// fetch only rejects on transport failure. Slack and Discord report a
			// revoked webhook (404), a disabled one (403), a rejected payload (400)
			// and throttling (429) as a status on a RESOLVED response — so without
			// this check a permanently dead webhook is byte-identical to a working
			// one, and the debounce window is consumed by a send that never landed.
			if (!res.ok) throw new Error(`webhook responded ${res.status} ${res.statusText}`);
		} catch (err) {
			// A failed send must not consume the debounce window: a transient outage
			// during the first incident would otherwise blank alerting until the window
			// elapsed, even after the endpoint recovered. Restore the prior timestamp so
			// the next occurrence may try again.
			if (previousSent == null) lastSent.delete(kind);
			else lastSent.set(kind, previousSent);

			safeLog(`[notify:${kind}] webhook failed: ${err instanceof Error ? err.message : String(err)}`);
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
 *
 * Trusts `Host` / `X-Forwarded-Proto`, both caller-controlled on a public,
 * unauthenticated endpoint — do not use this directly to build a link that is
 * posted somewhere trusted (e.g. Slack). Use `baseUrlFrom` for that, which
 * prefers `APP_BASE_URL` and only falls back to this derivation when unset.
 */
export function originFrom(req: Request): string {
	const host = req.headers.get('host') ?? 'localhost:3000';
	const proto = req.headers.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
	return `${proto}://${host}`;
}

/**
 * The base URL to use in outbound links (e.g. the Slack receipt-created
 * message). Prefers the explicit `APP_BASE_URL` env var; falls back to
 * `originFrom(req)` when unset.
 *
 * `originFrom` trusts request headers (`Host`, `X-Forwarded-Proto`), which are
 * attacker-controlled on this public endpoint — a forged `Host` header would
 * otherwise land a convincing phishing link in the team's own Slack, sent by
 * the team's own bot. `APP_BASE_URL` removes that header from the trust chain
 * once it is set.
 */
export function baseUrlFrom(req: Request): string {
	const configured = process.env.APP_BASE_URL;
	return configured && configured.length > 0 ? configured.replace(/\/$/, '') : originFrom(req);
}
