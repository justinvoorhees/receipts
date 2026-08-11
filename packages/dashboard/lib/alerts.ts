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
 * not turn a refusal into a 500, nor fail a receipt render that has already
 * computed successfully — there is nothing to persist, and a webhook failure
 * must not be able to take the page down.
 */

import { DEFAULT_CHAIN } from './chains';
import { receiptPath } from './receiptUrl';
import { log as structuredLog } from './log';

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
	log?: (message: string, fields?: Record<string, unknown>) => void;
}

const TIMEOUT_MS = 3_000;

export function createNotifier(opts: NotifierOptions = {}): Notify {
	const {
		webhookUrl,
		debounceMs = 0,
		fetchImpl = fetch,
		now = Date.now,
		log = (m: string, fields?: Record<string, unknown>) => structuredLog.warn(m, fields),
	} = opts;

	// `log` is caller-supplied, so it can throw. Nothing in this module may reject:
	// a broken logger must not turn a 429 into a 500.
	const safeLog = (message: string, fields?: Record<string, unknown>) => {
		try {
			log(message, fields);
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
			safeLog(text, { kind });
			return;
		}

		try {
			// `text` is what Slack reads and `content` is what Discord reads; each
			// ignores the other's key, so one URL reaches either service.
			//
			// ⚠️ The TRANSPORT is service-agnostic; the message bodies are not.
			// receiptCreatedMessage emits Slack mrkdwn (`<url|label>`), which
			// Discord renders literally. Pointing ACTIVITY_WEBHOOK_URL at Discord
			// needs a per-service formatter, not just a different URL.
			//
			// ⚠️⚠️ unfurl_links/unfurl_media are LOAD-BEARING, not cosmetic.
			// Activity messages carry a receipt URL. Left to expand it, Slack
			// FETCHES that URL to build a preview — which renders the receipt,
			// which fires this webhook again. One view, two full analyses, two
			// identical messages, and an effective global ceiling of half what is
			// configured. Measured in production 2026-08-11.
			//
			// robots.txt does not prevent it. `Disallow: /tx/` is served correctly
			// and Slack's expander fetched anyway; these flags are what stopped it.
			const res = await fetchImpl(webhookUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ text, content: text, unfurl_links: false, unfurl_media: false }),
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

			safeLog(`webhook failed: ${err instanceof Error ? err.message : String(err)}`, { kind });
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

/**
 * Escape text before it is interpolated into Slack mrkdwn.
 *
 * ⚠️ Load-bearing, not cosmetic. Token symbols reach this module straight from
 * `symbol()` on an arbitrary contract, so their content is chosen by whoever
 * deployed the token. Interpolated raw into a `<url|label>` link, a symbol
 * containing `>` closes the link early and one containing `<` opens a new
 * one — which is enough to post a link whose visible text and real destination
 * disagree, into our own Slack, from our own bot. Exactly the confusion
 * APP_BASE_URL exists to prevent at the other end of this same string.
 *
 * Slack treats only `&`, `<` and `>` as special, and the order below matters:
 * `&` must go first or it re-escapes the ampersands the other two introduce.
 * `|` needs no escaping — Slack splits a link on the FIRST one, so a pipe in
 * the label is shown literally and cannot reach the URL half.
 */
function escapeSlack(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The receipt fields the activity message reads. Structural, so a ReceiptModel satisfies it. */
export interface ReceiptSummary {
	txHash: string;
	aggregator: string | null;
	inputSymbol: string | null;
	outputSymbol: string | null;
	notionalUsd: number | null;
	allInCostBps: number | null;
}

export function receiptCreatedMessage(r: ReceiptSummary, baseUrl: string): string {
	const pair = escapeSlack(`${r.inputSymbol ?? '?'} → ${r.outputSymbol ?? '?'}`);
	const via = r.aggregator ? ` via ${escapeSlack(r.aggregator)}` : '';
	const notional = r.notionalUsd != null ? ` · $${Number(r.notionalUsd).toFixed(0)}` : '';
	const cost = r.allInCostBps != null ? ` · ${Number(r.allInCostBps).toFixed(1)}bps` : '';
	// DEFAULT_CHAIN rather than the row's own chain: ReceiptSummary is structural
	// and carries no chainId, and this message only ever fires from the /tx page
	// render — which SUPPORTED_CHAIN_IDS constrains to Base.
	const url = `${baseUrl}${receiptPath(DEFAULT_CHAIN, r.txHash)}`;
	// ⚠️ SLACK-SPECIFIC. `<url|label>` is Slack mrkdwn; Discord wants
	// `[label](url)` and renders this literally. The transport still posts both
	// `text` and `content` (see createNotifier), but THIS message is no longer
	// portable between the two — a Discord destination needs its own formatter.
	//
	// The pair carries the link rather than a bare URL on a second line, so the
	// channel reads as one scannable line per receipt.
	//
	// ⚠️ An earlier version of this comment claimed the link is safe from
	// unfurling because robots.txt disallows /tx/. That was WRONG — measured
	// 2026-08-11, Slack fetched it anyway and each message triggered a second
	// render. What actually prevents it is unfurl_links/unfurl_media in
	// createNotifier. Do not rely on robots.txt to stop a link expander.
	//
	// ⚠️ The function name and the `receipt_created` AlertKind both say
	// "created", but nothing is persisted and nothing is being created: this
	// fires on EVERY successful render of /tx/<chain>/<hash>, including repeat
	// views of the same transaction. Do not count these as unique receipts.
	return `<${url}|${pair}>${via}${notional}${cost}`;
}

/**
 * The base URL to use in outbound links (e.g. the Slack receipt-created
 * message), for callers holding a Headers rather than a Request — server
 * components, which never see the Request object.
 *
 * Same trust model, and it matters as much here: `Host` and `X-Forwarded-Proto`
 * are attacker-controlled on this public route, and a forged Host would land a
 * convincing phishing link in the team's own Slack, sent by the team's own bot.
 * APP_BASE_URL removes those headers from the trust chain once it is set.
 */
export function baseUrlFromHeaders(h: Headers): string {
	const configured = process.env.APP_BASE_URL;
	if (configured) {
		const trimmed = configured.replace(/\/+$/, '');
		// ⚠️ A scheme-less value is the likely misconfiguration, because the
		// obvious way to obtain this URL — copy the browser's address bar — hides
		// `https://`. Passed through, it produced `<receipts.example.com/tx/...|
		// PAIR>`, which Slack cannot resolve to a URL: it printed the angle
		// brackets literally and dropped the label, so the receipt link silently
		// stopped being a link. Nothing failed, nothing logged. Measured in
		// production 2026-08-11.
		//
		// Defaulting to https rather than rejecting: this runs on the render path
		// of a receipt that already computed, and a bad base URL must not be able
		// to fail the page. An explicit http:// is preserved — a staging host on
		// plain http is a real choice, and rewriting it would break the link the
		// other way.
		return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	}
	const host = h.get('host') ?? 'localhost:3000';
	const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
	return `${proto}://${host}`;
}
