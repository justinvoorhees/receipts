import { seedColumnSpec, type SeedRow } from './schema.js';
import { writeNdjsonLines, writeRowsToParquet } from './writeParquet.js';

/**
 * writeSeedParquet.ts — Seed rows in, Parquet on disk.
 *
 * The atomic temp-then-rename dance, the NDJSON streaming and the DuckDB COPY
 * now live in writeParquet.ts, shared with the Derived layer. This file keeps
 * only what is specific to a Seed: its column spec and its sort order.
 *
 * ⚠️ `ORDER BY block_number, block_position` is load-bearing — it is what makes
 * row-group min/max statistics useful. Without it, block-range pruning does
 * nothing.
 */

/** Re-exported for the existing writeSeedParquet.test.ts, which pins its behaviour. */
export { writeNdjsonLines };

export function writeSeedParquet(rows: SeedRow[], outPath: string): Promise<number> {
	return writeRowsToParquet(rows, {
		outPath,
		columnSpec: seedColumnSpec(),
		orderBy: 'block_number, block_position',
	});
}
