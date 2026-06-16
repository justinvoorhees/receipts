// Spec §5. Computes the five-component cost ledger per trade. All bps values
// signed (negative = surplus over reference, valid and preserved).

export interface TcaInputs {
	notionalUsd: number;
	referencePrice: number;
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
	const totalCostBps =
		((input.referencePrice - input.executedPrice) / input.referencePrice) * 10_000;
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
