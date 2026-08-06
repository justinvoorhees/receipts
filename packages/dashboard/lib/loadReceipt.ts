import { getReceiptByHash, type ReceiptRow } from './queries';
import type { Chain } from './chains';

/**
 * The single place the receipt route gets its data.
 *
 * `chain` is accepted but deliberately unused. getReceiptByHash matches on
 * transaction hash alone and ignores chain_id, which is safe ONLY because
 * lib/chains.ts registers exactly one chain — so every URL that resolves at all
 * resolves to Base and there is no second row to confuse it with. The tripwire
 * test in chains.test.ts is what stops that assumption expiring quietly.
 *
 * The parameter is in the signature now because the database removal that
 * follows replaces this body with an on-demand analyzeTransaction(hash,
 * chain.id) call. Fixing the shape here means that change edits one function
 * rather than one function and every caller.
 */
export async function loadReceipt(chain: Chain, hash: string): Promise<ReceiptRow | null> {
	void chain;
	return getReceiptByHash(hash);
}
