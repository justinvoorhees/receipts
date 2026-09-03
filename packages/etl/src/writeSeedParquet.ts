import { DuckDBInstance } from '@duckdb/node-api';
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { seedColumnSpec, type SeedRow } from './schema.js';

/**
 * writeSeedParquet.ts — rows in, Parquet on disk.
 *
 * DuckDB does the writing, deliberately. It is the engine every Derived file
 * will read with, so having it also do the writing removes an entire class of
 * bug: a library emitting Parquet that DuckDB cannot read, or writing row-group
 * statistics that silently do not match the data.
 *
 * `core`'s atomicWriteJson cannot be reused here — it JSON.stringifies its
 * input and only writes JSON — so the temp-then-rename dance is repeated.
 */

/**
 * Rows are ordered by (block_number, block_position) AT WRITE TIME, which is
 * what makes row-group min/max statistics useful. Without it, a block-range
 * filter has to decompress every row group in the file.
 */
const ROW_GROUP_SIZE = 4096;

/** SQL string literal escaping — paths are ours, but a stray quote must not build broken SQL. */
function sqlLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

export async function writeSeedParquet(rows: SeedRow[], outPath: string): Promise<number> {
	if (rows.length === 0) {
		throw new Error(`Refusing to write ${outPath}: no rows. An empty Seed file is never correct.`);
	}

	const dir = dirname(outPath);
	mkdirSync(dir, { recursive: true });

	// Both temps live beside the target: rename is only atomic within one
	// filesystem, and the OS temp directory is frequently a different mount.
	// Uniqueness must not depend on the clock: two concurrent writes into the
	// same directory landing in the same millisecond would otherwise share a
	// stamp and clobber each other's temp files mid-flight.
	const stamp = `${process.pid}.${randomUUID()}`;
	const ndjsonPath = join(dir, `.${stamp}.ndjson.tmp`);
	const parquetTmp = join(dir, `.${stamp}.parquet.tmp`);

	try {
		writeFileSync(ndjsonPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

		const instance = await DuckDBInstance.create(':memory:');
		const connection = await instance.connect();
		await connection.run(
			`COPY (
				SELECT * FROM read_json(${sqlLiteral(ndjsonPath)},
				                        columns := ${seedColumnSpec()},
				                        format := 'newline_delimited')
				ORDER BY block_number, block_position
			) TO ${sqlLiteral(parquetTmp)}
			  (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE ${ROW_GROUP_SIZE})`,
		);

		renameSync(parquetTmp, outPath);
		return rows.length;
	} finally {
		// A failure must not litter one temp pair per attempt beside the archive.
		// Nested try/catch, mirroring atomicWrite.ts: a cleanup failure (EACCES,
		// EBUSY — anything other than "already gone", which { force: true }
		// already absorbs) must never replace whatever error is already in
		// flight from the try block above.
		try {
			rmSync(ndjsonPath, { force: true });
		} catch {
			// Best-effort cleanup; the original error (or success) still wins.
		}
		try {
			rmSync(parquetTmp, { force: true });
		} catch {
			// Best-effort cleanup; the original error (or success) still wins.
		}
	}
}
