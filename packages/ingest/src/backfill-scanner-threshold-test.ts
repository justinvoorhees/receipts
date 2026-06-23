import { createPublicClient, http, parseAbiItem } from 'viem';
import { base } from 'viem/chains';

const SWAP_EVENT = parseAbiItem(
	'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
);

const POOLS = [
	{ address: '0xd0b53D9277642d899DF5C87A3966A349A798F224' as const, feeTier: 500 }, // 0.05%
	{ address: '0x6c561B446416E1A00E8E93E221854d6eA4171372' as const, feeTier: 3000 }, // 0.3%
];

// Registered aggregators from routers.json
const AGGREGATORS: Record<string, string> = {
	'0x19ceead7105607cd444f5ad10dd51356436095a1': 'Odos',
	'0xdef1c0ded9bec7f1a1670819833240f027b25eff': '0x',
	'0x6131b5fae19ea4f9d964eac0408e4408b66337b5': 'KyberSwap',
	'0x1111111254eeb25477b68fb85ed929f73a960582': '1inch-v5',
	'0x111111125421ca6dc452d289314280a0f8842a65': '1inch-v6',
	'0x6a000f20005980200259b80c5102003040001068': 'Velora-v6',
	'0x59c7c832e96d2568bea6db468c1aadcbbda08a52': 'Velora-v5',
	'0x7c137a37742437d2212b7bd873ed135b5c4c61da': 'Fabric',
	'0xc87de04e2ec1f4282dff2933a2d58199f688fc3d': 'Nordstern',
	'0xccc88a9d1b4ed6b0eaba998850414b24f1c315be': 'Relay',
};

const MAX_LOG_RANGE_BLOCKS = 5000n;
const USDC_DECIMALS = 6;
const TWO_WEEKS_BLOCKS = BigInt(Math.ceil((14 * 24 * 3600) / 2)); // ~604,800 blocks @ 2s/block on Base

async function scanAtThreshold(threshold: number): Promise<number> {
	const rpcUrl = process.env.TCA_RPC_URL;
	if (!rpcUrl) {
		throw new Error('TCA_RPC_URL environment variable not set');
	}

	const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
	const head = await client.getBlockNumber();
	const startBlock = head - TWO_WEEKS_BLOCKS;

	let count = 0;

	for (let fromBlock = startBlock; fromBlock < head; fromBlock += MAX_LOG_RANGE_BLOCKS) {
		const toBlock = fromBlock + MAX_LOG_RANGE_BLOCKS - 1n > head ? head : fromBlock + MAX_LOG_RANGE_BLOCKS - 1n;

		const logs = await client.getLogs({
			address: POOLS.map((p) => p.address),
			event: SWAP_EVENT,
			fromBlock,
			toBlock,
		});

		for (const log of logs) {
			const args = log.args as {
				amount0: bigint;
				amount1: bigint;
			};

			const notionalUsd = Number(args.amount1 < 0n ? -args.amount1 : args.amount1) / Math.pow(10, USDC_DECIMALS);

			if (notionalUsd >= threshold) {
				try {
					const tx = await client.getTransaction({ hash: log.transactionHash });
					const toAddressLower = tx.to?.toLowerCase();
					if (toAddressLower && AGGREGATORS[toAddressLower]) {
						count++;
					}
				} catch {
					// Skip
				}
			}
		}
	}

	return count;
}

async function runThresholdTest(): Promise<void> {
	const thresholds = [25_000, 10_000, 5_000, 2_000, 1_000];

	console.log('Testing aggregator-routed swap counts at different thresholds (past 2 weeks):\n');

	for (const threshold of thresholds) {
		try {
			console.log(`Testing $${threshold.toLocaleString()}...`);
			const count = await scanAtThreshold(threshold);
			console.log(`$${threshold.toLocaleString()}: ${count} swaps\n`);
		} catch (err) {
			console.error(`Error at threshold $${threshold}:`, err instanceof Error ? err.message : String(err));
		}
	}
}

runThresholdTest().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
