import { candidatesSelectSql, candidatesSetupSql } from './candidatesSql.js';
import { derivedFilePath } from './derivedPath.js';
import { DERIVED_SCHEMA_VERSION } from './derivedSchema.js';
import { loadRouterRegistry, routerValuesSql } from './routerRegistry.js';
import { copyQueryToParquet } from './writeParquet.js';

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
	});

	return { outPath, rowCount };
}
