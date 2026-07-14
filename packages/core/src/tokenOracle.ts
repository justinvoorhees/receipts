/**
 * Independent token→USD Chainlink oracles (Phase 2 — WBTC anchor).
 *
 * Some non-stable, non-ETH tokens still have a first-class Chainlink USD feed, so
 * their side of a swap CAN be valued independently of the pool it traded in — a
 * true anchor, not a mark. Today: WBTC (via BTC/USD, 1:1 peg). This map is the
 * seam Phase 3 grows (cbBTC, EURC/EUR-USD, majors) and where a general validated-
 * mid corroborator would also plug in.
 *
 * Feed addresses are Base mainnet, verified on-chain via `description()`
 * ("BTC / USD", 8 decimals). The reader mirrors `getBenchmarkMid`'s Chainlink
 * read: N-1 block, staleness-guarded, never-throw (null on any failure).
 */
import { createPublicClient, http, parseAbi, type PublicClient } from 'viem';
import { base } from 'viem/chains';
import { MAX_CHAINLINK_STALENESS_SECS } from './benchmarkPrice.js';

export interface TokenUsdFeed {
	feed: `0x${string}`;
	label: string;
}

/** Token address (lowercase) → its Chainlink USD feed. */
export const TOKEN_USD_FEEDS: Readonly<Record<string, TokenUsdFeed>> = {
	// WBTC (Base) → BTC/USD (WBTC is 1:1 BTC-pegged).
	'0x0555e30da8f98308edb960aa94c0db47230d2b9c': {
		feed: '0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F',
		label: 'BTC/USD',
	},
};

export function usdFeedFor(token: string): TokenUsdFeed | null {
	return TOKEN_USD_FEEDS[token.toLowerCase()] ?? null;
}

const CHAINLINK_ABI = parseAbi([
	'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

/** Chainlink 8-decimal answer → float USD. Pure. */
export function chainlinkAnswerToUsd(answer: bigint): number {
	return Number(answer) / 1e8;
}

/**
 * Independent USD price for `token` at the trade's reference block (N-1), or null
 * when the token has no mapped feed, the feed read fails, or the round is stale.
 * Never throws.
 */
export async function readTokenUsd(
	token: string,
	blockNumber: bigint,
	rpcUrl: string,
	clientOverride?: PublicClient,
): Promise<number | null> {
	const mapped = usdFeedFor(token);
	if (mapped == null) return null;
	try {
		const client = clientOverride ?? (createPublicClient({ chain: base, transport: http(rpcUrl) }) as PublicClient);
		const at = blockNumber - 1n;
		const [round, block] = await Promise.all([
			client.readContract({ address: mapped.feed, abi: CHAINLINK_ABI, functionName: 'latestRoundData', blockNumber: at }),
			client.getBlock({ blockNumber: at }),
		]);
		const price = chainlinkAnswerToUsd(round[1]);
		const stalenessSecs = Number(block.timestamp) - Number(round[3]);
		if (!(price > 0) || stalenessSecs > MAX_CHAINLINK_STALENESS_SECS) return null;
		return price;
	} catch {
		return null;
	}
}
