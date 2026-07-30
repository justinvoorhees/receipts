/**
 * referencePoolInRoute.mjs — is the Market Price ruler even measuring a pool
 * this trade touched?  [needs RPC]
 *
 * The Market Price ruler prices against the DEEPEST DISCOVERABLE pool for the
 * pair. This script asks how often that pool is actually one the route used.
 *
 * Baseline 2026-07-30 (20-receipt sample): reference pool ∈ route only 20%;
 * 65% of routes touch more than one pool, so "the pool the route used" is not
 * even singular. That is the spatial error behind the residual — and it is NOT
 * fixable by switching to a route-relative ruler, which is tautological (see
 * reconResidual.mjs).
 *
 * ⚠️ Small samples. Raise --limit before quoting the percentages.
 *
 *   node scripts/analysis/referencePoolInRoute.mjs [--limit=40]
 */
import { connect, core, env, num } from './_env.mjs';

const limit = Number((process.argv.find((a) => a.startsWith('--limit=')) ?? '--limit=40').slice(8));

const { createPublicClient, http } = await import('viem');
const { base } = await import('viem/chains');
const { getPairMidAtBlock, makeRpcDecimalsCache } = await core('tokenPricing.js');

const client = createPublicClient({ chain: base, transport: http(env.TCA_RPC_URL) });
const decimals = makeRpcDecimalsCache(client);

const sql = await connect();
const rows = await sql`
  select tx_hash, block_number, input_token, output_token, tier, route_shape,
         hop_count, notional_usd, slippage_bps, route_legs
  from receipts where route_legs is not null and block_number is not null
  order by id desc limit ${limit}`;
await sql.end();

let n = 0, hit = 0, multi = 0;
const byShape = {};
const detail = [];

for (const r of rows) {
	const routePools = new Set((r.route_legs ?? []).map((l) => (l.venue ?? '').toLowerCase()).filter((v) => v.startsWith('0x')));
	if (!routePools.size) continue;
	let mid = null;
	try { mid = await getPairMidAtBlock(client, r.input_token, r.output_token, BigInt(r.block_number) - 1n, decimals); }
	catch { /* unpriceable pair — not a finding, just skip */ }
	if (!mid?.poolAddress?.startsWith('0x')) continue;

	const inRoute = routePools.has(mid.poolAddress.toLowerCase());
	n++; if (inRoute) hit++;
	if (routePools.size > 1) multi++;
	const shape = r.route_shape ?? '?';
	(byShape[shape] ??= { hit: 0, miss: 0 })[inRoute ? 'hit' : 'miss']++;
	detail.push({ tx: r.tx_hash.slice(0, 10), inRoute, pools: routePools.size, shape, slip: num(r.slippage_bps), tier: r.tier });
}

console.log(`usable receipts: ${n}\n`);
console.log(`reference pool IS one of the route's pools : ${String(hit).padStart(3)}  (${(100 * hit / n).toFixed(0)}%)`);
console.log(`reference pool is NOT in the route         : ${String(n - hit).padStart(3)}  (${(100 * (n - hit) / n).toFixed(0)}%)`);
console.log(`routes touching >1 pool (ruler ambiguous)  : ${String(multi).padStart(3)}  (${(100 * multi / n).toFixed(0)}%)`);

console.log('\nby route shape:');
for (const [k, v] of Object.entries(byShape)) console.log(`  ${k.padEnd(9)} inRoute=${v.hit}  notInRoute=${v.miss}`);

console.log('\ntx          ref_in_route  pools  shape      slip_bps  tier');
for (const d of detail) {
	console.log(`${d.tx}  ${String(d.inRoute).padStart(12)}  ${String(d.pools).padStart(5)}  ${String(d.shape).padEnd(9)} ${String(d.slip?.toFixed(0) ?? '·').padStart(9)}  ${d.tier}`);
}
