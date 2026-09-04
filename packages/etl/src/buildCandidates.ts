import type { DuckDBConnection } from '@duckdb/node-api';
import { candidatesSelectSql, candidatesSetupSql } from './candidatesSql.js';
import { derivedFilePath } from './derivedPath.js';
import { DERIVED_SCHEMA_VERSION } from './derivedSchema.js';
import { loadRouterRegistry, routerValuesSql } from './routerRegistry.js';
import { copyQueryToParquet, sqlLiteral } from './writeParquet.js';

/**
 * buildCandidates.ts — Seed glob in, `candidates` Parquet out. No network.
 *
 * The rows never materialize in JS: DuckDB reads the Seed Parquet, aggregates
 * the logs and COPYs straight to the output file. That is why this uses
 * copyQueryToParquet rather than writeRowsToParquet.
 */

export interface BuildCandidatesOptions {
	/** Path or glob handed to `read_parquet`. A RUNTIME value. */
	seedGlob: string;
	/** Human label stamped into every row's `seed_file`; pass the glob for a multi-file build. */
	seedFile: string;
	routersPath: string;
	dataDir: string;
	build: string;
	chain: string;
	fromBlock: number;
	toBlock: number;
	/** Injected so `derived_at` is deterministic under test. */
	now?: () => Date;
}

export interface BuildCandidatesResult {
	outPath: string;
	rowCount: number;
}

export async function buildCandidates(
	opts: BuildCandidatesOptions,
): Promise<BuildCandidatesResult> {
	const routers = await loadRouterRegistry(opts.routersPath);
	const outPath = derivedFilePath({
		dataDir: opts.dataDir,
		build: opts.build,
		family: 'candidates',
		chain: opts.chain,
		fromBlock: opts.fromBlock,
		toBlock: opts.toBlock,
	});

	const rowCount = await copyQueryToParquet({
		outPath,
		setupSql: candidatesSetupSql({
			seedGlob: opts.seedGlob,
			routerValues: routerValuesSql(routers),
		}),
		selectSql: candidatesSelectSql({
			seedFile: opts.seedFile,
			derivedAt: (opts.now?.() ?? new Date()).toISOString(),
			schemaVersion: DERIVED_SCHEMA_VERSION,
		}),
		// `--from`/`--to` are otherwise used ONLY to build the filename, and
		// derivedPath.ts's lexical-sort-equals-block-order invariant depends on
		// the filename's bounds actually matching the data. Reconcile the
		// requested range against the range the data actually contained — the
		// same convention ingest.ts uses for the delivered block vs. the
		// requested one — before the temp file is renamed into place. A range
		// that fails this is never renamed, so a good file already at `outPath`
		// is left alone and no bad file is ever published.
		validate: (connection, parquetTmpPath) =>
			assertCandidatesBlockRange(connection, parquetTmpPath, opts.fromBlock, opts.toBlock),
	});

	return { outPath, rowCount };
}

/**
 * Refuse to publish a candidates file whose actual block range falls outside
 * the range its filename claims. `derivedFilePath` bakes `fromBlock`/`toBlock`
 * into the filename without ever checking them against the Seed data, so a
 * mismatched pair (e.g. a typo, or a Seed glob that does not match the
 * requested range) previously produced a well-formed, wrongly-named file.
 */
async function assertCandidatesBlockRange(
	connection: DuckDBConnection,
	parquetTmpPath: string,
	fromBlock: number,
	toBlock: number,
): Promise<void> {
	const reader = await connection.runAndReadAll(
		`SELECT min(block_number) AS min_block, max(block_number) AS max_block
		 FROM read_parquet(${sqlLiteral(parquetTmpPath)})`,
	);
	const row = reader.getRowObjects()[0]!;
	const minBlock = Number(row.min_block as unknown as bigint);
	const maxBlock = Number(row.max_block as unknown as bigint);
	if (minBlock < fromBlock || maxBlock > toBlock) {
		throw new Error(
			`Candidates data spans blocks ${minBlock}-${maxBlock}, outside the requested range ` +
				`${fromBlock}-${toBlock}. Refusing to publish a file whose name would claim a range ` +
				`the data does not match — check --from/--to against the Seed glob actually passed.`,
		);
	}
}
