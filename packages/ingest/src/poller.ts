import { createPublicClient, http, parseAbiItem } from 'viem';
import { base } from 'viem/chains';
import { eq } from 'drizzle-orm';
import type { Db } from '@fabric-tca/db';
import { schema } from '@fabric-tca/db';
import type { RouterRegistry } from './routerRegistry.js';
import { writeHeartbeat } from './heartbeat.js';

const POLL_CURSOR_ID = 'main';
const MAX_BACKOFF_MS = 60_000;
/**
 * Cap on the block range of a single `getLogs` call. Alchemy rejects ranges
 * above ~10k on most plans; keeping it at 5k leaves headroom and bounds the
 * per-call latency. Big backfills (e.g., 7 days = ~300k blocks) are processed
 * as a sequence of chunks rather than one massive call. The persisted cursor
 * advances after each chunk so a crash mid-backfill resumes cleanly.
 */
const MAX_LOG_RANGE_BLOCKS = 5000n;

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

	// Cursor resolution priority: explicit --from > persisted cursor > chain head.
	let lastProcessed: bigint;
	if (args.startBlock !== undefined) {
		lastProcessed = args.startBlock;
		log(`poller starting at block ${lastProcessed} (explicit --from)`);
	} else {
		const persisted = await args.db
			.select()
			.from(schema.pollState)
			.where(eq(schema.pollState.id, POLL_CURSOR_ID))
			.limit(1);
		if (persisted[0]) {
			lastProcessed = BigInt(persisted[0].lastBlock);
			log(`poller resuming from persisted cursor at block ${lastProcessed}`);
		} else {
			lastProcessed = await client.getBlockNumber();
			log(`poller starting at chain head ${lastProcessed} (no persisted cursor)`);
		}
	}

	let consecutiveFailures = 0;

	while (!args.signal?.aborted) {
		try {
			const head = await client.getBlockNumber();
			// Chunk the range so a multi-day backfill doesn't exceed Alchemy's
			// per-call block-range limit. Live tail (head - cursor < MAX_RANGE)
			// resolves to a single chunk like before.
			while (lastProcessed < head && !args.signal?.aborted) {
				const fromBlock = lastProcessed + 1n;
				const toBlock =
					head - fromBlock + 1n > MAX_LOG_RANGE_BLOCKS
						? fromBlock + MAX_LOG_RANGE_BLOCKS - 1n
						: head;

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
						`block ${fromBlock}..${toBlock}: ${logs.length} swaps, ${aggregatorRouted.length} aggregator-routed`,
					);
				}
				lastProcessed = toBlock;
				// Persist cursor after every chunk so a crash mid-backfill resumes
				// cleanly from the last completed chunk, not the start of the range.
				await args.db
					.insert(schema.pollState)
					.values({ id: POLL_CURSOR_ID, lastBlock: Number(toBlock) })
					.onConflictDoUpdate({
						target: schema.pollState.id,
						set: { lastBlock: Number(toBlock), updatedAt: new Date() },
					});
			}
			await writeHeartbeat(args.db, 'poller', {
				lastBlock: Number(lastProcessed),
				status: 'ok',
			});
			consecutiveFailures = 0;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			consecutiveFailures += 1;
			log(`poller tick error (${consecutiveFailures}): ${msg.slice(0, 200)}`);
			await writeHeartbeat(args.db, 'poller', {
				lastBlock: Number(lastProcessed),
				status: 'error',
				error: msg.slice(0, 500),
			});
		}
		// Exponential backoff on consecutive failures, capped. Resets to base
		// interval immediately after the first successful tick.
		const delay =
			consecutiveFailures === 0
				? args.pollIntervalMs
				: Math.min(args.pollIntervalMs * 2 ** consecutiveFailures, MAX_BACKOFF_MS);
		await sleep(delay, args.signal);
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
