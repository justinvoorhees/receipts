import { eq, sql } from 'drizzle-orm';
import { schema } from '@fabric-tca/db';
import type { Db } from '@fabric-tca/db';
import { decodeTransaction, type DecodedTx, type Direction } from './decoder.js';
import { getReferencePrice } from './referencePrice.js';
import { simulateAmountOut } from './quoter.js';
import { computeTcaLedger, type TcaLedger } from './tcaCalculator.js';
import type { RouterRegistry } from './routerRegistry.js';

/**
 * Promotion pipeline (spec §6, §9.2 steps 4–7):
 *   decoded tx + reference price → TCA ledger → swaps row.
 *
 * Run from the CLI (`tca-ingest process <tx_hash>`) for ad-hoc/manual promotion,
 * or in a loop over qualifying staging rows once the P99 gate is in place.
 *
 * Idempotent at the swaps table — uses onConflictDoUpdate on tx_hash so a
 * re-run replaces the ledger (cheap, predictable). The staging row's
 * `promoted_tx_hash` is set as a one-way breadcrumb.
 */

const USDC: `0x${string}` = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH: `0x${string}` = '0x4200000000000000000000000000000000000006';

export interface ProcessSwapArgs {
	db: Db;
	rpcUrl: string;
	txHash: `0x${string}`;
	poolAddress: `0x${string}`;
	poolFeeTier: number;
	registry: RouterRegistry;
}

export interface ProcessResult {
	txHash: `0x${string}`;
	direction: Direction;
	notionalUsd: number;
	referencePrice: number;
	simulatedPrice: number;
	executedPrice: number;
	priceImpactBps: number;
	slippageBps: number;
	ledger: TcaLedger;
}

export async function processSwap(args: ProcessSwapArgs): Promise<ProcessResult> {
	// Look up the router so we can attach the aggregator label + fee recipients.
	// (`to` was already verified at poller time; we re-fetch here to avoid
	// depending on staging being current.)
	const decoded = await decodeFromChain(args);

	// Reference and simulated prices share the same block-N-1 snapshot, so
	// run them in parallel.
	const tokenIn: `0x${string}` = decoded.direction === 'buy_weth' ? USDC : WETH;
	const tokenOut: `0x${string}` = decoded.direction === 'buy_weth' ? WETH : USDC;
	const [referencePrice, simulatedAmountOut] = await Promise.all([
		getReferencePrice({
			rpcUrl: args.rpcUrl,
			poolAddress: args.poolAddress,
			blockNumber: BigInt(decoded.blockNumber),
		}),
		simulateAmountOut({
			rpcUrl: args.rpcUrl,
			tokenIn,
			tokenOut,
			amountIn: decoded.amountInRaw,
			feeTier: args.poolFeeTier,
			blockNumber: BigInt(decoded.blockNumber) - 1n,
		}),
	]);

	const notionalUsd = computeNotional(decoded);
	const executedPrice = computeExecutedPrice(decoded);
	const simulatedPrice = computeSimulatedPrice(decoded.direction, decoded.amountInRaw, simulatedAmountOut);
	const aggFeeUsd = computeAggFeeUsd(decoded, referencePrice);

	const ledger = computeTcaLedger({
		direction: decoded.direction,
		notionalUsd,
		referencePrice,
		executedPrice,
		gasUsed: decoded.gasUsed,
		effectiveGasPrice: decoded.effectiveGasPrice,
		ethPriceUsd: referencePrice, // USDC/WETH ⇒ ref price doubles as ETH price
		poolFeeTier: args.poolFeeTier,
		aggFeeUsd,
	});

	// Sign convention: positive = cost paid by user, matching the rest of the
	// ledger. Slippage = simulated → executed (MEV/sandwich/ordering).
	const slippageBps = signedDeviationBps(decoded.direction, simulatedPrice, executedPrice);
	// `ref → simulated` includes the pool's LP fee (Quoter deducts it before
	// running the swap math). Subtract it to isolate "pure depth" — the cost
	// purely attributable to the pool's liquidity curve at the trade size.
	const rawRefToSimBps = signedDeviationBps(decoded.direction, referencePrice, simulatedPrice);
	const priceImpactBps = rawRefToSimBps - ledger.lpFeeBps;

	// Residual after every known component. If the math closes cleanly this
	// is near zero; persistent values point at something we're not modelling
	// (e.g., aggregator fees captured as positive slippage when fee_recipients
	// is empty, or float-arithmetic slop from the bps-denominator mismatch).
	const executionQualityBps =
		ledger.totalCostBps -
		ledger.lpFeeBps -
		ledger.aggFeeBps -
		priceImpactBps -
		slippageBps;

	const row = {
		txHash: decoded.txHash,
		blockNumber: decoded.blockNumber,
		blockTimestamp: decoded.blockTimestamp,
		aggregator: decoded.aggregator,
		direction: decoded.direction,
		amountInRaw: decoded.amountInRaw.toString(),
		amountOutRaw: decoded.amountOutRaw.toString(),
		notionalUsd: notionalUsd.toFixed(4),
		referencePrice: referencePrice.toFixed(8),
		executedPrice: executedPrice.toFixed(8),
		simulatedAmountOut: simulatedAmountOut.toString(),
		simulatedPrice: simulatedPrice.toFixed(8),
		totalCostBps: ledger.totalCostBps.toFixed(4),
		lpFeeBps: ledger.lpFeeBps.toFixed(4),
		aggFeeBps: ledger.aggFeeBps.toFixed(4),
		gasCostUsd: ledger.gasCostUsd.toFixed(4),
		gasCostBps: ledger.gasCostBps.toFixed(4),
		priceImpactBps: priceImpactBps.toFixed(4),
		slippageBps: slippageBps.toFixed(4),
		executionQualityBps: executionQualityBps.toFixed(4),
		gasUsed: decoded.gasUsed,
		effectiveGasPrice: decoded.effectiveGasPrice.toString(),
		poolFeeTier: args.poolFeeTier,
		rawTrace: decoded.rawTrace,
		processingStatus: 'complete',
		processedAt: new Date(),
	};

	await args.db
		.insert(schema.swaps)
		.values(row)
		.onConflictDoUpdate({
			target: schema.swaps.txHash,
			set: {
				blockNumber: row.blockNumber,
				blockTimestamp: row.blockTimestamp,
				aggregator: row.aggregator,
				direction: row.direction,
				amountInRaw: row.amountInRaw,
				amountOutRaw: row.amountOutRaw,
				notionalUsd: row.notionalUsd,
				referencePrice: row.referencePrice,
				executedPrice: row.executedPrice,
				simulatedAmountOut: row.simulatedAmountOut,
				simulatedPrice: row.simulatedPrice,
				totalCostBps: row.totalCostBps,
				lpFeeBps: row.lpFeeBps,
				aggFeeBps: row.aggFeeBps,
				gasCostUsd: row.gasCostUsd,
				gasCostBps: row.gasCostBps,
				priceImpactBps: row.priceImpactBps,
				slippageBps: row.slippageBps,
				executionQualityBps: row.executionQualityBps,
				gasUsed: row.gasUsed,
				effectiveGasPrice: row.effectiveGasPrice,
				poolFeeTier: row.poolFeeTier,
				rawTrace: row.rawTrace,
				processingStatus: row.processingStatus,
				processedAt: row.processedAt,
			},
		});

	// Breadcrumb on staging so we can tell promoted rows apart later.
	await args.db
		.update(schema.swapsStaging)
		.set({ promotedTxHash: decoded.txHash })
		.where(eq(schema.swapsStaging.txHash, decoded.txHash));

	return {
		txHash: decoded.txHash,
		direction: decoded.direction,
		notionalUsd,
		referencePrice,
		simulatedPrice,
		executedPrice,
		priceImpactBps,
		slippageBps,
		ledger: { ...ledger, executionQualityBps },
	};
}

async function decodeFromChain(args: ProcessSwapArgs): Promise<DecodedTx> {
	// First decode pass tells us the tx's `to`; we then look up the router and
	// re-decode with fee-recipient classification populated.
	const first = await decodeTransaction({
		rpcUrl: args.rpcUrl,
		txHash: args.txHash,
		context: {
			aggregator: null,
			poolAddress: args.poolAddress,
			poolFeeTier: args.poolFeeTier,
		},
	});
	const router = first.to
		? args.registry.byAddressLower.get(first.to.toLowerCase())
		: undefined;
	if (!router) {
		// No aggregator match → leave aggregator null but keep the decoded data.
		// Caller may still want to inspect or discard.
		return first;
	}
	return decodeTransaction({
		rpcUrl: args.rpcUrl,
		txHash: args.txHash,
		context: {
			aggregator: router.name,
			poolAddress: args.poolAddress,
			poolFeeTier: args.poolFeeTier,
			feeRecipientsLower: new Set(router.fee_recipients.map((a) => a.toLowerCase())),
		},
	});
}

function computeNotional(d: DecodedTx): number {
	// Notional = USD value of the trade, taken from the USDC leg (1 USDC ≡ 1 USD).
	return d.direction === 'buy_weth'
		? Number(d.amountInRaw) / 1e6 // user paid USDC
		: Number(d.amountOutRaw) / 1e6; // user received USDC
}

function computeExecutedPrice(d: DecodedTx): number {
	// Always USDC per WETH, regardless of direction.
	if (d.direction === 'buy_weth') {
		const usdcIn = Number(d.amountInRaw) / 1e6;
		const wethOut = Number(d.amountOutRaw) / 1e18;
		return usdcIn / wethOut;
	}
	const wethIn = Number(d.amountInRaw) / 1e18;
	const usdcOut = Number(d.amountOutRaw) / 1e6;
	return usdcOut / wethIn;
}

/**
 * Simulated execution price (USDC per WETH) from the QuoterV2's `amountOut`.
 * Same math as the actual executedPrice; just swaps in the simulated output.
 */
function computeSimulatedPrice(
	direction: Direction,
	amountInRaw: bigint,
	simulatedAmountOut: bigint,
): number {
	if (direction === 'buy_weth') {
		const usdcIn = Number(amountInRaw) / 1e6;
		const wethOut = Number(simulatedAmountOut) / 1e18;
		return usdcIn / wethOut;
	}
	const wethIn = Number(amountInRaw) / 1e18;
	const usdcOut = Number(simulatedAmountOut) / 1e6;
	return usdcOut / wethIn;
}

/**
 * Signed deviation in basis points from `baselinePrice` to `comparePrice`,
 * direction-aware. Positive bps = cost paid by user (worse than baseline),
 * matching the rest of the ledger's convention.
 *
 *   sell_weth: user received USDC; lower compare price = fewer USDC out = cost
 *   buy_weth:  user paid USDC; higher compare price = more USDC in = cost
 */
function signedDeviationBps(
	direction: Direction,
	baselinePrice: number,
	comparePrice: number,
): number {
	const deviation =
		direction === 'sell_weth'
			? baselinePrice - comparePrice
			: comparePrice - baselinePrice;
	return (deviation / baselinePrice) * 10_000;
}

function computeAggFeeUsd(d: DecodedTx, referencePrice: number): number {
	let total = 0;
	for (const t of d.transfers) {
		if (t.recipientClass !== 'aggregator_fee') continue;
		const tokenLower = t.token.toLowerCase();
		if (tokenLower === USDC.toLowerCase()) {
			total += Number(t.value) / 1e6;
		} else if (tokenLower === WETH.toLowerCase()) {
			total += (Number(t.value) / 1e18) * referencePrice;
		}
	}
	return total;
}

/**
 * Recomputes the P99 threshold from the staging table over the last `windowDays`
 * days and writes a new row into `p99_thresholds`. Returns the threshold + the
 * sample count used to compute it.
 */
export async function recomputeP99(
	db: Db,
	windowDays = 30,
): Promise<{ thresholdUsd: number; sampleCount: number }> {
	const result = await db.execute<{ threshold: string | null; sample_count: string }>(sql`
		SELECT
			percentile_cont(0.99) WITHIN GROUP (ORDER BY notional_usd_estimate::numeric) AS threshold,
			COUNT(*) AS sample_count
		FROM swaps_staging
		WHERE discovered_at > NOW() - (${windowDays} || ' days')::interval
	`);
	const row = result[0];
	if (!row) throw new Error('recomputeP99: no rows returned');
	const thresholdUsd = Number(row.threshold ?? 0);
	const sampleCount = Number(row.sample_count);
	await db.insert(schema.p99Thresholds).values({
		computedAt: new Date(),
		thresholdUsd: thresholdUsd.toFixed(2),
		sampleCount,
		windowDays,
	});
	return { thresholdUsd, sampleCount };
}
