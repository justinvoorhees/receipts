import { createDb } from '@fabric-tca/db';
import { schema } from '@fabric-tca/db';
import { eq } from 'drizzle-orm';

async function debug(): Promise<void> {
	const db = createDb(process.env.TCA_DATABASE_URL!);

	// The transaction we know has 1inch-v6 in trace
	const txHash = '0x0d969ce87d6154c858cd2590a658955c77f80e28e4a635df12fe01974b392ec9';

	const row = await db.select().from(schema.swaps).where(eq(schema.swaps.txHash, txHash)).limit(1);

	if (row.length === 0) {
		console.log('Transaction not found in database');
		return;
	}

	const swap = row[0];
	console.log('=== DEBUG: 0x0d969ce8... ===\n');
	console.log(`TX Hash: ${swap.txHash}`);
	console.log(`Aggregator: ${swap.aggregator}`);
	console.log(`Total Cost: ${swap.totalCostBps} bps`);
	console.log(`Processing Status: ${swap.processingStatus}`);
	console.log(`Block: ${swap.blockNumber}`);
}

debug().catch(console.error);
