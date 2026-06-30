/**
 * Fix three bugs in decompose-remaining.ts / fix-clawd-pi.ts:
 *
 * 1. Type strings 'uniswap_v3'/'uniswap_v4' fall through to toUpperCase() in the
 *    dashboard's getVenueLabel(). Correct types are 'univ3'/'univ4'.
 *
 * 2. TX1 leg2 and TX2 leg1 were attributed to fake pool 0x72ab388e2f4e10…
 *    (N/A on Basescan). Tracing the receipts shows the WETH↔USDC conversion is
 *    a Fabric OFP P2P fill via market maker 0x72ab388e2e2f… (same address in both
 *    transactions, emits 0x19b47279… OFP fill event). LP fee = 0.
 *
 * 3. TX1 Split A cbBTC leg: 0xb94b22332abf… is another OFP market maker
 *    (cbBTC↔USDC P2P fill), not a V3 pool. LP fee = 0.
 *
 * Run: set -a && source .env && set +a && npx tsx packages/ingest/src/fix-route-types.ts
 */
import postgres from 'postgres';
const sql = postgres(process.env.TCA_DATABASE_URL!);

const WETH    = '0x4200000000000000000000000000000000000006';
const USDC    = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const CLAWD   = '0x9f86db9fc6f7c9408e8fda3ff8ce4e78ac7a6b07';
const LFI     = '0x3722264ab15a1dfce5a5af89e6547f7949a8aba3';
const GITLAWB = '0x5f980dcfc4c0fa3911554cf5ab288ed0eb13dba3';
const cbBTC   = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';

const CLAWD_WETH_POOL = '0xcd55381a53da35ab1d7bc5e3fe5f76cac976fac3'; // V3 fee=10000
const LFI_WETH_POOL   = '0x588f68b9fa04366f33f8ce095c13f0cebab9406a'; // V3 fee=10000
const LFI_USDC_POOL   = '0x41932ea9b35bd2e663678dfca8228498a05a3689'; // V3 fee=2500
const V4              = '0x498581ff718922c3f8e6a244956af099b2652b2b'; // Uniswap V4 PoolManager
const WETH_USDC_OFP   = '0x72ab388e2e2f6facef59e3c3fa2c4e29011c2d38'; // Fabric OFP WETH/USDC MM
const CBTC_USDC_OFP   = '0xb94b22332abf5f89877a14cc88f2abc48c34b3df'; // Fabric OFP cbBTC/USDC MM

// ── TX1: CLAWD→USDC 3-split sell ──────────────────────────────────────────────
// Trace-verified route:
//   Split B (79%): CLAWD → V3 CLAWD/WETH → WETH → OFP WETH/USDC fill → USDC
//   Split C  (4%): CLAWD → V4 (two internal hops: CLAWD/WETH fee=10000 + WETH/USDC fee=500) → USDC
//   Split A (18%): CLAWD → V4 (CLAWD→cbBTC fee=10000) → OFP cbBTC/USDC fill → USDC
// LP fees: V3 CLAWD/WETH=100bps, V4 Split C≈105bps (10000+500), V4 Split A=100bps, OFP fills=0
const TX1 = '0xbc853779e6c5f846a08917a1afc710e17181fd0a31983723e15080497f63fe54';
const USDC_A = 328.96, USDC_B = 1447.21, USDC_C = 64.88;
const totalUsdc1 = USDC_A + USDC_B + USDC_C;
const wtdLp1 = (USDC_A * 100 + USDC_B * 100 + USDC_C * 105) / totalUsdc1;
const [row1] = await sql<{all_in_cost_bps:string;agg_fee_bps:string|null}[]>`
  SELECT all_in_cost_bps, agg_fee_bps FROM smoke_trades WHERE tx_hash = ${TX1}
`;
const slip1 = Number(row1.all_in_cost_bps) - wtdLp1 - Number(row1.agg_fee_bps ?? 0);

const legs1 = [
  // Split B — dominant path (79%)
  { venue: CLAWD_WETH_POOL, type: 'univ3', tokenIn: CLAWD, tokenOut: WETH,
    feeTierBps: 100, lpFeeBps: 100, priceImpactBps: 182.9378, splitFraction: 0.7857 },
  { venue: WETH_USDC_OFP,   type: 'rfq',   tokenIn: WETH,  tokenOut: USDC,
    feeTierBps: 0,   lpFeeBps: 0,   priceImpactBps: 1.5985,   splitFraction: 0.7857 },
  // Split C — small V4 path (4%)
  { venue: V4,              type: 'univ4', tokenIn: CLAWD, tokenOut: USDC,
    feeTierBps: null, lpFeeBps: null, priceImpactBps: 417.7548, splitFraction: 0.0357 },
  // Split A — cbBTC path (18%)
  { venue: V4,              type: 'univ4', tokenIn: CLAWD, tokenOut: cbBTC,
    feeTierBps: 100, lpFeeBps: 100, priceImpactBps: null,      splitFraction: 0.1786 },
  { venue: CBTC_USDC_OFP,  type: 'rfq',   tokenIn: cbBTC, tokenOut: USDC,
    feeTierBps: 0,   lpFeeBps: 0,   priceImpactBps: null,      splitFraction: 0.1786 },
];

// ── TX2: USDC→CLAWD purchase ───────────────────────────────────────────────────
// Trace-verified route:
//   Split B (97%): USDC → OFP USDC/WETH fill → WETH → V3 WETH/CLAWD → CLAWD
//   Split A  (3%): USDC → V4 (fee=500) → CLAWD
// LP fees: OFP USDC→WETH=0bps, V3 WETH/CLAWD=100bps, V4=5bps
const TX2 = '0x5bd00e22bab13fdf083525bb68633e6bf5dd581ae00a0f8b89329ada7065c2e9';
const USDC_B2 = 1403.71, USDC_A2 = 42.54;
const totalUsdc2 = USDC_B2 + USDC_A2;
const wtdLp2 = (USDC_B2 * (0 + 100) + USDC_A2 * 5) / totalUsdc2;
const [row2] = await sql<{all_in_cost_bps:string;agg_fee_bps:string|null}[]>`
  SELECT all_in_cost_bps, agg_fee_bps FROM smoke_trades WHERE tx_hash = ${TX2}
`;
const slip2 = Number(row2.all_in_cost_bps) - wtdLp2 - Number(row2.agg_fee_bps ?? 0);

const legs2 = [
  // Split B — dominant path (97%)
  { venue: WETH_USDC_OFP,   type: 'rfq',   tokenIn: USDC,  tokenOut: WETH,
    feeTierBps: 0,   lpFeeBps: 0,   priceImpactBps: -0.0048,  splitFraction: 0.9706 },
  { venue: CLAWD_WETH_POOL, type: 'univ3', tokenIn: WETH,  tokenOut: CLAWD,
    feeTierBps: 100, lpFeeBps: 100, priceImpactBps: 324.6647, splitFraction: 0.9706 },
  // Split A — small V4 path (3%)
  { venue: V4,              type: 'univ4', tokenIn: USDC,  tokenOut: CLAWD,
    feeTierBps: 5,   lpFeeBps: 5,   priceImpactBps: 335.3172, splitFraction: 0.0294 },
];

// ── TX3: LFI→GITLAWB ──────────────────────────────────────────────────────────
const TX3 = '0xe4b9514743e4f211b456f14c69fd3c4abddf68a620becbdcb1ffa7771c42f4b7';
const legs3 = [
  { venue: LFI_WETH_POOL, type: 'univ3', tokenIn: LFI,  tokenOut: WETH,
    feeTierBps: 100, lpFeeBps: 100, priceImpactBps: 25.8702,  splitFraction: 0.9091 },
  { venue: V4,            type: 'univ4', tokenIn: WETH,  tokenOut: USDC,
    feeTierBps: 1,   lpFeeBps: 1,   priceImpactBps: -0.7103,  splitFraction: 0.9091 },
  { venue: V4,            type: 'univ4', tokenIn: USDC,  tokenOut: GITLAWB,
    feeTierBps: null, lpFeeBps: null, priceImpactBps: null,    splitFraction: 1.0,
    note: 'PI unavailable — no GITLAWB reference pool' },
  { venue: LFI_USDC_POOL, type: 'univ3', tokenIn: LFI,  tokenOut: USDC,
    feeTierBps: 25,  lpFeeBps: 25,  priceImpactBps: 271.6882, splitFraction: 0.0909 },
];
// TX3 LP/slip unchanged from decompose-remaining (124.17 / -124.44)

console.log('Updating TX1…  wtdLP=' + wtdLp1.toFixed(2) + '  slip=' + slip1.toFixed(2));
await sql`
  UPDATE smoke_trades
  SET route_legs   = ${sql.json(legs1)},
      lp_fee_bps   = ${parseFloat(wtdLp1.toFixed(4))},
      slippage_bps = ${parseFloat(slip1.toFixed(4))}
  WHERE tx_hash = ${TX1}
`;

console.log('Updating TX2…  wtdLP=' + wtdLp2.toFixed(2) + '  slip=' + slip2.toFixed(2));
await sql`
  UPDATE smoke_trades
  SET route_legs   = ${sql.json(legs2)},
      lp_fee_bps   = ${parseFloat(wtdLp2.toFixed(4))},
      slippage_bps = ${parseFloat(slip2.toFixed(4))}
  WHERE tx_hash = ${TX2}
`;

console.log('Updating TX3…  (LP/slip unchanged)');
await sql`UPDATE smoke_trades SET route_legs = ${sql.json(legs3)} WHERE tx_hash = ${TX3}`;

// Verify
console.log('\n=== Verification ===');
const rows = await sql<{
  tx_hash: string; lp_fee_bps: string | null; slippage_bps: string | null;
  all_in_cost_bps: string; route_legs: unknown;
}[]>`
  SELECT tx_hash, all_in_cost_bps, lp_fee_bps, slippage_bps, route_legs
  FROM smoke_trades WHERE tx_hash = ANY(${[TX1, TX2, TX3]})
  ORDER BY usdc_amount::numeric DESC
`;
for (const r of rows) {
  const legs = Array.isArray(r.route_legs) ? r.route_legs as {
    type: string; tokenIn: string; tokenOut: string; venue: string;
    feeTierBps: number | null; priceImpactBps: number | null; splitFraction?: number;
  }[] : [];
  console.log(`\n${r.tx_hash.slice(0,14)}…  allIn=${Number(r.all_in_cost_bps).toFixed(2)}  lp=${r.lp_fee_bps ? Number(r.lp_fee_bps).toFixed(2) : 'null'}  slip=${r.slippage_bps ? Number(r.slippage_bps).toFixed(2) : 'null'}`);
  for (const l of legs) {
    const pct = l.splitFraction != null ? ` (${(l.splitFraction * 100).toFixed(0)}%)` : '';
    const venueShort = l.venue?.slice(0, 12) ?? '?';
    console.log(`  ${l.type.padEnd(8)} ${venueShort}…  ${l.tokenIn?.slice(0,8)}→${l.tokenOut?.slice(0,8)}  fee=${l.feeTierBps ?? '?'}bps  pi=${l.priceImpactBps?.toFixed(2) ?? 'null'}${pct}`);
  }
}

await sql.end();
console.log('\nDone.');
