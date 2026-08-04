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
			await fetchImpl(webhookUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ text, content: text }),
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
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
 */
export function originFrom(req: Request): string {
	const host = req.headers.get('host') ?? 'localhost:3000';
	const proto = req.headers.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
	return `${proto}://${host}`;
}
