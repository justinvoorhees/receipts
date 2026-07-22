/**
 * repopulateReceipts.mjs — re-analyze every persisted receipt in place.
 *
 * Persisted receipts go stale silently when core pricing/decomposition logic
 * changes (the API route returns cache hits without recomputing). This walks
 * all rows, re-runs analyzeTransaction, and UPDATEs the computed columns in
 * place — preserving id / created_at / user_id so History ordering is stable.
 *
 * Dry-run by default: prints a per-row diff on the key columns and writes
 * nothing. Pass --commit to persist. Optional --ids=56,134 limits the set.
 */
import { readFileSync } from 'node:fs';
import { createDb, schema } from '@fabric-tca/db';
const { analyzeTransaction } = await import(new URL('../packages/core/dist/analyzeTransaction.js', import.meta.url));
import { eq, asc } from 'drizzle-orm';

// ── env ──
const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
for (const line of env.split('\n')) {
	const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/);
	if (m) process.env[m[1]] = m[2];
}
const rpcUrl = process.env.TCA_RPC_URL;
const dbUrl = process.env.TCA_DATABASE_URL;
if (!rpcUrl || !dbUrl) { console.error('Missing TCA_RPC_URL or TCA_DATABASE_URL'); process.exit(1); }

const COMMIT = process.argv.includes('--commit');
const idsArg = process.argv.find(a => a.startsWith('--ids='));
const onlyIds = idsArg ? new Set(idsArg.slice('--ids='.length).split(',').map(Number)) : null;

const num = v => (v == null ? null : String(v));

/** Map a computed core Receipt → the mutable receipt columns (identity cols excluded). */
function toUpdate(r) {
	return {
		aggregator: r.aggregator, routerAddress: r.routerAddress, trader: r.trader,
		fillerAddress: r.fillerAddress, direction: r.direction,
		inputToken: r.inputToken, outputToken: r.outputToken,
		inputSymbol: r.inputSymbol, outputSymbol: r.outputSymbol,
		inputAmount: String(r.inputAmount), outputAmount: String(r.outputAmount),
		notionalUsd: num(r.notionalUsd), realizedPrice: num(r.realizedPrice), marketMid: num(r.marketMid),
		allInCostBps: num(r.allInCostBps), pricingStatus: r.pricingStatus, tier: r.tier,
		methodology: r.methodology, marketPriceFlags: r.marketPriceFlags, blockNumber: r.blockNumber,
		executionBps: num(r.executionBps), lpFeeBps: num(r.lpFeeBps), aggFeeBps: num(r.aggFeeBps),
		slippageBps: num(r.slippageBps), gasCostUsd: num(r.gasCostUsd), routePure: r.routePure,
		routeShape: r.routeShape, hopCount: r.hopCount, routeLegs: r.routeLegs,
		reconResidualBps: num(r.reconResidualBps), decompConfidence: r.decompConfidence,
		feeRecipient: r.feeRecipient, feeSinkSource: r.feeSinkSource,
		integratorFeeBps: num(r.integratorFeeBps), fabricFeeBps: num(r.fabricFeeBps),
		settlementEventName: r.settlementEventName, settlementEventTopic0: r.settlementEventTopic0,
		settlementEventSeen: r.settlementEventSeen, normalizeFlags: r.normalizeFlags,
		chainlinkPrice: num(r.chainlinkPrice), chainlinkDevBps: num(r.chainlinkDevBps),
		poolDivergenceBps: num(r.poolDivergenceBps), manipulationFlag: r.manipulationFlag,
		offchainPrice: num(r.offchainPrice), offchainDevBps: num(r.offchainDevBps),
		chainlinkStalenessSecs: num(r.chainlinkStalenessSecs),
	};
}

// Columns worth surfacing in the diff (the ones decomposition/pricing move).
const WATCH = ['tier', 'pricingStatus', 'routeShape', 'hopCount', 'allInCostBps', 'executionBps', 'lpFeeBps', 'aggFeeBps', 'slippageBps', 'decompConfidence'];
const norm = v => (v == null ? '·' : typeof v === 'string' && /^-?\d*\.?\d+$/.test(v) ? Number(v).toFixed(2) : String(v));

const db = createDb(dbUrl);
let rows = await db.select().from(schema.receipts).orderBy(asc(schema.receipts.id));
if (onlyIds) rows = rows.filter(r => onlyIds.has(r.id));

console.log(`${COMMIT ? 'COMMIT' : 'DRY-RUN'} — ${rows.length} receipts\n`);
let changed = 0, nulled = 0, failed = 0;
for (const row of rows) {
	let r;
	try { r = await analyzeTransaction(row.txHash, row.chainId, { rpcUrl }); }
	catch (e) { console.log(`id ${row.id}  ERROR ${e.message}`); failed++; continue; }
	if (!r) { console.log(`id ${String(row.id).padStart(3)}  ⚠ NULL receipt now (was ${row.inputSymbol}->${row.outputSymbol}) — SKIPPED, not overwriting`); nulled++; continue; }

	const upd = toUpdate(r);
	const diffs = WATCH.filter(k => norm(row[k]) !== norm(upd[k])).map(k => `${k}:${norm(row[k])}→${norm(upd[k])}`);
	const tag = diffs.length ? `Δ ${diffs.join('  ')}` : 'no change';
	console.log(`id ${String(row.id).padStart(3)}  ${(r.inputSymbol + '->' + r.outputSymbol).padEnd(16)} ${tag}`);
	if (diffs.length) changed++;
	if (COMMIT) await db.update(schema.receipts).set(upd).where(eq(schema.receipts.id, row.id));
}
console.log(`\n${COMMIT ? 'WROTE' : 'WOULD WRITE'}: ${rows.length} rows · changed=${changed} · null-now(skipped)=${nulled} · errors=${failed}`);
process.exit(0);
