import type { Route } from 'next';
import { headers } from 'next/headers';
import { notFound, permanentRedirect } from 'next/navigation';
import { classifyTransaction, type AnalyzeFailure } from '@fabric-tca/core';
import { resolveReceiptUrl } from '../../../../lib/receiptUrl';
import { loadReceipt } from '../../../../lib/loadReceipt';
import { ReceiptView } from '../../../../components/receiptView';
import {
	clientKeyFromHeaders,
	createMemoryStore,
	createRateLimiter,
} from '../../../../lib/rateLimit';
import {
	budgetWarningMessage,
	ceilingReachedMessage,
	createNotifier,
} from '../../../../lib/alerts.js';

export const dynamic = 'force-dynamic';

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

export default async function ReceiptPage({
	params,
}: {
	params: Promise<{ chain: string; hash: string }>;
}) {
	const { chain: chainParam, hash: hashParam } = await params;

	// Resolved BEFORE any data read, RPC call or limiter slot: a URL that cannot
	// name a transaction must cost one regex, not a query.
	const resolution = resolveReceiptUrl(chainParam, hashParam);
	if (resolution.kind === 'notFound') return notFound();
	if (resolution.kind === 'redirect') return permanentRedirect(resolution.to as Route);

	const { chain, hash } = resolution;

	const client = clientKeyFromHeaders(await headers());

	const perIp = await analysisLimiter(client);
	const globalBudget = perIp.allowed
		? await globalAnalysisLimiter(GLOBAL_KEY)
		: { allowed: false, remaining: 0, retryAfterSecs: perIp.retryAfterSecs };

	if (!globalBudget.allowed) {
		if (perIp.allowed) {
			console.warn('[tx] global analysis ceiling reached — pausing new receipts');
			void alertNotify(
				'ceiling_reached',
				ceilingReachedMessage(GLOBAL_ANALYSES_PER_HOUR, globalBudget.retryAfterSecs),
			);
		}
		return <CeilingNotice />;
	}
	if (globalBudget.remaining <= GLOBAL_ANALYSES_PER_HOUR * BUDGET_WARNING_FRACTION) {
		void alertNotify(
			'budget_warning',
			budgetWarningMessage(GLOBAL_ANALYSES_PER_HOUR, globalBudget.remaining),
		);
	}

	const receipt = await loadReceipt(chain, hash);

	// On a genuine miss, diagnose why rather than showing a bare empty state.
	let diagnosis: AnalyzeFailure | undefined;
	if (receipt == null) {
		const rpcUrl = process.env.TCA_RPC_URL;
		const budget = await diagnosisLimiter(clientKeyFromHeaders(await headers()));
		if (!budget.allowed) {
			// Deliberately leave `diagnosis` unset rather than inventing a reason
			// code: every AnalyzeFailure value asserts something about the
			// transaction, and we have not looked at it.
			diagnosis = undefined;
		} else {
			diagnosis = rpcUrl
				? await classifyTransaction(hash, chain.id, { rpcUrl })
				: { reason: 'ANALYZE_ERROR' };
		}
	}

	return (
		<div className="mt-[40px]">
			<ReceiptView trade={receipt} hash={hash} {...(diagnosis ? { diagnosis } : {})} />
		</div>
	);
}

/**
 * The ceiling is a statement about US, not about the transaction. Every other
 * empty state on this page asserts something the analysis established; this one
 * must not, because no analysis ran.
 */
function CeilingNotice() {
	return (
		<div className="mt-[40px] font-['Sohne_Mono'] text-[12px] leading-[18px]">
			Receipt generation is temporarily unavailable — the hourly analysis budget
			is exhausted. Please try again shortly.
		</div>
	);
}
