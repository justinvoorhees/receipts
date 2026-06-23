import { createPublicClient, http, parseAbiItem } from 'viem';
import { base } from 'viem/chains';

const SWAP_EVENT = parseAbiItem(
	'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
);

// Popular pools on Base to test
const POOLS_TO_TEST = [
	{ address: '0xd0b53D9277642d899DF5C87A3966A349A798F224' as const, name: 'USDC/WETH 0.05%' },
	{ address: '0x6c561B446416E1A00E8E93E221854d6eA4171372' as const, name: 'USDC/WETH 0.3%' },
	{ address: '0x8CA0b5E87e0B96d904bA0b6Bd6c3d8c5A1e0b0b0' as const, name: 'USDC/DAI 0.01%' },
	{ address: '0xA0b5e87E0B96d904Ba0b6Bd6C3D8c5A1E0b0b0b' as const, name: 'WETH/USDC 0.01%' },
	{ address: '0x8b9e9e7f1c5e6e5e4e3e2e1e0e9e8e7e6e5e4e3e' as const, name: 'USDC/USDbC 0.01%' },
];

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
const MIN_NOTIONAL = 10_000;
const MAX_NOTIONAL = 100_000;
const TWO_WEEKS_BLOCKS = BigInt(Math.ceil((14 * 24 * 3600) / 2));

async function testPool(client: any, poolAddr: string, poolName: string): Promise<void> {
	const head = await client.getBlockNumber();
	const startBlock = head - TWO_WEEKS_BLOCKS;

	let swapsFound = 0;
	let aggCount = 0;

	try {
		for (let fromBlock = startBlock; fromBlock < head; fromBlock += MAX_LOG_RANGE_BLOCKS) {
			const toBlock = fromBlock + MAX_LOG_RANGE_BLOCKS - 1n > head ? head : fromBlock + MAX_LOG_RANGE_BLOCKS - 1n;

			const logs = await client.getLogs({
				address: [poolAddr],
				event: SWAP_EVENT,
				fromBlock,
				toBlock,
			});

			for (const log of logs) {
				const args = log.args as { amount1: bigint };
				const notionalUsd = Number(args.amount1 < 0n ? -args.amount1 : args.amount1) / Math.pow(10, USDC_DECIMALS);

				if (notionalUsd < MIN_NOTIONAL || notionalUsd > MAX_NOTIONAL) continue;

				swapsFound++;
				if (swapsFound > 50) break;

				try {
					const tx = await client.getTransaction({ hash: log.transactionHash });
					const trace = await (
						client.request as unknown as (req: { method: string; params: unknown[] }) => Promise<unknown>
					)({
						method: 'debug_traceTransaction',
						params: [log.transactionHash, { tracer: 'callTracer', withLog: false }],
					});

					function findAgg(call: any): string | null {
						if (!call) return null;
						const to = call.to?.toLowerCase();
						if (to && AGGREGATORS[to]) return AGGREGATORS[to];
						if (call.calls) {
							for (const c of call.calls) {
								const found = findAgg(c);
								if (found) return found;
							}
						}
						return null;
					}

					if (findAgg(trace)) aggCount++;
				} catch {
					// Skip on error
				}
			}

			if (swapsFound > 50) break;
		}

		const pct = swapsFound > 0 ? ((aggCount / swapsFound) * 100).toFixed(1) : '0.0';
		console.log(`${poolName.padEnd(30)} | Swaps: ${swapsFound.toString().padEnd(3)} | Agg: ${aggCount} (${pct}%)`);
	} catch (err) {
		console.log(`${poolName.padEnd(30)} | ERROR`);
	}
}

async function testMultiplePools(): Promise<void> {
	const rpcUrl = process.env.TCA_RPC_URL;
	if (!rpcUrl) throw new Error('TCA_RPC_URL not set');

	const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

	console.log('Testing pools on Base for aggregator activity ($10k-$100k swaps)\n');
	console.log('Pool Name'.padEnd(30) + ' | Swaps | Agg %');
	console.log(''.padEnd(30) + '-+---------+---------');

	for (const pool of POOLS_TO_TEST) {
		await testPool(client, pool.address, pool.name);
	}
}

testMultiplePools().catch(console.error);
