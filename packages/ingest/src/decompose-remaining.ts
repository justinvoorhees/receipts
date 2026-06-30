/**
 * Full route decomposition + PI patch for 3 remaining Fabric trades whose stored
 * route_legs were assembled in the wrong direction by the multi-split decomposer.
 *
 * Trade 1: 0xbc853779… $1,447  block=46842721  CLAWD→USDC 3-split sell
 * Trade 2: 0x5bd00e22… $1,404  block=46975353  USDC→CLAWD 2-split purchase
 * Trade 3: 0xe4b9514…  $1,342  block=46386347  LFI→GITLAWB exotic
 *
 * Run: set -a && source .env && set +a && npx tsx packages/ingest/src/decompose-remaining.ts
 */
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import postgres from 'postgres';
import { readSlot0 } from './poolDiscovery.js';
import { sqrtPriceX96ToPrice } from './tokenPricing.js';

const rpc = createPublicClient({ chain: base, transport: http(process.env.TCA_RPC_URL!) });
const sql = postgres(process.env.TCA_DATABASE_URL!);

// ── Addresses ──────────────────────────────────────────────────────────────────
const WETH       = '0x4200000000000000000000000000000000000006';
const USDC       = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const CLAWD      = '0x9f86db9fc6f7c9408e8fda3ff8ce4e78ac7a6b07';
const LFI        = '0x3722264ab15a1dfce5a5af89e6547f7949a8aba3';
const GITLAWB    = '0x5f980dcfc4c0fa3911554cf5ab288ed0eb13dba3';
const cbBTC      = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';

const CLAWD_WETH_POOL = '0xcd55381a53da35ab1d7bc5e3fe5f76cac976fac3' as const; // fee=10000
const WETH_USDC_POOL  = '0x72ab388e2f4e10fb4b41a41761b24cb12b7ce43b' as const; // fee=100 (actual V3 pool)
const LFI_WETH_POOL   = '0x588f68b9fa04366f33f8ce095c13f0cebab9406a' as const; // fee=10000
const LFI_USDC_POOL   = '0x41932ea9b35bd2e663678dfca8228498a05a3689' as const; // fee=2500
const USDC_CLAWD_POOL = '0xb72a6e1091d43e19284050b7132e0646509eba5d' as const; // V3 reference for V4 splits

const V4_POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b';

// ── Helpers ────────────────────────────────────────────────────────────────────
function bps(cost: number) { return parseFloat(cost.toFixed(4)); }

// PI = (midRate - realizedRate) / midRate × 10000  (positive = cost paid by trader)
function legPiBps(midRate: number, realizedRate: number) {
  return (midRate - realizedRate) / midRate * 10_000;
}

// ══════════════════════════════════════════════════════════════════════════════
// TRADE 1: 0xbc853779… CLAWD→USDC 3-split sell  block=46842721
// ══════════════════════════════════════════════════════════════════════════════
const TX1 = '0xbc853779e6c5f846a08917a1afc710e17181fd0a31983723e15080497f63fe54';
const BLOCK1 = 46842721n;

console.log('\n══ Trade 1: CLAWD→USDC 3-split sell (' + TX1.slice(0, 12) + '…) ══\n');

// Market mid (USDC/WETH) from smoke_trades
const [tx1row] = await sql<{ market_mid: string; all_in_cost_bps: string; agg_fee_bps: string | null }[]>`
  SELECT market_mid, all_in_cost_bps, agg_fee_bps FROM smoke_trades WHERE tx_hash = ${TX1}
`;
const tx1MarketMid = Number(tx1row.market_mid); // USDC per WETH
console.log(`  market_mid USDC/WETH = ${tx1MarketMid.toFixed(4)}`);

// Read CLAWD/WETH pool slot0 at N-1 = block 46842720
const sqrtP_clawd_sell = await readSlot0(rpc as never, CLAWD_WETH_POOL, BLOCK1 - 1n);
if (!sqrtP_clawd_sell) throw new Error('Cannot read CLAWD/WETH slot0 for sell block');
// token0=CLAWD(18dec), token1=WETH(18dec) → rawPrice = WETH/CLAWD = token1/token0
const wethPerClawd_sell = sqrtPriceX96ToPrice(sqrtP_clawd_sell, 18, 18);
const clawdPerWeth_sell = 1 / wethPerClawd_sell;
console.log(`  CLAWD/WETH pool slot0@${BLOCK1 - 1n}: ${clawdPerWeth_sell.toFixed(0)} CLAWD/WETH (mid)`);

// ── Split A: 20,084,640 CLAWD → V4 (CLAWD→cbBTC fee=10000) → 0.004907 cbBTC → V3 (cbBTC→USDC fee=100) → 328.96 USDC
// For Split A, reference CLAWD→USDC = clawdPerWeth_sell → tx1MarketMid
// Realized CLAWD/USDC = 20,084,640 / 328.96
const splitA_clawdIn  = 20_084_640;
const splitA_usdcOut  = 328.96;
const splitA_refClawdPerUsdc = clawdPerWeth_sell / tx1MarketMid; // CLAWD per USDC
const splitA_realClawdPerUsdc = splitA_clawdIn / splitA_usdcOut;
// PI positive = trader paid more CLAWD per USDC than mid (cost)
const splitA_allInBps = legPiBps(1 / splitA_refClawdPerUsdc, splitA_usdcOut / splitA_clawdIn);
// But for a sell trade: realizedUsdcPerClawd vs midUsdcPerClawd
const midUsdcPerClawd_sell = tx1MarketMid / clawdPerWeth_sell;
const realUsdcPerClawd_A = splitA_usdcOut / splitA_clawdIn;
const splitA_pi = legPiBps(midUsdcPerClawd_sell, realUsdcPerClawd_A);
console.log(`  Split A: ${splitA_clawdIn.toLocaleString()} CLAWD → ${splitA_usdcOut} USDC`);
console.log(`    mid USDC/CLAWD=${midUsdcPerClawd_sell.toExponential(4)}  real=${realUsdcPerClawd_A.toExponential(4)}  allIn=${splitA_pi.toFixed(2)}bps`);

// ── Split B: 88,372,416 CLAWD → CLAWD/WETH V3 (fee=10000) → 0.772418 WETH → WETH/USDC V3 (fee=100) → 1,447.21 USDC
const splitB_clawdIn  = 88_372_416;
const splitB_wethOut  = 0.772418;
const splitB_usdcOut  = 1447.21;
// Leg 1: CLAWD→WETH  mid=wethPerClawd_sell
const realWethPerClawd_B = splitB_wethOut / splitB_clawdIn;
const splitB_leg1_allIn = legPiBps(wethPerClawd_sell, realWethPerClawd_B);
const splitB_leg1_pi = bps(splitB_leg1_allIn - 100); // fee=10000 = 100bps
// Leg 2: WETH→USDC  mid=tx1MarketMid
const realUsdcPerWeth_B = splitB_usdcOut / splitB_wethOut;
const splitB_leg2_allIn = legPiBps(tx1MarketMid, realUsdcPerWeth_B);
const splitB_leg2_pi = bps(splitB_leg2_allIn - 1); // fee=100 = 1bps
console.log(`  Split B: ${splitB_clawdIn.toLocaleString()} CLAWD → ${splitB_wethOut} WETH → ${splitB_usdcOut} USDC`);
console.log(`    leg1 CLAWD→WETH: mid=${wethPerClawd_sell.toExponential(4)} real=${realWethPerClawd_B.toExponential(4)} allIn=${splitB_leg1_allIn.toFixed(2)}bps pi=${splitB_leg1_pi.toFixed(2)}bps`);
console.log(`    leg2 WETH→USDC:  mid=${tx1MarketMid.toFixed(4)} real=${realUsdcPerWeth_B.toFixed(4)} allIn=${splitB_leg2_allIn.toFixed(2)}bps pi=${splitB_leg2_pi.toFixed(2)}bps`);

// ── Split C: 4,016,928 CLAWD → V4 (fee=500) → 64.88 USDC
const splitC_clawdIn  = 4_016_928;
const splitC_usdcOut  = 64.88;
const realUsdcPerClawd_C = splitC_usdcOut / splitC_clawdIn;
const splitC_pi = legPiBps(midUsdcPerClawd_sell, realUsdcPerClawd_C);
console.log(`  Split C: ${splitC_clawdIn.toLocaleString()} CLAWD → ${splitC_usdcOut} USDC`);
console.log(`    V4 allIn=${splitC_pi.toFixed(2)}bps`);

// ── Volume-weighted LP fee
const tx1_totalOut = splitA_usdcOut + splitB_usdcOut + splitC_usdcOut;
const tx1_wLP = (splitA_usdcOut * (100 + 100) + splitB_usdcOut * (100 + 1) + splitC_usdcOut * 5) / tx1_totalOut;
// Split A: V4 has no standard fee (estimated 100bps = 10000 fee tier) + V3 100 = 1bps
// Split B: V3 10000 = 100bps CLAWD/WETH + V3 100 = 1bps
// Split C: V4 fee=500 = 5bps
const splitA_lpBps = 100 + 1;  // V4 fee=10000 (100bps) + V3 fee=100 (1bps)
const splitB_lpBps = 100 + 1;  // V3 10000 + V3 100
const splitC_lpBps = 5;        // V4 fee=500
const tx1_wtdLp = (splitA_usdcOut * splitA_lpBps + splitB_usdcOut * splitB_lpBps + splitC_usdcOut * splitC_lpBps) / tx1_totalOut;
const tx1_allIn = Number(tx1row.all_in_cost_bps);
const tx1_aggFee = Number(tx1row.agg_fee_bps ?? 0);
const tx1_slippage = tx1_allIn - tx1_wtdLp - tx1_aggFee;
console.log(`\n  Weighted LP fee = ${tx1_wtdLp.toFixed(2)}bps  allIn=${tx1_allIn.toFixed(2)}  agg=${tx1_aggFee}  → slippage=${tx1_slippage.toFixed(2)}bps`);

// Build corrected route_legs for Trade 1
// Overall trade is CLAWD→USDC.  Three parallel splits are flattened as sequential summary legs.
// We represent the dominant path (Split B) as 2 legs, with note on shape=complex.
const tx1_legs = [
  {
    venue: CLAWD_WETH_POOL,
    type: 'uniswap_v3',
    tokenIn: CLAWD,
    tokenOut: WETH,
    feeTierBps: 100,
    lpFeeBps: 100,
    priceImpactBps: bps(splitB_leg1_pi),
    splitFraction: 0.7857,
  },
  {
    venue: WETH_USDC_POOL,
    type: 'uniswap_v3',
    tokenIn: WETH,
    tokenOut: USDC,
    feeTierBps: 1,
    lpFeeBps: 1,
    priceImpactBps: bps(splitB_leg2_pi),
    splitFraction: 0.7857,
  },
  {
    venue: V4_POOL_MANAGER,
    type: 'uniswap_v4',
    tokenIn: CLAWD,
    tokenOut: USDC,
    feeTierBps: 5,
    lpFeeBps: 5,
    priceImpactBps: bps(splitC_pi),
    splitFraction: 0.0357,
  },
  {
    venue: V4_POOL_MANAGER,
    type: 'uniswap_v4',
    tokenIn: CLAWD,
    tokenOut: cbBTC,
    feeTierBps: 100,
    lpFeeBps: 100,
    priceImpactBps: bps(splitA_pi),
    splitFraction: 0.1786,
  },
];

await sql`
  UPDATE smoke_trades
  SET route_legs    = ${sql.json(tx1_legs)},
      lp_fee_bps    = ${bps(tx1_wtdLp)},
      slippage_bps  = ${bps(tx1_slippage)}
  WHERE tx_hash = ${TX1}
`;
console.log('  ✓ Trade 1 patched.\n');

// ══════════════════════════════════════════════════════════════════════════════
// TRADE 2: 0x5bd00e22… USDC→CLAWD 2-split purchase  block=46975353
// ══════════════════════════════════════════════════════════════════════════════
const TX2 = '0x5bd00e22bab13fdf083525bb68633e6bf5dd581ae00a0f8b89329ada7065c2e9';
const BLOCK2 = 46975353n;

console.log('══ Trade 2: USDC→CLAWD purchase (' + TX2.slice(0, 12) + '…) ══\n');

const [tx2row] = await sql<{ market_mid: string; all_in_cost_bps: string; agg_fee_bps: string | null }[]>`
  SELECT market_mid, all_in_cost_bps, agg_fee_bps FROM smoke_trades WHERE tx_hash = ${TX2}
`;
const tx2MarketMid = Number(tx2row.market_mid);
console.log(`  market_mid USDC/WETH = ${tx2MarketMid.toFixed(4)}`);

// Read CLAWD/WETH pool slot0 at N-1 = block 46975352
const sqrtP_clawd_buy = await readSlot0(rpc as never, CLAWD_WETH_POOL, BLOCK2 - 1n);
if (!sqrtP_clawd_buy) throw new Error('Cannot read CLAWD/WETH slot0 for buy block');
const wethPerClawd_buy = sqrtPriceX96ToPrice(sqrtP_clawd_buy, 18, 18);
const clawdPerWeth_buy = 1 / wethPerClawd_buy;
const midClawdPerUsdc_buy = clawdPerWeth_buy / tx2MarketMid;
console.log(`  CLAWD/WETH pool slot0@${BLOCK2 - 1n}: ${clawdPerWeth_buy.toFixed(0)} CLAWD/WETH`);
console.log(`  mid CLAWD/USDC = ${midClawdPerUsdc_buy.toFixed(0)}`);

// Also read USDC/CLAWD V3 pool for Split A reference
const sqrtP_usdc_clawd = await readSlot0(rpc as never, USDC_CLAWD_POOL, BLOCK2 - 1n);
let splitA_ref_clawdPerUsdc = midClawdPerUsdc_buy; // fallback
if (sqrtP_usdc_clawd) {
  // USDC/CLAWD pool: token0=USDC(6dec), token1=CLAWD(18dec) → rawPrice = CLAWD/USDC × 10^(18-6) = CLAWD/USDC × 10^12
  // sqrtPriceX96ToPrice(sqrtP, 6, 18) = (sqrtP/2^96)^2 × 10^(18-6) = CLAWD per USDC scaled
  const rawClawdPerUsdc = sqrtPriceX96ToPrice(sqrtP_usdc_clawd, 6, 18);
  splitA_ref_clawdPerUsdc = rawClawdPerUsdc;
  console.log(`  USDC/CLAWD V3 pool slot0@N-1: ${rawClawdPerUsdc.toFixed(0)} CLAWD/USDC (direct ref)`);
}

// ── Split A: 42.54 USDC → V4 (fee=500) → 3,358,695 CLAWD
const splitA2_usdcIn   = 42.54;
const splitA2_clawdOut = 3_358_695;
const realClawdPerUsdc_A2 = splitA2_clawdOut / splitA2_usdcIn;
// For a buy, PI = (mid - realized) / mid where a higher realized rate is GOOD for trader
// Positive PI = trader got fewer CLAWD per USDC than mid (cost)
const splitA2_pi = legPiBps(splitA_ref_clawdPerUsdc, realClawdPerUsdc_A2);
console.log(`  Split A: ${splitA2_usdcIn} USDC → ${splitA2_clawdOut.toLocaleString()} CLAWD`);
console.log(`    mid=${splitA_ref_clawdPerUsdc.toFixed(0)} real=${realClawdPerUsdc_A2.toFixed(0)} allIn=${splitA2_pi.toFixed(2)}bps`);

// ── Split B: 1,403.71 USDC → WETH/USDC V3 (fee=100) → 0.895788 WETH → CLAWD/WETH V3 (fee=10000) → 110,772,727 CLAWD
const splitB2_usdcIn   = 1403.71;
const splitB2_wethOut  = 0.895788;
const splitB2_clawdOut = 110_772_727;
// Leg 1: USDC→WETH  mid = 1/tx2MarketMid WETH/USDC
const midWethPerUsdc = 1 / tx2MarketMid;
const realWethPerUsdc_B2 = splitB2_wethOut / splitB2_usdcIn;
const splitB2_leg1_allIn = legPiBps(midWethPerUsdc, realWethPerUsdc_B2);
const splitB2_leg1_pi = bps(splitB2_leg1_allIn - 1);
// Leg 2: WETH→CLAWD  mid = clawdPerWeth_buy
const realClawdPerWeth_B2 = splitB2_clawdOut / splitB2_wethOut;
const splitB2_leg2_allIn = legPiBps(clawdPerWeth_buy, realClawdPerWeth_B2);
const splitB2_leg2_pi = bps(splitB2_leg2_allIn - 100);
console.log(`  Split B: ${splitB2_usdcIn} USDC → ${splitB2_wethOut} WETH → ${splitB2_clawdOut.toLocaleString()} CLAWD`);
console.log(`    leg1 USDC→WETH:  mid=${midWethPerUsdc.toExponential(4)} real=${realWethPerUsdc_B2.toExponential(4)} allIn=${splitB2_leg1_allIn.toFixed(2)}bps pi=${splitB2_leg1_pi.toFixed(2)}bps`);
console.log(`    leg2 WETH→CLAWD: mid=${clawdPerWeth_buy.toFixed(0)} real=${realClawdPerWeth_B2.toFixed(0)} allIn=${splitB2_leg2_allIn.toFixed(2)}bps pi=${splitB2_leg2_pi.toFixed(2)}bps`);

const tx2_totalUsdc = splitA2_usdcIn + splitB2_usdcIn; // dust is negligible
const splitA2_lpBps = 5;       // V4 fee=500
const splitB2_lpBps = 1 + 100; // V3 100 + V3 10000
const tx2_wtdLp = (splitA2_usdcIn * splitA2_lpBps + splitB2_usdcIn * splitB2_lpBps) / tx2_totalUsdc;
const tx2_allIn = Number(tx2row.all_in_cost_bps);
const tx2_aggFee = Number(tx2row.agg_fee_bps ?? 0);
const tx2_slippage = tx2_allIn - tx2_wtdLp - tx2_aggFee;
console.log(`\n  Weighted LP fee = ${tx2_wtdLp.toFixed(2)}bps  allIn=${tx2_allIn.toFixed(2)}  agg=${tx2_aggFee}  → slippage=${tx2_slippage.toFixed(2)}bps`);

const tx2_legs = [
  {
    venue: WETH_USDC_POOL,
    type: 'uniswap_v3',
    tokenIn: USDC,
    tokenOut: WETH,
    feeTierBps: 1,
    lpFeeBps: 1,
    priceImpactBps: bps(splitB2_leg1_pi),
    splitFraction: 0.9706,
  },
  {
    venue: CLAWD_WETH_POOL,
    type: 'uniswap_v3',
    tokenIn: WETH,
    tokenOut: CLAWD,
    feeTierBps: 100,
    lpFeeBps: 100,
    priceImpactBps: bps(splitB2_leg2_pi),
    splitFraction: 0.9706,
  },
  {
    venue: V4_POOL_MANAGER,
    type: 'uniswap_v4',
    tokenIn: USDC,
    tokenOut: CLAWD,
    feeTierBps: 5,
    lpFeeBps: 5,
    priceImpactBps: bps(splitA2_pi),
    splitFraction: 0.0294,
  },
];

await sql`
  UPDATE smoke_trades
  SET route_legs    = ${sql.json(tx2_legs)},
      lp_fee_bps    = ${bps(tx2_wtdLp)},
      slippage_bps  = ${bps(tx2_slippage)}
  WHERE tx_hash = ${TX2}
`;
console.log('  ✓ Trade 2 patched.\n');

// ══════════════════════════════════════════════════════════════════════════════
// TRADE 3: 0xe4b9514… LFI→GITLAWB exotic  block=46386347
// ══════════════════════════════════════════════════════════════════════════════
const TX3 = '0xe4b9514743e4f211b456f14c69fd3c4abddf68a620becbdcb1ffa7771c42f4b7';
const BLOCK3 = 46386347n;

console.log('══ Trade 3: LFI→GITLAWB (' + TX3.slice(0, 12) + '…) ══\n');

const [tx3row] = await sql<{ market_mid: string; all_in_cost_bps: string; agg_fee_bps: string | null }[]>`
  SELECT market_mid, all_in_cost_bps, agg_fee_bps FROM smoke_trades WHERE tx_hash = ${TX3}
`;
const tx3MarketMid = Number(tx3row.market_mid);
console.log(`  market_mid USDC/WETH = ${tx3MarketMid.toFixed(4)}`);

// Read LFI/WETH and LFI/USDC pool slot0 at N-1 = block 46386346
const [sqrtP_lfi_weth, sqrtP_lfi_usdc] = await Promise.all([
  readSlot0(rpc as never, LFI_WETH_POOL, BLOCK3 - 1n),
  readSlot0(rpc as never, LFI_USDC_POOL, BLOCK3 - 1n),
]);
if (!sqrtP_lfi_weth) throw new Error('Cannot read LFI/WETH slot0');
if (!sqrtP_lfi_usdc) throw new Error('Cannot read LFI/USDC slot0');

// LFI/WETH pool: need to know token0/token1 ordering
// From resolve-token-addrs: pool label is "LFI/WETH" — let's check which is token0
// LFI=0x3722264a...  WETH=0x42000000...  Lexicographic: 0x37... < 0x42... → LFI=token0, WETH=token1
// sqrtPriceX96ToPrice(sqrtP, 18, 18) = WETH/LFI (token1/token0)
const wethPerLfi = sqrtPriceX96ToPrice(sqrtP_lfi_weth, 18, 18);
const lfiPerWeth = 1 / wethPerLfi;
const midUsdcPerLfi = wethPerLfi * tx3MarketMid;
const midLfiPerUsdc = lfiPerWeth / tx3MarketMid;
console.log(`  LFI/WETH pool slot0@N-1: ${lfiPerWeth.toFixed(2)} LFI/WETH  (${wethPerLfi.toExponential(4)} WETH/LFI)`);

// LFI/USDC pool: LFI=0x3722264a... USDC=0x8335...  0x37 < 0x83 → LFI=token0, USDC=token1
// sqrtPriceX96ToPrice(sqrtP, 18, 6) = USDC/LFI in adjusted units
// decimal correction: (sqrtP/2^96)^2 × 10^(6-18) = USDC/LFI × 10^-12... need care
// Actually sqrtPriceX96ToPrice(sqrtP, dec0, dec1) returns token1/token0 price.
// With dec0=18 (LFI), dec1=6 (USDC): raw price units = USDC per LFI × 10^(6-18) = ×10^-12
// The function adjusts: rawPrice × 10^(dec1-dec0) → actually check the function signature
// From tokenPricing.ts: price = (sqrtRatioX96 / 2^96)^2 × 10^(dec1-dec0)
// So with dec0=18, dec1=6: price = ratio^2 × 10^(6-18) = ratio^2 / 10^12 = USDC/LFI (correct units)
const usdcPerLfi_direct = sqrtPriceX96ToPrice(sqrtP_lfi_usdc, 18, 6);
console.log(`  LFI/USDC pool slot0@N-1: ${usdcPerLfi_direct.toExponential(4)} USDC/LFI  (cross-check via WETH: ${midUsdcPerLfi.toExponential(4)})`);

// Use the direct LFI/USDC pool as reference for LFI legs (more direct, fee=2500)
const refUsdcPerLfi = usdcPerLfi_direct;

// ── Split A (90.91%): 6,132,670 LFI → LFI/WETH V3 (fee=10000) → 0.646923 WETH → WETH/USDC V3 → 1,342.36 USDC → V4 → 6,577,718 GITLAWB
const splitA3_lfiIn   = 6_132_670;
const splitA3_wethOut = 0.646923;
const splitA3_usdcMid = 1342.36; // USDC at midpoint
const splitA3_gitlawbOut = 6_577_718;

// Leg 1: LFI→WETH  mid=wethPerLfi
const realWethPerLfi_A3 = splitA3_wethOut / splitA3_lfiIn;
const splitA3_leg1_allIn = legPiBps(wethPerLfi, realWethPerLfi_A3);
const splitA3_leg1_pi = bps(splitA3_leg1_allIn - 100); // fee=10000=100bps
console.log(`  Split A leg1 LFI→WETH: mid=${wethPerLfi.toExponential(4)} real=${realWethPerLfi_A3.toExponential(4)} allIn=${splitA3_leg1_allIn.toFixed(2)}bps pi=${splitA3_leg1_pi.toFixed(2)}bps`);

// Leg 2: WETH→USDC  mid=tx3MarketMid
const realUsdcPerWeth_A3 = splitA3_usdcMid / splitA3_wethOut;
const splitA3_leg2_allIn = legPiBps(tx3MarketMid, realUsdcPerWeth_A3);
const splitA3_leg2_pi = bps(splitA3_leg2_allIn - 1); // fee=100=1bps
console.log(`  Split A leg2 WETH→USDC: mid=${tx3MarketMid.toFixed(4)} real=${realUsdcPerWeth_A3.toFixed(4)} allIn=${splitA3_leg2_allIn.toFixed(2)}bps pi=${splitA3_leg2_pi.toFixed(2)}bps`);

// Leg 3: USDC→GITLAWB via V4 — no direct price reference for GITLAWB, leave PI null
console.log(`  Split A leg3 USDC→GITLAWB: ${splitA3_usdcMid} USDC → ${splitA3_gitlawbOut.toLocaleString()} GITLAWB  (PI: no reference)`);

// ── Split B (9.09%): 613,267 LFI → LFI/USDC V3 (fee=2500) → 132.52 USDC → V4 → 656,428 GITLAWB
const splitB3_lfiIn   = 613_267;
const splitB3_usdcOut = 132.52;
const splitB3_gitlawbOut = 656_428;

// Leg 1: LFI→USDC direct
const realUsdcPerLfi_B3 = splitB3_usdcOut / splitB3_lfiIn;
const splitB3_leg1_allIn = legPiBps(refUsdcPerLfi, realUsdcPerLfi_B3);
const splitB3_leg1_pi = bps(splitB3_leg1_allIn - 25); // fee=2500=25bps
console.log(`  Split B leg1 LFI→USDC: mid=${refUsdcPerLfi.toExponential(4)} real=${realUsdcPerLfi_B3.toExponential(4)} allIn=${splitB3_leg1_allIn.toFixed(2)}bps pi=${splitB3_leg1_pi.toFixed(2)}bps`);

// Leg 2: USDC→GITLAWB via V4 — no reference
console.log(`  Split B leg2 USDC→GITLAWB: ${splitB3_usdcOut} USDC → ${splitB3_gitlawbOut.toLocaleString()} GITLAWB  (PI: no reference)`);

const splitA3_usdcValue = splitA3_usdcMid;
const splitB3_usdcValue = splitB3_usdcOut;
const tx3_totalUsdc = splitA3_usdcValue + splitB3_usdcValue;
// LP fees per split: A = 100bps (LFI/WETH) + 1bps (WETH/USDC) + ~30bps (V4 est)
//                   B = 25bps (LFI/USDC) + ~30bps (V4 est)
const splitA3_lpBps = 100 + 1 + 30;  // estimate V4 at 30bps = fee=3000
const splitB3_lpBps = 25 + 30;
const tx3_wtdLp = (splitA3_usdcValue * splitA3_lpBps + splitB3_usdcValue * splitB3_lpBps) / tx3_totalUsdc;
const tx3_allIn = Number(tx3row.all_in_cost_bps);
const tx3_aggFee = Number(tx3row.agg_fee_bps ?? 0);
const tx3_slippage = tx3_allIn - tx3_wtdLp - tx3_aggFee;
console.log(`\n  Weighted LP fee = ${tx3_wtdLp.toFixed(2)}bps  allIn=${tx3_allIn.toFixed(2)}  agg=${tx3_aggFee}  → slippage=${tx3_slippage.toFixed(2)}bps`);

// Check trader address for BaseName
const TRADER3 = '0x3190902df5d0e8e4c36f4f2ba62fca462ced7eb6';
let trader3Name = TRADER3;
try {
  const name = await rpc.getEnsName({ address: TRADER3 as `0x${string}` });
  if (name) { trader3Name = name; console.log(`  Trader BaseName: ${name}`); }
  else { console.log(`  Trader ${TRADER3} — no BaseName`); }
} catch { console.log(`  BaseName lookup failed for ${TRADER3}`); }

const tx3_legs = [
  {
    venue: LFI_WETH_POOL,
    type: 'uniswap_v3',
    tokenIn: LFI,
    tokenOut: WETH,
    feeTierBps: 100,
    lpFeeBps: 100,
    priceImpactBps: bps(splitA3_leg1_pi),
    splitFraction: 0.9091,
  },
  {
    venue: WETH_USDC_POOL,
    type: 'uniswap_v3',
    tokenIn: WETH,
    tokenOut: USDC,
    feeTierBps: 1,
    lpFeeBps: 1,
    priceImpactBps: bps(splitA3_leg2_pi),
    splitFraction: 0.9091,
  },
  {
    venue: V4_POOL_MANAGER,
    type: 'uniswap_v4',
    tokenIn: USDC,
    tokenOut: GITLAWB,
    feeTierBps: null,
    lpFeeBps: null,
    priceImpactBps: null,
    splitFraction: 1.0,
    note: 'PI unavailable — no GITLAWB reference pool',
  },
  {
    venue: LFI_USDC_POOL,
    type: 'uniswap_v3',
    tokenIn: LFI,
    tokenOut: USDC,
    feeTierBps: 25,
    lpFeeBps: 25,
    priceImpactBps: bps(splitB3_leg1_pi),
    splitFraction: 0.0909,
  },
];

await sql`
  UPDATE smoke_trades
  SET route_legs    = ${sql.json(tx3_legs)},
      lp_fee_bps    = ${bps(tx3_wtdLp)},
      slippage_bps  = ${bps(tx3_slippage)}
  WHERE tx_hash = ${TX3}
`;
console.log('  ✓ Trade 3 patched.\n');

// ══════════════════════════════════════════════════════════════════════════════
// VERIFICATION
// ══════════════════════════════════════════════════════════════════════════════
console.log('══ Verification ══\n');
const ALL3 = [TX1, TX2, TX3];
const verRows = await sql<{
  tx_hash: string; aggregator: string; usdc_amount: string;
  all_in_cost_bps: string; lp_fee_bps: string | null; agg_fee_bps: string | null;
  slippage_bps: string | null; route_legs: unknown;
}[]>`
  SELECT tx_hash, aggregator, usdc_amount, all_in_cost_bps, lp_fee_bps, agg_fee_bps, slippage_bps, route_legs
  FROM smoke_trades WHERE tx_hash = ANY(${ALL3})
  ORDER BY usdc_amount::numeric DESC
`;

for (const r of verRows) {
  const legs = Array.isArray(r.route_legs) ? r.route_legs as {
    venue: string; type: string; tokenIn: string; tokenOut: string;
    feeTierBps: number | null; lpFeeBps: number | null; priceImpactBps: number | null; splitFraction?: number;
  }[] : [];
  console.log(`${r.tx_hash.slice(0, 14)}… ${r.aggregator.padEnd(12)} $${Number(r.usdc_amount).toFixed(0).padStart(6)}  allIn=${Number(r.all_in_cost_bps).toFixed(2)} lp=${r.lp_fee_bps ? Number(r.lp_fee_bps).toFixed(2) : 'null'} agg=${r.agg_fee_bps ?? 'null'} slip=${r.slippage_bps ? Number(r.slippage_bps).toFixed(2) : 'null'}`);
  for (const l of legs) {
    const tIn  = l.tokenIn?.slice(0, 8) ?? '?';
    const tOut = l.tokenOut?.slice(0, 8) ?? '?';
    const split = l.splitFraction != null ? ` (${(l.splitFraction * 100).toFixed(0)}%)` : '';
    console.log(`  ${l.type.padEnd(14)} ${tIn}→${tOut}  fee=${l.feeTierBps ?? '?'}bps  pi=${l.priceImpactBps?.toFixed(2) ?? 'null'}${split}`);
  }
  console.log();
}

await sql.end();
console.log('Done.');
