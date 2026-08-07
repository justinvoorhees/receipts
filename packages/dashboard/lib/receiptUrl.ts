import { DEFAULT_CHAIN, resolveChainParam, type Chain } from './chains';

/**
 * URL policy for receipts, kept pure and free of Next imports so the whole
 * canonicalization matrix is testable without standing up a request.
 */

export const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * The canonical path for a receipt.
 *
 * encodeURIComponent is a no-op on a valid hash (hex and '0x' are all
 * unreserved), and it is here for the callers that pass unvalidated user input:
 * a pasted value containing '/' or '?' becomes a safe 404 instead of escaping
 * the path segment.
 */
export function receiptPath(chain: Chain, hash: string): string {
	return `/tx/${chain.slug}/${encodeURIComponent(hash.toLowerCase())}`;
}

export type ReceiptUrlResolution =
	| { kind: 'render'; chain: Chain; hash: string }
	| { kind: 'redirect'; to: string }
	| { kind: 'notFound' };

/**
 * Decides what a `/tx/<chain>/<hash>` request should do.
 *
 * Chain and hash are normalized TOGETHER and produce at most one redirect. A
 * request that is non-canonical on both axes (say `/tx/8453/0xABC…`) must not
 * bounce the browser twice.
 *
 * Both segments are validated before the caller spends anything — no database
 * read, no RPC call, no rate-limiter slot. A malformed URL costs one regex.
 */
export function resolveReceiptUrl(chainParam: string, hashParam: string): ReceiptUrlResolution {
	const resolved = resolveChainParam(chainParam);
	if (!resolved) return { kind: 'notFound' };
	if (!HASH_RE.test(hashParam)) return { kind: 'notFound' };

	if (!resolved.canonical || hashParam !== hashParam.toLowerCase()) {
		return { kind: 'redirect', to: receiptPath(resolved.chain, hashParam) };
	}
	return { kind: 'render', chain: resolved.chain, hash: hashParam };
}

/**
 * Where a legacy `/?tx=…` link should land, or null if it cannot be
 * canonicalized.
 *
 * Null rather than a redirect for a malformed hash: the index answers that with
 * its empty search box, which is a better answer than a 404 for someone who
 * pasted badly.
 */
export function legacyReceiptRedirect(tx: string): string | null {
	const trimmed = tx.trim();
	if (!HASH_RE.test(trimmed)) return null;
	return receiptPath(DEFAULT_CHAIN, trimmed);
}

/**
 * What the search box should do with what the user typed.
 *
 * Extracted from the component because the decision is testable and a click
 * handler is not — this repo renders with renderToStaticMarkup and has no DOM.
 *
 * `invalid` exists so a bad paste gets the inline FailureNotice it always got,
 * with the search box still on screen. Navigating to a malformed hash would
 * land on the route's 404, which is right for a typed URL and wrong as an
 * answer to someone who just mistyped into the box.
 */
export type SearchSubmission =
	| { kind: 'navigate'; to: string }
	| { kind: 'invalid' }
	| { kind: 'empty' };

export function resolveSearchSubmission(raw: string): SearchSubmission {
	const trimmed = raw.trim();
	if (!trimmed) return { kind: 'empty' };
	if (!HASH_RE.test(trimmed)) return { kind: 'invalid' };
	return { kind: 'navigate', to: receiptPath(DEFAULT_CHAIN, trimmed) };
}
