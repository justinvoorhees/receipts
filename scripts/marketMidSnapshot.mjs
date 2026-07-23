/**
 * marketMidSnapshot.mjs — snapshot the computed Market Price for every distinct
 * (input_token, output_token, block) pair in the receipts table, to a JSON file.
 *
 * Purpose: regression-gate a pricing/discovery change WITHOUT trusting the
 * persisted `receipts.market_mid` column — persisted mids go stale silently when
 * core pricing changes, and some are stored in a display (inverted) orientation,
 * so they are not a clean baseline. Instead, snapshot the LIVE-computed mid on
 * two code versions and diff them (same orientation on both sides):
 *
 *   # on the pre-change base (e.g. main), with core dist built:
 *   git checkout <base> && npx tsc --build packages/core
 *   node scripts/marketMidSnapshot.mjs /tmp/base.json
 *
 *   # on the feature branch:
 *   git checkout <branch> && npx tsc --build packages/core
 *   node scripts/marketMidSnapshot.mjs /tmp/after.json
 *
 *   node scripts/marketMidSnapshot.mjs --diff /tmp/base.json /tmp/after.json
 *
 * The --diff mode classifies each pair: unchanged (<1bps), DRIFT (>1bps, both
 * priced), NEW (base null -> after priced), LOST (base priced -> after null),
 * and prints tier transitions so a drift that keeps oracle corroboration
 * (full->full) is distinguishable from one that does not.
 *
 * Reads TCA_RPC_URL / TCA_DATABASE_URL from the repo-root .env. No writes.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const env = Object.fromEntries(
	readFileSync(new URL('../.env', import.meta.url), 'utf8')
		.split('\n').filter((l) => l.includes('='))
		.map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

function diff(basePath, afterPath) {
	const base = JSON.parse(readFileSync(basePath));
	const after = JSON.parse(readFileSync(afterPath));
	let unchanged = 0, drift = 0, neu = 0, lost = 0;
	const rows = [];
	for (const k of Object.keys(after)) {
		const b = base[k] ?? { mid: null }, a = after[k];
		if (b.mid == null && a.mid != null) { neu++; rows.push(['NEW  ', k, b, a, '']); }
		else if (b.mid != null && a.mid == null) { lost++; rows.push(['LOST ', k, b, a, '']); }
		else if (b.mid != null && a.mid != null) {
			const dev = Math.abs(a.mid - b.mid) / b.mid * 10_000;
			if (dev > 1) { drift++; rows.push(['DRIFT', k, b, a, `${dev.toFixed(1)}bps`]); }
			else unchanged++;
		}
	}
	console.log(`pairs=${Object.keys(after).length} unchanged(<1bps)=${unchanged} DRIFT=${drift} NEW=${neu} LOST=${lost}`);
	for (const [tag, k, b, a, d] of rows) {
		console.log(`${tag} ${d.padStart(9)}  tier ${String(b.tier ?? 'null').padEnd(9)}->${a.tier}  ${k}`);
	}
	// Non-zero exit if anything was lost (a pair that priced before now doesn't).
	process.exit(lost > 0 ? 1 : 0);
}

async function snapshot(outPath) {
	const { default: postgres } = await import('postgres');
	const { createDefaultPricingDeps } = await import(new URL('../packages/core/dist/pricing.js', import.meta.url));
	const sql = postgres(env.TCA_DATABASE_URL, { prepare: false });
	const deps = createDefaultPricingDeps(env.TCA_RPC_URL);
	const rows = await sql`select distinct input_token, output_token, block_number from receipts`;
	const res = {};
	for (const r of rows) {
		const key = `${r.input_token}|${r.output_token}|${r.block_number}`;
		try {
			const mp = await deps.getMarketPrice(r.input_token, r.output_token, BigInt(r.block_number) - 1n);
			res[key] = { mid: mp.marketMid, tier: mp.tier };
		} catch (e) {
			res[key] = { mid: null, tier: 'ERROR', err: String(e).slice(0, 80) };
		}
	}
	writeFileSync(outPath, JSON.stringify(res, null, 2));
	console.log(`wrote ${outPath}: ${Object.keys(res).length} pairs`);
	await sql.end();
}

const args = process.argv.slice(2);
if (!env.TCA_RPC_URL || !env.TCA_DATABASE_URL) { console.error('Missing TCA_RPC_URL or TCA_DATABASE_URL'); process.exit(1); }
if (args[0] === '--diff') {
	if (args.length !== 3) { console.error('usage: --diff <base.json> <after.json>'); process.exit(1); }
	diff(args[1], args[2]);
} else if (args.length === 1) {
	await snapshot(args[0]);
} else {
	console.error('usage: marketMidSnapshot.mjs <out.json>  |  --diff <base.json> <after.json>');
	process.exit(1);
}
