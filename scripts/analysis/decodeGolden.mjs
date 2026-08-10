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
 *   node scripts/analysis/decodeGolden.mjs capture <out.json> [--concurrency=1] [--limit=N]
 *   node scripts/analysis/decodeGolden.mjs diff <before.json> <after.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { env, core, loadCorpus } from './_env.mjs';

const [mode, ...rest] = process.argv.slice(2);
const flag = (name, dflt) => {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? Number(hit.slice(name.length + 3)) : dflt;
};

/** Stable key order + bigint support, so a byte diff is a real diff. */
const stable = (v) => {
	if (v === null || typeof v !== 'object') return typeof v === 'bigint' ? `${v}n` : v;
	if (Array.isArray(v)) return v.map(stable);
	return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
};

async function capture(outFile) {
	if (!outFile) throw new Error('usage: decodeGolden.mjs capture <out.json>');
	const rpcUrl = env.TCA_RPC_URL;
	if (!rpcUrl) throw new Error('TCA_RPC_URL missing from the repo-root .env');

	const concurrency = flag('concurrency', 1);
	const limit = flag('limit', Infinity);
	if (concurrency > 1) {
		console.error(
			`⚠️  concurrency=${concurrency}: expect false differences. Re-run anything this flags serially before believing it.`,
		);
	}

	const { analyzeTransaction, enrichFeeSinkNames } = await core('index.js');
	const rows = loadCorpus().slice(0, limit).map((r) => ({ hash: r.tx_hash, chainId: r.chain_id ?? 8453 }));

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
	await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

	const ordered = Object.fromEntries(Object.keys(results).sort().map((k) => [k, results[k]]));
	writeFileSync(outFile, JSON.stringify(ordered, null, 2));
	const decoded = Object.values(ordered).filter((r) => r.receipt).length;
	console.log(
		`\nwrote ${outFile}: ${rows.length} hashes, ${decoded} decoded, ${rows.length - decoded} null` +
		`  (${((performance.now() - wall) / 1000).toFixed(0)}s, concurrency ${concurrency})`,
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

if (mode === 'capture') await capture(rest[0]);
else if (mode === 'diff') diff(rest[0], rest[1]);
else {
	console.error('usage: decodeGolden.mjs capture <out.json> [--concurrency=1] [--limit=N]');
	console.error('       decodeGolden.mjs diff <before.json> <after.json>');
	process.exit(1);
}
