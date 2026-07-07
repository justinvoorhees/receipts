/**
 * Seed `receipts` with the user's "past receipts" — the 25 curated smoke_trades
 * rows (all USDC/WETH on Base), reshaped into the generalized receipt columns.
 *
 * Curated-25 selection mirrors packages/dashboard/lib/queries.ts:getCuratedTrades —
 * all rows where batch IN ('smoke-01','smoke-02','smoke-03') PLUS the first 2 per
 * aggregator from batch='smoke-04' ordered by loadedAt asc.
 *
 * Idempotency note: receipts' unique index is on (userId, txHash, chainId). These
 * seed rows have userId = NULL, and Postgres treats NULL as distinct from NULL, so
 * onConflictDoNothing would NOT prevent duplicate rows on a re-run. Instead, main()
 * deletes existing seed rows (userId IS NULL) before inserting, so re-running this
 * script always leaves exactly 25 rows rather than accumulating duplicates.
 *
 * Run: npx tsx packages/db/scripts/seed-receipts.ts
 */
import 'dotenv/config';
import { asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { createDb, schema, type SmokeTradeRow } from '@fabric-tca/db';

const CHAIN_ID_BASE = 8453;
const USDC_ADDRESS_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH_ADDRESS_BASE = '0x4200000000000000000000000000000000000006';

export type NewReceipt = typeof schema.receipts.$inferInsert;

/**
 * Pure mapper: USDC/WETH smoke_trades row -> generalized receipts insert row.
 * `direction` determines which leg is input vs output; everything else
 * (decomposition + benchmark columns) carries straight across.
 */
export function mapSmokeToReceipt(row: SmokeTradeRow): NewReceipt {
	const isBuyWeth = row.direction === 'buy_weth';

	const inputToken = isBuyWeth ? USDC_ADDRESS_BASE : WETH_ADDRESS_BASE;
	const outputToken = isBuyWeth ? WETH_ADDRESS_BASE : USDC_ADDRESS_BASE;
	const inputSymbol = isBuyWeth ? 'USDC' : 'WETH';
	const outputSymbol = isBuyWeth ? 'WETH' : 'USDC';
	const inputAmount = isBuyWeth ? row.usdcAmount : row.wethAmount;
	const outputAmount = isBuyWeth ? row.wethAmount : row.usdcAmount;

	return {
		txHash: row.txHash,
		chainId: CHAIN_ID_BASE,
		userId: null,
		createdAt: row.loadedAt,
		aggregator: row.aggregator,
		trader: row.trader,
		direction: row.direction,
		inputToken,
		outputToken,
		inputSymbol,
		outputSymbol,
		inputAmount,
		outputAmount,
		notionalUsd: row.usdcAmount,
		realizedPrice: row.realizedPrice,
		marketMid: row.marketMid,
		allInCostBps: row.allInCostBps,
		pricingStatus: 'full',
		blockNumber: row.blockNumber,
		executionBps: row.executionBps,
		lpFeeBps: row.lpFeeBps,
		aggFeeBps: row.aggFeeBps,
		slippageBps: row.slippageBps,
		gasCostUsd: row.gasCostUsd,
		routePure: row.routePure,
		routeShape: row.routeShape,
		hopCount: row.hopCount,
		routeLegs: row.routeLegs,
		reconResidualBps: row.reconResidualBps,
		decompConfidence: row.decompConfidence,
		settlementEventName: row.settlementEventName,
		settlementEventTopic0: row.settlementEventTopic0,
		settlementEventSeen: row.settlementEventSeen,
		normalizeFlags: row.normalizeFlags,
		chainlinkPrice: row.chainlinkPrice,
		chainlinkDevBps: row.chainlinkDevBps,
		poolDivergenceBps: row.poolDivergenceBps,
		manipulationFlag: row.manipulationFlag,
		offchainPrice: row.offchainPrice,
		offchainDevBps: row.offchainDevBps,
		chainlinkStalenessSecs: row.chainlinkStalenessSecs,
	};
}

/** Mirrors dashboard/lib/queries.ts:getCuratedTrades. */
async function getCuratedSmokeTrades(db: ReturnType<typeof createDb>): Promise<SmokeTradeRow[]> {
	const base = await db
		.select()
		.from(schema.smokeTrades)
		.where(inArray(schema.smokeTrades.batch, ['smoke-01', 'smoke-02', 'smoke-03']))
		.orderBy(desc(schema.smokeTrades.blockNumber));

	const smoke04 = await db
		.select()
		.from(schema.smokeTrades)
		.where(eq(schema.smokeTrades.batch, 'smoke-04'))
		.orderBy(asc(schema.smokeTrades.loadedAt));

	const seen = new Map<string, number>();
	const top2: SmokeTradeRow[] = [];
	for (const row of smoke04) {
		const n = seen.get(row.aggregator) ?? 0;
		if (n < 2) {
			top2.push(row);
			seen.set(row.aggregator, n + 1);
		}
	}

	return [...base, ...top2];
}

async function main(): Promise<void> {
	const dbUrl = process.env.TCA_DATABASE_URL;
	if (!dbUrl) throw new Error('TCA_DATABASE_URL is not set');

	const db = createDb(dbUrl);

	const curated = await getCuratedSmokeTrades(db);
	console.log(`Found ${curated.length} curated smoke_trades rows to seed as receipts.`);

	const rows = curated.map(mapSmokeToReceipt);

	// Idempotency: userId is NULL for all seed rows, and the unique index is on
	// (userId, txHash, chainId) — Postgres treats NULL as distinct from NULL, so
	// onConflictDoNothing would NOT dedupe across runs. Delete prior seed rows first.
	const deleted = await db.delete(schema.receipts).where(isNull(schema.receipts.userId)).returning({ id: schema.receipts.id });
	console.log(`Deleted ${deleted.length} pre-existing seed receipts (userId IS NULL).`);

	if (rows.length > 0) {
		await db.insert(schema.receipts).values(rows);
	}
	console.log(`Inserted ${rows.length} receipts.`);

	const [{ count }] = await db.execute<{ count: string }>(sql`select count(*)::text as count from receipts`);
	console.log(`Total rows now in receipts: ${count}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(err);
			process.exit(1);
		});
}
