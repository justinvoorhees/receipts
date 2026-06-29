import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

async function checkSwap(): Promise<void> {
	const rpcUrl = process.env.TCA_RPC_URL;
	if (!rpcUrl) throw new Error('TCA_RPC_URL not set');

	const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

	// Sample P99+ swaps from our routing analysis
	const swaps = [
		'0x0303cea9da13b51b84331b07a14d1f986b639fbb25fbd1f6b1c25dcfb91fbfa4', // 0x83d55acd (62 swaps)
		'0xbc35df3911486f21f7cfa967af949a3c5c68ffe4be172e3f628f89095d322e4f', // 0x3725bd4d (16 swaps)
		'0x0d969ce87d6154c858cd2590a658955c77f80e28e4a635df12fe01974b392ec9', // 0x9008d19f (1 swap)
	];

	const aggregators: Record<string, string> = {
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

	console.log('=== CHECKING P99+ SWAP DESTINATIONS ===\n');

	for (const txHash of swaps) {
		try {
			const tx = await client.getTransaction({ hash: txHash as `0x${string}` });
			const toAddr = tx.to?.toLowerCase();
			const isAgg = toAddr && aggregators[toAddr];

			console.log(`Tx: ${txHash.slice(0, 16)}...`);
			console.log(`  to: ${toAddr}`);
			console.log(`  Aggregator: ${isAgg ? `YES - ${aggregators[toAddr!]}` : 'NO'}`);

			// Also check the trace to see if aggregators are called
			const trace = await (
				client.request as unknown as (req: { method: string; params: unknown[] }) => Promise<unknown>
			)({
				method: 'debug_traceTransaction',
				params: [txHash, { tracer: 'callTracer', withLog: false }],
			});

			function findAggCalls(call: any): string[] {
				const found: string[] = [];
				if (call?.to?.toLowerCase() && aggregators[call.to.toLowerCase()]) {
					found.push(aggregators[call.to.toLowerCase()]);
				}
				if (call?.calls) {
					for (const subcall of call.calls) {
						found.push(...findAggCalls(subcall));
					}
				}
				return found;
			}

			const aggCalls = findAggCalls(trace);
			if (aggCalls.length > 0) {
				console.log(`  In trace: ${aggCalls.join(', ')}`);
			}

			console.log();
		} catch (err) {
			console.error(`Error checking ${txHash.slice(0, 16)}:`, err instanceof Error ? err.message : String(err));
			console.log();
		}
	}
}

checkSwap().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
