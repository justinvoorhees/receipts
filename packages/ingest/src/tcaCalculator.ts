// Spec §5. Computes the five-component cost ledger per trade. All bps values
// signed: positive = cost paid by user (worse than reference), negative =
// surplus over reference (better than reference). Surpluses are real and
// preserved — that's where execution quality lives.

export type Direction = 'buy_weth' | 'sell_weth';

export interface TcaInputs {
	direction: Direction;
	notionalUsd: number;
	referencePrice: number;
	/** USDC per WETH, regardless of trade direction. */
	executedPrice: number;
	gasUsed: bigint;
	effectiveGasPrice: bigint; // wei
	ethPriceUsd: number; // contemporaneous with the trade block (slot0 at N)
	poolFeeTier: number; // 500 -> 5 bps, 3000 -> 30 bps
	aggFeeUsd: number; // sum of transfers to known fee recipients
}

export interface TcaLedger {
	totalCostBps: number;
	lpFeeBps: number;
	aggFeeBps: number;
	gasCostUsd: number;
	gasCostBps: number;
	executionQualityBps: number;
}

export function computeTcaLedger(input: TcaInputs): TcaLedger {
	// `executedPrice` is always USDC-per-WETH. Direction determines which way
	// a deviation reads as cost.
	//   sell_weth: user received USDC; lower executedPrice = fewer USDC out = cost
	//   buy_weth:  user paid USDC; higher executedPrice = more USDC in = cost
	const deviation =
		input.direction === 'sell_weth'
			? input.referencePrice - input.executedPrice
			: input.executedPrice - input.referencePrice;
	const totalCostBps = (deviation / input.referencePrice) * 10_000;
	const lpFeeBps = input.poolFeeTier / 1e4;
	const aggFeeBps = (input.aggFeeUsd / input.notionalUsd) * 10_000;
	const gasCostEth = (Number(input.gasUsed) * Number(input.effectiveGasPrice)) / 1e18;
	const gasCostUsd = gasCostEth * input.ethPriceUsd;
	const gasCostBps = (gasCostUsd / input.notionalUsd) * 10_000;
	const executionQualityBps = totalCostBps - lpFeeBps - aggFeeBps - gasCostBps;
	return {
		totalCostBps,
		lpFeeBps,
		aggFeeBps,
		gasCostUsd,
		gasCostBps,
		executionQualityBps,
	};
}
