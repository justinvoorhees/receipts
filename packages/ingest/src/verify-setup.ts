import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

async function verify(): Promise<void> {
	const rpcUrl = process.env.TCA_RPC_URL;
	if (!rpcUrl) throw new Error('TCA_RPC_URL not set');

	const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

	// Our pools
	const pools = [
		{ addr: '0xd0b53D9277642d899DF5C87A3966A349A798F224', name: 'USDC/WETH 0.05%' },
		{ addr: '0x6c561B446416E1A00E8E93E221854d6eA4171372', name: 'USDC/WETH 0.3%' },
	];

	// Aggregators we have
	const aggregators = [
		{ addr: '0x19ceead7105607cd444f5ad10dd51356436095a1', name: 'Odos' },
		{ addr: '0xdef1c0ded9bec7f1a1670819833240f027b25eff', name: '0x' },
		{ addr: '0x6131b5fae19ea4f9d964eac0408e4408b66337b5', name: 'KyberSwap' },
		{ addr: '0x1111111254eeb25477b68fb85ed929f73a960582', name: '1inch-v5' },
		{ addr: '0x111111125421ca6dc452d289314280a0f8842a65', name: '1inch-v6' },
		{ addr: '0x6a000f20005980200259b80c5102003040001068', name: 'Velora-v6' },
		{ addr: '0x59c7c832e96d2568bea6db468c1aadcbbda08a52', name: 'Velora-v5' },
		{ addr: '0x7c137a37742437d2212b7bd873ed135b5c4c61da', name: 'Fabric' },
		{ addr: '0xc87de04e2ec1f4282dff2933a2d58199f688fc3d', name: 'Nordstern' },
		{ addr: '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be', name: 'Relay' },
	];

	console.log('=== VERIFYING POOL CONTRACTS ===\n');
	for (const pool of pools) {
		try {
			const code = await client.getCode({ address: pool.addr as `0x${string}` });
			const exists = code && code !== '0x';
			console.log(`${pool.name}`);
			console.log(`  ${pool.addr}`);
			console.log(`  Status: ${exists ? '✓ EXISTS' : '✗ NOT FOUND'}\n`);
		} catch (err) {
			console.log(`${pool.name}: ERROR - ${err instanceof Error ? err.message : String(err)}\n`);
		}
	}

	console.log('\n=== VERIFYING AGGREGATOR CONTRACTS ===\n');
	let found = 0;
	let missing = 0;

	for (const agg of aggregators) {
		try {
			const code = await client.getCode({ address: agg.addr as `0x${string}` });
			const exists = code && code !== '0x';
			if (exists) {
				console.log(`✓ ${agg.name}: ${agg.addr}`);
				found++;
			} else {
				console.log(`✗ ${agg.name}: ${agg.addr} (NOT FOUND)`);
				missing++;
			}
		} catch (err) {
			console.log(`✗ ${agg.name}: ERROR`);
			missing++;
		}
	}

	console.log(`\nSummary: ${found}/${aggregators.length} aggregators found`);

	if (missing > 0) {
		console.log(`\n⚠️  WARNING: ${missing} aggregator addresses don't exist on Base!`);
		console.log('This would explain the low aggregator-routed swap counts.');
	}
}

verify().catch((err) => {
	console.error('Error:', err);
	process.exit(1);
});
