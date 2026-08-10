/**
 * decodeProfile.mjs — where does a single decode's wall-clock actually go?
 *
 * Stands an instrumented JSON-RPC proxy in front of the real endpoint, decodes
 * one transaction through it, and reports: how many calls were issued, how many
 * were DISTINCT, how much of the wall-clock had only one request in flight, and
 * a timeline of every call.
 *
 * Why a proxy rather than instrumenting the code: the decode reaches the network
 * from fourteen separate client constructions across eight modules. The proxy is
 * the one place that sees all of them, and it needs no code change to use — so
 * it profiles whatever is checked out, including an unmodified `main`.
 *
 * The two numbers to look at first:
 *
 *   unique vs total — repeats are pure waste. This is what found 290 calls of
 *   which only 121 were distinct (2026-08-10), and it is the first thing to
 *   check after adding any new read.
 *
 *   time with 1 request in flight — a decode is round-trip bound, so this is
 *   the fraction of the wall-clock spent waiting on a serial chain. Anything
 *   above ~25% means some loop is awaiting one item at a time; the timeline
 *   below shows which calls, and their selectors identify the loop.
 *
 * Read-only. Writes only the NDJSON log it is asked for.
 *
 *   node scripts/analysis/decodeProfile.mjs <txHash> [--chain=8453] [--out=FILE] [--timeline]
 */
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { env, core } from './_env.mjs';

const args = process.argv.slice(2);
const hash = args.find((a) => a.startsWith('0x'));
const flag = (name, dflt) => {
	const hit = args.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : dflt;
};
if (!hash) {
	console.error('usage: node scripts/analysis/decodeProfile.mjs <txHash> [--chain=8453] [--timeline]');
	process.exit(1);
}
const chainId = Number(flag('chain', '8453'));
const outFile = flag('out', null);
const showTimeline = args.includes('--timeline');

const upstream = env.TCA_RPC_URL;
if (!upstream) throw new Error('TCA_RPC_URL missing from the repo-root .env');

// ── The proxy ───────────────────────────────────────────────────────────────

/** One row per HTTP request: when it started/ended, and what it asked for. */
const rows = [];
let t0 = null;
let seq = 0;

/** Human-readable call label. Selectors are the fastest way to spot which loop
 *  a serial chain belongs to, so they are kept verbatim. */
const describe = (c) => {
	const p = c.params ?? [];
	if (c.method === 'eth_call') {
		const blk = typeof p[1] === 'string' ? p[1] : JSON.stringify(p[1]);
		return `eth_call ${p[0]?.to ?? '?'} ${(p[0]?.data ?? '').slice(0, 10)} @${blk}`;
	}
	if (c.method === 'eth_getLogs') {
		const f = p[0] ?? {};
		return `eth_getLogs ${f.address ?? 'any'} ${f.fromBlock}-${f.toBlock}`;
	}
	return `${c.method} ${JSON.stringify(p).slice(0, 100)}`;
};

const server = http.createServer((req, res) => {
	const chunks = [];
	req.on('data', (d) => chunks.push(d));
	req.on('end', async () => {
		const body = Buffer.concat(chunks).toString();
		if (t0 === null) t0 = performance.now();
		const start = performance.now() - t0;
		const id = ++seq;
		let parsed = null;
		try {
			parsed = JSON.parse(body);
		} catch {
			/* pass it through unparsed */
		}
		const calls = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];

		let status = 502;
		let text = '{}';
		try {
			const up = await fetch(upstream, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body,
			});
			status = up.status;
			text = await up.text();
		} catch (e) {
			text = JSON.stringify({ error: String(e) });
		}
		const end = performance.now() - t0;
		rows.push({ id, start, end, ms: end - start, methods: calls.map(describe) });
		res.writeHead(status, { 'content-type': 'application/json' });
		res.end(text);
	});
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// ── The decode ──────────────────────────────────────────────────────────────

const { analyzeTransaction } = await core('index.js');
const started = performance.now();
const receipt = await analyzeTransaction(hash, chainId, { rpcUrl: `http://127.0.0.1:${port}` });
const wall = performance.now() - started;
server.close();

// ── The report ──────────────────────────────────────────────────────────────

const calls = rows.flatMap((r) => r.methods);
const unique = new Set(calls);
const span = Math.max(...rows.map((r) => r.end), 1);

console.log(`\n${hash}`);
console.log(`decoded: ${receipt ? `yes (${receipt.routeLegs?.length ?? 0} legs)` : 'NO — null receipt'}`);
console.log(`wall: ${wall.toFixed(0)}ms   RPC calls: ${calls.length}   distinct: ${unique.size}` +
	`   repeats: ${calls.length - unique.size}`);
console.log(`summed RPC latency: ${rows.reduce((a, r) => a + r.ms, 0).toFixed(0)}ms` +
	`  (serial-factor ${(rows.reduce((a, r) => a + r.ms, 0) / span).toFixed(2)}x)`);

// Time spent at each in-flight depth. Depth 1 is the serial chain.
const events = rows
	.flatMap((r) => [{ t: r.start, d: 1 }, { t: r.end, d: -1 }])
	.sort((a, b) => a.t - b.t);
const atDepth = new Map();
let depth = 0;
let prev = 0;
for (const e of events) {
	atDepth.set(depth, (atDepth.get(depth) ?? 0) + (e.t - prev));
	prev = e.t;
	depth += e.d;
}
console.log('\nwall-clock by concurrent requests in flight:');
for (const [n, ms] of [...atDepth].sort((a, b) => a[0] - b[0])) {
	if (ms < 1) continue;
	const note = n === 1 ? '   <- serial chain' : '';
	console.log(`  ${String(n).padStart(3)}: ${String(Math.round(ms)).padStart(6)}ms  ${((ms / span) * 100).toFixed(1)}%${note}`);
}

const counts = new Map();
for (const c of calls) counts.set(c, (counts.get(c) ?? 0) + 1);
const repeated = [...counts].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
if (repeated.length) {
	console.log('\nmost-repeated calls (each repeat is a call that did not need making):');
	for (const [c, n] of repeated.slice(0, 10)) console.log(`  x${String(n).padStart(3)}  ${c.slice(0, 88)}`);
}

if (showTimeline) {
	console.log('\ntimeline:');
	for (const r of [...rows].sort((a, b) => a.start - b.start)) {
		const lead = ' '.repeat(Math.round((r.start / span) * 60));
		const bar = '#'.repeat(Math.max(1, Math.round((r.ms / span) * 60)));
		console.log(
			`${String(r.id).padStart(4)} ${String(Math.round(r.start)).padStart(6)}→${String(Math.round(r.end)).padStart(6)}` +
			` ${String(Math.round(r.ms)).padStart(5)}ms |${lead}${bar}`.padEnd(78) + `| ${r.methods[0]?.slice(0, 56) ?? ''}`,
		);
	}
}

if (outFile) {
	writeFileSync(outFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
	console.log(`\nwrote ${outFile}`);
}
