// Skeleton for the eth_getLogs poller. Iterates blocks every TCA_POLL_INTERVAL_MS,
// fetches Swap events on the configured USDC/WETH Uniswap V3 pools, filters by
// `to` against the router registry, and writes survivors to swaps_staging.
//
// See spec §6 (Transaction Decoding) and §9.2 (Processing Pipeline).
//
// Once a swap is in staging, the P99 promotion step is a separate routine —
// keeps the hot path (poll → stage) cheap and the slower per-tx decoding work
// (trace, reference price, ledger) decoupled.

export interface PollerArgs {
	rpcUrl: string;
	pollIntervalMs: number;
	// poolAddresses: `0x${string}`[]; // USDC/WETH 0.05% + 0.3% on Base
}

export async function startPoller(_args: PollerArgs): Promise<void> {
	// TODO: viem `createPublicClient` + `getLogs({ event: SwapEvent, ... })`
	// in a loop, dedup by tx_hash + log_index, insert into swaps_staging.
	throw new Error('Not yet implemented.');
}
