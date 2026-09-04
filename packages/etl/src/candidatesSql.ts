import { sqlLiteral } from './writeParquet.js';

/**
 * candidatesSql.ts — the SQL that turns a Seed glob into `candidates`.
 *
 * Zero RPC. Everything here is computed from `receipt_json` and `tx_json`,
 * which the Seed already holds. Measured against the pilot Seed (155,732 rows,
 * 300 blocks) on 2026-09-04: 13,641 rows out, ~7s.
 */

/** The Swap events that define a candidate. */
export const SWAP_TOPICS = {
	v2: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
	v3: '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
	v4: '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f',
} as const;

export const TRANSFER_TOPIC =
	'0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const ALL_SWAP_TOPICS = [SWAP_TOPICS.v2, SWAP_TOPICS.v3, SWAP_TOPICS.v4]
	.map(sqlLiteral)
	.join(', ');

/**
 * ⚠️ A v4 pool's identity is its poolId (`topics[1]`), NOT the log's emitter.
 * Every v4 Swap in the pilot window is emitted by one of two singletons, so
 * `count(DISTINCT emitter)` collapses 485 distinct pools onto 2 rows.
 */
const POOL_KEY = `CASE WHEN topic0 = ${sqlLiteral(SWAP_TOPICS.v4)} THEN topic1 ELSE emitter END`;

/**
 * Hex string -> decimal string, for wei quantities.
 *
 * ⚠️ Deliberately bounded at 2^128. DuckDB's widest integer is 128-bit, and a
 * full uint256 OVERFLOWS IT AND ABORTS THE ENTIRE COPY. Wei quantities cannot
 * reach that: total ETH supply is ~1.2e26 wei and 2^127 is ~1.7e38, twelve
 * orders of magnitude of headroom. A trimmed payload longer than 32 hex digits
 * is therefore not a wei quantity, and yields NULL rather than killing a build.
 *
 * ⚠️ This bound is safe for gas and value ONLY. Token amounts genuinely can
 * exceed 2^128 (a high-supply 18-decimal token), so leg amounts must never use
 * this macro — they come from JS `bigint` via `String()`, which has no ceiling.
 */
export const HEX_TO_DEC_MACRO = `CREATE OR REPLACE MACRO hex_to_dec(h) AS (
  CASE
    WHEN h IS NULL THEN NULL
    WHEN length(ltrim(lower(substr(h, 3)), '0')) > 32 THEN NULL
    ELSE CAST(
      COALESCE(
        list_reduce(
          [CAST(strpos('0123456789abcdef', c) - 1 AS UHUGEINT)
           FOR c IN string_split(ltrim(lower(substr(h, 3)), '0'), '')],
          lambda a, b: a * 16 + b),
        0::UHUGEINT)
    AS VARCHAR)
  END
)`;

/**
 * Statements to run before the select: the macro, the Seed view, the router
 * lookup table, and the per-transaction log aggregates.
 *
 * `seedGlob` is a path or glob passed straight to `read_parquet`. It is a
 * RUNTIME value — never derived from `import.meta.url`.
 */
export function candidatesSetupSql(opts: { seedGlob: string; routerValues: string }): string[] {
	return [
		HEX_TO_DEC_MACRO,
		`CREATE OR REPLACE VIEW seed AS SELECT * FROM read_parquet(${sqlLiteral(opts.seedGlob)})`,
		`CREATE OR REPLACE TABLE routers (address VARCHAR, name VARCHAR, version VARCHAR)`,
		`INSERT INTO routers VALUES ${opts.routerValues}`,
		// One row per receipt log. A transaction with no logs contributes none,
		// which is why every aggregate is COALESCEd in the select below.
		`CREATE OR REPLACE TEMP TABLE tx_logs AS
		 SELECT s.tx_hash,
		        json_extract_string(l.value, '$.address')   AS emitter,
		        json_extract_string(l.value, '$.topics[0]') AS topic0,
		        json_extract_string(l.value, '$.topics[1]') AS topic1
		 FROM seed s, json_each(s.receipt_json, '$.logs') l`,
		`CREATE OR REPLACE TEMP TABLE tx_agg AS
		 SELECT tx_hash,
		        count(*)                                                        AS log_count,
		        count(*) FILTER (topic0 = ${sqlLiteral(TRANSFER_TOPIC)})        AS erc20_transfer_count,
		        count(*) FILTER (topic0 = ${sqlLiteral(SWAP_TOPICS.v2)})        AS v2_legs,
		        count(*) FILTER (topic0 = ${sqlLiteral(SWAP_TOPICS.v3)})        AS v3_legs,
		        count(*) FILTER (topic0 = ${sqlLiteral(SWAP_TOPICS.v4)})        AS v4_legs,
		        count(DISTINCT ${POOL_KEY}) FILTER (topic0 IN (${ALL_SWAP_TOPICS})) AS distinct_pools,
		        count(DISTINCT topic1) FILTER (topic0 = ${sqlLiteral(SWAP_TOPICS.v4)}) AS distinct_v4_poolids
		 FROM tx_logs GROUP BY tx_hash`,
	];
}

/**
 * The select whose result IS the candidates file. Column order here must match
 * CANDIDATE_COLUMNS in derivedSchema.ts.
 *
 * ORDER BY block_number, block_position is load-bearing: it is what makes
 * row-group min/max statistics useful, exactly as in the Seed layer.
 */
export function candidatesSelectSql(opts: {
	seedFile: string;
	derivedAt: string;
	schemaVersion: number;
}): string {
	return `SELECT
	  s.chain_id,
	  s.block_number,
	  s.block_position,
	  s.tx_hash,
	  s.block_timestamp,
	  s.tx_from,
	  s.tx_to,
	  s.tx_status,
	  CASE
	    WHEN r.address IS NOT NULL AND COALESCE(a.v2_legs + a.v3_legs + a.v4_legs, 0) > 0 THEN 'both'
	    WHEN r.address IS NOT NULL THEN 'router'
	    ELSE 'swap_log'
	  END::VARCHAR                                              AS selected_via,
	  r.name                                                    AS router_name,
	  r.version                                                 AS router_version,
	  (COALESCE(a.v2_legs, 0) + COALESCE(a.v3_legs, 0) + COALESCE(a.v4_legs, 0))::INTEGER AS swap_log_count,
	  COALESCE(a.v2_legs, 0)::INTEGER                           AS v2_legs,
	  COALESCE(a.v3_legs, 0)::INTEGER                           AS v3_legs,
	  COALESCE(a.v4_legs, 0)::INTEGER                           AS v4_legs,
	  COALESCE(a.distinct_pools, 0)::INTEGER                    AS distinct_pools,
	  COALESCE(a.distinct_v4_poolids, 0)::INTEGER               AS distinct_v4_poolids,
	  COALESCE(a.log_count, 0)::INTEGER                         AS log_count,
	  COALESCE(a.erc20_transfer_count, 0)::INTEGER              AS erc20_transfer_count,
	  hex_to_dec(json_extract_string(s.receipt_json, '$.gasUsed'))::BIGINT AS gas_used,
	  hex_to_dec(json_extract_string(s.receipt_json, '$.effectiveGasPrice')) AS effective_gas_price,
	  hex_to_dec(json_extract_string(s.receipt_json, '$.l1Fee'))             AS l1_fee,
	  hex_to_dec(json_extract_string(s.tx_json, '$.value'))                  AS tx_value,
	  ${sqlLiteral(opts.seedFile)}                              AS seed_file,
	  ${sqlLiteral(opts.derivedAt)}::TIMESTAMP                  AS derived_at,
	  ${opts.schemaVersion}::INTEGER                            AS derived_schema_version
	FROM seed s
	LEFT JOIN tx_agg a ON a.tx_hash = s.tx_hash
	LEFT JOIN routers r ON lower(s.tx_to) = r.address
	WHERE r.address IS NOT NULL OR COALESCE(a.v2_legs + a.v3_legs + a.v4_legs, 0) > 0
	ORDER BY s.block_number, s.block_position`;
}
