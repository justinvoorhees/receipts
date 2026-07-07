import postgres from 'postgres';
const sql = postgres(process.env.TCA_DATABASE_URL!);
const rows = await sql<{
  tx_hash: string; aggregator: string; usdc_amount: string;
  all_in_cost_bps: string; lp_fee_bps: string | null; agg_fee_bps: string | null;
  slippage_bps: string | null; leg_count: number; normalize_flags: unknown;
}[]>`
  SELECT tx_hash, aggregator, usdc_amount::text,
         all_in_cost_bps, lp_fee_bps, agg_fee_bps, slippage_bps,
         jsonb_array_length(route_legs::jsonb) as leg_count,
         normalize_flags
  FROM smoke_trades
  ORDER BY usdc_amount::numeric DESC
`;
for (const r of rows) {
  const flags = (Array.isArray(r.normalize_flags) ? r.normalize_flags : []) as string[];
  const issues = flags.filter(f => f.includes('MID_NULL') || f.includes('ROUTE_NOT') || f.includes('IMPLAUS'));
  const hasIssues = r.lp_fee_bps === null || r.slippage_bps === null || issues.length > 0;
  const mark = hasIssues ? ' ⚠' : ' ✓';
  console.log(`${r.tx_hash.slice(0,14)}… ${r.aggregator.padEnd(12)} $${Number(r.usdc_amount).toFixed(0).padStart(7)}  allIn=${Number(r.all_in_cost_bps).toFixed(2).padStart(7)}  lp=${r.lp_fee_bps ? Number(r.lp_fee_bps).toFixed(2) : 'null'}  slip=${r.slippage_bps ? Number(r.slippage_bps).toFixed(2) : 'null'}  legs=${r.leg_count}${mark}${issues.length ? '  ' + (issues[0] ?? '').slice(0, 50) : ''}`);
}
await sql.end();
