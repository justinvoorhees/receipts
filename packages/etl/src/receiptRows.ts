import type { Receipt } from '@fabric-tca/core';
import { DERIVED_SCHEMA_VERSION, priceConfidenceLabel, type LegRow, type ReceiptFeeSink, type ReceiptRow } from './derivedSchema.js';

/**
 * receiptRows.ts — the pure boundary between a `Receipt` (what the decoder
 * produces) and the two row shapes this ETL writes (`ReceiptRow`, `LegRow`).
 *
 * No RPC, no DuckDB, no I/O: every function here is a plain object transform,
 * which is what makes it unit-testable and keeps the runner (Task 7) thin.
 *
 * ⚠️⚠️ EVERY import from `@fabric-tca/core` in this file is `import type`, and
 * that is load-bearing, not style — see factCacheStore.ts's docstring for why
 * a value import here would compile, typecheck and pass vitest, then die at
 * runtime under `dist/` with ERR_UNKNOWN_FILE_EXTENSION. `receiptRows.test.ts`
 * pins this discipline the same way factCacheStore.test.ts does for itself.
 */

/**
 * Fixed for a whole ETL run: which core build decoded, which RPC endpoint
 * served it, which Seed file the candidates came from, and when the run
 * happened. Deliberately a SEPARATE object from `TxContext` — folding the two
 * together invites passing one transaction's block_position into another
 * transaction's row. `blockPosition`/`blockTimestamp` vary per transaction and
 * come from the `candidates` row; these four do not.
 */
export interface RunContext {
	coreGitSha: string;
	rpcSource: string;
	seedFile: string;
	derivedAt: string;
}

/**
 * Varies per transaction: read from the `candidates` row for this tx, never
 * computed here. Kept separate from `RunContext` for the same reason — see
 * that interface's docstring.
 */
export interface TxContext {
	blockPosition: number;
	blockTimestamp: string;
}

/** What `toFailureRow` needs when a candidate reached decode but produced no
 *  `Receipt` — identity plus why, nothing else. */
export interface FailureArgs {
	txHash: string;
	chainId: number;
	blockNumber: number;
	failureReason: string;
}

/** One entry of `Receipt.routeLegs` as `analyzeTransaction`'s `toPersistedLeg`
 *  + `attachLegSymbols` actually produce it. `Receipt.routeLegs` is typed
 *  `unknown[] | null` on the core side (JSON round-tripped, no static shape),
 *  so this is the boundary cast — every field below is read defensively,
 *  never trusted. */
interface RouteLegLike {
	venue?: unknown;
	type?: unknown;
	tokenIn?: unknown;
	tokenOut?: unknown;
	tokenInSymbol?: unknown;
	tokenOutSymbol?: unknown;
	amountInRaw?: unknown;
	amountOutRaw?: unknown;
	feeTierBps?: unknown;
	lpFeeBps?: unknown;
	feeResolved?: unknown;
	priceImpactBps?: unknown;
	notionalUsdc?: unknown;
	notionalApprox?: unknown;
	frameChain?: unknown;
	v4Emitter?: unknown;
}

/** A string field, or NULL when absent/not a string — never `String(undefined)`. */
function nullableString(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

/** A number field, or NULL when absent/not a finite number. */
function nullableNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A boolean field, or NULL when absent/not a boolean. Distinct from
 *  `nullableString`/`nullableNumber` only in the type it guards, but kept as
 *  its own function so a call site names its intent. */
function nullableBoolean(value: unknown): boolean | null {
	return typeof value === 'boolean' ? value : null;
}

/** A `string[]` field, or NULL when absent/not an array of strings. */
function nullableStringArray(value: unknown): string[] | null {
	return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : null;
}

/** Map `Receipt.feeSinks` (`FeeSinkOut[]`, camelCase, no `name`) to the
 *  persisted STRUCT shape. No `name` field at all — see `RECEIPT_COLUMNS`'s
 *  docstring. A sink's human name resolves at READ time from the
 *  contract-name registry (`configs/contractNames.json` + `MANUAL_OVERRIDES`,
 *  falling back to Etherscan on a cache miss — see `contractNames.ts`'s
 *  `enrichFeeSinkNames`), and a `Receipt` never carries one to persist: this
 *  ETL run never calls that enricher (an Etherscan call per sink, rate
 *  limited, and its `persistCache()` writes through to the committed config
 *  file — wrong for a bulk run), so there is nothing correct to store here. */
function toFeeSinks(feeSinks: Receipt['feeSinks']): ReceiptFeeSink[] {
	return feeSinks.map((sink) => ({
		address: nullableString(sink.address),
		fee_bps: nullableNumber(sink.feeBps),
		source: nullableString(sink.source),
	}));
}

/**
 * Successful decode → one `ReceiptRow`. Column order matches `RECEIPT_COLUMNS`
 * exactly — `receiptRows.test.ts` asserts it, and the Task 7 writer depends
 * on it.
 */
export function toReceiptRow(receipt: Receipt, tx: TxContext, run: RunContext): ReceiptRow {
	return {
		tx_hash: receipt.txHash,
		chain_id: receipt.chainId,
		block_number: receipt.blockNumber,
		block_position: tx.blockPosition,
		block_timestamp: tx.blockTimestamp,
		aggregator: receipt.aggregator,
		router_address: receipt.routerAddress,
		trader: receipt.trader,
		filler_address: receipt.fillerAddress,
		direction: receipt.direction,
		input_token: receipt.inputToken,
		output_token: receipt.outputToken,
		input_symbol: receipt.inputSymbol,
		output_symbol: receipt.outputSymbol,
		input_amount: receipt.inputAmount,
		output_amount: receipt.outputAmount,
		notional_usd: receipt.notionalUsd,
		realized_price: receipt.realizedPrice,
		market_mid: receipt.marketMid,
		all_in_cost_bps: receipt.allInCostBps,
		price_confidence: priceConfidenceLabel(receipt.pricingStatus ?? ''),
		pricing_status: receipt.pricingStatus,
		tier: receipt.tier,
		methodology: receipt.methodology,
		market_price_flags: receipt.marketPriceFlags,
		reference_depth_usd: receipt.referenceDepthUsd,
		reference_pool_address: receipt.referencePoolAddress,
		execution_bps: receipt.executionBps,
		lp_fee_bps: receipt.lpFeeBps,
		agg_fee_bps: receipt.aggFeeBps,
		slippage_bps: receipt.slippageBps,
		gas_cost_usd: receipt.gasCostUsd,
		route_pure: receipt.routePure,
		route_shape: receipt.routeShape,
		hop_count: receipt.hopCount,
		route_reconstructed: receipt.routeReconstructed,
		recon_residual_bps: receipt.reconResidualBps,
		decomp_confidence: receipt.decompConfidence,
		fee_recipient: receipt.feeRecipient,
		fee_sink_source: receipt.feeSinkSource,
		fee_sinks: toFeeSinks(receipt.feeSinks),
		integrator_fee_bps: receipt.integratorFeeBps,
		fabric_fee_bps: receipt.fabricFeeBps,
		settlement_event_name: receipt.settlementEventName,
		settlement_event_topic0: receipt.settlementEventTopic0,
		settlement_event_seen: receipt.settlementEventSeen,
		normalize_flags: receipt.normalizeFlags,
		failure_reason: null,
		core_git_sha: run.coreGitSha,
		rpc_source: run.rpcSource,
		seed_file: run.seedFile,
		derived_at: run.derivedAt,
		derived_schema_version: DERIVED_SCHEMA_VERSION,
	};
}

/**
 * A candidate that reached decode but produced no `Receipt` → one `ReceiptRow`
 * carrying identity, `failure_reason`, `price_confidence: 'Unavailable'` and
 * provenance, with every other column NULL. ~36% of router-selected and ~60%
 * of `swap_log` candidates land here — without this row the table cannot
 * compute its own coverage. Emits the SAME keys, in the SAME order, as
 * `toReceiptRow`.
 */
export function toFailureRow(args: FailureArgs, tx: TxContext, run: RunContext): ReceiptRow {
	return {
		tx_hash: args.txHash,
		chain_id: args.chainId,
		block_number: args.blockNumber,
		block_position: tx.blockPosition,
		block_timestamp: tx.blockTimestamp,
		aggregator: null,
		router_address: null,
		trader: null,
		filler_address: null,
		direction: null,
		input_token: null,
		output_token: null,
		input_symbol: null,
		output_symbol: null,
		input_amount: null,
		output_amount: null,
		notional_usd: null,
		realized_price: null,
		market_mid: null,
		all_in_cost_bps: null,
		price_confidence: 'Unavailable',
		pricing_status: null,
		tier: null,
		methodology: null,
		market_price_flags: null,
		reference_depth_usd: null,
		reference_pool_address: null,
		execution_bps: null,
		lp_fee_bps: null,
		agg_fee_bps: null,
		slippage_bps: null,
		gas_cost_usd: null,
		route_pure: null,
		route_shape: null,
		hop_count: null,
		route_reconstructed: null,
		recon_residual_bps: null,
		decomp_confidence: null,
		fee_recipient: null,
		fee_sink_source: null,
		fee_sinks: null,
		integrator_fee_bps: null,
		fabric_fee_bps: null,
		settlement_event_name: null,
		settlement_event_topic0: null,
		settlement_event_seen: null,
		normalize_flags: null,
		failure_reason: args.failureReason,
		core_git_sha: run.coreGitSha,
		rpc_source: run.rpcSource,
		seed_file: run.seedFile,
		derived_at: run.derivedAt,
		derived_schema_version: DERIVED_SCHEMA_VERSION,
	};
}

/**
 * `Receipt.routeLegs` → one `LegRow` per leg, numbered in route order. Pure —
 * token decimals are not on a `Receipt`, so no scaled amount is synthesized
 * here (see `LEG_COLUMNS`'s docstring); joins to the token cache do that.
 *
 * `routeLegs` is `unknown[] | null` on the core side. Each element is cast to
 * `RouteLegLike` and read defensively through the `nullable*` helpers — an
 * absent optional (`feeResolved`, `frameChain`, `v4Emitter` are OMITTED by
 * core when they do not apply) becomes NULL, never the literal string
 * `"undefined"`.
 *
 * `route_reconstructed` is carried over from the parent `receipt`, not from
 * the leg itself — `Receipt.routeLegs` has no such field, and this is the one
 * place a leg row still has the receipt in scope to read it from. See
 * `LEG_COLUMNS`'s docstring for why: without it, a `'0'` amount on the
 * un-reconstructed "pools touched" path (`venuesToUncostedLegs`) is
 * indistinguishable from a genuine measured zero.
 */
export function toLegRows(receipt: Receipt): LegRow[] {
	if (receipt.routeLegs == null) return [];
	return (receipt.routeLegs as RouteLegLike[]).map((leg, index) => ({
		tx_hash: receipt.txHash,
		leg_index: index,
		route_reconstructed: receipt.routeReconstructed,
		venue: nullableString(leg.venue),
		v4_emitter: nullableString(leg.v4Emitter),
		type: nullableString(leg.type),
		token_in: nullableString(leg.tokenIn),
		token_out: nullableString(leg.tokenOut),
		symbol_in: nullableString(leg.tokenInSymbol),
		symbol_out: nullableString(leg.tokenOutSymbol),
		amount_in_raw: nullableString(leg.amountInRaw),
		amount_out_raw: nullableString(leg.amountOutRaw),
		fee_tier_bps: nullableNumber(leg.feeTierBps),
		lp_fee_bps: nullableNumber(leg.lpFeeBps),
		fee_resolved: nullableBoolean(leg.feeResolved),
		price_impact_bps: nullableNumber(leg.priceImpactBps),
		notional_usdc: nullableNumber(leg.notionalUsdc),
		notional_approx: nullableBoolean(leg.notionalApprox),
		frame_chain: nullableStringArray(leg.frameChain),
		derived_schema_version: DERIVED_SCHEMA_VERSION,
	}));
}
