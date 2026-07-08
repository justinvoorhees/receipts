import {
	boolean,
	pgTable,
	text,
	integer,
	numeric,
	jsonb,
	timestamp,
	uniqueIndex,
	serial,
} from 'drizzle-orm/pg-core';

/**
 * On-demand cost receipts. One row per computed cost-receipt for an
 * analyzed transaction, keyed loosely to a (user, tx, chain) tuple so a
 * given user can re-request the same tx on multiple chains without
 * collisions. Generalizes token-pair-specific columns (input/output token
 * instead of USDC/WETH) so receipts aren't limited to a single trading pair.
 *
 * users table added when auth lands; receipts.userId is the forward hook
 */
export const receipts = pgTable(
	'receipts',
	{
		// identity
		id: serial('id').primaryKey(),
		txHash: text('tx_hash').notNull(),
		chainId: integer('chain_id').notNull(),
		userId: text('user_id'),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		// trade
		aggregator: text('aggregator').notNull(),
		trader: text('trader').notNull(),
		direction: text('direction').notNull(),
		inputToken: text('input_token').notNull(),
		outputToken: text('output_token').notNull(),
		inputSymbol: text('input_symbol').notNull(),
		outputSymbol: text('output_symbol').notNull(),
		inputAmount: numeric('input_amount').notNull(),
		outputAmount: numeric('output_amount').notNull(),
		notionalUsd: numeric('notional_usd'),
		realizedPrice: numeric('realized_price'),
		marketMid: numeric('market_mid'),
		allInCostBps: numeric('all_in_cost_bps'),
		pricingStatus: text('pricing_status').notNull(), // 'full' | 'partial'
		blockNumber: integer('block_number').notNull(),
		// decomposition
		executionBps: numeric('execution_bps'),
		lpFeeBps: numeric('lp_fee_bps'),
		aggFeeBps: numeric('agg_fee_bps'),
		slippageBps: numeric('slippage_bps'),
		gasCostUsd: numeric('gas_cost_usd'),
		routePure: boolean('route_pure'),
		routeShape: text('route_shape'),
		hopCount: integer('hop_count'),
		routeLegs: jsonb('route_legs'),
		reconResidualBps: numeric('recon_residual_bps'),
		decompConfidence: text('decomp_confidence'),
		// tagging / provenance
		settlementEventName: text('settlement_event_name'),
		settlementEventTopic0: text('settlement_event_topic0'),
		settlementEventSeen: boolean('settlement_event_seen').notNull().default(false),
		normalizeFlags: jsonb('normalize_flags'),
		// benchmark validation (nullable)
		chainlinkPrice: numeric('chainlink_price'),
		chainlinkDevBps: numeric('chainlink_dev_bps'),
		poolDivergenceBps: numeric('pool_divergence_bps'),
		manipulationFlag: boolean('manipulation_flag'),
		offchainPrice: numeric('offchain_price'),
		offchainDevBps: numeric('offchain_dev_bps'),
		chainlinkStalenessSecs: numeric('chainlink_staleness_secs'),
	},
	(t) => ({
		byUserTxChain: uniqueIndex('receipts_user_tx_chain_idx').on(t.userId, t.txHash, t.chainId),
	}),
);

export type ReceiptRow = typeof receipts.$inferSelect;
