/**
 * rpcCapacity.mjs — how should this endpoint be talked to?
 *
 * A decode is round-trip bound, so the only levers are "issue fewer calls" and
 * "issue them at the same time". This measures which of those the current
 * endpoint actually rewards, using an archive-state `eth_call` — the shape the
 * decoder issues hundreds of.
 *
 * Measured 2026-08-10 (QuickNode, Base): serial ~87ms per call, concurrency 20
 * ~5.6ms per call — a ~26x return on parallelism, which is why the decode was
 * rewritten around fan-out.
 *
 * ⚠️⚠️ IT ALSO SAYS NOT TO BATCH. JSON-RPC batching measured WORSE than plain
 * concurrency: one batch of 60 took 3695ms against 334ms for the same 60 calls
 * at concurrency 20. Do not reach for viem's `batch: true` on the strength of
 * "fewer HTTP requests must be faster" — run this first. Re-run it after any
 * provider change; the answer is a property of the provider, not of the code.
 *
 * Read-only. Writes nothing. Costs ~250 RPC calls.
 *
 *   node scripts/analysis/rpcCapacity.mjs [--block=0x…]
 */
import { env } from './_env.mjs';

const rpcUrl = env.TCA_RPC_URL;
if (!rpcUrl) throw new Error('TCA_RPC_URL missing from the repo-root .env');

const flag = (name, dflt) => {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : dflt;
};
// A historical block, so this measures ARCHIVE reads — the expensive kind, and
// what the decoder actually does. A `latest` read is much cheaper and would
// flatter the endpoint.
const block = flag('block', '0x2e6af5d');

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
/** balanceOf(<varying holder>) — varied so nothing is served from a cache. */
const call = (i) => ({
	jsonrpc: '2.0',
	id: i,
	method: 'eth_call',
	params: [
		{ to: USDC, data: `0x70a08231${'0'.repeat(63 - 6)}${(0x420000 + i).toString(16)}` },
		block,
	],
});

const post = (body) =>
	fetch(rpcUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	}).then((r) => r.json());

const time = async (label, fn) => {
	const started = performance.now();
	const note = await fn();
	const ms = performance.now() - started;
	console.log(`${label.padEnd(34)} ${String(Math.round(ms)).padStart(6)}ms  ${note ?? ''}`);
	return ms;
};

const N = 60;
console.log(`\nendpoint capacity, archive eth_call @${block}\n`);

const serialMs = await time('20 calls, serial', async () => {
	for (let i = 0; i < 20; i++) await post(call(i));
	return '';
});
console.log(`${''.padEnd(34)} ${'  '}(${(serialMs / 20).toFixed(1)}ms per call)\n`);

for (const c of [5, 10, 20, 40]) {
	const ms = await time(`${N} calls, concurrency ${c}`, async () => {
		let next = 0;
		const worker = async () => {
			while (next < N) await post(call(next++));
		};
		await Promise.all(Array.from({ length: c }, worker));
		return '';
	});
	console.log(`${''.padEnd(34)} ${'  '}(${(ms / N).toFixed(1)}ms per call, ${(serialMs / 20 / (ms / N)).toFixed(1)}x vs serial)`);
}

console.log('');
await time(`${N} calls, ONE batch request`, async () => {
	const r = await post(Array.from({ length: N }, (_, i) => call(i)));
	return Array.isArray(r) ? `(batch of ${r.length} accepted)` : `(BATCH REJECTED: ${JSON.stringify(r).slice(0, 90)})`;
});
await time(`${N} calls, batches of 20`, async () => {
	const chunks = [];
	for (let i = 0; i < N; i += 20) chunks.push(Array.from({ length: 20 }, (_, j) => call(i + j)));
	const rs = await Promise.all(chunks.map(post));
	return `(${rs.filter(Array.isArray).length}/${chunks.length} batches ok)`;
});

console.log('\nIf batching is not clearly FASTER than the best concurrency row, do not batch.');
