/**
 * schema.ts — the single source of truth for the Seed layer's shape.
 *
 * A Seed row is one transaction, self-sufficient: trace, receipt, transaction
 * envelope and block header are all reachable without a join. Four columns hold
 * JSON payloads; the rest exist only so DuckDB can prune row groups without
 * decompressing those payloads.
 *
 * Timestamps are ISO 8601 UTC STRINGS in TypeScript, not Date objects, because
 * a SeedRow's serialized form is a line of NDJSON. DuckDB parses them into
 * TIMESTAMP on the way into Parquet.
 */

export const SCHEMA_VERSION = 1;

/** Whether the chain had permanently committed to this block when we read it. */
export type Finality = 'finalized' | 'safe' | 'unsafe';

/**
 * Column name → DuckDB type. Insertion order IS the Parquet column order, and
 * `schema.test.ts` freezes both. See that test before changing anything here.
 */
export const SEED_COLUMNS = {
	chain_id: 'INTEGER',
	block_number: 'BIGINT',
	block_position: 'INTEGER',
	tx_hash: 'VARCHAR',
	block_timestamp: 'TIMESTAMP',
	tx_from: 'VARCHAR',
	tx_to: 'VARCHAR',
	tx_status: 'BOOLEAN',
	block_hash: 'VARCHAR',
	trace_json: 'VARCHAR',
	receipt_json: 'VARCHAR',
	tx_json: 'VARCHAR',
	block_json: 'VARCHAR',
	finality: 'VARCHAR',
	ingested_at: 'TIMESTAMP',
	source: 'VARCHAR',
	schema_version: 'INTEGER',
} as const satisfies Readonly<Record<string, string>>;

export interface SeedRow {
	chain_id: number;
	/**
	 * Safe as a JS number: Base is near 5.1e7, and 2^53 is ~9.0e15. Stored as
	 * BIGINT in Parquet, which reads back as a `bigint` on the JS side.
	 */
	block_number: number;
	block_position: number;
	tx_hash: string;
	block_timestamp: string;
	tx_from: string;
	/** NULL for a contract-creation transaction. */
	tx_to: string | null;
	tx_status: boolean;
	block_hash: string;
	trace_json: string;
	receipt_json: string;
	tx_json: string;
	block_json: string;
	finality: Finality;
	ingested_at: string;
	source: string;
	schema_version: number;
}

/**
 * Render SEED_COLUMNS as a DuckDB `read_json(columns := …)` struct literal.
 *
 * Passing the types explicitly rather than letting DuckDB sniff them is what
 * makes the written Parquet deterministic: sniffing infers from the first rows,
 * so a chunk where every `tx_to` happened to be NULL could otherwise land a
 * different type than a chunk where one was set.
 */
export function seedColumnSpec(): string {
	const entries = Object.entries(SEED_COLUMNS).map(([name, type]) => `'${name}': '${type}'`);
	return `{${entries.join(', ')}}`;
}
