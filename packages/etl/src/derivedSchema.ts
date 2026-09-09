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
export const DERIVED_SCHEMA_VERSION = 2;

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
 * One row per decoded receipt — trade-level granularity.
 *
 * `failure_reason` means a row exists for every candidate that reached decode,
 * whether or not a receipt came out the other side: ~36% of router-selected
 * and ~60% of `swap_log` candidates produce no receipt. Omitting those rows
 * would make the table unable to compute its own coverage.
 *
 * `price_confidence` and `tier` are BOTH stored, deliberately. `price_confidence`
 * is derived from `pricing_status` (see `priceConfidenceLabel`) to match the
 * `/methodology` vocabulary the receipt page renders. `tier` is core's own
 * label, and the two disagree on real data — 1 of 340 router receipts measured
 * `tier='full'` with `pricing_status='estimated'`, a corroborated mid on a pair
 * with no USD anchor. Storing only one would silently disagree with the
 * receipt page for that case.
 *
 * ⚠️ In both measured populations (router-selected and `swap_log`), roughly
 * 62% of rows land at `price_confidence='Unavailable'`. The cost columns
 * (`all_in_cost_bps`, `execution_bps`, `slippage_bps`, …) are NULL on those
 * rows by nature — no reliable market price means no cost decomposition — not
 * because of a defect in this table or the decoder.
 *
 * `fee_sinks` is a genuine nested column, not a JSON string: query it with
 * `UNNEST`. Verified to round-trip through a DuckDB `read_json` columns spec,
 * including the empty-array case.
 *
 * Deliberately NOT included: `market_mid_before`/`market_mid_after` (dropped
 * in the previous plan), the Chainlink/offchain benchmark block (populated on
 * 4 of 82 corpus receipts; the oracle is inert), and `decode_stable`/
 * `decode_unstable_fields` (determinism is a branch-level property, re-measured
 * with `decodeGolden.mjs determinism`, not worth a per-row column).
 */
export const RECEIPT_COLUMNS = {
	tx_hash: 'VARCHAR',
	chain_id: 'INTEGER',
	block_number: 'BIGINT',
	block_position: 'INTEGER',
	block_timestamp: 'TIMESTAMP',
	aggregator: 'VARCHAR',
	router_address: 'VARCHAR',
	trader: 'VARCHAR',
	filler_address: 'VARCHAR',
	direction: 'VARCHAR',
	input_token: 'VARCHAR',
	output_token: 'VARCHAR',
	input_symbol: 'VARCHAR',
	output_symbol: 'VARCHAR',
	input_amount: 'DOUBLE',
	output_amount: 'DOUBLE',
	notional_usd: 'DOUBLE',
	realized_price: 'DOUBLE',
	market_mid: 'DOUBLE',
	all_in_cost_bps: 'DOUBLE',
	price_confidence: 'VARCHAR',
	pricing_status: 'VARCHAR',
	tier: 'VARCHAR',
	methodology: 'VARCHAR',
	market_price_flags: 'VARCHAR[]',
	reference_depth_usd: 'DOUBLE',
	reference_pool_address: 'VARCHAR',
	execution_bps: 'DOUBLE',
	lp_fee_bps: 'DOUBLE',
	agg_fee_bps: 'DOUBLE',
	slippage_bps: 'DOUBLE',
	gas_cost_usd: 'DOUBLE',
	route_pure: 'BOOLEAN',
	route_shape: 'VARCHAR',
	hop_count: 'INTEGER',
	route_reconstructed: 'BOOLEAN',
	recon_residual_bps: 'DOUBLE',
	decomp_confidence: 'VARCHAR',
	fee_recipient: 'VARCHAR',
	fee_sink_source: 'VARCHAR',
	fee_sinks: 'STRUCT(address VARCHAR, fee_bps DOUBLE, source VARCHAR, name VARCHAR)[]',
	integrator_fee_bps: 'DOUBLE',
	fabric_fee_bps: 'DOUBLE',
	settlement_event_name: 'VARCHAR',
	settlement_event_topic0: 'VARCHAR',
	settlement_event_seen: 'BOOLEAN',
	normalize_flags: 'VARCHAR[]',
	failure_reason: 'VARCHAR',
	core_git_sha: 'VARCHAR',
	rpc_source: 'VARCHAR',
	seed_file: 'VARCHAR',
	derived_at: 'TIMESTAMP',
	derived_schema_version: 'INTEGER',
} as const satisfies Readonly<Record<string, string>>;

/** One entry of `ReceiptRow.fee_sinks`. Mirrors the `fee_sinks` STRUCT fields. */
export interface ReceiptFeeSink {
	address: string | null;
	fee_bps: number | null;
	source: string | null;
	name: string | null;
}

export interface ReceiptRow {
	tx_hash: string;
	chain_id: number;
	block_number: number;
	block_position: number;
	block_timestamp: string;
	aggregator: string | null;
	router_address: string | null;
	trader: string | null;
	filler_address: string | null;
	direction: string | null;
	input_token: string | null;
	output_token: string | null;
	input_symbol: string | null;
	output_symbol: string | null;
	input_amount: number | null;
	output_amount: number | null;
	notional_usd: number | null;
	realized_price: number | null;
	market_mid: number | null;
	all_in_cost_bps: number | null;
	price_confidence: string;
	pricing_status: string | null;
	tier: string | null;
	methodology: string | null;
	market_price_flags: string[] | null;
	reference_depth_usd: number | null;
	reference_pool_address: string | null;
	execution_bps: number | null;
	lp_fee_bps: number | null;
	agg_fee_bps: number | null;
	slippage_bps: number | null;
	gas_cost_usd: number | null;
	route_pure: boolean | null;
	route_shape: string | null;
	hop_count: number | null;
	route_reconstructed: boolean | null;
	recon_residual_bps: number | null;
	decomp_confidence: string | null;
	fee_recipient: string | null;
	fee_sink_source: string | null;
	fee_sinks: ReceiptFeeSink[] | null;
	integrator_fee_bps: number | null;
	fabric_fee_bps: number | null;
	settlement_event_name: string | null;
	settlement_event_topic0: string | null;
	settlement_event_seen: boolean | null;
	normalize_flags: string[] | null;
	failure_reason: string | null;
	core_git_sha: string | null;
	rpc_source: string | null;
	seed_file: string;
	derived_at: string;
	derived_schema_version: number;
}

/**
 * One row per decoded leg of a receipt's route.
 *
 * ⚠️ Carries raw amounts only — no decimals-scaled DOUBLE. `toLegRows` is a
 * pure function over a `Receipt`, and token decimals are not on it;
 * synthesising a human-scaled amount here would mean an RPC read inside a
 * pure transform. Join to `data/cache/tokens.base.parquet` (Task 3/5) when a
 * scaled amount is wanted — that table exists precisely so the scaling is a
 * join, not a re-read.
 *
 * ⚠️ `amount_in_raw`/`amount_out_raw` are VARCHAR, never numeric. Token
 * amounts genuinely exceed 2^128 for high-supply 18-decimal tokens, so
 * DuckDB's widest integer type cannot hold them; these come from a JS bigint
 * via `String()`, which has no ceiling.
 */
export const LEG_COLUMNS = {
	tx_hash: 'VARCHAR',
	leg_index: 'INTEGER',
	venue: 'VARCHAR',
	v4_emitter: 'VARCHAR',
	type: 'VARCHAR',
	token_in: 'VARCHAR',
	token_out: 'VARCHAR',
	symbol_in: 'VARCHAR',
	symbol_out: 'VARCHAR',
	amount_in_raw: 'VARCHAR',
	amount_out_raw: 'VARCHAR',
	fee_tier_bps: 'DOUBLE',
	lp_fee_bps: 'DOUBLE',
	fee_resolved: 'BOOLEAN',
	price_impact_bps: 'DOUBLE',
	notional_usdc: 'DOUBLE',
	notional_approx: 'BOOLEAN',
	frame_chain: 'VARCHAR[]',
	derived_schema_version: 'INTEGER',
} as const satisfies Readonly<Record<string, string>>;

export interface LegRow {
	tx_hash: string;
	leg_index: number;
	venue: string | null;
	v4_emitter: string | null;
	type: string | null;
	token_in: string | null;
	token_out: string | null;
	symbol_in: string | null;
	symbol_out: string | null;
	amount_in_raw: string | null;
	amount_out_raw: string | null;
	fee_tier_bps: number | null;
	lp_fee_bps: number | null;
	fee_resolved: boolean | null;
	price_impact_bps: number | null;
	notional_usdc: number | null;
	notional_approx: boolean | null;
	frame_chain: string[] | null;
	derived_schema_version: number;
}

/**
 * The /methodology vocabulary, derived from `pricing_status` so the table and
 * the receipt page agree. Mirrors fallbackMethodology in
 * packages/dashboard/components/receipt/priceFormat.ts.
 *
 * ⚠️ Derived from `pricing_status`, NOT `tier`. They disagree on real data —
 * 1 of 340 router receipts had tier='full' with pricing_status='estimated', a
 * corroborated mid on a pair with no USD anchor. Both columns are stored so
 * that case is queryable rather than erased; this label follows the UI.
 */
export function priceConfidenceLabel(pricingStatus: string): string {
	if (pricingStatus === 'full') return 'Verified';
	if (pricingStatus === 'estimated') return 'Estimated';
	return 'Unavailable';
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
