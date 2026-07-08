import { getReceiptByHash } from '../../lib/queries';
import { ReceiptView } from '../../components/ReceiptView';

export const dynamic = 'force-dynamic';

const DEFAULT_HASH = '0x9703bfa335528a8e01c6b63dd3046ccd6e13a66ba2e6954956aa2df39da269c1';

export default async function ReceiptsPage({
	searchParams,
}: {
	searchParams: Promise<{ tx?: string }>;
}) {
	const sp = await searchParams;
	const hash = (sp.tx ?? DEFAULT_HASH).trim();
	const receipt = await getReceiptByHash(hash);

	return (
		<div className="mt-[40px]">
			<ReceiptView trade={receipt} hash={hash} />
		</div>
	);
}
