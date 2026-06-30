/**
 * redecompose-smoke.ts — Re-run decomposition on every smoke_trades row using
 * the latest normalizeSmokeTrade (smoke profile: lowered floors, PancakeSwap V3,
 * venue-third-token impurity). Updates decomposition columns in place.
 *
 * Run: set -a && source .env && set +a && npx tsx packages/ingest/src/redecompose-smoke.ts
 */
import postgres from 'postgres';
import { normalizeSmokeTrade, type SmokeCandidate } from './normalizeSmokeTrade.js';

async function main(): Promise<void> {
	const rpcUrl = process.env.TCA_RPC_URL;
	const dbUrl = process.env.TCA_DATABASE_URL;
	if (!rpcUrl) throw new Error('TCA_RPC_URL not set');
	if (!dbUrl) throw new Error('TCA_DATABASE_URL not set');

	const sql = postgres(dbUrl);

	// Read all smoke_trades rows
	const rows = await sql`
		SELECT tx_hash, aggregator, trader, batch,
		       experiment_slug, run_id, v1_status,
		       v1_quote_amount_usd, v1_realized_amount_usd,
		       lp_fee_bps, agg_fee_bps, slippage_bps, execution_bps,
		       route_pure
		FROM smoke_trades
		ORDER BY batch, aggregator
	`;
	console.log(`smoke_trades: ${rows.length} rows to re-decompose\n`);

	for (const row of rows) {
		const txHash = row.tx_hash as string;
		const aggregator = row.aggregator as string;
		const batch = row.batch as string;

		// Capture BEFORE values
		const beforeLp = row.lp_fee_bps != null ? Number(row.lp_fee_bps).toFixed(2) : 'null';
		const beforeAgg = Number(row.agg_fee_bps).toFixed(2);
		const beforeSlip = row.slippage_bps != null ? Number(row.slippage_bps).toFixed(1) : 'null';
		const beforePure = row.route_pure;

		// Rebuild SmokeCandidate from stored columns
		const candidate: SmokeCandidate = {
			txHash: txHash as `0x${string}`,
			aggregator,
			trader: (row.trader as string) as `0x${string}`,
			experimentSlug: row.experiment_slug as string,
			runId: row.run_id as string,
			v1Status: row.v1_status as string,
			v1QuoteAmountUsd: row.v1_quote_amount_usd != null ? Number(row.v1_quote_amount_usd) : null,
			v1RealizedAmountUsd: row.v1_realized_amount_usd != null ? Number(row.v1_realized_amount_usd) : null,
		};

		const result = await normalizeSmokeTrade({ candidate, rpcUrl });
		if (!result.ok) {
			console.error(`  ERROR ${txHash.slice(0, 10)} (${aggregator}): ${result.reason}`);
			continue;
		}

		const r = result.row;

		// UPDATE decomposition + oracle columns in place — preserve batch, tx_hash, provenance
		await sql`
			UPDATE smoke_trades SET
				lp_fee_bps = ${r.lpFeeBps == null ? null : String(r.lpFeeBps)},
				agg_fee_bps = ${String(r.aggFeeBps)},
				slippage_bps = ${r.slippageBps == null ? null : String(r.slippageBps)},
				execution_bps = ${r.executionBps == null ? null : String(r.executionBps)},
				route_pure = ${r.routePure},
				route_shape = ${r.routeShape},
				hop_count = ${r.hopCount},
				route_legs = ${r.routeLegs != null ? sql.json(r.routeLegs as any) : null},
				recon_residual_bps = ${r.reconResidualBps == null ? null : String(r.reconResidualBps)},
				decomp_confidence = ${r.decompConfidence},
				settlement_event_seen = ${r.settlementEventSeen},
				normalize_flags = ${sql.json(r.normalizeFlags)},
				market_mid = ${String(r.marketMid)},
				all_in_cost_bps = ${String(r.allInCostBps)},
				realized_price = ${String(r.realizedPrice)},
				gas_cost_usd = ${String(r.gasCostUsd)},
				offchain_price = ${r.offchainPrice == null ? null : String(r.offchainPrice)},
				offchain_dev_bps = ${r.offchainDevBps == null ? null : String(r.offchainDevBps)},
				chainlink_staleness_secs = ${r.chainlinkStalenessSecs == null ? null : String(r.chainlinkStalenessSecs)}
			WHERE tx_hash = ${txHash}
		`;

		// AFTER values
		const afterLp = r.lpFeeBps != null ? r.lpFeeBps.toFixed(2) : 'null';
		const afterAgg = r.aggFeeBps.toFixed(2);
		const afterSlip = r.slippageBps != null ? r.slippageBps.toFixed(1) : 'null';
		const afterPure = r.routePure;

		console.log(
			`  ${batch} ${aggregator.padEnd(11)} ${txHash.slice(0, 10)}  ` +
			`lp: ${beforeLp} -> ${afterLp}  agg: ${beforeAgg} -> ${afterAgg}  ` +
			`slip: ${beforeSlip} -> ${afterSlip}  pure: ${beforePure} -> ${afterPure}`,
		);
	}

	console.log('\nDone.');
	await sql.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
