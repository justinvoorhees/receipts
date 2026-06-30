/**
 * Fix CLAWD PI for Trades 1 and 2.
 *
 * Bug in decompose-remaining.ts: sqrtPriceX96ToPrice(sqrtP, 18, 18) on the
 * CLAWD/WETH pool (WETH=token0, CLAWD=token1) returns CLAWD/WETH (≈111M).
 * The prior script erroneously inverted this and used 1/111M for mid CLAWD/WETH,
 * giving PI=10000 bps everywhere.
 *
 * Run: set -a && source .env && set +a && npx tsx packages/ingest/src/fix-clawd-pi.ts
 */
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import postgres from 'postgres';
import { readSlot0 } from './poolDiscovery.js';
import { sqrtPriceX96ToPrice } from './tokenPricing.js';

const rpc = createPublicClient({ chain: base, transport: http(process.env.TCA_RPC_URL!) });
const sql = postgres(process.env.TCA_DATABASE_URL!);

function bps(n: number) { return parseFloat(n.toFixed(4)); }
// positive PI = cost to trader
function legPiBps(midRate: number, realizedRate: number) {
  return (midRate - realizedRate) / midRate * 10_000;
}

const WETH    = '0x4200000000000000000000000000000000000006';
const USDC    = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const CLAWD   = '0x9f86db9fc6f7c9408e8fda3ff8ce4e78ac7a6b07';
const cbBTC   = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';
const V4      = '0x498581ff718922c3f8e6a244956af099b2652b2b';

const CLAWD_WETH_POOL = '0xcd55381a53da35ab1d7bc5e3fe5f76cac976fac3' as const; // WETH=t0 CLAWD=t1
const WETH_USDC_POOL  = '0x72ab388e2f4e10fb4b41a41761b24cb12b7ce43b' as const; // fee=100
const USDC_CLAWD_POOL = '0xb72a6e1091d43e19284050b7132e0646509eba5d' as const; // USDC=t0 CLAWD=t1

// ══════════════════════════════════════════════════════════════════════════════
// TRADE 1: 0xbc853779… CLAWD→USDC 3-split sell  block=46842721
// ══════════════════════════════════════════════════════════════════════════════
const TX1 = '0xbc853779e6c5f846a08917a1afc710e17181fd0a31983723e15080497f63fe54';
const BLOCK1 = 46842721n;

console.log('══ Trade 1: CLAWD→USDC sell ══\n');
const [tx1row] = await sql<{ market_mid: string; all_in_cost_bps: string; agg_fee_bps: string | null }[]>`
  SELECT market_mid, all_in_cost_bps, agg_fee_bps FROM smoke_trades WHERE tx_hash = ${TX1}
`;
const mid1 = Number(tx1row.market_mid); // USDC/WETH

// WETH=token0 CLAWD=token1 → sqrtPriceX96ToPrice returns CLAWD/WETH
const sqrtP1 = await readSlot0(rpc as never, CLAWD_WETH_POOL, BLOCK1 - 1n);
if (!sqrtP1) throw new Error('no slot0 T1');
const clawdPerWeth1 = sqrtPriceX96ToPrice(sqrtP1, 18, 18); // ≈111M CLAWD/WETH
const wethPerClawd1 = 1 / clawdPerWeth1;
const midUsdcPerClawd1 = mid1 / clawdPerWeth1;             // USDC per CLAWD

console.log(`  market_mid=${mid1.toFixed(2)} USDC/WETH`);
console.log(`  CLAWD/WETH slot0@N-1: ${clawdPerWeth1.toFixed(0)} CLAWD/WETH`);
console.log(`  mid USDC/CLAWD: ${midUsdcPerClawd1.toExponential(4)}`);

// Transfer amounts from batch-investigate
const s1A = { clawdIn: 20_084_640,  usdcOut: 328.96  };
const s1B = { clawdIn: 88_372_416,  wethOut: 0.772418, usdcOut: 1447.21 };
const s1C = { clawdIn:  4_016_928,  usdcOut: 64.88   };

// Split A overall (CLAWD → V4 → cbBTC → V3 → USDC)
const realA1 = s1A.usdcOut / s1A.clawdIn;
const piA1   = legPiBps(midUsdcPerClawd1, realA1);

// Split B leg1: CLAWD→WETH (V3 fee=10000=100bps)
const realWethPerClawd_B1 = s1B.wethOut / s1B.clawdIn;
const allInB1_leg1 = legPiBps(wethPerClawd1, realWethPerClawd_B1);
const piB1_leg1    = bps(allInB1_leg1 - 100);
// Split B leg2: WETH→USDC (V3 fee=100=1bps)
const realUsdcPerWeth_B1 = s1B.usdcOut / s1B.wethOut;
const allInB1_leg2 = legPiBps(mid1, realUsdcPerWeth_B1);
const piB1_leg2    = bps(allInB1_leg2 - 1);

// Split C overall (CLAWD → V4 fee=500 → USDC)
const realC1 = s1C.usdcOut / s1C.clawdIn;
const piC1   = legPiBps(midUsdcPerClawd1, realC1);

console.log(`  Split A: allIn=${piA1.toFixed(2)}bps  mid=${midUsdcPerClawd1.toExponential(4)} real=${realA1.toExponential(4)}`);
console.log(`  Split B leg1: allIn=${allInB1_leg1.toFixed(2)}bps pi=${piB1_leg1.toFixed(2)}bps  mid=${wethPerClawd1.toExponential(4)} real=${realWethPerClawd_B1.toExponential(4)}`);
console.log(`  Split B leg2: allIn=${allInB1_leg2.toFixed(2)}bps pi=${piB1_leg2.toFixed(2)}bps  mid=${mid1.toFixed(2)} real=${realUsdcPerWeth_B1.toFixed(2)}`);
console.log(`  Split C: allIn=${piC1.toFixed(2)}bps  mid=${midUsdcPerClawd1.toExponential(4)} real=${realC1.toExponential(4)}`);

const total1 = s1A.usdcOut + s1B.usdcOut + s1C.usdcOut;
const wtdLp1 = (s1A.usdcOut * (100 + 1) + s1B.usdcOut * (100 + 1) + s1C.usdcOut * 5) / total1;
const allIn1 = Number(tx1row.all_in_cost_bps);
const agg1   = Number(tx1row.agg_fee_bps ?? 0);
const slip1  = allIn1 - wtdLp1 - agg1;
console.log(`  wtdLP=${wtdLp1.toFixed(2)}bps allIn=${allIn1.toFixed(2)} agg=${agg1} → slip=${slip1.toFixed(2)}bps\n`);

// Cap at ±500 if implausible
const capPi = (v: number) => Math.abs(v) > 500 ? null : bps(v);

const legs1 = [
  { venue: CLAWD_WETH_POOL, type: 'uniswap_v3', tokenIn: CLAWD, tokenOut: WETH,
    feeTierBps: 100, lpFeeBps: 100, priceImpactBps: capPi(piB1_leg1), splitFraction: 0.7857 },
  { venue: WETH_USDC_POOL,  type: 'uniswap_v3', tokenIn: WETH,  tokenOut: USDC,
    feeTierBps: 1,   lpFeeBps: 1,   priceImpactBps: capPi(piB1_leg2), splitFraction: 0.7857 },
  { venue: V4,              type: 'uniswap_v4', tokenIn: CLAWD, tokenOut: USDC,
    feeTierBps: 5,   lpFeeBps: 5,   priceImpactBps: capPi(piC1),      splitFraction: 0.0357 },
  { venue: V4,              type: 'uniswap_v4', tokenIn: CLAWD, tokenOut: cbBTC,
    feeTierBps: 100, lpFeeBps: 100, priceImpactBps: capPi(piA1),      splitFraction: 0.1786 },
];

await sql`
  UPDATE smoke_trades
  SET route_legs   = ${sql.json(legs1)},
      lp_fee_bps   = ${bps(wtdLp1)},
      slippage_bps = ${bps(slip1)}
  WHERE tx_hash = ${TX1}
`;
console.log('  ✓ Trade 1 patched.\n');

// ══════════════════════════════════════════════════════════════════════════════
// TRADE 2: 0x5bd00e22… USDC→CLAWD purchase  block=46975353
// ══════════════════════════════════════════════════════════════════════════════
const TX2 = '0x5bd00e22bab13fdf083525bb68633e6bf5dd581ae00a0f8b89329ada7065c2e9';
const BLOCK2 = 46975353n;

console.log('══ Trade 2: USDC→CLAWD purchase ══\n');
const [tx2row] = await sql<{ market_mid: string; all_in_cost_bps: string; agg_fee_bps: string | null }[]>`
  SELECT market_mid, all_in_cost_bps, agg_fee_bps FROM smoke_trades WHERE tx_hash = ${TX2}
`;
const mid2 = Number(tx2row.market_mid); // USDC/WETH

const sqrtP2 = await readSlot0(rpc as never, CLAWD_WETH_POOL, BLOCK2 - 1n);
if (!sqrtP2) throw new Error('no slot0 T2 CLAWD/WETH');
const clawdPerWeth2 = sqrtPriceX96ToPrice(sqrtP2, 18, 18); // ≈129M CLAWD/WETH
const midClawdPerUsdc2 = clawdPerWeth2 / mid2;              // CLAWD per USDC

// USDC/CLAWD pool: USDC=token0(6dec) CLAWD=token1(18dec)
const sqrtP2uc = await readSlot0(rpc as never, USDC_CLAWD_POOL, BLOCK2 - 1n);
let refClawdPerUsdc2 = midClawdPerUsdc2;
if (sqrtP2uc) {
  // token0=USDC(6dec), token1=CLAWD(18dec) → price = CLAWD/USDC adjusted for decimals
  refClawdPerUsdc2 = sqrtPriceX96ToPrice(sqrtP2uc, 6, 18);
}

console.log(`  market_mid=${mid2.toFixed(2)} USDC/WETH`);
console.log(`  CLAWD/WETH slot0@N-1: ${clawdPerWeth2.toFixed(0)} CLAWD/WETH`);
console.log(`  mid CLAWD/USDC (WETH bridge): ${midClawdPerUsdc2.toFixed(0)}`);
console.log(`  mid CLAWD/USDC (direct pool): ${refClawdPerUsdc2.toFixed(0)}`);

// Transfer amounts
const s2A = { usdcIn: 42.54,     clawdOut: 3_358_695 };
const s2B = { usdcIn: 1_403.71,  wethOut:  0.895788,  clawdOut: 110_772_727 };

// Split A: USDC → V4 (fee=500) → CLAWD  — use direct USDC/CLAWD pool as ref
const realClawdPerUsdc_A2 = s2A.clawdOut / s2A.usdcIn;
const piA2 = legPiBps(refClawdPerUsdc2, realClawdPerUsdc_A2);

// Split B leg1: USDC→WETH (V3 fee=100=1bps)
const realWethPerUsdc_B2 = s2B.wethOut / s2B.usdcIn;
const midWethPerUsdc2    = 1 / mid2;
const allInB2_leg1 = legPiBps(midWethPerUsdc2, realWethPerUsdc_B2);
const piB2_leg1    = bps(allInB2_leg1 - 1);

// Split B leg2: WETH→CLAWD (V3 fee=10000=100bps)
const realClawdPerWeth_B2 = s2B.clawdOut / s2B.wethOut;
const allInB2_leg2 = legPiBps(clawdPerWeth2, realClawdPerWeth_B2);
const piB2_leg2    = bps(allInB2_leg2 - 100);

console.log(`  Split A:       allIn=${piA2.toFixed(2)}bps  mid=${refClawdPerUsdc2.toFixed(0)} real=${realClawdPerUsdc_A2.toFixed(0)}`);
console.log(`  Split B leg1:  allIn=${allInB2_leg1.toFixed(2)}bps pi=${piB2_leg1.toFixed(2)}bps`);
console.log(`  Split B leg2:  allIn=${allInB2_leg2.toFixed(2)}bps pi=${piB2_leg2.toFixed(2)}bps  mid=${clawdPerWeth2.toFixed(0)} real=${realClawdPerWeth_B2.toFixed(0)}`);

const total2 = s2A.usdcIn + s2B.usdcIn;
const wtdLp2 = (s2A.usdcIn * 5 + s2B.usdcIn * (1 + 100)) / total2;
const allIn2 = Number(tx2row.all_in_cost_bps);
const agg2   = Number(tx2row.agg_fee_bps ?? 0);
const slip2  = allIn2 - wtdLp2 - agg2;
console.log(`  wtdLP=${wtdLp2.toFixed(2)}bps allIn=${allIn2.toFixed(2)} agg=${agg2} → slip=${slip2.toFixed(2)}bps\n`);

const legs2 = [
  { venue: WETH_USDC_POOL,  type: 'uniswap_v3', tokenIn: USDC,  tokenOut: WETH,
    feeTierBps: 1,   lpFeeBps: 1,   priceImpactBps: capPi(piB2_leg1), splitFraction: 0.9706 },
  { venue: CLAWD_WETH_POOL, type: 'uniswap_v3', tokenIn: WETH,  tokenOut: CLAWD,
    feeTierBps: 100, lpFeeBps: 100, priceImpactBps: capPi(piB2_leg2), splitFraction: 0.9706 },
  { venue: V4,              type: 'uniswap_v4', tokenIn: USDC,  tokenOut: CLAWD,
    feeTierBps: 5,   lpFeeBps: 5,   priceImpactBps: capPi(piA2),      splitFraction: 0.0294 },
];

await sql`
  UPDATE smoke_trades
  SET route_legs   = ${sql.json(legs2)},
      lp_fee_bps   = ${bps(wtdLp2)},
      slippage_bps = ${bps(slip2)}
  WHERE tx_hash = ${TX2}
`;
console.log('  ✓ Trade 2 patched.\n');

// ══════════════════════════════════════════════════════════════════════════════
// VERIFICATION — all 3 trades
// ══════════════════════════════════════════════════════════════════════════════
const TX3 = '0xe4b9514743e4f211b456f14c69fd3c4abddf68a620becbdcb1ffa7771c42f4b7';
console.log('══ Verification ══\n');
const verRows = await sql<{
  tx_hash: string; aggregator: string; usdc_amount: string;
  all_in_cost_bps: string; lp_fee_bps: string | null; agg_fee_bps: string | null;
  slippage_bps: string | null; route_legs: unknown;
}[]>`
  SELECT tx_hash, aggregator, usdc_amount, all_in_cost_bps, lp_fee_bps, agg_fee_bps, slippage_bps, route_legs
  FROM smoke_trades WHERE tx_hash = ANY(${[TX1, TX2, TX3]})
  ORDER BY usdc_amount::numeric DESC
`;

for (const r of verRows) {
  const legs = Array.isArray(r.route_legs) ? r.route_legs as {
    type: string; tokenIn: string; tokenOut: string; feeTierBps: number | null;
    priceImpactBps: number | null; splitFraction?: number;
  }[] : [];
  console.log(`${r.tx_hash.slice(0, 14)}… ${r.aggregator.padEnd(12)} $${Number(r.usdc_amount).toFixed(0).padStart(6)}`);
  console.log(`  allIn=${Number(r.all_in_cost_bps).toFixed(2)}  lp=${r.lp_fee_bps ? Number(r.lp_fee_bps).toFixed(2) : 'null'}  agg=${r.agg_fee_bps ?? 'null'}  slip=${r.slippage_bps ? Number(r.slippage_bps).toFixed(2) : 'null'}`);
  for (const l of legs) {
    const pct = l.splitFraction != null ? ` (${(l.splitFraction * 100).toFixed(0)}%)` : '';
    const tIn  = l.tokenIn?.slice(0, 8) ?? '?';
    const tOut = l.tokenOut?.slice(0, 8) ?? '?';
    console.log(`  ${l.type.padEnd(14)} ${tIn}→${tOut}  fee=${l.feeTierBps ?? '?'}bps  pi=${l.priceImpactBps?.toFixed(2) ?? 'null'}${pct}`);
  }
  console.log();
}

await sql.end();
console.log('Done.');
