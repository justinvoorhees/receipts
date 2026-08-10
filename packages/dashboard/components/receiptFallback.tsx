'use client';
/**
 * The receipt route's Suspense fallback (app/tx/[chain]/[hash]/page.tsx).
 *
 * Two different screens, chosen by whether a receipt was already on display:
 *
 *   - Hard navigation (shared link, refresh, first load): no previous receipt,
 *     so this is the index's empty state with the URL's hash prefilled and the
 *     button reading "Analyzing…". Server-rendered, so it streams immediately
 *     instead of leaving a blank page for the ~40 RPC calls.
 *   - Client-side navigation to another hash: the receipt the reader was
 *     looking at, dimmed and pulsing, with the loader word the click drew.
 *     Client-only, so there is no hydration constraint on the random word.
 *
 * This is what makes the second case possible at all: Next commits the incoming
 * route and shows this fallback rather than holding the old page on screen, so
 * "keep the previous receipt up" has to mean "render it here".
 */
import { ReceiptView } from './receiptView';
import { useReceiptTransition } from './receiptTransition';

export function ReceiptFallback({ hash }: { hash: string }) {
	const { receipt } = useReceiptTransition();
	return <ReceiptView trade={receipt} hash={hash} decoding />;
}
