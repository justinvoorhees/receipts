// Skeleton for per-transaction decoding (spec §6).
//
// For each promoted tx:
//   1. eth_getTransactionReceipt — gasUsed, effectiveGasPrice, logs
//   2. eth_getTransaction — to (router), input (calldata)
//   3. debug_traceTransaction({ tracer: 'callTracer', tracerConfig: { withLog: true, onlyTopCall: false } })
//      via `publicClient.request({ method: 'debug_traceTransaction', params: [...] })`
//      (viem doesn't expose a typed wrapper; raw request is the path)
//   4. Parse the call tree for Transfer events, classify recipients
//      (user / pool / aggregator-fee-wallet / other), confirm pool contracts
//      against the canonical Uniswap V3 factory.

export interface DecodedTx {
	txHash: `0x${string}`;
	blockNumber: number;
	blockTimestamp: number;
	aggregator: string | null;
	direction: 'buy_weth' | 'sell_weth';
	amountInRaw: bigint;
	amountOutRaw: bigint;
	gasUsed: bigint;
	effectiveGasPrice: bigint;
	poolFeeTier: number;
	transferEvents: Array<{
		token: `0x${string}`;
		from: `0x${string}`;
		to: `0x${string}`;
		value: bigint;
	}>;
	rawTrace: unknown;
}

export async function decodeTransaction(/* args */): Promise<DecodedTx> {
	// TODO: implement.
	throw new Error('Not yet implemented.');
}
