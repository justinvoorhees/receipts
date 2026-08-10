import { headers } from 'next/headers';
import { classifyTransaction, type AnalyzeFailure } from '@fabric-tca/core';
import type { Chain } from '../../../../lib/chains';
import { loadReceipt } from '../../../../lib/loadReceipt';
import { log } from '../../../../lib/log';
import { ReceiptView } from '../../../../components/receiptView';
import {
	clientKeyFromHeaders,
	createMemoryStore,
	createRateLimiter,
} from '../../../../lib/rateLimit';
import {
	baseUrlFromHeaders,
	budgetWarningMessage,
	ceilingReachedMessage,
	createNotifier,
	receiptCreatedMessage,
} from '../../../../lib/alerts.js';


/**
 * A miss spends RPC to diagnose WHY, and this is the cheapest path in the app
 * to trigger: a plain GET, so crawlers, link unfurlers and an <img> tag all
 * reach it with no JS and no CORS preflight. Cheaper per hit than a full
 * analysis (~1 call), so the ceiling is higher than the API's — but it is not
 * free and must not be unbounded.
 *
 * Moved here verbatim from app/page.tsx when receipts left the index. Same
 * limit, same window, same behaviour — only the address changed.
 */
const diagnosisLimiter = createRateLimiter(createMemoryStore(), {
	limit: Number(process.env.RATE_LIMIT_DIAGNOSIS_PER_MIN) || 30,
	windowMs: 60_000,
});

const envInt = (name: string, fallback: number): number => {
	const raw = Number(process.env[name]);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
};

/**
 * Per-IP analysis budget. Moved here verbatim from POST /api/receipts when
 * receipts stopped being stored — same limit, same window, new address.
 */
const analysisLimiter = createRateLimiter(createMemoryStore(), {
	limit: envInt('RATE_LIMIT_ANALYSES_PER_MIN', 20),
	windowMs: 60_000,
});

/**
 * Circuit breaker on total spend, counted across every client.
 *
 * This route is public and now costs a full analysis (~40 RPC calls) on every
 * hit, so per-IP limits alone do not bound the bill — a flood just uses more
 * IPs, each arriving with a full budget. This is the only ceiling a distributed
 * source cannot walk around, and with receipts no longer stored there is no
 * cache hit to fall back on. It is blunt on purpose: when it trips, receipts
 * pause for everyone rather than quietly running up an RPC invoice.
 */
const GLOBAL_ANALYSES_PER_HOUR = envInt('RATE_LIMIT_ANALYSES_GLOBAL_PER_HOUR', 500);
const globalAnalysisLimiter = createRateLimiter(createMemoryStore(), {
	limit: GLOBAL_ANALYSES_PER_HOUR,
	windowMs: 60 * 60 * 1000,
});
const GLOBAL_KEY = 'global';

/** Warn with a fifth of the hourly budget left — once the ceiling trips the tool is already down. */
const BUDGET_WARNING_FRACTION = 0.2;

const alertNotify = createNotifier({
	webhookUrl: process.env.ALERT_WEBHOOK_URL,
	debounceMs: 60 * 60 * 1000,
});

/**
 * Deliberately NOT debounced — a launch-day burst of real receipts should all
 * be reported. The global ceiling above already bounds the volume.
 *
 * Its own URL, independent of ALERT_WEBHOOK_URL: sharing a channel would bury a
 * ceiling warning under activity during a flood.
 */
const activityNotify = createNotifier({ webhookUrl: process.env.ACTIVITY_WEBHOOK_URL });


/**
 * The analysis, and everything that must be spent to get it: the per-IP budget,
 * the global ceiling, the receipt itself, and the diagnosis of a miss.
 *
 * Its own module rather than a second export from page.tsx, because Next.js
 * permits only a fixed set of named exports there (`metadata`, `dynamic`, …)
 * and rejects the build otherwise — an error that surfaces as a failed deploy,
 * not a failed test. The route's tests drive this directly: every side effect
 * that guards the RPC bill lives here, not in the page function.
 */
export async function ReceiptBody({ chain, hash }: { chain: Chain; hash: string }) {
	const client = clientKeyFromHeaders(await headers());

	const perIp = await analysisLimiter(client);
	// Per-IP is checked first and short-circuits: a visitor throttled here never
	// touched the shared budget, so the global limiter must not be charged for
	// a request it didn't admit.
	if (!perIp.allowed) {
		return <CeilingNotice reason="perIp" retryAfterSecs={perIp.retryAfterSecs} />;
	}

	const globalBudget = await globalAnalysisLimiter(GLOBAL_KEY);
	if (!globalBudget.allowed) {
		log.warn('global analysis ceiling reached, pausing new receipts', { route: 'tx' });
		void alertNotify(
			'ceiling_reached',
			ceilingReachedMessage(GLOBAL_ANALYSES_PER_HOUR, globalBudget.retryAfterSecs),
		);
		return <CeilingNotice reason="global" />;
	}
	if (globalBudget.remaining <= GLOBAL_ANALYSES_PER_HOUR * BUDGET_WARNING_FRACTION) {
		void alertNotify(
			'budget_warning',
			budgetWarningMessage(GLOBAL_ANALYSES_PER_HOUR, globalBudget.remaining),
		);
	}

	const receipt = await loadReceipt(chain, hash);
	if (receipt) {
		void activityNotify(
			'receipt_created',
			receiptCreatedMessage(receipt, baseUrlFromHeaders(await headers())),
		);
	}

	// On a genuine miss, diagnose why rather than showing a bare empty state.
	let diagnosis: AnalyzeFailure | undefined;
	if (receipt == null) {
		const budget = await diagnosisLimiter(clientKeyFromHeaders(await headers()));
		if (!budget.allowed) {
			// Deliberately leave `diagnosis` unset rather than inventing a reason
			// code: every AnalyzeFailure value asserts something about the
			// transaction, and we have not looked at it.
			diagnosis = undefined;
		} else {
			// process.env.TCA_RPC_URL is guaranteed set here: loadReceipt() above
			// throws synchronously-awaited when it is unset (see loadReceipt.ts),
			// so control cannot reach this branch with it unset.
			diagnosis = await classifyTransaction(hash, chain.id, { rpcUrl: process.env.TCA_RPC_URL! });
		}
	}

	// No margin wrapper here: the page above owns the `mt-[40px]`, so that the
	// shell and the resolved receipt occupy the same box and nothing shifts when
	// one replaces the other.
	return <ReceiptView trade={receipt} hash={hash} {...(diagnosis ? { diagnosis } : {})} />;
}

/**
 * A refusal is a statement about US, not about the transaction. Every other
 * empty state on this page asserts something the analysis established; this
 * one must not, because no analysis ran.
 *
 * Two distinct causes get two distinct — and separately honest — messages.
 * `perIp` is a per-visitor, per-minute throttle: brief, and specific to this
 * caller, so it's safe to say it'll pass in moments. `global` is the shared
 * hourly ceiling actually being exhausted: true for everyone, not brief.
 * Collapsing them into one sentence would tell a merely-throttled visitor a
 * false thing about the site's overall capacity — the same category of error
 * this component exists to avoid making about the transaction.
 */
function CeilingNotice({
	reason,
	retryAfterSecs,
}: {
	reason: 'perIp' | 'global';
	retryAfterSecs?: number;
}) {
	const message =
		reason === 'perIp'
			? `You're requesting receipts faster than we allow. Please wait ${retryAfterSecs ?? 60}s and try again.`
			: 'Receipt generation is temporarily unavailable — the hourly analysis budget is exhausted. Please try again shortly.';
	// Margin-free for the same reason as ReceiptBody's return: the page owns the
	// `mt-[40px]` this renders inside.
	return <div className="font-['Sohne_Mono'] text-[12px] leading-[18px]">{message}</div>;
}
