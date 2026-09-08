import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * writeParquet.ts — rows or a query in, Parquet on disk, atomically.
 *
 * DuckDB does the writing, deliberately. It is the engine every Derived file
 * is read with, so having it also do the writing removes an entire class of
 * bug: a library emitting Parquet DuckDB cannot read, or writing row-group
 * statistics that silently do not match the data.
 *
 * Generalized out of writeSeedParquet.ts, which is now a caller. The Derived
 * layer needs both entry points: `writeRowsToParquet` for a JS row array, and
 * `copyQueryToParquet` for a file that is produced by SQL over Seed Parquet
 * and never materializes in JS at all.
 *
 * ⚠️ Both entry points CLOSE the DuckDB connection and instance. The Seed
 * layer's original never did — harmless for a one-shot CLI, a native-memory
 * leak the moment a Derived build calls it in a loop.
 */

/**
 * Rows are ordered AT WRITE TIME, which is what makes row-group min/max
 * statistics useful. Without it, a block-range filter has to decompress every
 * row group in the file.
 *
 * ⚠️ 4096 was reasoned against an estimated ~17 KB/row; the pilot Seed measured
 * ~945 bytes/row, so the premise has already moved. It is a knob to revisit
 * with measurement against real Derived query patterns, not a settled number.
 */
const DEFAULT_ROW_GROUP_SIZE = 4096;

/** SQL string literal escaping — paths are ours, but a stray quote must not build broken SQL. */
export function sqlLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/** One NDJSON line per row, produced lazily so the whole batch is never held as one string. */
function* ndjsonLines(rows: readonly unknown[]): Generator<string> {
	for (const row of rows) {
		yield `${JSON.stringify(row)}\n`;
	}
}

/**
 * Stream rows into a writable sink one line at a time, instead of building one
 * monolithic `rows.map(...).join('\n')` string.
 *
 * A single JS string is capped at `buffer.constants.MAX_STRING_LENGTH` (512
 * MiB on Node 20), and a full ingest batch measures well past that — the
 * `join('\n')` approach threw `RangeError: Invalid string length` on a real
 * 300-block pilot before this fix. The row ARRAY itself is fine (it already
 * fit in memory to get here); only the serialization step needed to change.
 *
 * `pipeline` gets backpressure and error handling for free: it only pulls the
 * next line once the sink's buffer has drained, and it propagates the sink's
 * own error while destroying both ends.
 */
export function writeNdjsonLines(rows: readonly unknown[], sink: Writable): Promise<void> {
	return pipeline(Readable.from(ndjsonLines(rows)), sink);
}

/**
 * Run `body` against a fresh in-memory DuckDB, closing both handles afterwards
 * whatever happens. `closeSync` on an already-closed handle is not expected
 * here — each is closed exactly once — so failures are not swallowed.
 *
 * Nested try/finally, not a flat one: `instance.connect()` and `body()` can
 * each throw before the other handle exists or after it is already open, so
 * only nesting guarantees `instance.closeSync()` still runs when `connect()`
 * itself throws, and that a throwing `connection.closeSync()` cannot skip it.
 *
 * Exported so other readers (e.g. factCacheStore.ts's `readRows`) reuse this
 * shape instead of nesting a second copy that can drift from it.
 */
export async function withDuckDb<T>(body: (connection: DuckDBConnection) => Promise<T>): Promise<T> {
	const instance = await DuckDBInstance.create(':memory:');
	try {
		const connection = await instance.connect();
		try {
			return await body(connection);
		} finally {
			connection.closeSync();
		}
	} finally {
		instance.closeSync();
	}
}

/** Temp paths beside the target, unique without depending on the clock. */
function tempPaths(outPath: string): { dir: string; ndjson: string; parquet: string } {
	const dir = dirname(outPath);
	// Both temps live beside the target: rename is only atomic within one
	// filesystem, and the OS temp directory is frequently a different mount.
	// Uniqueness must not depend on the clock: two concurrent writes into the
	// same directory landing in the same millisecond would otherwise share a
	// stamp and clobber each other's temp files mid-flight.
	const stamp = `${process.pid}.${randomUUID()}`;
	return {
		dir,
		ndjson: join(dir, `.${stamp}.ndjson.tmp`),
		parquet: join(dir, `.${stamp}.parquet.tmp`),
	};
}

/**
 * A failure must not litter one temp pair per attempt beside the archive.
 * Nested try/catch, mirroring atomicWrite.ts: a cleanup failure (EACCES,
 * EBUSY — anything other than "already gone", which { force: true } absorbs)
 * must never replace whatever error is already in flight.
 */
function cleanup(...paths: string[]): void {
	for (const path of paths) {
		try {
			rmSync(path, { force: true });
		} catch {
			// Best-effort cleanup; the original error (or success) still wins.
		}
	}
}

function copySql(selectSql: string, parquetTmp: string, rowGroupSize: number): string {
	return `COPY (${selectSql}) TO ${sqlLiteral(parquetTmp)}
	  (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE ${rowGroupSize})`;
}

/** Write a JS row array to Parquet. `columnSpec` comes from `derivedColumnSpec`. */
export async function writeRowsToParquet(
	rows: readonly unknown[],
	opts: { outPath: string; columnSpec: string; orderBy: string; rowGroupSize?: number },
): Promise<number> {
	if (rows.length === 0) {
		throw new Error(`Refusing to write ${opts.outPath}: no rows. An empty file is never correct.`);
	}
	const { dir, ndjson, parquet } = tempPaths(opts.outPath);
	mkdirSync(dir, { recursive: true });

	try {
		await writeNdjsonLines(rows, createWriteStream(ndjson));
		await withDuckDb((connection) =>
			connection.run(
				copySql(
					`SELECT * FROM read_json(${sqlLiteral(ndjson)},
					                         columns := ${opts.columnSpec},
					                         format := 'newline_delimited')
					 ORDER BY ${opts.orderBy}`,
					parquet,
					opts.rowGroupSize ?? DEFAULT_ROW_GROUP_SIZE,
				),
			),
		);
		renameSync(parquet, opts.outPath);
		return rows.length;
	} finally {
		cleanup(ndjson, parquet);
	}
}

/**
 * Write the result of a SQL query to Parquet, without materializing it in JS.
 * `setupSql` statements run in order first (views, macros, lookup tables).
 *
 * Refuses to write an empty result for the same reason `writeRowsToParquet`
 * does: a Derived file with no rows is a build that silently did nothing.
 */
export async function copyQueryToParquet(opts: {
	outPath: string;
	setupSql?: readonly string[];
	selectSql: string;
	rowGroupSize?: number;
	/**
	 * Runs against the just-written temp Parquet, after the COPY but before the
	 * empty-result check and the atomic rename — i.e. before the result is
	 * published. Throw to refuse publishing; the temp file is still cleaned up
	 * and `outPath` (if something already lives there) is left untouched.
	 */
	validate?: (connection: DuckDBConnection, parquetTmpPath: string) => Promise<void>;
}): Promise<number> {
	const { dir, parquet } = tempPaths(opts.outPath);
	mkdirSync(dir, { recursive: true });

	try {
		const count = await withDuckDb(async (connection) => {
			for (const statement of opts.setupSql ?? []) {
				await connection.run(statement);
			}
			await connection.run(
				copySql(opts.selectSql, parquet, opts.rowGroupSize ?? DEFAULT_ROW_GROUP_SIZE),
			);
			await opts.validate?.(connection, parquet);
			const reader = await connection.runAndReadAll(
				`SELECT count(*) AS n FROM read_parquet(${sqlLiteral(parquet)})`,
			);
			// count(*) comes back as a JS bigint; the double cast is what the
			// package's DuckDBValue union requires.
			return Number(reader.getRowObjects()[0]!.n as unknown as bigint);
		});

		if (count === 0) {
			throw new Error(`Refusing to write ${opts.outPath}: no rows. An empty file is never correct.`);
		}
		renameSync(parquet, opts.outPath);
		return count;
	} finally {
		cleanup(parquet);
	}
}
