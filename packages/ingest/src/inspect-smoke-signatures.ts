/**
 * Checkpoint diagnostic (not part of the pipeline): for each row in
 * smoke_trades, print the normalized cost fields and list the distinctive
 * events its aggregator's settlement contract emitted (signature discovery).
 * READ-ONLY. Run: set -a && source .env && set +a && npx tsx packages/ingest/src/inspect-smoke-signatures.ts
 */
import postgres from 'postgres';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { AGGREGATOR_SIGNATURES, findSettlementEvents } from './aggregatorSignatures.js';

async function main(): Promise<void> {
	const dbUrl = process.env.TCA_DATABASE_URL!;
	const rpcUrl = process.env.TCA_RPC_URL!;
	const sql = postgres(dbUrl);
	const rpc = createPublicClient({ chain: base, transport: http(rpcUrl) });

	const rows = await sql`
		SELECT tx_hash, aggregator, direction, settled_in, usdc_amount, weth_amount,
		       all_in_cost_bps, lp_fee_bps, agg_fee_bps, slippage_bps, execution_bps,
		       gas_cost_usd, route_pure, settlement_event_seen, normalize_flags
		FROM smoke_trades ORDER BY aggregator`;

	for (const r of rows) {
		const sig = AGGREGATOR_SIGNATURES[r.aggregator];
		console.log(`\n=== ${r.aggregator}  ${r.tx_hash} ===`);
		console.log(`  dir=${r.direction} settledIn=${r.settled_in} usdc=${Number(r.usdc_amount).toFixed(4)} weth=${Number(r.weth_amount).toFixed(8)}`);
		console.log(`  Accuracy(-allIn)=${(-Number(r.all_in_cost_bps)).toFixed(1)}bps  LP=${fmt(r.lp_fee_bps)} Agg=${fmt(r.agg_fee_bps)} Slip=${fmt(r.slippage_bps)} Exec=${fmt(r.execution_bps)} gas=$${Number(r.gas_cost_usd).toFixed(4)} pure=${r.route_pure}`);
		if (Array.isArray(r.normalize_flags) && r.normalize_flags.length) console.log(`  flags: ${r.normalize_flags.join(' | ')}`);
		if (!sig) { console.log('  NO signature entry'); continue; }
		const receipt = await rpc.getTransactionReceipt({ hash: r.tx_hash as `0x${string}` });
		const events = findSettlementEvents(
			receipt.logs.map((l) => ({ address: l.address, topics: l.topics as readonly string[] })),
			sig.settlementContract,
		);
		console.log(`  settlementContract=${sig.settlementContract} eventSeen=${r.settlement_event_seen}`);
		console.log(`  distinctive events emitted by that contract:`);
		if (events.length === 0) console.log('    (none — settlement event may be emitted by a different contract)');
		for (const e of events) console.log(`    topic0=${e.topic0}  count=${e.count}`);
	}
	await sql.end();
}
function fmt(v: unknown): string { return v == null ? 'null' : `${Number(v).toFixed(1)}`; }
main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
