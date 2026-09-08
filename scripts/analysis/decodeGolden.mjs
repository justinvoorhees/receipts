/**
 * decodeGolden.mjs — does today's code produce the same receipts as yesterday's?
 *
 * Fills the hole the README names: `rpcProviderAB.mjs` can A/B two PROVIDERS on
 * one codebase, but nothing could answer "does this refactor change any
 * receipt". This captures every corpus receipt to a file; run it on two git
 * refs and diff the two files.
 *
 *   git stash                                     # or: git checkout main
 *   node scripts/analysis/decodeGolden.mjs capture /tmp/before.json
 *   git stash pop                                 # or: git checkout my-branch
 *   node scripts/analysis/decodeGolden.mjs capture /tmp/after.json
 *   node scripts/analysis/decodeGolden.mjs diff /tmp/before.json /tmp/after.json
 *
 * ⚠️⚠️ CAPTURE SERIALLY (the default) IF YOU INTEND TO BELIEVE THE DIFF.
 * Concurrency>1 is roughly 2x faster and WILL produce false differences: under
 * concurrent load the live endpoint fails reads transiently, the decode swallows
 * those failures as evidence (`catch → null` means "no such pool" / "no mid"),
 * and receipts come back quietly degraded — tier full→estimated, a venue
 * mislabelled univ3, allInCostBps 101→5012. Observed repeatedly on 2026-08-10,
 * on unmodified `main`, and stable when re-run serially. This is the same trap
 * `rpcProviderAB.mjs --control` exists for: a raw diff over-reports, so anything
 * it flags must be re-run serially before it is believed.
 *
 * So: `--concurrency=N` is for a fast smell-test only. A serial run is the only
 * one whose clean result means anything.
 *
 * Read-only against the chain. Writes only the capture file it is given.
 *
 *   node scripts/analysis/decodeGolden.mjs capture <out.json> [--hashes-from=<parquet>] [--concurrency=1] [--limit=N]
 *   node scripts/analysis/decodeGolden.mjs diff <before.json> <after.json>
 *   node scripts/analysis/decodeGolden.mjs determinism <candidates.parquet> [--limit=N]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { env, core, loadCases } from './_env.mjs';

const [mode, ...rest] = process.argv.slice(2);
const flag = (name, dflt) => {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? Number(hit.slice(name.length + 3)) : dflt;
};
/**
 * `flag()` above always coerces via `Number(...)` — fine for `--concurrency=`
 * and `--limit=`, but `Number('data/derived/.../candidates....parquet')` is
 * `NaN`. `--hashes-from=` needs the raw string, so it gets its own reader
 * rather than reusing `flag()`.
 */
const flagStr = (name, dflt) => {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : dflt;
};

/**
 * Hashes from a candidates Parquet instead of docs/qa/cases.json.
 *
 * `selected_via = 'both'` is the router-selected subset that actually swaps —
 * 535 rows on the 2026-09-04a pilot build. 'router' (130) emits no Swap log and
 * 'swap_log' (12,976) is the full population, which is a different run.
 */
async function hashesFromParquet(parquetPath) {
	const { DuckDBInstance } = await import('@duckdb/node-api');
	const instance = await DuckDBInstance.create(':memory:');
	try {
		const connection = await instance.connect();
		try {
			const reader = await connection.runAndReadAll(
				`SELECT tx_hash, chain_id FROM read_parquet('${parquetPath.replace(/'/g, "''")}')
				 WHERE selected_via = 'both' ORDER BY block_number, block_position`,
			);
			return reader.getRowObjects().map((r) => ({
				hash: String(r.tx_hash),
				chainId: Number(r.chain_id),
			}));
		} finally {
			connection.closeSync();
		}
	} finally {
		instance.closeSync();
	}
}

/** Stable key order + bigint support, so a byte diff is a real diff. */
const stable = (v) => {
	if (v === null || typeof v !== 'object') return typeof v === 'bigint' ? `${v}n` : v;
	if (Array.isArray(v)) return v.map(stable);
	return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
};

/**
 * `hashesFrom`/`concurrency` default to the CLI `flagStr`/`flag` lookups when
 * not supplied, so the plain `capture(outFile)` call from the `capture` mode
 * dispatch below behaves exactly as before. `determinism()` instead passes
 * both explicitly — see its docstring for why that is load-bearing rather
 * than cosmetic.
 */
async function capture(outFile, { hashesFrom, concurrency } = {}) {
	if (!outFile) throw new Error('usage: decodeGolden.mjs capture <out.json>');
	const rpcUrl = env.TCA_RPC_URL;
	if (!rpcUrl) throw new Error('TCA_RPC_URL missing from the repo-root .env');

	const resolvedConcurrency = concurrency ?? flag('concurrency', 1);
	const limit = flag('limit', Infinity);
	if (resolvedConcurrency > 1) {
		console.error(
			`⚠️  concurrency=${resolvedConcurrency}: expect false differences. Re-run anything this flags serially before believing it.`,
		);
	}

	const { analyzeTransaction, enrichFeeSinkNames } = await core('index.js');
	const resolvedHashesFrom = hashesFrom ?? flagStr('hashes-from', null);
	const rows = resolvedHashesFrom
		? (await hashesFromParquet(resolvedHashesFrom)).slice(0, limit)
		: loadCases().slice(0, limit).map((c) => ({ hash: c.hash, chainId: c.chainId ?? 8453 }));

	const results = {};
	let done = 0;
	let next = 0;
	const worker = async () => {
		while (next < rows.length) {
			const { hash, chainId } = rows[next++];
			const started = performance.now();
			let receipt = null;
			let error = null;
			try {
				receipt = await analyzeTransaction(hash, chainId, { rpcUrl });
				if (receipt) receipt = { ...receipt, feeSinks: await enrichFeeSinkNames(receipt.feeSinks) };
			} catch (e) {
				error = String(e);
			}
			results[hash] = { receipt: receipt ? stable(receipt) : null, error };
			process.stderr.write(
				`${++done}/${rows.length} ${hash.slice(0, 12)} ${Math.round(performance.now() - started)}ms\n`,
			);
		}
	};
	const wall = performance.now();
	await Promise.all(Array.from({ length: Math.max(1, resolvedConcurrency) }, worker));

	const ordered = Object.fromEntries(Object.keys(results).sort().map((k) => [k, results[k]]));
	writeFileSync(outFile, JSON.stringify(ordered, null, 2));
	const decoded = Object.values(ordered).filter((r) => r.receipt).length;
	console.log(
		`\nwrote ${outFile}: ${rows.length} hashes, ${decoded} decoded, ${rows.length - decoded} null` +
		`  (${((performance.now() - wall) / 1000).toFixed(0)}s, concurrency ${resolvedConcurrency})`,
	);
}

function diff(beforeFile, afterFile) {
	if (!beforeFile || !afterFile) throw new Error('usage: decodeGolden.mjs diff <before.json> <after.json>');
	const a = JSON.parse(readFileSync(beforeFile, 'utf8'));
	const b = JSON.parse(readFileSync(afterFile, 'utf8'));

	const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
	const changed = keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));

	console.log(`compared ${keys.length} hashes: ${keys.length - changed.length} identical, ${changed.length} differing`);
	for (const k of changed) {
		const ra = a[k]?.receipt ?? {};
		const rb = b[k]?.receipt ?? {};
		const fields = [...new Set([...Object.keys(ra), ...Object.keys(rb)])]
			.filter((f) => JSON.stringify(ra[f]) !== JSON.stringify(rb[f]));
		console.log(`\n--- ${k}`);
		for (const f of fields) {
			const left = JSON.stringify(ra[f]) ?? 'absent';
			const right = JSON.stringify(rb[f]) ?? 'absent';
			console.log(`    ${f}: ${left.slice(0, 70)} => ${right.slice(0, 70)}`);
		}
	}
	if (changed.length) {
		console.log(
			'\n⚠️  Re-run each differing hash SERIALLY on both refs before treating it as a real change —' +
			'\n   a concurrent capture produces false differences (see the header of this file).',
		);
	}
	process.exitCode = changed.length ? 1 : 0;
}

/**
 * Determinism: capture the SAME code twice, serially, and diff.
 *
 * A clean result means a receipt is reproducible. A dirty one means the decode
 * is absorbing transient RPC failures as evidence — the open
 * `transient-rpc-silently-degrades-receipts` hazard — and every before/after
 * diff in the enrichment work is uninterpretable until it is understood.
 *
 * `concurrency: 1` is passed to `capture()` as an explicit option, not via
 * `process.argv` — a `--concurrency=N` typed on this mode's own command line
 * has no path to reach `capture()`'s concurrency at all, so it structurally
 * cannot raise it. (An earlier version pushed `--concurrency=1` onto
 * `process.argv` instead; `flag()` resolves via `Array.prototype.find`, which
 * returns the FIRST match, so a `--concurrency=8` already present ahead of
 * the pushed value in argv would have won. That version's serial guarantee
 * was a positional accident, not an enforced one — fixed here.)
 */
async function determinism(parquetPath) {
	if (!parquetPath) throw new Error('usage: decodeGolden.mjs determinism <candidates.parquet>');
	const a = `/tmp/determinism-pass1.${process.pid}.json`;
	const b = `/tmp/determinism-pass2.${process.pid}.json`;
	const options = { hashesFrom: parquetPath, concurrency: 1 };
	console.log('pass 1 of 2...');
	await capture(a, options);
	console.log('pass 2 of 2...');
	await capture(b, options);
	console.log('\n=== determinism diff (same code, two serial passes) ===');
	diff(a, b);
}

if (mode === 'capture') await capture(rest[0]);
else if (mode === 'diff') diff(rest[0], rest[1]);
else if (mode === 'determinism') await determinism(rest[0]);
else {
	console.error('usage: decodeGolden.mjs capture <out.json> [--hashes-from=<parquet>] [--concurrency=1] [--limit=N]');
	console.error('       decodeGolden.mjs diff <before.json> <after.json>');
	console.error('       decodeGolden.mjs determinism <candidates.parquet> [--limit=N]');
	process.exit(1);
}
