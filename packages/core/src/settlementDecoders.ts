/**
 * Protocol-aware settlement decoders. Authoritative beneficiary identity from a
 * protocol's own event, mirroring resolveAggregator's "declaration, not
 * inference" discipline. Seeded with UniswapX only; add a decoder per protocol.
 *
 * UniswapX BaseReactor emits `Fill(bytes32 orderHash, address filler, address
 * swapper, uint256 nonce)` — all three addresses indexed, so `swapper` is
 * topics[3] and no data decode is needed. Matching keys off the LOG EMITTER
 * being a known reactor (not tx.to), so a filler contract that is itself tx.to
 * and calls the reactor internally still matches.
 */
export type LogLite = { address: string; topics: readonly string[] };

export const FILL_TOPIC0 = '0x78ad7ec0e9f89e74012afa58738b6b661c024cb0fd185ee2f616c0a28924bd66';

const topicToAddress = (t: string): string => ('0x' + t.slice(-40)).toLowerCase();

/** Lowercased swapper iff exactly one Fill from a known reactor; else null. */
export function decodeUniswapXBeneficiary(
	logs: readonly LogLite[],
	reactors: ReadonlySet<string>,
): string | null {
	const fills = logs.filter(
		(l) => l.topics[0] === FILL_TOPIC0 && l.topics.length >= 4 && reactors.has(l.address.toLowerCase()),
	);
	if (fills.length !== 1) return null; // 0 = not UniswapX; >1 = batch (out of scope)
	return topicToAddress(fills[0]!.topics[3]!);
}
