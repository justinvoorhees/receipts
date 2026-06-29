import 'dotenv/config';
import { readFileSync } from 'fs';
import { createDb } from '@fabric-tca/db';
import { processSwap } from './processSwap.js';
import { loadRouterRegistry } from './routerRegistry.js';
import { resolve } from 'path';
import { POOLS } from './poller.js';

interface SwapRecord {
	blockNumber: string;
	transactionHash: string;
	logIndex: string;
	poolAddress: string;
	feeTier: string;
	notionalUsd: string;
}

async function backfillP99(csvPath: string): Promise<void> {
	const databaseUrl = process.env.TCA_DATABASE_URL;
	const rpcUrl = process.env.TCA_RPC_URL;
	const registryPath = 'configs/routers.json';

	if (!databaseUrl || !rpcUrl) {
		throw new Error('TCA_DATABASE_URL and TCA_RPC_URL must be set');
	}

	const db = createDb(databaseUrl);
	const registry = await loadRouterRegistry(resolve(process.cwd(), registryPath));

	// Read CSV
	const csvContent = readFileSync(csvPath, 'utf-8');
	const lines = csvContent.trim().split('\n');

	// Skip header
	const records: SwapRecord[] = lines
		.slice(1)
		.map((line) => {
			const [blockNumber, transactionHash, logIndex, poolAddress, feeTier, notionalUsd] =
				line.split(',');
			return {
				blockNumber: blockNumber || '',
				transactionHash: transactionHash || '',
				logIndex: logIndex || '',
				poolAddress: poolAddress || '',
				feeTier: feeTier || '',
				notionalUsd: notionalUsd || '',
			};
		})
		.filter((r) => r.transactionHash);

	console.log(`Processing ${records.length} P99+ swaps for backfill\n`);

	let processed = 0;
	let failed = 0;

	for (const record of records) {
		try {
			const pool = POOLS.find(
				(p) => p.address.toLowerCase() === record.poolAddress.toLowerCase(),
			);
			if (!pool) {
				console.warn(`[SKIP] ${record.transactionHash} — pool ${record.poolAddress} not found`);
				failed++;
				continue;
			}

			const result = await processSwap({
				db,
				rpcUrl,
				txHash: record.transactionHash as `0x${string}`,
				poolAddress: pool.address,
				poolFeeTier: pool.feeTier,
				registry,
			});

			processed++;
			const pct = ((processed / records.length) * 100).toFixed(1);
			console.log(
				`[${pct}%] ${record.transactionHash.slice(0, 10)}... ` +
					`$${Number(record.notionalUsd).toFixed(0)} ` +
					`totalCost=${result.ledger.totalCostBps.toFixed(2)}bps`,
			);
		} catch (err) {
			failed++;
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[ERROR] ${record.transactionHash}: ${msg}`);
		}
	}

	console.log(`\n✓ Backfill complete: ${processed} processed, ${failed} failed`);
}

const csvPath = process.argv[2] || '/tmp/p99_swaps.csv';
backfillP99(csvPath).catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
