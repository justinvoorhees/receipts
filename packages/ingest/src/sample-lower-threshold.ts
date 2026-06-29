import { createPublicClient, http, parseAbiItem } from 'viem';
import { base } from 'viem/chains';

const SWAP_EVENT = parseAbiItem(
	'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
);

const POOLS = [
	{ address: '0xd0b53D9277642d899DF5C87A3966A349A798F224' as const, feeTier: 500 },
	{ address: '0x6c561B446416E1A00E8E93E221854d6eA4171372' as const, feeTier: 3000 },
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

interface SwapSample {
	txHash: string;
	notionalUsd: number;
	directTo: string;
	aggregatorViaTrace: string | null;
}

async function sampleLowerThreshold(): Promise<void> {
	const rpcUrl = process.env.TCA_RPC_URL;
	if (!rpcUrl) throw new Error('TCA_RPC_URL not set');

	const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
	const head = await client.getBlockNumber();
	const startBlock = head - TWO_WEEKS_BLOCKS;

	console.log(`Sampling $${MIN_NOTIONAL.toLocaleString()}-$${MAX_NOTIONAL.toLocaleString()} swaps from past 2 weeks\n`);

	const samples: SwapSample[] = [];

	for (let fromBlock = startBlock; fromBlock < head && samples.length < 100; fromBlock += MAX_LOG_RANGE_BLOCKS) {
		const toBlock = fromBlock + MAX_LOG_RANGE_BLOCKS - 1n > head ? head : fromBlock + MAX_LOG_RANGE_BLOCKS - 1n;
		const progress = ((Number(toBlock - startBlock) / Number(head - startBlock)) * 100).toFixed(1);
		console.log(`[${progress}%] Scanning blocks ${fromBlock}-${toBlock}...`);

		const logs = await client.getLogs({
			address: POOLS.map((p) => p.address),
			event: SWAP_EVENT,
			fromBlock,
			toBlock,
		});

		for (const log of logs) {
			if (samples.length >= 100) break;

			const args = log.args as { amount1: bigint };
			const notionalUsd = Number(args.amount1 < 0n ? -args.amount1 : args.amount1) / Math.pow(10, USDC_DECIMALS);

			if (notionalUsd < MIN_NOTIONAL || notionalUsd > MAX_NOTIONAL) continue;

			try {
				const tx = await client.getTransaction({ hash: log.transactionHash });

				// Get trace
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
					if (call.calls && Array.isArray(call.calls)) {
						for (const c of call.calls) {
							const found = findAgg(c);
							if (found) return found;
						}
					}
					return null;
				}

				const agg = findAgg(trace);

				samples.push({
					txHash: log.transactionHash,
					notionalUsd,
					directTo: tx.to || 'unknown',
					aggregatorViaTrace: agg,
				});
			} catch {
				// Skip on error
			}
		}
	}

	console.log(`\n✓ Found ${samples.length} samples\n`);

	// Analyze
	let aggCount = 0;
	const byAgg = new Map<string, number>();

	for (const s of samples) {
		if (s.aggregatorViaTrace) {
			aggCount++;
			byAgg.set(s.aggregatorViaTrace, (byAgg.get(s.aggregatorViaTrace) ?? 0) + 1);
		}
	}

	console.log('=== AGGREGATOR BREAKDOWN ===\n');
	for (const [agg, count] of Array.from(byAgg.entries()).sort((a, b) => b[1] - a[1])) {
		const pct = ((count / samples.length) * 100).toFixed(1);
		console.log(`${agg}: ${count} (${pct}%)`);
	}

	const nonAggPct = (((samples.length - aggCount) / samples.length) * 100).toFixed(1);
	console.log(`NONE: ${samples.length - aggCount} (${nonAggPct}%)`);

	console.log(`\n=== SUMMARY ===`);
	console.log(`Total samples: ${samples.length}`);
	console.log(`With aggregator: ${aggCount} (${((aggCount / samples.length) * 100).toFixed(1)}%)`);
	console.log(`Without aggregator: ${samples.length - aggCount} (${nonAggPct}%)`);
}

sampleLowerThreshold().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
