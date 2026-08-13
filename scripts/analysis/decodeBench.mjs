/**
 * decodeBench.mjs — how long does a decode take, end to end?
 *
 * Decodes a fixed set of transactions SERIALLY and reports per-hash and total
 * wall-clock. Serial on purpose: this measures what one visitor waits for on
 * `/tx`, which is the number the tool is judged by.
 *
 * ⚠️ Wall-clock against a shared endpoint is noisy — a single run misled this
 * work once, reporting a regression for a change that was in fact a 32%
 * reduction in calls. Treat a <15% difference between two runs as nothing, and
 * confirm any conclusion with `decodeProfile.mjs`, whose call COUNT is exact
 * and does not move with network weather.
 *
 * The default set spans the shapes that cost different amounts: a 10-leg
 * aggregator route, a hard-to-price pair, a single hop, and the two anchoring
 * paths. `--cases` runs the whole case list (docs/qa/cases.json) instead.
 *
 * Read-only. Writes nothing.
 *
 *   node scripts/analysis/decodeBench.mjs [--cases] [--limit=N] [--label=TEXT]
 */
import { env, core, loadCases, median } from './_env.mjs';

/** Shapes chosen so a change that only helps one of them is visible as such. */
const DEFAULT_SET = [
	['10-leg 0x route', '0xb02037466b0756a3972f77d674413a0d7468663aca62e8c6eb757f15ced59e26'],
	['4-leg', '0x9703bfa335528a8e01c6b63dd3046ccd6e13a66ba2e6954956aa2df39da269c1'],
	['3-leg, hard pair', '0xa21e4d82b961726614ce6f310e30e29a4b55b8eca1d6a46621c3adaf8edf6ab1'],
	['single hop', '0xc8078a93d1ccfe88e9fc78ed1d1a4feaf9485f71d9fd91189cf2081d6dd365c8'],
	['uniswapx fill', '0x97a73ba891215ca32d239bbeb2b0e27dea5720890c907940ccfd758dbb691a73'],
	['beneficiary-anchored', '0xd6bb5ae0ec9017de395fb9b0435fe18c1859c6fbf7830052bab20f36e496bc0f'],
];

const flag = (name, dflt) => {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : dflt;
};
const useCases = process.argv.includes('--cases');
const limit = Number(flag('limit', Infinity));
const label = flag('label', useCases ? 'case list' : 'default set');

const rpcUrl = env.TCA_RPC_URL;
if (!rpcUrl) throw new Error('TCA_RPC_URL missing from the repo-root .env');

const { analyzeTransaction, enrichFeeSinkNames } = await core('index.js');

const set = useCases
	? loadCases().slice(0, limit).map((c) => [c.hash.slice(0, 12), c.hash])
	: DEFAULT_SET.slice(0, limit);

console.log(`\n=== ${label} (${set.length} receipts, serial) ===`);
const times = [];
let nulls = 0;
for (const [name, hash] of set) {
	const started = performance.now();
	const receipt = await analyzeTransaction(hash, 8453, { rpcUrl });
	// enrichFeeSinkNames is on the render path too, so it belongs in the number.
	if (receipt) await enrichFeeSinkNames(receipt.feeSinks);
	const ms = performance.now() - started;
	times.push(ms);
	if (!receipt) nulls += 1;
	console.log(
		`${name.padEnd(22)} ${String(Math.round(ms)).padStart(6)}ms` +
		`  legs=${String(receipt?.routeLegs?.length ?? '-').padStart(2)}${receipt ? '' : '  NULL'}`,
	);
}

const total = times.reduce((a, b) => a + b, 0);
console.log(
	`\ntotal ${(total / 1000).toFixed(1)}s   mean ${Math.round(total / times.length)}ms` +
	`   median ${Math.round(median(times))}ms   slowest ${Math.round(Math.max(...times))}ms` +
	(nulls ? `   (${nulls} null)` : ''),
);
