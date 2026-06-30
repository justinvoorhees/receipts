/**
 * Batch patch for all 8 remaining trades:
 *
 * NON-FABRIC GATED (4 trades — KyberSwap, Relay, Nordstern, Velora):
 *   These are pure OTC/RFQ fills with no AMM pools. Route reconstruction failed
 *   (shape=complex, hops=0) but allIn and agg_fee are already correct.
 *   Fix: lp_fee_bps=0, slippage_bps = all_in_cost_bps - agg_fee_bps
 *
 * FABRIC $2,132 (FAIR token, block=46435607):
 *   Leg 1 (FAIR→USDC via contract 0x73f0859f…) has pi=null / MID_NULL.
 *   discoverPool(FAIR, USDC) returned no pool. Fix via two-hop:
 *     FAIR/USDC = (WETH/FAIR pool slot0 at N-1) / (market_mid USDC/WETH)
 *   Realized amounts from transfer ledger: 72,986,713.45 FAIR → 2,131.58 USDC
 *
 * FABRIC $1,447 / $1,404 / $1,342 (CLAWD, LFI/GITLAWB):
 *   Multi-split routes where legs are decomposed in the wrong direction.
 *   PI cannot be reliably patched without re-decomposing the full route.
 *   Left as-is (conf=low is accurate). Token symbols added to dashboard instead.
 *
 * Run: set -a && source .env && set +a && npx tsx packages/ingest/src/patch-batch.ts
 */
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import postgres from 'postgres';
import { readSlot0 } from './poolDiscovery.js';
import { sqrtPriceX96ToPrice } from './tokenPricing.js';

const rpc = createPublicClient({ chain: base, transport: http(process.env.TCA_RPC_URL!) });
const sql = postgres(process.env.TCA_DATABASE_URL!);

// ── 1. Non-Fabric gated: lp=0, slip=allIn-agg ─────────────────────────────────
const OTC_HASHES = [
  '0xbdaa6662fa12410d329d8954e46ea611f8a3a2008426151cba1c37121edbc9ce', // kyberswap $35045
  '0xd6bb5ae0ec9017de395fb9b0435fe18c1859c6fbf7830052bab20f36e496bc0f', // relay     $ 7499
  '0xb169b2e5b0ef710bc32be123260e2eaf3263636839bf3abcd3c2a57e9b8bf536', // nordstern $ 6328
  '0x451f2b5c0ba2b0983e5e68332c07f18f3d9caa6c869500503b5a3df513a2a2f0', // velora    $ 1235
];

console.log('=== Patch 1: Non-Fabric OTC — lp=0, slip=allIn-agg ===');
const otcRows = await sql<{ tx_hash: string; aggregator: string; all_in_cost_bps: string; agg_fee_bps: string | null }[]>`
  SELECT tx_hash, aggregator, all_in_cost_bps, agg_fee_bps
  FROM smoke_trades WHERE tx_hash = ANY(${OTC_HASHES})
`;

for (const row of otcRows) {
  const allIn = Number(row.all_in_cost_bps);
  const aggFee = Number(row.agg_fee_bps ?? 0);
  const slippage = allIn - 0 - aggFee; // lp=0

  console.log(`  ${row.aggregator.padEnd(12)} ${row.tx_hash.slice(0, 12)}…  allIn=${allIn.toFixed(2)} agg=${aggFee.toFixed(3)} → lp=0 slip=${slippage.toFixed(3)}`);

  await sql`
    UPDATE smoke_trades
    SET lp_fee_bps    = 0,
        slippage_bps  = ${slippage}
    WHERE tx_hash = ${row.tx_hash}
  `;
}
console.log(`  Done — updated ${otcRows.length} rows.\n`);

// ── 2. Fabric $2,132: FAIR leg PI via two-hop ─────────────────────────────────
const FAIR_TX   = '0xd7fc72398891a5b40fd267293d4fdf15e116e6ebcd6f2e95e3df872b4e811046';
const FAIR_BLOCK = 46435607n;
// Pools
const WETH_FAIR_POOL  = '0xfc01837343cfc2a9ddca9e8a0a19825f6b2f0460' as const; // token0=WETH, token1=FAIR
const FAIR_VENUE      = '0x73f0859f844f042cd699f35bb5fe13a120f95c0f';
// Transfer amounts (from trace/transfers in investigate output)
const FAIR_IN_HUMAN  = 72_986_713.454643;    // FAIR sent to solver
const USDC_OUT_HUMAN =  2_131.580384;         // USDC received from solver

console.log('=== Patch 2: Fabric $2,132 FAIR leg PI ===');
const [fairRow] = await sql<{
  route_legs: unknown; all_in_cost_bps: string; market_mid: string; normalize_flags: unknown;
}[]>`
  SELECT route_legs, all_in_cost_bps, market_mid, normalize_flags
  FROM smoke_trades WHERE tx_hash = ${FAIR_TX}
`;
if (!fairRow) { console.error('TX not found'); process.exit(1); }

const legs = Array.isArray(fairRow.route_legs)
  ? fairRow.route_legs as { venue: string; type: string; feeTierBps: number; lpFeeBps: number; priceImpactBps: number | null; [k: string]: unknown }[]
  : [];
const flags = (Array.isArray(fairRow.normalize_flags) ? fairRow.normalize_flags : []) as string[];
const marketMid = Number(fairRow.market_mid); // USDC/WETH

// Read WETH/FAIR pool slot0 at N-1
const sqrtP = await readSlot0(rpc as never, WETH_FAIR_POOL, FAIR_BLOCK - 1n);
if (sqrtP === null) { console.error('Cannot read WETH/FAIR pool slot0'); process.exit(1); }

// token0=WETH(18dec), token1=FAIR(18dec) → rawPrice = FAIR/WETH (token1/token0)
const fairPerWeth = sqrtPriceX96ToPrice(sqrtP, 18, 18);
// Two-hop FAIR/USDC reference
const fairPerUsdc = fairPerWeth / marketMid;
const usdcPerFair = fairPerUsdc > 0 ? 1 / fairPerUsdc : 0;

// Realized rate (USDC per FAIR)
const realizedUsdcPerFair = USDC_OUT_HUMAN / FAIR_IN_HUMAN;

// legCostBps = (mid - realized) / mid × 10000
const legCostBps = (usdcPerFair - realizedUsdcPerFair) / usdcPerFair * 10_000;
const leg1FeeBps = legs[1]?.feeTierBps ?? 0;
const leg1PiBps = legCostBps - leg1FeeBps;

console.log(`  WETH/FAIR pool slot0@N-1: ${fairPerWeth.toFixed(2)} FAIR/WETH`);
console.log(`  Market mid: ${marketMid.toFixed(4)} USDC/WETH`);
console.log(`  Reference  FAIR/USDC = ${fairPerUsdc.toFixed(2)}  USDC/FAIR = ${usdcPerFair.toExponential(4)}`);
console.log(`  Realized   FAIR_in=${FAIR_IN_HUMAN.toFixed(3)}  USDC_out=${USDC_OUT_HUMAN.toFixed(6)}`);
console.log(`  Realized   USDC/FAIR = ${realizedUsdcPerFair.toExponential(4)}`);
console.log(`  legCostBps=${legCostBps.toFixed(2)}  feeTier=${leg1FeeBps}bps  PI=${leg1PiBps.toFixed(2)}bps`);

if (Math.abs(leg1PiBps) > 500) {
  console.warn(`  WARNING: PI ${leg1PiBps.toFixed(2)}bps exceeds 500bps cap — not patching`);
} else {
  const patchedLegs = legs.map((l, i) =>
    i === 1 ? { ...l, priceImpactBps: parseFloat(leg1PiBps.toFixed(4)) } : l
  );
  // Remove MID_NULL flag for FAIR leg; keep everything else
  const patchedFlags = flags.filter(f => !f.startsWith('MID_NULL: leg 0x73f0859f'));

  await sql`
    UPDATE smoke_trades
    SET route_legs      = ${sql.json(patchedLegs)},
        normalize_flags = ${sql.json(patchedFlags)}
    WHERE tx_hash = ${FAIR_TX}
  `;
  console.log(`  Patched leg[1].priceImpactBps → ${leg1PiBps.toFixed(2)}bps. Removed MID_NULL flag.`);
}

// ── 3. Verify ──────────────────────────────────────────────────────────────────
console.log('\n=== Verification ===');
const ALL = [...OTC_HASHES, FAIR_TX];
const verifyRows = await sql<{
  tx_hash: string; aggregator: string; all_in_cost_bps: string; lp_fee_bps: string | null;
  agg_fee_bps: string | null; slippage_bps: string | null; route_legs: unknown;
}[]>`
  SELECT tx_hash, aggregator, all_in_cost_bps, lp_fee_bps, agg_fee_bps, slippage_bps, route_legs
  FROM smoke_trades WHERE tx_hash = ANY(${ALL})
  ORDER BY usdc_amount::numeric DESC
`;
for (const r of verifyRows) {
  const legs2 = Array.isArray(r.route_legs) ? r.route_legs as { venue: string; priceImpactBps: number | null }[] : [];
  const piSummary = legs2.length ? legs2.map(l => `pi=${l.priceImpactBps?.toFixed(2) ?? 'null'}`).join(' | ') : '';
  console.log(`  ${r.aggregator.padEnd(12)} ${r.tx_hash.slice(0, 12)}…  allIn=${Number(r.all_in_cost_bps).toFixed(2)} lp=${r.lp_fee_bps ?? 'null'} agg=${r.agg_fee_bps ?? 'null'} slip=${r.slippage_bps ? Number(r.slippage_bps).toFixed(2) : 'null'}  ${piSummary}`);
}

await sql.end();
console.log('\nDone.');
