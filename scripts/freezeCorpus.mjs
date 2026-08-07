/**
 * freezeCorpus.mjs — one-time dump of the receipts table to a static JSON corpus.
 *
 * The database this script talks to was removed from the running product
 * (see docs/superpowers/specs/2026-08-06-database-removal-design.md). This
 * script is retained ONLY as a pre-teardown escape hatch: the Railway
 * Postgres instance still exists as of this writing, and if it turns out
 * docs/qa/corpus.json needs to be regenerated or widened before that
 * instance is deleted, this is the tool to do it with.
 *
 * `--dry` is the safe mode: it connects, counts the rows that would be
 * frozen, prints the count, and writes nothing. Always run with `--dry`
 * first:
 *
 *   node scripts/freezeCorpus.mjs --dry
 *
 * A BARE RUN (no `--dry`) OVERWRITES docs/qa/corpus.json, which is frozen
 * at 62 rows and pinned by a checksum test (scripts/corpus.test.mjs). Do
 * not run it bare unless you specifically intend to replace the frozen
 * corpus — e.g. a full unfiltered re-dump before the Railway instance is
 * deleted.
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
 *
 * This script is intentionally self-contained (its own env read, its own
 * `postgres` import) rather than sharing scripts/analysis/_env.mjs: that
 * file no longer talks to a database at all (its loadCorpus() reads the
 * frozen JSON instead), and this script needs to keep working as a DB
 * client even after _env.mjs sheds its last connection-adjacent code.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const MIN_NOTIONAL_USD = 5;
const DRY_RUN = process.argv.includes('--dry');

const env = Object.fromEntries(
	readFileSync(new URL('../.env', import.meta.url), 'utf8')
		.split('\n').filter((l) => l.includes('='))
		.map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const { default: postgres } = await import('postgres');
const sql = postgres(env.TCA_DATABASE_URL, { ssl: 'require', max: 1 });

if (DRY_RUN) {
	const [{ count }] = await sql`
		select count(*) from receipts
		where notional_usd >= ${MIN_NOTIONAL_USD}`;
	await sql.end();
	console.log(`[dry run] would freeze ${count} receipts (notional >= $${MIN_NOTIONAL_USD}) — wrote nothing`);
	process.exit(0);
}

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
