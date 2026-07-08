import { createPublicClient, decodeEventLog, http, parseAbiItem } from 'viem';
import { base } from 'viem/chains';

/**
 * Per-transaction decoder (spec §6). Fetches receipt + tx + debug trace,
 * extracts the Swap event for direction/amounts, walks the call tree for
 * Transfer events on USDC/WETH, and classifies each Transfer's recipient.
 *
 * Output is a structured `DecodedTx` that flows into `tcaCalculator`.
 *
 * Requires an archive RPC: `debug_traceTransaction` is not on free tiers.
 */

const USDC: `0x${string}` = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH: `0x${string}` = '0x4200000000000000000000000000000000000006';

const SWAP_EVENT = parseAbiItem(
	'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
);
const TRANSFER_EVENT = parseAbiItem(
	'event Transfer(address indexed from, address indexed to, uint256 value)',
);

export type Direction = 'buy_weth' | 'sell_weth';
export type TransferRecipientClass = 'user' | 'pool' | 'aggregator_fee' | 'other';

export interface TransferEvent {
	token: `0x${string}`;
	from: `0x${string}`;
	to: `0x${string}`;
	value: bigint;
	recipientClass: TransferRecipientClass;
}

export interface DecodedTx {
	txHash: `0x${string}`;
	blockNumber: number;
	blockTimestamp: number;
	from: `0x${string}`;
	to: `0x${string}` | null;
	aggregator: string | null;
	direction: Direction;
	amountInRaw: bigint;
	amountOutRaw: bigint;
	gasUsed: bigint;
	effectiveGasPrice: bigint;
	poolAddress: `0x${string}`;
	poolFeeTier: number;
	transfers: TransferEvent[];
	rawTrace: unknown;
}

export interface DecodeArgs {
	rpcUrl: string;
	txHash: `0x${string}`;
	/**
	 * Aggregator/pool context the poller already established for this tx. The
	 * decoder doesn't re-derive these from the trace — it trusts the staging
	 * row that prompted the promotion.
	 */
	context: {
		aggregator: string | null;
		poolAddress: `0x${string}`;
		poolFeeTier: number;
		/** Optional fee-recipient set for the aggregator (from router registry). */
		feeRecipientsLower?: Set<string>;
	};
}

export async function decodeTransaction(args: DecodeArgs): Promise<DecodedTx> {
	const client = createPublicClient({ chain: base, transport: http(args.rpcUrl) });

	const [receipt, tx] = await Promise.all([
		client.getTransactionReceipt({ hash: args.txHash }),
		client.getTransaction({ hash: args.txHash }),
	]);

	const block = await client.getBlock({ blockNumber: receipt.blockNumber });

	// Pull the Swap event from the receipt logs (faster than walking the trace).
	const swapLog = receipt.logs.find(
		(l) => l.address.toLowerCase() === args.context.poolAddress.toLowerCase(),
	);
	if (!swapLog) {
		throw new Error(`No swap log found on pool ${args.context.poolAddress} in ${args.txHash}`);
	}
	const swapDecoded = decodeEventLog({
		abi: [SWAP_EVENT],
		data: swapLog.data,
		topics: swapLog.topics,
	});
	const amount0 = swapDecoded.args.amount0; // WETH (token0)
	const amount1 = swapDecoded.args.amount1; // USDC (token1)

	// Direction: positive token1 (USDC into pool) = user bought WETH.
	const direction: Direction = amount1 > 0n ? 'buy_weth' : 'sell_weth';
	const amountInRaw = direction === 'buy_weth' ? amount1 : amount0;
	const amountOutRaw = direction === 'buy_weth' ? abs(amount0) : abs(amount1);

	// debug_traceTransaction is non-standard; viem's typed `request` doesn't know
	// about it. Cast through `unknown` to bypass the union without disabling
	// strictness elsewhere.
	const rawTrace = await (
		client.request as unknown as (req: { method: string; params: unknown[] }) => Promise<unknown>
	)({
		method: 'debug_traceTransaction',
		params: [
			args.txHash,
			{ tracer: 'callTracer', tracerConfig: { withLog: true, onlyTopCall: false } },
		],
	});

	const transfers = extractTransfers(rawTrace, {
		userLower: tx.from.toLowerCase(),
		poolLower: args.context.poolAddress.toLowerCase(),
		feeRecipientsLower: args.context.feeRecipientsLower ?? new Set(),
	});

	return {
		txHash: args.txHash,
		blockNumber: Number(receipt.blockNumber),
		blockTimestamp: Number(block.timestamp),
		from: tx.from,
		to: tx.to,
		aggregator: args.context.aggregator,
		direction,
		amountInRaw,
		amountOutRaw,
		gasUsed: receipt.gasUsed,
		effectiveGasPrice: receipt.effectiveGasPrice ?? 0n,
		poolAddress: args.context.poolAddress,
		poolFeeTier: args.context.poolFeeTier,
		transfers,
		rawTrace,
	};
}

/**
 * Walks a callTracer trace tree, pulls every USDC/WETH Transfer log, decodes
 * it, and classifies the recipient. Used downstream by the TCA calculator
 * for the aggregator-fee component (transfers whose recipient is a known
 * fee wallet are the aggregator fee).
 */
function extractTransfers(
	trace: unknown,
	context: {
		userLower: string;
		poolLower: string;
		feeRecipientsLower: Set<string>;
	},
): TransferEvent[] {
	const out: TransferEvent[] = [];
	const visit = (node: TraceNode) => {
		if (node.logs) {
			for (const logEntry of node.logs) {
				const tokenLower = logEntry.address.toLowerCase();
				if (tokenLower !== USDC.toLowerCase() && tokenLower !== WETH.toLowerCase()) continue;
				try {
					const decoded = decodeEventLog({
						abi: [TRANSFER_EVENT],
						data: logEntry.data,
						topics: logEntry.topics,
					});
					out.push({
						token: logEntry.address.toLowerCase() as `0x${string}`,
						from: decoded.args.from,
						to: decoded.args.to,
						value: decoded.args.value,
						recipientClass: classify(decoded.args.to.toLowerCase(), context),
					});
				} catch {
					// Non-Transfer log on the same token contract — ignore.
				}
			}
		}
		if (node.calls) {
			for (const child of node.calls) visit(child);
		}
	};
	visit(trace as TraceNode);
	return out;
}

function classify(
	recipientLower: string,
	context: { userLower: string; poolLower: string; feeRecipientsLower: Set<string> },
): TransferRecipientClass {
	if (recipientLower === context.userLower) return 'user';
	if (recipientLower === context.poolLower) return 'pool';
	if (context.feeRecipientsLower.has(recipientLower)) return 'aggregator_fee';
	return 'other';
}

/**
 * Minimal shape of a callTracer node. We only read `logs` and `calls`; the
 * tree may have many more fields (from/to/value/gas/etc.) which we ignore.
 */
interface TraceNode {
	logs?: {
		address: `0x${string}`;
		data: `0x${string}`;
		topics: [signature: `0x${string}`, ...args: `0x${string}`[]] | [];
	}[];
	calls?: TraceNode[];
}

function abs(n: bigint): bigint {
	return n < 0n ? -n : n;
}
