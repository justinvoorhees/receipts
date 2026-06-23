/**
 * LOAD — normalize candidates and upsert into smoke_trades.
 *
 * PER_AGG_LIMIT caps how many candidates per aggregator we attempt (the 1→10→100
 * checkpoints). ONLY_SUCCESS=1 (default) restricts to v1 status='success'.
 * Idempotent on tx_hash. Writes ONLY to smoke_trades.
 *
 * Run: set -a && source .env && set +a && PER_AGG_LIMIT=1 npx tsx packages/ingest/src/load-smoke-trades.ts
 */
import { readFileSync } from 'fs';
import postgres from 'postgres';
import { schema } from '@fabric-tca/db';
import { drizzle } from 'drizzle-orm/postgres-js';
import { normalizeSmokeTrade, type SmokeCandidate } from './normalizeSmokeTrade.js';

const IN_PATH = process.env.IN_PATH ?? '/tmp/smoke_candidates.json';
const PER_AGG_LIMIT = Number(process.env.PER_AGG_LIMIT ?? '1');
const ONLY_SUCCESS = process.env.ONLY_SUCCESS !== '0';

async function main(): Promise<void> {
	const rpcUrl = process.env.TCA_RPC_URL;
	const dbUrl = process.env.TCA_DATABASE_URL;
	if (!rpcUrl) throw new Error('TCA_RPC_URL not set');
	if (!dbUrl) throw new Error('TCA_DATABASE_URL not set');

	const all = JSON.parse(readFileSync(IN_PATH, 'utf8')) as SmokeCandidate[];
	const eligible = all.filter((c) => c.trader && (!ONLY_SUCCESS || c.v1Status === 'success'));

	// Take up to PER_AGG_LIMIT per aggregator.
	const perAgg = new Map<string, SmokeCandidate[]>();
	for (const c of eligible) {
		const list = perAgg.get(c.aggregator) ?? [];
		if (list.length < PER_AGG_LIMIT) { list.push(c); perAgg.set(c.aggregator, list); }
	}
	const chosen = [...perAgg.values()].flat();
	console.log(`Attempting ${chosen.length} candidates (≤${PER_AGG_LIMIT}/agg, only_success=${ONLY_SUCCESS}).`);

	const client = postgres(dbUrl, { prepare: false });
	const db = drizzle(client, { schema });

	const report: Record<string, { ok: number; fail: number; reasons: string[] }> = {};
	for (const c of chosen) {
		const r = await normalizeSmokeTrade({ candidate: c, rpcUrl });
		report[c.aggregator] ??= { ok: 0, fail: 0, reasons: [] };
		if (!r.ok) { report[c.aggregator]!.fail++; report[c.aggregator]!.reasons.push(`${c.txHash.slice(0, 10)}: ${r.reason}`); continue; }
		const row = r.row;
		await db.insert(schema.smokeTrades).values({
			txHash: row.txHash, aggregator: row.aggregator, trader: row.trader,
			direction: row.direction, settledIn: row.settledIn,
			usdcAmount: String(row.usdcAmount), wethAmount: String(row.wethAmount),
			realizedPrice: String(row.realizedPrice), marketMid: String(row.marketMid),
			allInCostBps: String(row.allInCostBps), blockNumber: row.blockNumber,
			lpFeeBps: row.lpFeeBps == null ? null : String(row.lpFeeBps),
			aggFeeBps: String(row.aggFeeBps),
			slippageBps: row.slippageBps == null ? null : String(row.slippageBps),
			executionBps: row.executionBps == null ? null : String(row.executionBps),
			gasCostUsd: String(row.gasCostUsd), routePure: row.routePure,
			experimentSlug: row.experimentSlug, runId: row.runId, v1Status: row.v1Status,
			v1QuoteAmountUsd: row.v1QuoteAmountUsd == null ? null : String(row.v1QuoteAmountUsd),
			v1RealizedAmountUsd: row.v1RealizedAmountUsd == null ? null : String(row.v1RealizedAmountUsd),
			settlementEventName: row.settlementEventName, settlementEventTopic0: row.settlementEventTopic0,
			settlementEventSeen: row.settlementEventSeen, normalizeFlags: row.normalizeFlags,
		}).onConflictDoUpdate({
			target: schema.smokeTrades.txHash,
			set: {
				allInCostBps: String(row.allInCostBps), lpFeeBps: row.lpFeeBps == null ? null : String(row.lpFeeBps),
				aggFeeBps: String(row.aggFeeBps), slippageBps: row.slippageBps == null ? null : String(row.slippageBps),
				executionBps: row.executionBps == null ? null : String(row.executionBps), gasCostUsd: String(row.gasCostUsd),
				settlementEventSeen: row.settlementEventSeen, normalizeFlags: row.normalizeFlags,
			},
		});
		report[c.aggregator]!.ok++;
	}

	console.log('\n=== LOAD REPORT (per aggregator) ===');
	for (const [agg, s] of Object.entries(report).sort()) {
		console.log(`${agg}: ok=${s.ok} fail=${s.fail}${s.reasons.length ? ' | ' + s.reasons.join('; ') : ''}`);
	}
	const total = await client`SELECT COUNT(*) AS n FROM smoke_trades`;
	console.log(`\nsmoke_trades now holds ${total[0]!.n} rows.`);
	await client.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
