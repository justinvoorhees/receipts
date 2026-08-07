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
