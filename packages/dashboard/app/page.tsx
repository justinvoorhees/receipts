import type { Route } from 'next';
import { permanentRedirect } from 'next/navigation';
import { legacyReceiptRedirect } from '../lib/receiptUrl';
import { ReceiptView } from '../components/receiptView';

export const dynamic = 'force-dynamic';

/**
 * The index is the search box and nothing else. Receipts live at
 * /tx/<chain>/<hash>.
 *
 * `?tx=` is still read, for ONE purpose: sending links shared before the move
 * to their canonical home. This page never renders a receipt from it. A
 * malformed hash is deliberately NOT redirected — the empty search box is a
 * better answer than a 404 for someone who pasted badly.
 */
export default async function IndexPage({
	searchParams,
}: {
	searchParams: Promise<{ tx?: string }>;
}) {
	const sp = await searchParams;
	const tx = sp.tx?.trim();
	if (tx) {
		const canonical = legacyReceiptRedirect(tx);
		if (canonical) permanentRedirect(canonical as Route);
	}

	return (
		<div className="mt-[40px]">
			<ReceiptView trade={null} hash="" />
		</div>
	);
}
