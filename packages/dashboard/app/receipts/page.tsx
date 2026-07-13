import { getReceiptByHash } from '../../lib/queries';
import { ReceiptView } from '../../components/ReceiptView';
import { classifyTransaction, type AnalyzeFailure } from '@fabric-tca/core';

export const dynamic = 'force-dynamic';

const DEFAULT_HASH = '0x9703bfa335528a8e01c6b63dd3046ccd6e13a66ba2e6954956aa2df39da269c1';
const DEFAULT_CHAIN_ID = 8453;

export default async function ReceiptsPage({
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
