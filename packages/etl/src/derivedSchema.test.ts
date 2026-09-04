import { describe, expect, it } from 'vitest';
import { CANDIDATE_COLUMNS, DERIVED_SCHEMA_VERSION, derivedColumnSpec } from './derivedSchema.js';

/**
 * Unlike the Seed's schema test, this one is a VERSION tripwire, not a freeze.
 * A Derived file rebuilds from Seeds in seconds, so changing its shape is
 * allowed — but it must be deliberate. If this test fails: update the list
 * below AND bump DERIVED_SCHEMA_VERSION, so a file written by the old shape is
 * distinguishable from one written by the new shape after the fact.
 */
const CANDIDATES_V1: ReadonlyArray<readonly [string, string]> = [
	['chain_id', 'INTEGER'],
	['block_number', 'BIGINT'],
	['block_position', 'INTEGER'],
	['tx_hash', 'VARCHAR'],
	['block_timestamp', 'TIMESTAMP'],
	['tx_from', 'VARCHAR'],
	['tx_to', 'VARCHAR'],
	['tx_status', 'BOOLEAN'],
	['selected_via', 'VARCHAR'],
	['router_name', 'VARCHAR'],
	['router_version', 'VARCHAR'],
	['swap_log_count', 'INTEGER'],
	['v2_legs', 'INTEGER'],
	['v3_legs', 'INTEGER'],
	['v4_legs', 'INTEGER'],
	['distinct_pools', 'INTEGER'],
	['distinct_v4_poolids', 'INTEGER'],
	['log_count', 'INTEGER'],
	['erc20_transfer_count', 'INTEGER'],
	['gas_used', 'BIGINT'],
	['effective_gas_price', 'VARCHAR'],
	['l1_fee', 'VARCHAR'],
	['tx_value', 'VARCHAR'],
	['seed_file', 'VARCHAR'],
	['derived_at', 'TIMESTAMP'],
	['derived_schema_version', 'INTEGER'],
];

describe('candidates schema', () => {
	it('has these exact columns, in this order, with these types', () => {
		expect(Object.entries(CANDIDATE_COLUMNS)).toEqual(CANDIDATES_V1.map(([n, t]) => [n, t]));
	});

	it('is at version 1', () => {
		expect(DERIVED_SCHEMA_VERSION).toBe(1);
	});

	it('stores wei quantities as VARCHAR, never a numeric type', () => {
		// uint256 has no native Parquet type and DECIMAL(38,0) cannot hold the
		// range. Any of these becoming numeric is a silent precision loss.
		for (const col of ['effective_gas_price', 'l1_fee', 'tx_value'] as const) {
			expect(CANDIDATE_COLUMNS[col]).toBe('VARCHAR');
		}
	});
});

describe('derivedColumnSpec', () => {
	it('renders a DuckDB read_json column spec in declaration order', () => {
		const spec = derivedColumnSpec({ a: 'INTEGER', b: 'VARCHAR' });
		expect(spec).toBe("{'a': 'INTEGER', 'b': 'VARCHAR'}");
	});

	it('rejects an empty column set rather than emitting invalid SQL', () => {
		expect(() => derivedColumnSpec({})).toThrow(/at least one column/);
	});
});
