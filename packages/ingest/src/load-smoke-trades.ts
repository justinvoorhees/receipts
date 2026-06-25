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
const BATCH = process.env.BATCH ?? 'smoke-01';
const SKIP_LOADED = process.env.SKIP_LOADED === '1';

async function main(): Promise<void> {
	const rpcUrl = process.env.TCA_RPC_URL;
	const dbUrl = process.env.TCA_DATABASE_URL;
	if (!rpcUrl) throw new Error('TCA_RPC_URL not set');
	if (!dbUrl) throw new Error('TCA_DATABASE_URL not set');

	const client = postgres(dbUrl, { prepare: false });
	const db = drizzle(client, { schema });

	const all = JSON.parse(readFileSync(IN_PATH, 'utf8')) as SmokeCandidate[];
	let eligible = all.filter((c) => c.trader && (!ONLY_SUCCESS || c.v1Status === 'success'));

	// When SKIP_LOADED is set, exclude candidates whose txHash is already in smoke_trades
	// so a second run picks DIFFERENT txns.
	if (SKIP_LOADED) {
		const existing = new Set(
			(await client`select tx_hash from smoke_trades`).map((r) => (r as { tx_hash: string }).tx_hash),
		);
		eligible = eligible.filter((c) => !existing.has(c.txHash.toLowerCase()));
		console.log(`SKIP_LOADED: excluded ${existing.size} already-loaded txns; ${eligible.length} candidates remain.`);
	}

	// Group all eligible candidates per aggregator.
	const perAgg = new Map<string, SmokeCandidate[]>();
	for (const c of eligible) {
		const list = perAgg.get(c.aggregator) ?? [];
		list.push(c);
		perAgg.set(c.aggregator, list);
	}
	console.log(`${eligible.length} eligible candidates across ${perAgg.size} aggregators (≤${PER_AGG_LIMIT} ok/agg, only_success=${ONLY_SUCCESS}).`);

	// Try candidates per aggregator until PER_AGG_LIMIT succeed.
	const report: Record<string, { ok: number; fail: number; reasons: string[] }> = {};
	for (const [agg, candidates] of perAgg) {
		report[agg] = { ok: 0, fail: 0, reasons: [] };
		for (const c of candidates) {
			if (report[agg]!.ok >= PER_AGG_LIMIT) break;
			const r = await normalizeSmokeTrade({ candidate: c, rpcUrl });
			if (!r.ok) { report[agg]!.fail++; report[agg]!.reasons.push(`${c.txHash.slice(0, 10)}: ${r.reason}`); continue; }
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
				routeShape: row.routeShape,
				hopCount: row.hopCount,
				routeLegs: row.routeLegs != null ? JSON.stringify(row.routeLegs) : null,
				reconResidualBps: row.reconResidualBps == null ? null : String(row.reconResidualBps),
				decompConfidence: row.decompConfidence,
				experimentSlug: row.experimentSlug, runId: row.runId, v1Status: row.v1Status,
				v1QuoteAmountUsd: row.v1QuoteAmountUsd == null ? null : String(row.v1QuoteAmountUsd),
				v1RealizedAmountUsd: row.v1RealizedAmountUsd == null ? null : String(row.v1RealizedAmountUsd),
				settlementEventName: row.settlementEventName, settlementEventTopic0: row.settlementEventTopic0,
				settlementEventSeen: row.settlementEventSeen, normalizeFlags: row.normalizeFlags,
				batch: BATCH,
			}).onConflictDoUpdate({
				target: schema.smokeTrades.txHash,
				set: {
					allInCostBps: String(row.allInCostBps), lpFeeBps: row.lpFeeBps == null ? null : String(row.lpFeeBps),
					aggFeeBps: String(row.aggFeeBps), slippageBps: row.slippageBps == null ? null : String(row.slippageBps),
					executionBps: row.executionBps == null ? null : String(row.executionBps), gasCostUsd: String(row.gasCostUsd),
					routePure: row.routePure,
					routeShape: row.routeShape,
					hopCount: row.hopCount,
					routeLegs: row.routeLegs != null ? JSON.stringify(row.routeLegs) : null,
					reconResidualBps: row.reconResidualBps == null ? null : String(row.reconResidualBps),
					decompConfidence: row.decompConfidence,
					settlementEventSeen: row.settlementEventSeen, normalizeFlags: row.normalizeFlags,
				},
			});
			report[agg]!.ok++;
		}
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
