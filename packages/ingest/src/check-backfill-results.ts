/**
 * Verify the 9 newly-ingested smoke trades.
 * Run: set -a && source .env && set +a && npx tsx packages/ingest/src/check-backfill-results.ts
 */
import postgres from 'postgres';
const sql = postgres(process.env.TCA_DATABASE_URL!);

const HASHES = [
  '0xd7fc72398891a5b40fd267293d4fdf15e116e6ebcd6f2e95e3df872b4e811046',
  '0xbc853779e6c5f846a08917a1afc710e17181fd0a31983723e15080497f63fe54',
  '0x5bd00e22bab13fdf083525bb68633e6bf5dd581ae00a0f8b89329ada7065c2e9',
  '0xe4b9514743e4f211b456f14c69fd3c4abddf68a620becbdcb1ffa7771c42f4b7',
  '0xa86c70f29b212dc6beebd3ce1ef9c57415aa0701ec78d08e2fb75cf082d9a078',
  '0xbdaa6662fa12410d329d8954e46ea611f8a3a2008426151cba1c37121edbc9ce',
  '0xb169b2e5b0ef710bc32be123260e2eaf3263636839bf3abcd3c2a57e9b8bf536',
  '0xd6bb5ae0ec9017de395fb9b0435fe18c1859c6fbf7830052bab20f36e496bc0f',
  '0x451f2b5c0ba2b0983e5e68332c07f18f3d9caa6c869500503b5a3df513a2a2f0',
];

const rows = await sql<{
  tx_hash: string; aggregator: string; usdc_amount: string; all_in_cost_bps: string;
  lp_fee_bps: string | null; agg_fee_bps: string | null; slippage_bps: string | null;
  hop_count: number | null; route_shape: string | null; decomp_confidence: string | null;
  route_legs: unknown; normalize_flags: unknown;
}[]>`
  SELECT tx_hash, aggregator, usdc_amount, all_in_cost_bps, lp_fee_bps, agg_fee_bps, slippage_bps,
         hop_count, route_shape, decomp_confidence, route_legs, normalize_flags
  FROM smoke_trades
  WHERE tx_hash = ANY(${HASHES})
  ORDER BY usdc_amount::numeric DESC
`;

console.log(`Found ${rows.length}/9 rows.\n`);
for (const r of rows) {
  const legs = Array.isArray(r.route_legs) ? r.route_legs as { venue: string; type: string; lpFeeBps: number; priceImpactBps: number | null }[] : [];
  const flags = (Array.isArray(r.normalize_flags) ? r.normalize_flags : []) as string[];
  console.log(`${r.aggregator.padEnd(12)} $${Number(r.usdc_amount).toFixed(0).padStart(6)} allIn=${Number(r.all_in_cost_bps).toFixed(2).padStart(7)}bps hops=${r.hop_count ?? '?'} shape=${r.route_shape ?? '?'} conf=${r.decomp_confidence ?? '?'}`);
  console.log(`              lp=${r.lp_fee_bps ?? 'null'} agg=${r.agg_fee_bps ?? 'null'} slip=${r.slippage_bps ?? 'null'}`);
  for (const l of legs) {
    console.log(`              leg: ${(l.venue ?? '?').slice(0, 14)} type=${l.type} lpFee=${l.lpFeeBps?.toFixed(2) ?? '?'} pi=${l.priceImpactBps?.toFixed(2) ?? 'null'}`);
  }
  const importantFlags = flags.filter((f: string) => !f.startsWith('BENCH_') && !f.startsWith('NO_DUNE'));
  if (importantFlags.length) console.log(`              flags: ${importantFlags.slice(0, 3).join(' | ')}`);
  console.log('');
}

await sql.end();
