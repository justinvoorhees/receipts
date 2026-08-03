import { headers } from 'next/headers';
import { getReceiptByHash } from '../lib/queries';
import { ReceiptView } from '../components/receiptView';
import { classifyTransaction, type AnalyzeFailure } from '@fabric-tca/core';
import { clientKeyFromHeaders, createMemoryStore, createRateLimiter } from '../lib/rateLimit';

export const dynamic = 'force-dynamic';

const DEFAULT_CHAIN_ID = 8453;

/**
 * `/?tx=…` spends RPC on every cache miss, and it is the cheapest path in the
 * app to trigger: a plain GET, so crawlers, link unfurlers and an <img> tag all
 * reach it with no JS and no CORS preflight. Cheaper per hit than a full
 * analysis (~1 call), so the ceiling is higher than the API's — but it is not
 * free and must not be unbounded.
 */
const diagnosisLimiter = createRateLimiter(createMemoryStore(), {
	limit: Number(process.env.RATE_LIMIT_DIAGNOSIS_PER_MIN) || 30,
	windowMs: 60_000,
});

export default async function ReceiptPage({
	searchParams,
}: {
	searchParams: Promise<{ tx?: string }>;
}) {
	const sp = await searchParams;
	const explicit = sp.tx != null && sp.tx.trim() !== '';
	// No default transaction: the bare index renders just the search input (empty
	// hash → empty field). A receipt is only fetched for an explicitly-pasted tx.
	const hash = explicit ? (sp.tx as string).trim() : '';
	const receipt = explicit ? await getReceiptByHash(hash) : null;

	// On a genuine miss for an explicitly-pasted hash, diagnose WHY (page is the
	// single server render; successes are already persisted by the awaited POST).
	let diagnosis: AnalyzeFailure | undefined;
	if (receipt == null && explicit) {
		const rpcUrl = process.env.TCA_RPC_URL;
		const budget = await diagnosisLimiter(clientKeyFromHeaders(await headers()));
		if (!budget.allowed) {
			// Deliberately leave `diagnosis` unset rather than inventing a reason
			// code: every AnalyzeFailure value asserts something about the
			// transaction, and we have not looked at it. The page falls back to the
			// plain search state instead of making a claim we did not verify.
			diagnosis = undefined;
		} else {
			diagnosis = rpcUrl
				? await classifyTransaction(hash, DEFAULT_CHAIN_ID, { rpcUrl })
				: { reason: 'ANALYZE_ERROR' };
		}
	}

	return (
		<div className="mt-[40px]">
			<ReceiptView trade={receipt} hash={hash} {...(diagnosis ? { diagnosis } : {})} />
		</div>
	);
}
