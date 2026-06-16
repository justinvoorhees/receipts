import { createPublicClient, http, parseAbiItem } from 'viem';
import { base } from 'viem/chains';
import type { Db } from '@fabric-tca/db';
import { schema } from '@fabric-tca/db';
import type { RouterRegistry } from './routerRegistry.js';

/**
 * Uniswap V3 Swap event. `amount0` / `amount1` are signed deltas — positive
 * means the token was sent INTO the pool by the swapper, negative means the
 * pool paid the token out. For the canonical Base USDC/WETH pool the token
 * ordering is token0 = WETH (lower address), token1 = USDC.
 */
const SWAP_EVENT = parseAbiItem(
	'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
);

/**
 * Verified Uniswap V3 USDC/WETH pools on Base (per spec §4.2).
 * Both verified via Uniswap V3 factory's getPool(WETH, USDC, fee) call
 * against mainnet.base.org, with token0/token1/fee/slot0 round-tripped
 * against each pool to confirm identity and liveness.
 */
export const POOLS: { address: `0x${string}`; feeTier: number }[] = [
	{ address: '0xd0b53D9277642d899DF5C87A3966A349A798F224', feeTier: 500 }, // 0.05%
	{ address: '0x6c561B446416E1A00E8E93E221854d6eA4171372', feeTier: 3000 }, // 0.3%
];

export interface PollerArgs {
	db: Db;
	rpcUrl: string;
	pollIntervalMs: number;
	registry: RouterRegistry;
	pools: { address: `0x${string}`; feeTier: number }[];
	/** Block to resume from; defaults to current head. Pass for backfills. */
	startBlock?: bigint;
	signal?: AbortSignal;
	onProgress?: (msg: string) => void;
}

export async function startPoller(args: PollerArgs): Promise<void> {
	const log = (msg: string) => (args.onProgress ? args.onProgress(msg) : console.log(msg));
	const client = createPublicClient({ chain: base, transport: http(args.rpcUrl) });

	const head = await client.getBlockNumber();
	let lastProcessed = args.startBlock ?? head;
	log(`poller starting at block ${lastProcessed} (chain head ${head})`);

	while (!args.signal?.aborted) {
		try {
			const head = await client.getBlockNumber();
			if (head > lastProcessed) {
				const fromBlock = lastProcessed + 1n;
				const toBlock = head;

				const logs = await client.getLogs({
					address: args.pools.map((p) => p.address),
					event: SWAP_EVENT,
					fromBlock,
					toBlock,
				});

				if (logs.length > 0) {
					// Resolve the `to` for each unique tx. eth_getTransaction is cheap
					// relative to downstream trace work; batch if this ever becomes hot.
					const txMap = new Map<string, `0x${string}` | null>();
					for (const txHash of new Set(logs.map((l) => l.transactionHash))) {
						const tx = await client.getTransaction({ hash: txHash as `0x${string}` });
						txMap.set(txHash, tx.to);
					}

					const aggregatorRouted = logs.filter((l) => {
						const to = txMap.get(l.transactionHash);
						return (
							to !== null &&
							to !== undefined &&
							args.registry.byAddressLower.has(to.toLowerCase())
						);
					});

					if (aggregatorRouted.length > 0) {
						// Block timestamps (one fetch per unique block).
						const blockMap = new Map<bigint, number>();
						for (const blockNumber of new Set(aggregatorRouted.map((l) => l.blockNumber))) {
							const block = await client.getBlock({ blockNumber });
							blockMap.set(blockNumber, Number(block.timestamp));
						}

						// Notional estimate uses the USDC leg (token1) directly — USDC is
						// 1:1 USD by assumption, no spot-price lookup needed for staging.
						// Reference-price-based notional comes later at promotion.
						const rows = aggregatorRouted.map((l) => {
							const amount0 = l.args.amount0 ?? 0n; // WETH
							const amount1 = l.args.amount1 ?? 0n; // USDC
							const notionalUsdc = abs(amount1);
							const notionalUsdEst = Number(notionalUsdc) / 1e6;
							return {
								txHash: l.transactionHash,
								logIndex: l.logIndex,
								blockNumber: Number(l.blockNumber),
								blockTimestamp: blockMap.get(l.blockNumber) ?? 0,
								poolAddress: l.address.toLowerCase(),
								toAddress: txMap.get(l.transactionHash)!.toLowerCase(),
								amountInRaw: amount0.toString(),
								amountOutRaw: amount1.toString(),
								notionalUsdEstimate: notionalUsdEst.toFixed(2),
							};
						});

						// `onConflictDoNothing` so re-polls don't double-insert if the
						// poller restarts and overlaps a range.
						await args.db.insert(schema.swapsStaging).values(rows).onConflictDoNothing();
					}

					log(
						`block ${fromBlock}..${head}: ${logs.length} swaps, ${aggregatorRouted.length} aggregator-routed`,
					);
				}
				lastProcessed = head;
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log(`poller tick error: ${msg.slice(0, 200)}`);
		}
		await sleep(args.pollIntervalMs, args.signal);
	}
	log('poller stopped');
}

function abs(n: bigint): bigint {
	return n < 0n ? -n : n;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const onAbort = () => {
			clearTimeout(t);
			resolve();
		};
		const t = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}
