import { DEFAULT_CHAIN, resolveChainParam, type Chain } from './chains';

/**
 * URL policy for receipts, kept pure and free of Next imports so the whole
 * canonicalization matrix is testable without standing up a request — the same
 * split as middleware.ts / lib/accessDecision.ts.
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
