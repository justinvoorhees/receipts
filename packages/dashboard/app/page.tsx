import { getReceiptByHash } from '../lib/queries';
import { ReceiptView } from '../components/receiptView';
import { classifyTransaction, type AnalyzeFailure } from '@fabric-tca/core';

export const dynamic = 'force-dynamic';

const DEFAULT_HASH = '0xa21e4d82b961726614ce6f310e30e29a4b55b8eca1d6a46621c3adaf8edf6ab1';
const DEFAULT_CHAIN_ID = 8453;

export default async function ReceiptPage({
	searchParams,
}: {
	searchParams: Promise<{ tx?: string }>;
}) {
	const sp = await searchParams;
	const explicit = sp.tx != null && sp.tx.trim() !== '';
	const hash = (sp.tx ?? DEFAULT_HASH).trim();
	const receipt = await getReceiptByHash(hash);

	// On a genuine miss for an explicitly-pasted hash, diagnose WHY (page is the
	// single server render; successes are already persisted by the awaited POST).
	let diagnosis: AnalyzeFailure | undefined;
	if (receipt == null && explicit) {
		const rpcUrl = process.env.TCA_RPC_URL;
		diagnosis = rpcUrl
			? await classifyTransaction(hash, DEFAULT_CHAIN_ID, { rpcUrl })
			: { reason: 'ANALYZE_ERROR' };
	}

	return (
		<div className="mt-[40px]">
			<ReceiptView trade={receipt} hash={hash} {...(diagnosis ? { diagnosis } : {})} />
		</div>
	);
}
