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
		// The contract the taker called (tx.to, lowercased) — the aggregator's
		// router for this specific trade. Nullable: rows persisted before this
		// column existed are backfilled best-effort.
		routerAddress: text('router_address'),
		trader: text('trader').notNull(),
		// The filler/relayer EOA (tx.from) that submitted a UniswapX-anchored
		// fill; null for self- and net-flow-anchored trades, and for rows
		// persisted before this column existed (no backfill).
		fillerAddress: text('filler_address'),
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
		// single Market Price apparatus (Phase 2): tier = full|estimated|none,
		// methodology = human string for the receipt, marketPriceFlags = jsonb string[].
		tier: text('tier'),
		methodology: text('methodology'),
		marketPriceFlags: jsonb('market_price_flags'),
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
		// fee attribution (nullable). `aggFeeBps` is the total retained fee; these
		// split/identify it. `feeRecipient` is the dominant fee-sink address and
		// `feeSinkSource` how it was detected ('vault_map' | 'retained_balance').
		// For a Fabric-routed trade, a fee > Fabric's 10bps protocol-fee cap is an
		// integrator's forwarded feeBps: `integratorFeeBps` = the fee, `fabricFeeBps`
		// = 0. A fee <= 10bps is ambiguous on-chain → both left null.
		feeRecipient: text('fee_recipient'),
		feeSinkSource: text('fee_sink_source'),
		integratorFeeBps: numeric('integrator_fee_bps'),
		fabricFeeBps: numeric('fabric_fee_bps'),
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
