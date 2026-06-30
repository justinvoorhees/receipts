/**
 * Patch the null PI on leg 0 (USDC→CLAWNCH via OTC solver) for the CLAWNCH trade.
 *
 * Root cause: discoverPool(USDC, CLAWNCH) found the 3000-fee Uniswap V3 pool
 * (0x8DB506...) whose sqrtPriceX96 is at the extreme tick max (3.4e+26 CLAWNCH/USDC —
 * a dead pool with zero real liquidity). That gave PI=10000 bps → nulled by cap.
 *
 * Fix: compute USDC/CLAWNCH reference via two-hop:
 *   CLAWNCH/USDC = CLAWNCH/WETH (from the liquid V3 pool slot0 at N-1) × WETH/USDC (market mid)
 *
 * Run: set -a && source .env && set +a && npx tsx packages/ingest/src/patch-clawnch-pi.ts
 */
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import postgres from 'postgres';
import { readSlot0 } from './poolDiscovery.js';
import { sqrtPriceX96ToPrice } from './tokenPricing.js';

const TX = '0xa86c70f29b212dc6beebd3ce1ef9c57415aa0701ec78d08e2fb75cf082d9a078';
const BLOCK = 47273631n;
const V3_WETH_CLAWNCH = '0x07da9c5d35028f578dfac5be6e5aaa8a835704f6' as const;

// Actual trade amounts (from transfer ledger, confirmed by investigate-clawnch.ts)
const USDC_IN_HUMAN    = 1_203_647_228 / 1e6;       // 1203.647228 USDC
const CLAWNCH_SWAPPED  = 158_869_999_999_999_970_000_000_000n; // ~158,870,000 CLAWNCH (18 dec)
const CLAWNCH_HUMAN    = Number(CLAWNCH_SWAPPED) / 1e18;

const rpc = createPublicClient({ chain: base, transport: http(process.env.TCA_RPC_URL!) });
const sql = postgres(process.env.TCA_DATABASE_URL!);

// 1. Verify the stored row
const [row] = await sql<{ route_legs: unknown; all_in_cost_bps: string; market_mid: string; normalize_flags: unknown }[]>`
  SELECT route_legs, all_in_cost_bps, market_mid, normalize_flags
  FROM smoke_trades WHERE tx_hash = ${TX}
`;
if (!row) { console.error('TX not found in smoke_trades'); process.exit(1); }

const legs = Array.isArray(row.route_legs)
  ? row.route_legs as { venue: string; type: string; feeTierBps: number; lpFeeBps: number; priceImpactBps: number | null; [k: string]: unknown }[]
  : [];
const flags = (Array.isArray(row.normalize_flags) ? row.normalize_flags : []) as string[];
const marketMid = Number(row.market_mid); // USDC per WETH

console.log(`Stored: allIn=${Number(row.all_in_cost_bps).toFixed(2)}bps  marketMid=${marketMid.toFixed(2)}`);
console.log(`Legs before patch:`);
for (const l of legs) {
  console.log(`  ${l.venue.slice(0, 14)}  type=${l.type}  feeTier=${l.feeTierBps}bps  lp=${l.lpFeeBps}bps  pi=${l.priceImpactBps?.toFixed(2) ?? 'null'}`);
}
console.log(`Flags: ${flags.join(' | ')}`);

if (legs.length < 1) { console.error('No legs found'); process.exit(1); }

// 2. Compute two-hop USDC/CLAWNCH reference from V3 WETH/CLAWNCH pool at N-1
const sqrtP = await readSlot0(rpc as never, V3_WETH_CLAWNCH, BLOCK - 1n);
if (sqrtP === null) { console.error('Could not read slot0 from WETH/CLAWNCH pool'); process.exit(1); }

// token0=WETH(0x4200), token1=CLAWNCH(0xa1f7) → rawPrice = CLAWNCH/WETH (token1/token0)
const clawnchPerWeth = sqrtPriceX96ToPrice(sqrtP, 18, 18);
const wethPerClawnch = clawnchPerWeth > 0 ? 1 / clawnchPerWeth : 0;
const usdcPerClawnch = wethPerClawnch * marketMid;     // USDC per CLAWNCH
const clawnchPerUsdc = usdcPerClawnch > 0 ? 1 / usdcPerClawnch : 0; // CLAWNCH per USDC (reference)

console.log(`\nTwo-hop reference (V3 pool @ N-1 × market mid ${marketMid.toFixed(2)}):`);
console.log(`  CLAWNCH/WETH = ${clawnchPerWeth.toFixed(2)}`);
console.log(`  WETH/CLAWNCH = ${wethPerClawnch.toExponential(4)}`);
console.log(`  USDC/CLAWNCH = ${usdcPerClawnch.toExponential(4)}`);
console.log(`  CLAWNCH/USDC = ${clawnchPerUsdc.toFixed(2)}`);

// 3. Compute leg 0 PI (tokenIn=USDC, tokenOut=CLAWNCH; mid = CLAWNCH per USDC)
const realizedClawnchPerUsdc = CLAWNCH_HUMAN / USDC_IN_HUMAN;
const leg0CostBps = (clawnchPerUsdc - realizedClawnchPerUsdc) / clawnchPerUsdc * 10_000;
const leg0FeeBps = legs[0].feeTierBps ?? 0;
const leg0PiBps = leg0CostBps - leg0FeeBps;

console.log(`\nLeg 0 PI:`);
console.log(`  reference CLAWNCH/USDC = ${clawnchPerUsdc.toFixed(2)}`);
console.log(`  realized  CLAWNCH/USDC = ${realizedClawnchPerUsdc.toFixed(2)}`);
console.log(`  legTotalCostBps = ${leg0CostBps.toFixed(2)} bps`);
console.log(`  feeTierBps      = ${leg0FeeBps} bps`);
console.log(`  priceImpactBps  = ${leg0PiBps.toFixed(2)} bps`);

if (Math.abs(leg0PiBps) > 500) {
  console.warn(`  WARNING: leg0PiBps ${leg0PiBps.toFixed(2)} still > 500 cap — this leg is unusual`);
}

// 4. Patch route_legs[0].priceImpactBps and remove the PI_IMPLAUSIBLE flag
const patchedLegs = legs.map((l, i) =>
  i === 0 ? { ...l, priceImpactBps: parseFloat(leg0PiBps.toFixed(4)) } : l
);
const patchedFlags = flags.filter(f => !f.startsWith(`PI_IMPLAUSIBLE: leg ${legs[0].venue.slice(0, 10)}`));

console.log(`\nApplying patch...`);
const result = await sql`
  UPDATE smoke_trades
  SET route_legs      = ${sql.json(patchedLegs)},
      normalize_flags = ${sql.json(patchedFlags)}
  WHERE tx_hash = ${TX}
  RETURNING tx_hash, route_legs, normalize_flags
`;

if (!result.length) { console.error('UPDATE returned 0 rows'); process.exit(1); }

console.log(`Updated 1 row.`);
const finalLegs = Array.isArray(result[0].route_legs)
  ? result[0].route_legs as typeof legs
  : [];
console.log(`\nLegs after patch:`);
for (const l of finalLegs) {
  console.log(`  ${l.venue.slice(0, 14)}  type=${l.type}  feeTier=${l.feeTierBps}bps  lp=${l.lpFeeBps}bps  pi=${l.priceImpactBps?.toFixed(2) ?? 'null'}`);
}
const finalFlags = Array.isArray(result[0].normalize_flags) ? result[0].normalize_flags as string[] : [];
console.log(`Flags: ${finalFlags.join(' | ') || '(none)'}`);

await sql.end();
