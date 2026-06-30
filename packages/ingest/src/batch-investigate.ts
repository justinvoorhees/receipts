/**
 * Batch investigation of 8 remaining smoke trades with null/unresolved decomposition.
 * For each TX: decode transfers, identify all tokens and venues, classify bytecode,
 * read pool slot0, compute PI where two-hop reference is available.
 *
 * Run: set -a && source .env && set +a && npx tsx packages/ingest/src/batch-investigate.ts
 */
import { createPublicClient, http, parseAbi } from 'viem';
import { base } from 'viem/chains';
import postgres from 'postgres';
import { decodeTransferLogs } from './tradeEndpoints.js';
import { readSlot0 } from './poolDiscovery.js';
import { sqrtPriceX96ToPrice } from './tokenPricing.js';

// ── Known token symbols (to avoid extra RPC calls) ────────────────────────────
const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC',   decimals: 6  },
  '0x4200000000000000000000000000000000000006': { symbol: 'WETH',   decimals: 18 },
  '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': { symbol: 'cbETH',  decimals: 18 },
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': { symbol: 'cbBTC',  decimals: 8  },
  '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b': { symbol: 'VIRTUAL',decimals: 18 },
  '0x0555e30da8f98308edb960aa94c0db47230d2b9c': { symbol: 'WBTC',   decimals: 8  },
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { symbol: 'DAI',    decimals: 18 },
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': { symbol: 'USDbC',  decimals: 6  },
  '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42': { symbol: 'EURC',   decimals: 6  },
  '0xa1f72459dfa10bad200ac160ecd78c6b77a747be': { symbol: 'CLAWNCH',decimals: 18 },
};

// Known aggregator/router addresses that look like venues but aren't pools
const KNOWN_ROUTERS = new Set([
  '0x7c137a37742437d2212b7bd873ed135b5c4c61da', // Fabric settlement
]);

const TX_HASHES = [
  // ── Non-Fabric gated ─────────────────────────────────────────────────────
  '0xbdaa6662fa12410d329d8954e46ea611f8a3a2008426151cba1c37121edbc9ce', // kyberswap  $35 045
  '0xd6bb5ae0ec9017de395fb9b0435fe18c1859c6fbf7830052bab20f36e496bc0f', // relay      $ 7 499
  '0xb169b2e5b0ef710bc32be123260e2eaf3263636839bf3abcd3c2a57e9b8bf536', // nordstern  $ 6 328
  '0x451f2b5c0ba2b0983e5e68332c07f18f3d9caa6c869500503b5a3df513a2a2f0', // velora     $ 1 235
  // ── Fabric complex-routing ───────────────────────────────────────────────
  '0xd7fc72398891a5b40fd267293d4fdf15e116e6ebcd6f2e95e3df872b4e811046', // fabric     $ 2 132
  '0xbc853779e6c5f846a08917a1afc710e17181fd0a31983723e15080497f63fe54', // fabric     $ 1 447
  '0x5bd00e22bab13fdf083525bb68633e6bf5dd581ae00a0f8b89329ada7065c2e9', // fabric     $ 1 404
  '0xe4b9514743e4f211b456f14c69fd3c4abddf68a620becbdcb1ffa7771c42f4b7', // fabric     $ 1 342
];

const ERC20_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);
const POOL_ABI = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function factory() view returns (address)',
  'function poolManager() view returns (address)',
]);
const BAL_ABI = parseAbi(['function balanceOf(address) view returns (uint256)']);

interface TraceNode {
  from?: string; to?: string; value?: string;
  logs?: { address: string; data: string; topics: readonly string[] }[];
  calls?: TraceNode[];
}
function flatLogs(t: TraceNode): { address: string; data: string; topics: readonly string[] }[] {
  const out: typeof t.logs extends undefined ? never[] : NonNullable<typeof t.logs> = [];
  const visit = (n: TraceNode) => { if (n.logs) out.push(...n.logs); n.calls?.forEach(visit); };
  visit(t);
  return out as { address: string; data: string; topics: readonly string[] }[];
}

const rpc = createPublicClient({ chain: base, transport: http(process.env.TCA_RPC_URL!) });
const sql = postgres(process.env.TCA_DATABASE_URL!);

// Token metadata cache
const tokenCache = new Map<string, { symbol: string; decimals: number }>();
for (const [a, v] of Object.entries(KNOWN_TOKENS)) tokenCache.set(a, v);

async function getTokenMeta(addr: string): Promise<{ symbol: string; decimals: number }> {
  const key = addr.toLowerCase();
  if (tokenCache.has(key)) return tokenCache.get(key)!;
  try {
    const [symbol, decimals] = await Promise.all([
      rpc.readContract({ address: addr as `0x${string}`, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => '???'),
      rpc.readContract({ address: addr as `0x${string}`, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18 as number),
    ]);
    const meta = { symbol: String(symbol), decimals: Number(decimals) };
    tokenCache.set(key, meta);
    return meta;
  } catch {
    return { symbol: addr.slice(0, 8), decimals: 18 };
  }
}

async function classifyVenue(addr: string, blockNumber: bigint): Promise<{
  kind: 'eoa' | 'pool_v3' | 'pool_v4' | 'contract';
  token0?: string; token1?: string; fee?: number;
  mid?: number; sym0?: string; sym1?: string; dec0?: number; dec1?: number;
}> {
  const code = await rpc.getBytecode({ address: addr as `0x${string}` });
  if (!code || code === '0x') return { kind: 'eoa' };

  // Try V3-style pool
  try {
    const [t0, t1, fee] = await Promise.all([
      rpc.readContract({ address: addr as `0x${string}`, abi: POOL_ABI, functionName: 'token0', blockNumber }),
      rpc.readContract({ address: addr as `0x${string}`, abi: POOL_ABI, functionName: 'token1', blockNumber }),
      rpc.readContract({ address: addr as `0x${string}`, abi: POOL_ABI, functionName: 'fee', blockNumber }),
    ]);
    const [m0, m1] = await Promise.all([getTokenMeta(t0), getTokenMeta(t1)]);
    const sqrtP = await readSlot0(rpc as never, addr as `0x${string}`, blockNumber - 1n);
    let mid: number | undefined;
    if (sqrtP !== null) mid = sqrtPriceX96ToPrice(sqrtP, m0.decimals, m1.decimals);
    return { kind: 'pool_v3', token0: t0, token1: t1, fee: Number(fee), mid, sym0: m0.symbol, sym1: m1.symbol, dec0: m0.decimals, dec1: m1.decimals };
  } catch { /* not V3 */ }

  // Try V4-style (has poolManager)
  try {
    await rpc.readContract({ address: addr as `0x${string}`, abi: POOL_ABI, functionName: 'poolManager', blockNumber });
    return { kind: 'pool_v4' };
  } catch { /* not V4 */ }

  return { kind: 'contract' };
}

// Fetch DB rows first
const dbRows = await sql<{
  tx_hash: string; aggregator: string; usdc_amount: string; all_in_cost_bps: string;
  market_mid: string; block_number: number; route_legs: unknown; normalize_flags: unknown;
}[]>`
  SELECT tx_hash, aggregator, usdc_amount, all_in_cost_bps, market_mid, block_number,
         route_legs, normalize_flags
  FROM smoke_trades WHERE tx_hash = ANY(${TX_HASHES})
`;
const dbByHash = new Map(dbRows.map(r => [r.tx_hash, r]));

// ── Main loop ──────────────────────────────────────────────────────────────────
for (const txHash of TX_HASHES) {
  const db = dbByHash.get(txHash);
  if (!db) { console.log(`\n[${txHash.slice(0, 10)}] NOT IN DB`); continue; }

  const legs = Array.isArray(db.route_legs)
    ? db.route_legs as { venue: string; type: string; tokenIn: string; tokenOut: string; feeTierBps: number; lpFeeBps: number; priceImpactBps: number | null }[]
    : [];
  const flags = (Array.isArray(db.normalize_flags) ? db.normalize_flags : []) as string[];
  const marketMid = Number(db.market_mid);
  const blockNumber = BigInt(db.block_number);

  console.log(`\n${'═'.repeat(90)}`);
  console.log(`TX   ${txHash}`);
  console.log(`AGG  ${db.aggregator.padEnd(12)} $${Number(db.usdc_amount).toFixed(0).padStart(7)}  allIn=${Number(db.all_in_cost_bps).toFixed(2)}bps  mid=${marketMid.toFixed(2)} USDC/WETH  block=${db.block_number}`);

  // Fetch receipt + trace in parallel
  let receipt: Awaited<ReturnType<typeof rpc.getTransactionReceipt>>;
  let trace: TraceNode;
  try {
    [receipt, trace] = await Promise.all([
      rpc.getTransactionReceipt({ hash: txHash as `0x${string}` }),
      (rpc.request as unknown as (r: { method: string; params: unknown[] }) => Promise<unknown>)({
        method: 'debug_traceTransaction',
        params: [txHash, { tracer: 'callTracer', tracerConfig: { withLog: true, onlyTopCall: false } }],
      }).then(r => r as TraceNode),
    ]);
  } catch (e) {
    console.log(`  RPC ERROR: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
    continue;
  }
  console.log(`GAS  ${receipt.gasUsed.toLocaleString()} used`);

  // Decode transfers
  const allLogs = flatLogs(trace);
  const transfers = decodeTransferLogs(allLogs as never);

  // Identify unique token addresses
  const tokenAddrs = new Set(transfers.map(t => t.token.toLowerCase()));
  const tokenMeta = new Map<string, { symbol: string; decimals: number }>();
  await Promise.all([...tokenAddrs].map(async a => { tokenMeta.set(a, await getTokenMeta(a)); }));

  // Print transfer ledger
  console.log(`\nTRANSFERS (${transfers.length}):`);
  for (const t of transfers) {
    const meta = tokenMeta.get(t.token.toLowerCase()) ?? { symbol: '?', decimals: 18 };
    const amount = Number(t.value) / 10 ** meta.decimals;
    const fmt = amount < 0.001 ? amount.toExponential(4) : amount.toLocaleString('en-US', { maximumFractionDigits: 6 });
    console.log(`  ${meta.symbol.padEnd(8)} ${fmt.padStart(20)}  from=${t.from.slice(0, 12)}  to=${t.to.slice(0, 12)}`);
  }

  // Identify all unique venue-like addresses (from legs + from transfers that aren't known tokens or traders)
  const venueAddrs = new Set<string>();
  for (const l of legs) venueAddrs.add(l.venue.toLowerCase());
  // Also scan transfers for addresses that aren't traders or settlement contracts
  const traderAddrs = new Set(transfers.map(t => [t.from.toLowerCase(), t.to.toLowerCase()]).flat());
  for (const a of traderAddrs) {
    if (!tokenMeta.has(a) && !KNOWN_ROUTERS.has(a)) venueAddrs.add(a);
  }

  // Classify venues
  console.log(`\nVENUES:`);
  const venueInfo = new Map<string, Awaited<ReturnType<typeof classifyVenue>>>();
  // Classify in parallel
  const classifications = await Promise.all(
    [...venueAddrs].map(async addr => {
      const info = await classifyVenue(addr, blockNumber);
      return { addr, info };
    })
  );
  for (const { addr, info } of classifications) {
    venueInfo.set(addr, info);
    const isLeg = legs.some(l => l.venue.toLowerCase() === addr);
    const marker = isLeg ? '★' : ' ';
    if (info.kind === 'eoa') {
      // Check USDC balance (might be a solver)
      let usdcBal = '';
      try {
        const bal = await rpc.readContract({ address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', abi: BAL_ABI, functionName: 'balanceOf', args: [addr as `0x${string}`], blockNumber });
        if (bal > 0n) usdcBal = ` (USDC bal after: ${(Number(bal)/1e6).toFixed(2)})`;
      } catch { /* skip */ }
      console.log(`  ${marker} ${addr}  EOA/solver${usdcBal}`);
    } else if (info.kind === 'pool_v3') {
      const midStr = info.mid !== undefined ? `  mid@N-1=${info.mid.toFixed(6)} ${info.sym1}/${info.sym0}` : '';
      console.log(`  ${marker} ${addr}  V3 pool: ${info.sym0}/${info.sym1}  fee=${info.fee}(${(info.fee!/100).toFixed(0)}bps)${midStr}`);
    } else if (info.kind === 'pool_v4') {
      console.log(`  ${marker} ${addr}  V4 position manager`);
    } else {
      console.log(`  ${marker} ${addr}  contract (unknown type)`);
    }
  }

  // Stored legs + PI
  if (legs.length > 0) {
    console.log(`\nSTORED LEGS:`);
    for (const l of legs) {
      const sym0 = l.tokenIn ? (tokenMeta.get(l.tokenIn.toLowerCase())?.symbol ?? l.tokenIn.slice(0, 8)) : '?';
      const sym1 = l.tokenOut ? (tokenMeta.get(l.tokenOut.toLowerCase())?.symbol ?? l.tokenOut.slice(0, 8)) : '?';
      console.log(`  ${l.venue.slice(0, 14)}  type=${l.type}  ${sym0}→${sym1}  fee=${l.feeTierBps}bps  lp=${l.lpFeeBps}bps  pi=${l.priceImpactBps?.toFixed(2) ?? 'null'}`);
    }

    // ── Attempt PI derivation for OTC legs with null PI ─────────────────
    console.log(`\nPI ANALYSIS:`);
    for (const l of legs) {
      if (l.priceImpactBps !== null) {
        console.log(`  ${l.venue.slice(0, 14)}  pi=${l.priceImpactBps.toFixed(2)}bps  (already computed)`);
        continue;
      }
      const symIn  = l.tokenIn  ? (tokenMeta.get(l.tokenIn.toLowerCase())?.symbol  ?? '?') : '?';
      const symOut = l.tokenOut ? (tokenMeta.get(l.tokenOut.toLowerCase())?.symbol ?? '?') : '?';
      const info = venueInfo.get(l.venue.toLowerCase());

      if (info?.kind === 'pool_v3' && info.mid !== undefined) {
        // V3 pool — pi = legTotalCostBps - feeTier, but we need realized amounts
        console.log(`  ${l.venue.slice(0, 14)}  V3 ${symIn}→${symOut}  ref-mid=${info.mid.toFixed(6)} (need realized amounts to compute PI)`);
      } else if (info?.kind === 'eoa') {
        // OTC solver — try two-hop if one of the tokens is WETH or can be priced via WETH
        const WETH = '0x4200000000000000000000000000000000000006';
        const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
        const tokenIn  = l.tokenIn?.toLowerCase()  ?? '';
        const tokenOut = l.tokenOut?.toLowerCase() ?? '';
        const isUsdcIn  = tokenIn  === USDC;
        const isUsdcOut = tokenOut === USDC;
        const isWethIn  = tokenIn  === WETH;
        const isWethOut = tokenOut === WETH;

        if ((isUsdcIn || isWethIn) && !isUsdcOut && !isWethOut) {
          // intermediate token — look for its WETH pool among known leg venues
          const otherToken = isUsdcIn ? tokenOut : tokenOut;
          // Try to find a V3 pool for otherToken/WETH in the same tx
          const wethPool = classifications.find(c =>
            c.info.kind === 'pool_v3' &&
            ((c.info.token0?.toLowerCase() === WETH && c.info.token1?.toLowerCase() === otherToken) ||
             (c.info.token1?.toLowerCase() === WETH && c.info.token0?.toLowerCase() === otherToken))
          );
          if (wethPool?.info.kind === 'pool_v3' && wethPool.info.mid !== undefined) {
            // Determine price direction: mid is token1/token0
            const isToken0Weth = wethPool.info.token0?.toLowerCase() === WETH;
            // if token0=WETH, token1=other → mid = other/WETH → 1/mid = WETH/other
            const wethPerOther = isToken0Weth ? (wethPool.info.mid > 0 ? 1 / wethPool.info.mid : 0) : wethPool.info.mid;
            const usdcPerOther = wethPerOther * marketMid;
            const otherPerUsdc = usdcPerOther > 0 ? 1 / usdcPerOther : 0;
            const metaIn  = tokenMeta.get(tokenIn)  ?? { symbol: '?', decimals: 18 };
            const metaOut = tokenMeta.get(tokenOut) ?? { symbol: '?', decimals: 18 };

            // Get realized amounts from transfers
            const solverAddr = l.venue.toLowerCase();
            const inTransfer  = transfers.find(t => t.to.toLowerCase()   === solverAddr && t.token.toLowerCase() === tokenIn);
            const outTransfer = transfers.find(t => t.from.toLowerCase() === solverAddr && t.token.toLowerCase() === tokenOut);
            if (!outTransfer) {
              // Also check Fabric settlement as intermediary
              const settlIn  = transfers.find(t => t.token.toLowerCase() === tokenIn  && t.to.toLowerCase()   !== solverAddr);
              const settlOut = transfers.find(t => t.token.toLowerCase() === tokenOut && t.from.toLowerCase() !== solverAddr);
              if (settlIn && settlOut) {
                const amtIn  = Number(settlIn.value)  / 10 ** metaIn.decimals;
                const amtOut = Number(settlOut.value) / 10 ** metaOut.decimals;
                console.log(`  ${l.venue.slice(0, 14)}  OTC ${symIn}→${symOut}  amounts=${amtIn.toFixed(4)} ${symIn} → ${amtOut.toFixed(4)} ${symOut}`);
                console.log(`    ref (two-hop) ${symOut}/USDC = ${otherPerUsdc.toFixed(4)} via WETH  marketMid=${marketMid.toFixed(2)}`);
                const realizedOtherPerUsdc = amtOut / amtIn;
                const costBps = (otherPerUsdc - realizedOtherPerUsdc) / otherPerUsdc * 10_000;
                console.log(`    realized ${symOut}/USDC = ${realizedOtherPerUsdc.toFixed(4)}  legCostBps=${costBps.toFixed(2)}  PI=${costBps.toFixed(2)}bps`);
              } else {
                console.log(`  ${l.venue.slice(0, 14)}  OTC ${symIn}→${symOut}  ref-mid=${otherPerUsdc.toExponential(4)} USDC/${symOut}  (can't find transfer amounts)`);
              }
            } else {
              const amtIn  = inTransfer  ? Number(inTransfer.value)  / 10 ** metaIn.decimals  : NaN;
              const amtOut =               Number(outTransfer.value) / 10 ** metaOut.decimals;
              const realizedRate = isUsdcIn ? amtOut / amtIn : amtIn / amtOut;
              const refRate = isUsdcIn ? otherPerUsdc : usdcPerOther;
              const costBps = (refRate - realizedRate) / refRate * 10_000;
              const piSymbol = isUsdcIn ? `${symOut}/USDC` : `${symIn}/USDC`;
              console.log(`  ${l.venue.slice(0, 14)}  OTC ${symIn}→${symOut}  realized ${piSymbol}=${realizedRate.toFixed(6)}  ref=${refRate.toFixed(6)}  legCostBps=${costBps.toFixed(2)}  PI=${costBps.toFixed(2)}bps`);
            }
          } else {
            console.log(`  ${l.venue.slice(0, 14)}  OTC ${symIn}→${symOut}  no reference pool found for ${symOut}/WETH — PI cannot be computed`);
          }
        } else {
          console.log(`  ${l.venue.slice(0, 14)}  OTC ${symIn}→${symOut}  not a USDC-in or WETH-in leg — PI skip`);
        }
      } else {
        console.log(`  ${l.venue.slice(0, 14)}  ${symIn}→${symOut}  kind=${info?.kind ?? 'unknown'}  PI not computable without realized amounts`);
      }
    }
  } else {
    // No stored legs — summarize the transfer-derived route
    console.log(`\nROUTE INFERENCE (no stored legs):`);
    const FABRIC = '0x7c137a37742437d2212b7bd873ed135b5c4c61da';
    const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const WETH = '0x4200000000000000000000000000000000000006';
    // Find trader: who received WETH (or USDC for sells)
    const wethReceiver = transfers.find(t => t.token.toLowerCase() === WETH && t.to.toLowerCase() !== FABRIC);
    const usdcSender   = transfers.find(t => t.token.toLowerCase() === USDC && t.from.toLowerCase() !== FABRIC);
    if (wethReceiver) console.log(`  WETH receiver (likely trader): ${wethReceiver.to}`);
    if (usdcSender)   console.log(`  USDC sender  (likely trader): ${usdcSender.from}`);
    // Show intermediate tokens
    const intermediates = [...tokenAddrs].filter(a => a !== USDC && a !== WETH);
    for (const a of intermediates) {
      const m = tokenMeta.get(a);
      console.log(`  intermediate token: ${a}  ${m?.symbol ?? '?'}  decimals=${m?.decimals ?? '?'}`);
    }
  }

  // Relevant flags
  const importantFlags = flags.filter(f => !f.startsWith('BENCH_') && !f.startsWith('NO_DUNE'));
  if (importantFlags.length) {
    console.log(`\nFLAGS (${importantFlags.length}):`);
    for (const f of importantFlags) console.log(`  ${f.slice(0, 140)}`);
  }
}

await sql.end();
console.log(`\n${'═'.repeat(90)}\nDone.`);
