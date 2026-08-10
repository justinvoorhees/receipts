/**
 * pinnedPool.ts — resolve a pair's reference pool ONCE per decode, then sample
 * it at whatever block the caller asks for.
 *
 * `priceReceipt` builds the receipt's Execution/Market/Delta triple by running
 * the whole Market Price apparatus at three adjacent blocks (refBlock-1,
 * refBlock, refBlock+1). Each run re-discovered and re-ranked candidate pools
 * from scratch, which is both the single most expensive thing in a decode and,
 * more importantly, WRONG in a way nothing flagged: ranking is by on-chain
 * depth, so a pair whose two deepest pools are close can rank differently one
 * block apart, and the triple then reports the gap between two different pools
 * as if it were movement over time.
 *
 * `readMidFromPool`'s docstring in pricing.ts has claimed since it was written
 * that it exists so "the three-block sampler can reuse an ALREADY-RESOLVED pool
 * rather than re-discovering per block — re-discovery could rank a different
 * pool at a different block, which would make the receipt's 'deviation between
 * blocks' measure space instead of time." The general path never did it. This
 * is that.
 *
 * Selection is pinned; the READ is not. The mid is still read from the pinned
 * pool at each sampled block, which is what makes the wings measure time.
 */

/** Pair key that is stable across token casing and argument order. */
function pairKey(a: string, b: string): string {
	const la = a.toLowerCase();
	const lb = b.toLowerCase();
	return la < lb ? `${la}/${lb}` : `${lb}/${la}`;
}

/**
 * Wrap a pool resolver so that, for the life of the returned function, each
 * token pair is resolved exactly once — always at `pinBlock`, whatever block the
 * caller passes. The block argument is deliberately ignored: pinning to
 * "whichever block asked first" would make pool selection depend on the order
 * three concurrent samples happen to resolve in.
 *
 * A `null` resolution is cached too — "this pair has no pool" is an answer, and
 * re-deriving it per block costs a full factory scan.
 *
 * ⚠️ A REJECTION IS NOT CACHED, matching rpcMemo: a transient failure must not
 * become this pair's permanent answer for the rest of the receipt.
 */
export function pinnedPoolResolver<T>(
	resolve: (a: string, b: string, block: bigint) => Promise<T>,
	pinBlock: bigint,
): (a: string, b: string, block: bigint) => Promise<T> {
	const memo = new Map<string, Promise<T>>();
	return (a, b, _block) => {
		const key = pairKey(a, b);
		const hit = memo.get(key);
		if (hit) return hit;

		const pending = resolve(a, b, pinBlock).catch((err) => {
			memo.delete(key);
			throw err;
		});
		memo.set(key, pending);
		return pending;
	};
}
