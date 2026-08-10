import { Suspense } from 'react';
import type { Route } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { resolveReceiptUrl } from '../../../../lib/receiptUrl';
import { ReceiptFallback } from '../../../../components/receiptFallback';
import { ReceiptBody } from './receiptBody';

export const dynamic = 'force-dynamic';

/**
 * The receipt route's shell — everything that can render before the ~40 RPC
 * calls resolve.
 *
 * URL resolution stays HERE, above the Suspense boundary, for two reasons: a
 * URL that cannot name a transaction must cost one regex rather than a query,
 * and `notFound()`/`permanentRedirect()` must run before streaming starts, or
 * they can no longer set a status code.
 *
 * The analysis is a suspended child, NOT an await in this function, and that is
 * the whole point of the split. There is deliberately no `loading.tsx` for this
 * segment: a segment-level fallback replaces the ENTIRE page subtree on every
 * navigation to a new hash, which unmounts the search box (losing its pending
 * state) and the receipt already on screen (losing the pulse that reports the
 * next one is loading). With the boundary inside the page instead:
 *
 *   - a hard navigation (shared link, refresh) streams this shell immediately —
 *     the search box prefilled with the URL's hash, reading "Analyzing…" — and
 *     swaps in the receipt when it lands;
 *   - a client-side navigation to another hash gets the SAME fallback, but
 *     ReceiptFallback fills it with the receipt already on screen, pulsing.
 *
 * That second case is why the fallback is a component and not markup: Next
 * commits the incoming route and renders this fallback rather than holding the
 * previous page up, so keeping the old receipt visible means re-rendering it
 * here, from the client-side store in components/receiptTransition.ts.
 */
export default async function ReceiptPage({
	params,
}: {
	params: Promise<{ chain: string; hash: string }>;
}) {
	const { chain: chainParam, hash: hashParam } = await params;

	const resolution = resolveReceiptUrl(chainParam, hashParam);
	if (resolution.kind === 'notFound') return notFound();
	if (resolution.kind === 'redirect') return permanentRedirect(resolution.to as Route);

	const { chain, hash } = resolution;

	return (
		<div className="mt-[40px]">
			<Suspense fallback={<ReceiptFallback hash={hash} />}>
				<ReceiptBody chain={chain} hash={hash} />
			</Suspense>
		</div>
	);
}
