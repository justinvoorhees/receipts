import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

async function testTraceDetection(): Promise<void> {
	const rpcUrl = process.env.TCA_RPC_URL;
	if (!rpcUrl) throw new Error('TCA_RPC_URL not set');

	const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

	// Registry of aggregators
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

	function findAggregatorInTrace(trace: unknown): string | null {
		function walk(call: any): string | null {
			if (!call) return null;
			const to = call.to?.toLowerCase();
			if (to && AGGREGATORS[to]) return AGGREGATORS[to];
			if (call.calls && Array.isArray(call.calls)) {
				for (const c of call.calls) {
					const found = walk(c);
					if (found) return found;
				}
			}
			return null;
		}
		return walk(trace);
	}

	// Sample of P99+ swaps to test
	const testSwaps = [
		'0x0303cea9da13b51b84331b07a14d1f986b639fbb25fbd1f6b1c25dcfb91fbfa4',
		'0xbc35df3911486f21f7cfa967af949a3c5c68ffe4be172e3f628f89095d322e4f',
		'0x0d969ce87d6154c858cd2590a658955c77f80e28e4a635df12fe01974b392ec9',
		'0xe099544602c85e2fad03355ad165d7589d1257e81886f8398359525d356cbaa5',
		'0xca2f51cbca5ed8d7760f029834b45f0e92fb7ed100d55a9c7e32337852dc0733',
	];

	console.log('=== TESTING TRACE-BASED AGGREGATOR DETECTION ===\n');
	console.log(`Testing ${testSwaps.length} P99+ swaps\n`);

	let found = 0;
	for (const txHash of testSwaps) {
		try {
			const tx = await client.getTransaction({ hash: txHash as `0x${string}` });

			// Get trace
			const trace = await (
				client.request as unknown as (req: { method: string; params: unknown[] }) => Promise<unknown>
			)({
				method: 'debug_traceTransaction',
				params: [txHash, { tracer: 'callTracer', withLog: false }],
			});

			const aggregator = findAggregatorInTrace(trace);

			console.log(`${txHash.slice(0, 18)}...`);
			console.log(`  Direct to: ${tx.to}`);
			console.log(`  Via trace: ${aggregator || 'NONE'}`);

			if (aggregator) {
				found++;
				console.log(`  ✓ FOUND: ${aggregator}`);
			}
			console.log();
		} catch (err) {
			console.error(`Error on ${txHash.slice(0, 18)}: ${err instanceof Error ? err.message : String(err)}\n`);
		}
	}

	console.log(`\n=== RESULTS ===`);
	console.log(`Found aggregators in: ${found}/${testSwaps.length} swaps`);
	console.log(`Success rate: ${((found / testSwaps.length) * 100).toFixed(0)}%`);

	if (found > 0) {
		console.log(
			'\n✓ Trace-based detection is working!\nSafe to proceed with full backfill using processSwap (which has trace detection built in).',
		);
	} else {
		console.log('\n✗ No aggregators found. Detection may be broken or sample size too small.');
	}
}

testTraceDetection().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
