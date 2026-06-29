/**
 * EXTRACT — pull controlled swaps from the v1 "Aggregator Benchmark" DB.
 *
 * Reads the most recent smoke-% experiment (or EXPERIMENT_SLUG override),
 * joins runs + execution_records, and emits one SmokeCandidate per execution
 * with a tx hash. READ ONLY against V1_DATABASE_URL. No writes.
 *
 * Output: /tmp/smoke_candidates.json
 * Run: set -a && source .env && set +a && npx tsx packages/ingest/src/extract-smoke-candidates.ts
 */
import { writeFileSync } from 'fs';
import postgres from 'postgres';

const OUT_PATH = process.env.OUT_PATH ?? '/tmp/smoke_candidates.json';

async function main(): Promise<void> {
	const url = process.env.V1_DATABASE_URL;
	if (!url) throw new Error('V1_DATABASE_URL not set');
	const sql = postgres(url, { prepare: false });

	// Pick the experiment: explicit override, else the most recent smoke-% run.
	const slugOverride = process.env.EXPERIMENT_SLUG;
	const exp = slugOverride
		? await sql`SELECT id, slug FROM experiments WHERE slug = ${slugOverride} LIMIT 1`
		: await sql`SELECT id, slug FROM experiments WHERE slug LIKE 'smoke-%' ORDER BY started_at DESC LIMIT 1`;
	if (exp.length === 0) throw new Error('no smoke experiment found');
	const { id: experimentId, slug: experimentSlug } = exp[0]!;

	// All executions for that experiment that actually landed a tx hash.
	const rows = await sql`
		SELECT er.run_id, er.provider, er.tx_hash, er.status,
		       er.quote_amount_usd, er.realized_amount_usd,
		       r.intent
		FROM execution_records er
		JOIN runs r ON r.id = er.run_id
		WHERE r.experiment_id = ${experimentId}
		  AND er.tx_hash IS NOT NULL
		ORDER BY er.provider, er.submitted_at`;

	// The trader EOA is the signer. v1's runs.intent does NOT store the trader —
	// it only contains { pair, size_usd, direction }. The trader address is derived
	// at runtime from TCA_EOA_PRIVATE_KEY and never persisted in the DB.
	// We check intent.account / intent.from / intent.signer for forward-compat,
	// then fall back to SMOKE_TRADER env (required for current v1 data).
	const candidates = rows.map((r: Record<string, unknown>) => {
		const intent = (r.intent ?? {}) as Record<string, unknown>;
		const trader = String(
			intent.account ?? intent.from ?? intent.signer ?? process.env.SMOKE_TRADER ?? '',
		).toLowerCase();
		return {
			txHash: String(r.tx_hash).toLowerCase(),
			aggregator: String(r.provider).toLowerCase(),
			trader,
			experimentSlug,
			runId: String(r.run_id),
			v1Status: String(r.status),
			v1QuoteAmountUsd: r.quote_amount_usd == null ? null : Number(r.quote_amount_usd),
			v1RealizedAmountUsd: r.realized_amount_usd == null ? null : Number(r.realized_amount_usd),
		};
	});

	writeFileSync(OUT_PATH, JSON.stringify(candidates, null, 2));

	// Orientation report: provider × status breakdown.
	const byKey = new Map<string, number>();
	for (const c of candidates) {
		const k = `${c.aggregator}\t${c.v1Status}`;
		byKey.set(k, (byKey.get(k) ?? 0) + 1);
	}
	console.log(`Experiment: ${experimentSlug} (${candidates.length} executions with tx hashes)`);
	console.log('provider\tstatus\tcount');
	for (const [k, n] of [...byKey.entries()].sort()) console.log(`${k}\t${n}`);
	const missingTrader = candidates.filter((c) => !c.trader).length;
	if (missingTrader > 0) console.log(`WARN: ${missingTrader} rows missing trader — set SMOKE_TRADER env to the benchmark EOA.`);
	console.log(`Wrote ${OUT_PATH}`);
	await sql.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
