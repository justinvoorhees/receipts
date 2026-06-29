import { createDb } from '@fabric-tca/db';
import { schema } from '@fabric-tca/db';
import { gte } from 'drizzle-orm';

async function checkResults(): Promise<void> {
	const databaseUrl = process.env.TCA_DATABASE_URL;
	if (!databaseUrl) throw new Error('TCA_DATABASE_URL not set');

	const db = createDb(databaseUrl);
	const rows = await db
		.select({
			aggregator: schema.swaps.aggregator,
			notionalUsd: schema.swaps.notionalUsd,
		})
		.from(schema.swaps)
		.where(gte(schema.swaps.notionalUsd, '500000'));

	const byAgg = new Map<string | null, number>();
	for (const row of rows) {
		const agg = row.aggregator || 'NONE';
		byAgg.set(agg, (byAgg.get(agg) ?? 0) + 1);
	}

	console.log('=== P99+ SWAPS BY AGGREGATOR ===\n');
	const sorted = Array.from(byAgg.entries()).sort((a, b) => b[1] - a[1]);
	for (const [agg, count] of sorted) {
		const pct = ((count / rows.length) * 100).toFixed(1);
		console.log(`${agg}: ${count} (${pct}%)`);
	}
	console.log(`\nTotal: ${rows.length}`);
}

checkResults().catch((err) => {
	console.error('Error:', err);
	process.exit(1);
});
