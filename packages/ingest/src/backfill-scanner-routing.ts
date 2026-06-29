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
const TWO_WEEKS_BLOCKS = BigInt(Math.ceil((14 * 24 * 3600) / 2));

interface RoutingEntry {
	toAddress: string;
	count: number;
	examples: Array<{ txHash: string; notionalUsd: number }>;
}

async function scanRouting(): Promise<void> {
	const rpcUrl = process.env.TCA_RPC_URL;
	if (!rpcUrl) {
		throw new Error('TCA_RPC_URL environment variable not set');
	}

	const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
	const head = await client.getBlockNumber();
	const startBlock = head - TWO_WEEKS_BLOCKS;

	console.log(
		`\nScanning routing of P99+ swaps (>$${MIN_NOTIONAL_USD.toLocaleString()}) from ${startBlock} to ${head}\n`,
	);

	const routing = new Map<string, RoutingEntry>();

	for (let fromBlock = startBlock; fromBlock < head; fromBlock += MAX_LOG_RANGE_BLOCKS) {
		const toBlock = fromBlock + MAX_LOG_RANGE_BLOCKS - 1n > head ? head : fromBlock + MAX_LOG_RANGE_BLOCKS - 1n;

		const logs = await client.getLogs({
			address: POOLS.map((p) => p.address),
			event: SWAP_EVENT,
			fromBlock,
			toBlock,
		});

		const progress = ((Number(toBlock - startBlock) / Number(head - startBlock)) * 100).toFixed(1);
		console.log(`[${progress}%] Blocks ${fromBlock}-${toBlock}: ${logs.length} swaps`);

		for (const log of logs) {
			const args = log.args as {
				amount0: bigint;
				amount1: bigint;
			};

			const notionalUsd = Number(args.amount1 < 0n ? -args.amount1 : args.amount1) / Math.pow(10, USDC_DECIMALS);

			if (notionalUsd >= MIN_NOTIONAL_USD) {
				try {
					const tx = await client.getTransaction({ hash: log.transactionHash });
					const to = tx.to?.toLowerCase() || 'unknown';

					if (!routing.has(to)) {
						routing.set(to, { toAddress: to, count: 0, examples: [] });
					}

					const entry = routing.get(to)!;
					entry.count++;
					if (entry.examples.length < 3) {
						entry.examples.push({ txHash: log.transactionHash, notionalUsd });
					}
				} catch {
					// Skip
				}
			}
		}
	}

	// Sort by count descending
	const sorted = Array.from(routing.values()).sort((a, b) => b.count - a.count);

	console.log(`\n✓ Found ${sorted.length} unique routing destinations for P99+ swaps\n`);
	console.log(`Total P99+ swaps: ${sorted.reduce((sum, r) => sum + r.count, 0)}\n`);

	console.log('Routing breakdown (top 20):');
	console.log('---');

	for (let i = 0; i < Math.min(20, sorted.length); i++) {
		const route = sorted[i];
		console.log(`\n${i + 1}. ${route.toAddress}`);
		console.log(`   Count: ${route.count}`);
		console.log(`   Examples:`);
		for (const ex of route.examples) {
			console.log(`     - ${ex.txHash.slice(0, 18)}... ($${ex.notionalUsd.toFixed(0)})`);
		}
	}

	console.log('\n\n--- CSV format for analysis ---');
	console.log('toAddress,count');
	for (const route of sorted) {
		console.log(`${route.toAddress},${route.count}`);
	}
}

scanRouting().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
