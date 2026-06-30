import postgres from 'postgres';
const sql = postgres(process.env.TCA_DATABASE_URL!);
const rows = await sql<{ tx_hash: string; aggregator: string; usdc_amount: string; block_number: number; route_legs: unknown; normalize_flags: unknown }[]>`
  SELECT tx_hash, aggregator, usdc_amount, block_number, route_legs, normalize_flags
  FROM smoke_trades
  WHERE tx_hash != '0xa86c70f29b212dc6beebd3ce1ef9c57415aa0701ec78d08e2fb75cf082d9a078'
  ORDER BY usdc_amount::numeric DESC
`;
for (const r of rows) {
  const legs = Array.isArray(r.route_legs) ? r.route_legs as { venue: string; type: string }[] : [];
  const flags = (Array.isArray(r.normalize_flags) ? r.normalize_flags : []) as string[];
  console.log(`${r.tx_hash} ${r.aggregator.padEnd(12)} $${Number(r.usdc_amount).toFixed(0).padStart(6)} block=${r.block_number}`);
  for (const l of legs) console.log(`  leg: ${l.venue} type=${l.type}`);
  for (const f of flags.filter((f: string) => f.includes('MULTI-HOP') || f.includes('COUNTER') || f.includes('MID_NULL') || f.includes('ROUTE_NOT')))
    console.log(`  >> ${f.slice(0, 150)}`);
}
await sql.end();
