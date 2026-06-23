import { createPublicClient, http, parseAbiItem } from 'viem';
import { base } from 'viem/chains';
import { writeFileSync } from 'fs';

const SWAP_EVENT = parseAbiItem(
	'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
);

const POOL_005 = '0xd0b53D9277642d899DF5C87A3966A349A798F224';
const MAX_LOG_RANGE_BLOCKS = 5000n;
const USDC_DECIMALS = 6;
const MIN_NOTIONAL = 10_000;
const TWO_WEEKS_BLOCKS = BigInt(Math.ceil((14 * 24 * 3600) / 2));

interface Swap {
	blockNumber: bigint;
	transactionHash: string;
	logIndex: number;
	poolAddress: string;
	feeTier: number;
	notionalUsd: number;
	amount0: bigint;
	amount1: bigint;
}

async function scanPool005Backfill(): Promise<void> {
	const rpcUrl = process.env.TCA_RPC_URL;
	if (!rpcUrl) throw new Error('TCA_RPC_URL not set');

	const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
	const head = await client.getBlockNumber();
	const startBlock = head - TWO_WEEKS_BLOCKS;

	console.log(`Scanning USDC/WETH 0.05% pool for all swaps > $${MIN_NOTIONAL.toLocaleString()} (past 2 weeks)\n`);

	const swaps: Swap[] = [];

	for (let fromBlock = startBlock; fromBlock < head; fromBlock += MAX_LOG_RANGE_BLOCKS) {
		const toBlock = fromBlock + MAX_LOG_RANGE_BLOCKS - 1n > head ? head : fromBlock + MAX_LOG_RANGE_BLOCKS - 1n;
		const progress = ((Number(toBlock - startBlock) / Number(head - startBlock)) * 100).toFixed(1);

		const logs = await client.getLogs({
			address: [POOL_005],
			event: SWAP_EVENT,
			fromBlock,
			toBlock,
		});

		console.log(`[${progress}%] Blocks ${fromBlock}-${toBlock}: ${logs.length} swaps, qualifying: ${swaps.length}`);

		for (const log of logs) {
			const args = log.args as { amount0: bigint; amount1: bigint };
			const notionalUsd = Number(args.amount1 < 0n ? -args.amount1 : args.amount1) / Math.pow(10, USDC_DECIMALS);

			if (notionalUsd >= MIN_NOTIONAL) {
				swaps.push({
					blockNumber: log.blockNumber,
					transactionHash: log.transactionHash,
					logIndex: log.logIndex,
					poolAddress: log.address,
					feeTier: 500,
					notionalUsd,
					amount0: args.amount0,
					amount1: args.amount1,
				});
			}
		}
	}

	console.log(`\n✓ Found ${swaps.length} qualifying swaps\n`);

	// Write CSV
	const csvPath = '/tmp/backfill_005_pool.csv';
	let csv = 'blockNumber,transactionHash,logIndex,poolAddress,feeTier,notionalUsd,amount0,amount1\n';
	for (const swap of swaps) {
		csv += `${swap.blockNumber},${swap.transactionHash},${swap.logIndex},${swap.poolAddress},${swap.feeTier},${swap.notionalUsd.toFixed(2)},${swap.amount0},${swap.amount1}\n`;
	}

	writeFileSync(csvPath, csv);
	console.log(`✓ CSV written to ${csvPath}`);
	console.log(`\nReady to backfill ${swaps.length} swaps`);
}

scanPool005Backfill().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
