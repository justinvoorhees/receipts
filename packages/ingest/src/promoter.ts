import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import type { Db } from '@fabric-tca/db';
import { schema } from '@fabric-tca/db';
import { processSwap } from './processSwap.js';
import type { RouterRegistry } from './routerRegistry.js';

/**
 * Continuous promotion loop. Tails `swaps_staging` for rows that
 *   (a) clear the current size threshold, and
 *   (b) haven't been promoted yet,
 * runs the full pipeline (decoder + reference price + ledger) on each, and
 * writes to `swaps`. Idempotent — `promoted_tx_hash` is set on the staging
 * row inside `processSwap`, so a restart skips already-handled rows.
 *
 * Designed to run alongside the poller as a separate process (or in the
 * same supervisor). Failures on a single tx don't abort the loop; the row
 * stays un-promoted so the next pass retries it.
 */

/**
 * Cold-start floor (spec §3): until we have enough staging data for a
 * statistically meaningful P99, treat $500k as the minimum notional.
 * Once `recompute-p99` has been run and yields a higher threshold, that
 * takes over.
 */
const COLD_START_FLOOR_USD = 500_000;

export interface PromoterArgs {
	db: Db;
	rpcUrl: string;
	pollIntervalMs: number;
	registry: RouterRegistry;
	pools: { address: `0x${string}`; feeTier: number }[];
	batchSize?: number;
	signal?: AbortSignal;
	onProgress?: (msg: string) => void;
}

export async function startPromoter(args: PromoterArgs): Promise<void> {
	const log = (m: string) => (args.onProgress ? args.onProgress(m) : console.log(m));
	const batchSize = args.batchSize ?? 20;
	const poolByAddressLower = new Map(
		args.pools.map((p) => [p.address.toLowerCase(), p] as const),
	);

	log(`promoter starting (cold-start floor $${COLD_START_FLOOR_USD.toLocaleString()})`);

	while (!args.signal?.aborted) {
		try {
			const threshold = await getCurrentThreshold(args.db);
			const pending = await args.db
				.select()
				.from(schema.swapsStaging)
				.where(
					and(
						gte(schema.swapsStaging.notionalUsdEstimate, threshold.toFixed(2)),
						isNull(schema.swapsStaging.promotedTxHash),
					),
				)
				.orderBy(desc(schema.swapsStaging.blockNumber))
				.limit(batchSize);

			for (const row of pending) {
				if (args.signal?.aborted) break;

				// Skip if we no longer recognize the router (registry change since staging).
				if (!args.registry.byAddressLower.has(row.toAddress.toLowerCase())) {
					log(`skip ${row.txHash} — router ${row.toAddress} not in current registry`);
					await args.db
						.update(schema.swapsStaging)
						.set({ promotedTxHash: 'skipped' })
						.where(eq(schema.swapsStaging.txHash, row.txHash));
					continue;
				}

				const pool = poolByAddressLower.get(row.poolAddress.toLowerCase());
				if (!pool) {
					log(`skip ${row.txHash} — pool ${row.poolAddress} not in current pool set`);
					continue;
				}

				try {
					const result = await processSwap({
						db: args.db,
						rpcUrl: args.rpcUrl,
						txHash: row.txHash as `0x${string}`,
						poolAddress: pool.address,
						poolFeeTier: pool.feeTier,
						registry: args.registry,
					});
					log(
						`promoted ${row.txHash} — ${result.direction} ` +
							`$${result.notionalUsd.toFixed(0)} ` +
							`totalCost=${result.ledger.totalCostBps.toFixed(2)}bps ` +
							`exec=${result.ledger.executionQualityBps.toFixed(2)}bps`,
					);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					log(`promote error ${row.txHash}: ${msg.slice(0, 200)}`);
					// Row stays un-promoted; the next pass retries it.
				}
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log(`promoter tick error: ${msg.slice(0, 200)}`);
		}
		await sleep(args.pollIntervalMs, args.signal);
	}
	log('promoter stopped');
}

async function getCurrentThreshold(db: Db): Promise<number> {
	const rows = await db
		.select()
		.from(schema.p99Thresholds)
		.orderBy(desc(schema.p99Thresholds.computedAt))
		.limit(1);
	const latest = rows[0];
	const p99 = latest ? Number(latest.thresholdUsd) : 0;
	return Math.max(p99, COLD_START_FLOOR_USD);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const onAbort = () => {
			clearTimeout(t);
			resolve();
		};
		const t = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}
