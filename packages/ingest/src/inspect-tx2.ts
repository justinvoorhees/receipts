import postgres from 'postgres';
const sql = postgres(process.env.TCA_DATABASE_URL!);
const TX = '0x5bd00e22bab13fdf083525bb68633e6bf5dd581ae00a0f8b89329ada7065c2e9';
// Get column names first
const cols = await sql<{ column_name: string }[]>`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'smoke_trades' ORDER BY ordinal_position
`;
console.log('columns:', cols.map(c => c.column_name).join(', '));
const [r] = await sql`SELECT * FROM smoke_trades WHERE tx_hash = ${TX}`;
for (const [k, v] of Object.entries(r)) {
  if (k === 'route_legs' || k === 'normalize_flags') continue;
  console.log(`${k}: ${v}`);
}
console.log('route_legs:', JSON.stringify(r.route_legs, null, 2));
const flags = (Array.isArray(r.normalize_flags) ? r.normalize_flags : []) as string[];
for (const f of flags) console.log('flag:', f);
await sql.end();
