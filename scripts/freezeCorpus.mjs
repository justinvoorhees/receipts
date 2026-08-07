/**
 * freezeCorpus.mjs — one-time dump of the receipts table to a static JSON corpus.
 *
 * Run this ONCE, while the database still exists. After the database is gone
 * this file cannot be regenerated, and docs/qa/corpus.json is the only surviving
 * record of the analyzed history.
 *
 * Rows below $5 are dropped: they are dust trades whose bps figures are
 * dominated by rounding and gas, and they distort every aggregate the analysis
 * scripts compute. `notional_usd >= 5` also excludes NULLs by SQL's own rules
 * (NULL >= 5 is NULL, not true) — measured at zero such rows, but the behaviour
 * is stated here so a future reader does not have to rediscover it.
 *
 * Output is the raw postgres row shape: snake_case keys, `numeric` columns as
 * strings. That is deliberately identical to what the analysis scripts already
 * destructure, so retargeting them is a filter swap and not a rewrite.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { connect } from './analysis/_env.mjs';

const MIN_NOTIONAL_USD = 5;

const sql = await connect();
const rows = await sql`
	select * from receipts
	where notional_usd >= ${MIN_NOTIONAL_USD}
	order by id asc`;
await sql.end();

mkdirSync(new URL('../docs/qa/', import.meta.url), { recursive: true });
writeFileSync(
	new URL('../docs/qa/corpus.json', import.meta.url),
	`${JSON.stringify(rows, null, '\t')}\n`,
);

console.log(`froze ${rows.length} receipts (notional >= $${MIN_NOTIONAL_USD})`);
