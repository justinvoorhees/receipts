/**
 * derivedSchema.ts — the shape of the Derived layer's files.
 *
 * The Seed layer's schema is FROZEN: rebuilding a Seed means re-fetching from
 * an endpoint that may no longer agree. A Derived file has no such problem —
 * it rebuilds from Seeds in seconds with no network — so this schema is
 * VERSIONED instead. Change it deliberately and bump DERIVED_SCHEMA_VERSION,
 * so a file on disk can be told apart from one written by a later shape.
 *
 * Insertion order IS the Parquet column order. `derivedSchema.test.ts` pins it.
 */

/** Bumped on ANY change to a Derived column list, including an addition. */
export const DERIVED_SCHEMA_VERSION = 1;

/**
 * One row per candidate swap transaction.
 *
 * `selected_via` records WHY the row is here:
 *   'swap_log' — emits at least one v2/v3/v4 Swap log, tx.to is not a known router
 *   'router'   — tx.to IS a known router, but no Swap log was emitted
 *   'both'     — both
 *
 * ⚠️ The 'router' rows are kept deliberately. They are the approvals, bridge
 * calls and reverts that a router-address filter sweeps up, and omitting them
 * would make their absence invisible. A research table needs its own
 * denominator.
 *
 * ⚠️ Wei quantities are VARCHAR decimal strings. uint256 has no native Parquet
 * type, and DECIMAL(38,0) cannot hold the range. `gas_used` is the exception:
 * gas is bounded by the block gas limit, so BIGINT is safe and far easier to
 * aggregate.
 */
export const CANDIDATE_COLUMNS = {
	chain_id: 'INTEGER',
	block_number: 'BIGINT',
	block_position: 'INTEGER',
	tx_hash: 'VARCHAR',
	block_timestamp: 'TIMESTAMP',
	tx_from: 'VARCHAR',
	tx_to: 'VARCHAR',
	tx_status: 'BOOLEAN',
	selected_via: 'VARCHAR',
	router_name: 'VARCHAR',
	router_version: 'VARCHAR',
	swap_log_count: 'INTEGER',
	v2_legs: 'INTEGER',
	v3_legs: 'INTEGER',
	v4_legs: 'INTEGER',
	/**
	 * ⚠️ Counted on the CORRECT pool identity: a v4 pool is its `poolId`
	 * (`topics[1]`), not the Swap log's emitter. All v4 legs in the pilot window
	 * come from two singletons, so counting emitters collapses 485 pools to 2.
	 */
	distinct_pools: 'INTEGER',
	distinct_v4_poolids: 'INTEGER',
	log_count: 'INTEGER',
	erc20_transfer_count: 'INTEGER',
	gas_used: 'BIGINT',
	effective_gas_price: 'VARCHAR',
	l1_fee: 'VARCHAR',
	tx_value: 'VARCHAR',
	seed_file: 'VARCHAR',
	derived_at: 'TIMESTAMP',
	derived_schema_version: 'INTEGER',
} as const satisfies Readonly<Record<string, string>>;

export interface CandidateRow {
	chain_id: number;
	block_number: number;
	block_position: number;
	tx_hash: string;
	block_timestamp: string;
	tx_from: string;
	tx_to: string | null;
	tx_status: boolean;
	selected_via: 'swap_log' | 'router' | 'both';
	router_name: string | null;
	router_version: string | null;
	swap_log_count: number;
	v2_legs: number;
	v3_legs: number;
	v4_legs: number;
	distinct_pools: number;
	distinct_v4_poolids: number;
	log_count: number;
	erc20_transfer_count: number;
	gas_used: number;
	/** Wei, decimal string. NULL when the payload exceeds 2^128 (see HEX_TO_DEC_MACRO). */
	effective_gas_price: string | null;
	l1_fee: string | null;
	tx_value: string | null;
	seed_file: string;
	derived_at: string;
	derived_schema_version: number;
}

/**
 * Render a column map as a DuckDB `read_json(columns := …)` struct literal.
 * Passing types explicitly rather than letting DuckDB sniff them is what makes
 * the written Parquet deterministic: sniffing infers from the first rows, so a
 * chunk where a column happened to be all-NULL could land a different type.
 */
export function derivedColumnSpec(columns: Readonly<Record<string, string>>): string {
	const entries = Object.entries(columns);
	if (entries.length === 0) {
		throw new Error('A column spec needs at least one column; an empty struct is invalid SQL');
	}
	return `{${entries.map(([name, type]) => `'${name}': '${type}'`).join(', ')}}`;
}
