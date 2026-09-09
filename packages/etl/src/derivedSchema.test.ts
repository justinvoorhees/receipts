import { describe, expect, it } from 'vitest';
import {
	CANDIDATE_COLUMNS,
	DERIVED_SCHEMA_VERSION,
	derivedColumnSpec,
	LEG_COLUMNS,
	priceConfidenceLabel,
	RECEIPT_COLUMNS,
} from './derivedSchema.js';

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

	it('is at version 2', () => {
		expect(DERIVED_SCHEMA_VERSION).toBe(2);
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

const RECEIPTS_V2: ReadonlyArray<readonly [string, string]> = [
	['tx_hash', 'VARCHAR'],
	['chain_id', 'INTEGER'],
	['block_number', 'BIGINT'],
	['block_position', 'INTEGER'],
	['block_timestamp', 'TIMESTAMP'],
	['aggregator', 'VARCHAR'],
	['router_address', 'VARCHAR'],
	['trader', 'VARCHAR'],
	['filler_address', 'VARCHAR'],
	['direction', 'VARCHAR'],
	['input_token', 'VARCHAR'],
	['output_token', 'VARCHAR'],
	['input_symbol', 'VARCHAR'],
	['output_symbol', 'VARCHAR'],
	['input_amount', 'DOUBLE'],
	['output_amount', 'DOUBLE'],
	['notional_usd', 'DOUBLE'],
	['realized_price', 'DOUBLE'],
	['market_mid', 'DOUBLE'],
	['all_in_cost_bps', 'DOUBLE'],
	['price_confidence', 'VARCHAR'],
	['pricing_status', 'VARCHAR'],
	['tier', 'VARCHAR'],
	['methodology', 'VARCHAR'],
	['market_price_flags', 'VARCHAR[]'],
	['reference_depth_usd', 'DOUBLE'],
	['reference_pool_address', 'VARCHAR'],
	['execution_bps', 'DOUBLE'],
	['lp_fee_bps', 'DOUBLE'],
	['agg_fee_bps', 'DOUBLE'],
	['slippage_bps', 'DOUBLE'],
	['gas_cost_usd', 'DOUBLE'],
	['route_pure', 'BOOLEAN'],
	['route_shape', 'VARCHAR'],
	['hop_count', 'INTEGER'],
	['route_reconstructed', 'BOOLEAN'],
	['recon_residual_bps', 'DOUBLE'],
	['decomp_confidence', 'VARCHAR'],
	['fee_recipient', 'VARCHAR'],
	['fee_sink_source', 'VARCHAR'],
	['fee_sinks', 'STRUCT(address VARCHAR, fee_bps DOUBLE, source VARCHAR, name VARCHAR)[]'],
	['integrator_fee_bps', 'DOUBLE'],
	['fabric_fee_bps', 'DOUBLE'],
	['settlement_event_name', 'VARCHAR'],
	['settlement_event_topic0', 'VARCHAR'],
	['settlement_event_seen', 'BOOLEAN'],
	['normalize_flags', 'VARCHAR[]'],
	['failure_reason', 'VARCHAR'],
	['core_git_sha', 'VARCHAR'],
	['rpc_source', 'VARCHAR'],
	['seed_file', 'VARCHAR'],
	['derived_at', 'TIMESTAMP'],
	['derived_schema_version', 'INTEGER'],
];

const LEGS_V2: ReadonlyArray<readonly [string, string]> = [
	['tx_hash', 'VARCHAR'],
	['leg_index', 'INTEGER'],
	['venue', 'VARCHAR'],
	['v4_emitter', 'VARCHAR'],
	['type', 'VARCHAR'],
	['token_in', 'VARCHAR'],
	['token_out', 'VARCHAR'],
	['symbol_in', 'VARCHAR'],
	['symbol_out', 'VARCHAR'],
	['amount_in_raw', 'VARCHAR'],
	['amount_out_raw', 'VARCHAR'],
	['fee_tier_bps', 'DOUBLE'],
	['lp_fee_bps', 'DOUBLE'],
	['fee_resolved', 'BOOLEAN'],
	['price_impact_bps', 'DOUBLE'],
	['notional_usdc', 'DOUBLE'],
	['notional_approx', 'BOOLEAN'],
	['frame_chain', 'VARCHAR[]'],
	['derived_schema_version', 'INTEGER'],
];

describe('receipts schema', () => {
	it('has these exact columns, in this order, with these types', () => {
		expect(Object.entries(RECEIPT_COLUMNS)).toEqual(RECEIPTS_V2.map(([n, t]) => [n, t]));
	});

	it('stores BOTH tier and pricing_status, because they disagree on real data', () => {
		// 1 of 340 router receipts: tier='full', pricing_status='estimated'
		// (a corroborated mid on a pair with no USD anchor). Storing one alone
		// silently disagrees with the receipt page.
		expect(RECEIPT_COLUMNS.tier).toBe('VARCHAR');
		expect(RECEIPT_COLUMNS.pricing_status).toBe('VARCHAR');
		expect(RECEIPT_COLUMNS.price_confidence).toBe('VARCHAR');
	});

	it('carries failure_reason so failures get rows and coverage is computable', () => {
		expect(RECEIPT_COLUMNS.failure_reason).toBe('VARCHAR');
	});

	it('does not carry the dropped wing or benchmark columns', () => {
		for (const dropped of [
			'market_mid_before', 'market_mid_after', 'chainlink_price', 'chainlink_dev_bps',
			'offchain_price', 'pool_divergence_bps', 'manipulation_flag', 'decode_stable',
		]) {
			expect(RECEIPT_COLUMNS[dropped as keyof typeof RECEIPT_COLUMNS]).toBeUndefined();
		}
	});
});

describe('legs schema', () => {
	it('has these exact columns, in this order, with these types', () => {
		expect(Object.entries(LEG_COLUMNS)).toEqual(LEGS_V2.map(([n, t]) => [n, t]));
	});

	it('stores raw leg amounts as VARCHAR, never a numeric type', () => {
		// Token amounts genuinely exceed 2^128 for high-supply 18-decimal
		// tokens, so DuckDB's widest integer cannot hold them. These come from
		// JS bigint via String(), which has no ceiling.
		expect(LEG_COLUMNS.amount_in_raw).toBe('VARCHAR');
		expect(LEG_COLUMNS.amount_out_raw).toBe('VARCHAR');
	});
});

describe('priceConfidenceLabel', () => {
	it('maps pricing_status to the /methodology vocabulary', () => {
		expect(priceConfidenceLabel('full')).toBe('Verified');
		expect(priceConfidenceLabel('estimated')).toBe('Estimated');
		expect(priceConfidenceLabel('partial')).toBe('Unavailable');
	});

	it('treats an unknown status as Unavailable rather than inventing a label', () => {
		expect(priceConfidenceLabel('something-new')).toBe('Unavailable');
	});
});

describe('DERIVED_SCHEMA_VERSION', () => {
	it('is at version 2 now that receipts and legs exist', () => {
		expect(DERIVED_SCHEMA_VERSION).toBe(2);
	});
});
