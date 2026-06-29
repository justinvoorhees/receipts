import { createPublicClient, http, parseAbiItem } from 'viem';
import { base } from 'viem/chains';

const SWAP_EVENT = parseAbiItem(
	'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
);

const POOLS = [
	{ address: '0xd0b53D9277642d899DF5C87A3966A349A798F224' as const, feeTier: 500 }, // 0.05%
	{ address: '0x6c561B446416E1A00E8E93E221854d6eA4171372' as const, feeTier: 3000 }, // 0.3%
];

const MAX_LOG_RANGE_BLOCKS = 5000n;
const USDC_DECIMALS = 6;
const MIN_NOTIONAL_USD = 500_000;
const TWO_WEEKS_BLOCKS = BigInt(Math.ceil((14 * 24 * 3600) / 2)); // ~604,800 blocks @ 2s/block on Base

interface SwapResult {
	blockNumber: bigint;
	transactionHash: string;
	logIndex: number;
	poolAddress: string;
	feeTier: number;
	notionalUsd: number;
	amount0: bigint;
	amount1: bigint;
	timestamp?: number;
}

async function scanForLargeSwaps(): Promise<void> {
	const rpcUrl = process.env.TCA_RPC_URL;
	if (!rpcUrl) {
		throw new Error('TCA_RPC_URL environment variable not set');
	}

	const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
	const head = await client.getBlockNumber();
	const startBlock = head - TWO_WEEKS_BLOCKS;

	console.log(`Scanning ${startBlock} to ${head} (~${head - startBlock} blocks, ~2 weeks)`);
	console.log(`Looking for swaps with notional > $${MIN_NOTIONAL_USD.toLocaleString()}\n`);

	const results: SwapResult[] = [];
	let processedBlocks = 0n;

	for (let fromBlock = startBlock; fromBlock < head; fromBlock += MAX_LOG_RANGE_BLOCKS) {
		const toBlock = fromBlock + MAX_LOG_RANGE_BLOCKS - 1n > head ? head : fromBlock + MAX_LOG_RANGE_BLOCKS - 1n;

		try {
			const logs = await client.getLogs({
				address: POOLS.map((p) => p.address),
				event: SWAP_EVENT,
				fromBlock,
				toBlock,
			});

			processedBlocks = toBlock - startBlock;
			const progress = ((Number(processedBlocks) / Number(head - startBlock)) * 100).toFixed(1);
			console.log(`[${progress}%] Blocks ${fromBlock}-${toBlock}: ${logs.length} swaps found`);

			for (const log of logs) {
				const pool = POOLS.find((p) => p.address.toLowerCase() === log.address.toLowerCase());
				if (!pool) continue;

				const args = log.args as {
					amount0: bigint;
					amount1: bigint;
				};

				// Notional is abs(amount1) in USDC (6 decimals)
				// amount1 is the USDC amount in the canonical WETH/USDC pair
				const notionalUsd = Number(args.amount1 < 0n ? -args.amount1 : args.amount1) / Math.pow(10, USDC_DECIMALS);

				if (notionalUsd >= MIN_NOTIONAL_USD) {
					results.push({
						blockNumber: log.blockNumber,
						transactionHash: log.transactionHash,
						logIndex: log.logIndex,
						poolAddress: log.address,
						feeTier: pool.feeTier,
						notionalUsd,
						amount0: args.amount0,
						amount1: args.amount1,
					});
				}
			}
		} catch (err) {
			console.error(`Error scanning blocks ${fromBlock}-${toBlock}:`, err);
			throw err;
		}
	}

	console.log(`\n✓ Found ${results.length} qualifying swaps\n`);

	// Sort by notional descending
	results.sort((a, b) => b.notionalUsd - a.notionalUsd);

	// Print CSV header
	console.log('blockNumber,transactionHash,logIndex,poolAddress,feeTier,notionalUsd,amount0,amount1');

	// Print CSV rows
	for (const swap of results) {
		console.log(
			`${swap.blockNumber},${swap.transactionHash},${swap.logIndex},${swap.poolAddress},${swap.feeTier},${swap.notionalUsd.toFixed(2)},${swap.amount0},${swap.amount1}`,
		);
	}

	console.log(`\n✓ Total: ${results.length} swaps > $${MIN_NOTIONAL_USD.toLocaleString()}`);
	console.log(`Min notional: $${Math.min(...results.map((r) => r.notionalUsd)).toFixed(2)}`);
	console.log(`Max notional: $${Math.max(...results.map((r) => r.notionalUsd)).toFixed(2)}`);
	console.log(`Avg notional: $${(results.reduce((sum, r) => sum + r.notionalUsd, 0) / results.length).toFixed(2)}`);
}

scanForLargeSwaps().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
