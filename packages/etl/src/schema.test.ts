import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, SEED_COLUMNS, seedColumnSpec } from './schema.js';

/**
 * The Seed layer is immutable by design: Derived files rebuild from Seeds in
 * seconds, but rebuilding a Seed means re-fetching from an endpoint that may no
 * longer agree with what it said before.
 *
 * If this test fails you are changing the data model. That is allowed, but it is
 * a deliberate act, not a refactor. Before editing this list, apply the
 * promotion rule from the spec (§4): a field becomes a column only if it is used
 * for PRUNING (deciding which rows to read), IDENTITY, or INTEGRITY. Anything
 * used for COMPUTATION stays inside a JSON payload, because computation is what
 * Derived files are for.
 */
const FROZEN: ReadonlyArray<readonly [string, string]> = [
	['chain_id', 'INTEGER'],
	['block_number', 'BIGINT'],
	['block_position', 'INTEGER'],
	['tx_hash', 'VARCHAR'],
	['block_timestamp', 'TIMESTAMP'],
	['tx_from', 'VARCHAR'],
	['tx_to', 'VARCHAR'],
	['tx_status', 'BOOLEAN'],
	['block_hash', 'VARCHAR'],
	['trace_json', 'VARCHAR'],
	['receipt_json', 'VARCHAR'],
	['tx_json', 'VARCHAR'],
	['block_json', 'VARCHAR'],
	['finality', 'VARCHAR'],
	['ingested_at', 'TIMESTAMP'],
	['source', 'VARCHAR'],
	['schema_version', 'INTEGER'],
];

describe('Seed schema', () => {
	it('is frozen: 17 columns, in order, with these exact types', () => {
		expect(Object.entries(SEED_COLUMNS)).toEqual(FROZEN.map(([n, t]) => [n, t]));
	});

	it('is at version 1', () => {
		expect(SCHEMA_VERSION).toBe(1);
	});

	it('renders a DuckDB read_json column spec', () => {
		const spec = seedColumnSpec();
		expect(spec.startsWith("{'chain_id': 'INTEGER'")).toBe(true);
		expect(spec.endsWith("'schema_version': 'INTEGER'}")).toBe(true);
		expect(spec.split(',').length).toBe(17);
	});
});
