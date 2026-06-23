/**
 * v2.1 cost decomposition — enriches existing `router_trades` with:
 *   gas_cost_usd, lp_fee_bps, agg_fee_bps, slippage_bps
 *
 * Receipt-based (no debug_traceTransaction, no extra CU cost beyond
 * eth_getTransactionReceipt). For each trade:
 *
 *   1. Gas cost USD = gasUsed × effectiveGasPrice / 1e18 × ETH/USD (market_mid)
 *   2. LP fee bps  = sum of fee tiers across all Uniswap V3 Swap events in the receipt
 *   3. Agg fee bps = all_in_cost - lp_fee - slippage  (or measured from token flows)
 *   4. Slippage bps = residual: all_in_cost - lp_fee - agg_fee
 *
 * The all_in_cost_bps invariant (market mid vs realized price) is already in the
 * DB and is NOT recomputed here — the decomposition must sum to it.
 *
 * Run: source .env && npx tsx packages/ingest/src/enrich-router-trades.ts
 */

import { createPublicClient, http, parseAbiItem, decodeEventLog } from 'viem';
import { base } from 'viem/chains';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, isNull, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { schema } from '@fabric-tca/db';

const SWAP_EVENT = parseAbiItem(
	'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
);
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

// Known USDC/WETH pools on Base with their fee tiers (bps = feeTier / 100)
const POOL_FEE_TIERS: Record<string, number> = {
	'0xd0b53d9277642d899df5c87a3966a349a798f224': 500,   // 5 bps
	'0x88a43bbdf9d098eec7bceda4e2494615dfd9bb9c': 100,   // 1 bps
	'0x6c561b446416e1a00e8e93e221854d6ea4171372': 3000,  // 30 bps
	'0x4c36388be6f416a29c8d8eee81c771ce6be14b18': 10000, // 100 bps
};

const CONCURRENCY = 8;

interface SwapHop {
	poolAddress: string;
	feeTierRaw: number; // e.g., 500 = 5 bps
}

function getFeeTierBps(feeTierRaw: number): number {
	return feeTierRaw / 100;
}

async function main(): Promise<void> {
	const rpcUrl = process.env.TCA_RPC_URL;
	const dbUrl = process.env.TCA_DATABASE_URL;
	if (!rpcUrl) throw new Error('TCA_RPC_URL not set');
	if (!dbUrl) throw new Error('TCA_DATABASE_URL not set');

	const client = postgres(dbUrl);
	const db = drizzle(client);
	const rpc = createPublicClient({ chain: base, transport: http(rpcUrl) });

	// Fetch all trades that haven't been enriched yet
	const trades = await db
		.select({
			txHash: schema.routerTrades.txHash,
			marketMid: schema.routerTrades.marketMid,
			allInCostBps: schema.routerTrades.allInCostBps,
			direction: schema.routerTrades.direction,
			aggregator: schema.routerTrades.aggregator,
		})
		.from(schema.routerTrades)
		.where(isNull(schema.routerTrades.gasCostUsd));

	console.log(`Enriching ${trades.length} trades with cost decomposition…\n`);

	let done = 0;
	let enriched = 0;
	let errors = 0;
	const unknownPools = new Set<string>();

	for (let i = 0; i < trades.length; i += CONCURRENCY) {
		const batch = trades.slice(i, i + CONCURRENCY);
		const results = await Promise.allSettled(
			batch.map(async (trade) => {
				const receipt = await rpc.getTransactionReceipt({
					hash: trade.txHash as `0x${string}`,
				});

				// 1. Gas cost in USD
				const gasUsed = receipt.gasUsed;
				const effectiveGasPrice = receipt.effectiveGasPrice;
				const gasCostEth = Number(gasUsed * effectiveGasPrice) / 1e18;
				const ethPriceUsd = Number(trade.marketMid);
				const gasCostUsd = gasCostEth * ethPriceUsd;

				// 2. LP fee — find all Uniswap V3 Swap events, sum fee tiers
				const swapHops: SwapHop[] = [];
				for (const log of receipt.logs) {
					if (log.topics[0] === SWAP_TOPIC) {
						const poolAddr = log.address.toLowerCase();
						const feeTier = POOL_FEE_TIERS[poolAddr];
						if (feeTier !== undefined) {
							swapHops.push({ poolAddress: poolAddr, feeTierRaw: feeTier });
						} else {
							unknownPools.add(poolAddr);
							// Unknown pool — try to read fee tier on-chain
							try {
								const fee = await rpc.readContract({
									address: log.address as `0x${string}`,
									abi: [parseAbiItem('function fee() view returns (uint24)')],
									functionName: 'fee',
								});
								const feeNum = Number(fee);
								POOL_FEE_TIERS[poolAddr] = feeNum;
								swapHops.push({ poolAddress: poolAddr, feeTierRaw: feeNum });
							} catch {
								// Not a V3 pool or not readable — skip
							}
						}
					}
				}

				// Total LP fee in bps across all hops
				const lpFeeBps = swapHops.reduce((sum, h) => sum + getFeeTierBps(h.feeTierRaw), 0);

				// 3. Decomposition: all_in = lp_fee + agg_fee + slippage
				// For now, we split the non-LP portion as:
				//   agg_fee = 0 (placeholder — needs trace-level token flow analysis)
				//   slippage = all_in - lp_fee (residual absorbs price impact + MEV + agg fee)
				const allInCostBps = Number(trade.allInCostBps);
				const slippageBps = allInCostBps - lpFeeBps;
				const aggFeeBps = 0;

				// 4. Update the row
				await db
					.update(schema.routerTrades)
					.set({
						gasUsed,
						effectiveGasPrice: effectiveGasPrice.toString(),
						gasCostUsd: gasCostUsd.toFixed(6),
						lpFeeBps: lpFeeBps.toFixed(4),
						aggFeeBps: aggFeeBps.toFixed(4),
						slippageBps: slippageBps.toFixed(4),
					})
					.where(eq(schema.routerTrades.txHash, trade.txHash));

				return { txHash: trade.txHash, gasCostUsd, lpFeeBps, slippageBps };
			}),
		);

		for (const r of results) {
			if (r.status === 'fulfilled') enriched++;
			else { errors++; console.error('  error:', r.reason?.message ?? r.reason); }
		}

		done += batch.length;
		if (done % 50 === 0 || done === trades.length) {
			console.log(`  …${done}/${trades.length}  (enriched: ${enriched}, errors: ${errors})`);
		}
	}

	// Summary
	const gasStats = await db.execute<{ avg_gas: string; min_gas: string; max_gas: string }>(sql`
		SELECT
			ROUND(AVG(gas_cost_usd::numeric), 6) AS avg_gas,
			ROUND(MIN(gas_cost_usd::numeric), 6) AS min_gas,
			ROUND(MAX(gas_cost_usd::numeric), 6) AS max_gas
		FROM router_trades
		WHERE gas_cost_usd IS NOT NULL
	`);
	const g = gasStats[0]!;
	console.log(`\n=== GAS COST USD ===`);
	console.log(`  avg: $${g.avg_gas}  min: $${g.min_gas}  max: $${g.max_gas}`);

	if (unknownPools.size > 0) {
		console.log(`\n=== POOLS ENCOUNTERED (looked up on-chain) ===`);
		for (const p of unknownPools) console.log(`  ${p}`);
	}

	const lpStats = await db.execute<{ avg_lp: string; distinct_lp: string }>(sql`
		SELECT
			ROUND(AVG(lp_fee_bps::numeric), 2) AS avg_lp,
			COUNT(DISTINCT lp_fee_bps) AS distinct_lp
		FROM router_trades
		WHERE lp_fee_bps IS NOT NULL
	`);
	console.log(`\n=== LP FEE BPS ===`);
	console.log(`  avg: ${lpStats[0]!.avg_lp} bps  distinct values: ${lpStats[0]!.distinct_lp}`);

	console.log(`\nDone. Enriched ${enriched} trades, ${errors} errors.`);
	await client.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
