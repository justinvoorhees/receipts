/**
 * validate-route-decomposition.ts — Validates multi-hop route decomposition
 * across all smoke_trades rows.
 *
 * For each row, prints all_in vs (LP+Agg+Slippage) reconciliation and the
 * residual/confidence distribution. Asserts the invariant LP+Agg+Slippage=all_in
 * within a 0.01 bps tolerance for high/medium confidence rows.
 *
 * Run: set -a && source .env && set +a && npx tsx packages/ingest/src/validate-route-decomposition.ts
 */

import postgres from 'postgres';

const RECON_TOL_BPS = 0.01;

async function main(): Promise<void> {
	const dbUrl = process.env.TCA_DATABASE_URL;
	if (!dbUrl) throw new Error('TCA_DATABASE_URL not set');
	const sql = postgres(dbUrl);

	const rows = await sql`
		SELECT
			tx_hash, aggregator, batch,
			all_in_cost_bps, lp_fee_bps, agg_fee_bps, slippage_bps, execution_bps,
			route_shape, hop_count, decomp_confidence, recon_residual_bps,
			route_legs, normalize_flags
		FROM smoke_trades
		ORDER BY batch, aggregator
	`;

	console.log('╔══════════════════════════════════════════════════════════════════════╗');
	console.log('║  Route Decomposition Validation — smoke_trades                      ║');
	console.log('╚══════════════════════════════════════════════════════════════════════╝\n');
	console.log(`  Total rows: ${rows.length}\n`);

	// Column header
	console.log(
		'  ' +
		'batch      '.padEnd(12) +
		'agg        '.padEnd(14) +
		'tx         '.padEnd(14) +
		'shape   '.padEnd(9) +
		'hops '.padEnd(5) +
		'conf   '.padEnd(8) +
		'all_in  '.padStart(9) +
		'lp      '.padStart(9) +
		'agg_fee '.padStart(9) +
		'slip    '.padStart(9) +
		'residual'.padStart(9) +
		'  ok?',
	);
	console.log('  ' + '─'.repeat(118));

	let passCount = 0;
	let failCount = 0;
	let lowConfCount = 0;
	let nullDecompCount = 0;

	const confidenceDist: Record<string, number> = {};
	const shapeDist: Record<string, number> = {};

	for (const row of rows) {
		const allIn = Number(row.all_in_cost_bps);
		const lp = row.lp_fee_bps != null ? Number(row.lp_fee_bps) : null;
		const agg = row.agg_fee_bps != null ? Number(row.agg_fee_bps) : null;
		const slip = row.slippage_bps != null ? Number(row.slippage_bps) : null;
		const conf = (row.decomp_confidence as string | null) ?? '—';
		const shape = (row.route_shape as string | null) ?? '—';
		const hops = row.hop_count != null ? String(row.hop_count) : '—';
		const txShort = (row.tx_hash as string).slice(0, 10);
		const reconResidual = row.recon_residual_bps != null ? Number(row.recon_residual_bps) : null;

		confidenceDist[conf] = (confidenceDist[conf] ?? 0) + 1;
		shapeDist[shape] = (shapeDist[shape] ?? 0) + 1;

		let reconOk: string;

		if (lp == null || slip == null || agg == null) {
			// No decomposition (should only happen for low-confidence complex routes)
			reconOk = conf === 'low' ? 'skip(low)' : 'NULL-DECOMP';
			if (conf !== 'low') nullDecompCount++;
			else lowConfCount++;
		} else {
			const sum = lp + agg + slip;
			const delta = Math.abs(sum - allIn);

			if (delta <= RECON_TOL_BPS) {
				reconOk = 'PASS';
				passCount++;
			} else if (conf === 'low') {
				reconOk = `~${delta.toFixed(2)}(low)`;
				lowConfCount++;
			} else {
				reconOk = `FAIL(${delta.toFixed(4)})`;
				failCount++;
			}
		}

		const lpStr = lp != null ? lp.toFixed(2) : 'null';
		const aggStr = agg != null ? agg.toFixed(2) : 'null';
		const slipStr = slip != null ? slip.toFixed(2) : 'null';
		const residualStr = reconResidual != null ? reconResidual.toFixed(2) : '—';

		console.log(
			'  ' +
			(row.batch as string).padEnd(12) +
			(row.aggregator as string).padEnd(14) +
			txShort.padEnd(14) +
			shape.padEnd(9) +
			hops.padEnd(5) +
			conf.padEnd(8) +
			allIn.toFixed(2).padStart(9) +
			lpStr.padStart(9) +
			aggStr.padStart(9) +
			slipStr.padStart(9) +
			residualStr.padStart(9) +
			`  ${reconOk}`,
		);
	}

	// Per-leg detail for multi-hop rows
	const multiHopRows = rows.filter(r => r.hop_count != null && Number(r.hop_count) > 1);
	if (multiHopRows.length > 0) {
		console.log('\n  ─── Per-leg breakdown (multi-hop rows) ───────────────────────────────────────');
		for (const row of multiHopRows) {
			const rawLegs = row.route_legs;
			const legs = rawLegs == null
				? null
				: (typeof rawLegs === 'string' ? JSON.parse(rawLegs) : rawLegs) as Array<{
					venue: string;
					type: string;
					tokenIn: string;
					tokenOut: string;
					feeTierBps?: number;
					notionalUsdc?: number;
					lpFeeBps?: number;
					priceImpactBps?: number | null;
				}>;
			if (!legs) continue;
			const txShort = (row.tx_hash as string).slice(0, 10);
			console.log(`\n  ${row.batch} ${row.aggregator} ${txShort} — ${row.route_shape}/${row.hop_count}-hop conf=${row.decomp_confidence}`);
			console.log('    ' + 'venue(type)        '.padEnd(22) + 'pair              '.padEnd(20) + 'fee(bps)'.padStart(9) + '  notional($)'.padStart(13) + '  legLP(bps)'.padStart(12) + '  legPI(bps)'.padStart(12));
			console.log('    ' + '─'.repeat(88));
			for (const leg of legs) {
				const venueShort = `${leg.venue.slice(0, 8)}(${leg.type})`;
				const pair = `${leg.tokenIn.slice(0, 6)}→${leg.tokenOut.slice(0, 6)}`;
				const fee = leg.feeTierBps != null ? leg.feeTierBps.toFixed(2) : '—';
				const notional = leg.notionalUsdc != null ? `$${leg.notionalUsdc.toFixed(2)}` : '—';
				const legLp = leg.lpFeeBps != null ? leg.lpFeeBps.toFixed(4) : '—';
				const pi = leg.priceImpactBps != null ? leg.priceImpactBps.toFixed(4) : '—';
				console.log(
					'    ' +
					venueShort.padEnd(22) +
					pair.padEnd(20) +
					fee.padStart(9) +
					notional.padStart(13) +
					legLp.padStart(12) +
					pi.padStart(12),
				);
			}
		}
	}

	// Summary
	console.log('\n  ─── Summary ──────────────────────────────────────────────────────────');
	console.log(`\n  Reconciliation (high/medium confidence, tol=${RECON_TOL_BPS} bps):`);
	console.log(`    PASS:              ${passCount}`);
	console.log(`    FAIL:              ${failCount}`);
	console.log(`    low-conf (skipped): ${lowConfCount}`);
	console.log(`    null decomp (unexpected): ${nullDecompCount}`);

	console.log('\n  Confidence distribution:');
	for (const [k, v] of Object.entries(confidenceDist).sort()) {
		console.log(`    ${k.padEnd(10)} ${v}`);
	}

	console.log('\n  Route shape distribution:');
	for (const [k, v] of Object.entries(shapeDist).sort()) {
		console.log(`    ${k.padEnd(10)} ${v}`);
	}

	const invariantOk = failCount === 0 && nullDecompCount === 0;
	console.log(`\n  Invariant: ${invariantOk ? 'PASS — all high/medium confidence rows reconcile' : 'FAIL — see FAIL rows above'}`);
	console.log('');

	await sql.end();
	if (!invariantOk) process.exit(1);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
