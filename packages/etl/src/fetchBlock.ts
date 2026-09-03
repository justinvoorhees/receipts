import type { BlockPayloads } from './buildSeedRows.js';
import type { RawBlock, RawReceipt, TraceEntry } from './rpcTypes.js';
import { rpcCall } from './finality.js';

/**
 * fetchBlock.ts — the three calls that describe one block.
 *
 * They are issued in parallel because they are independent, and they are kept
 * in one function so that a Seed row can never be built from a partial fetch.
 */
export async function fetchBlockPayloads(
	rpcUrl: string,
	blockNumber: number,
): Promise<BlockPayloads> {
	const tag = `0x${blockNumber.toString(16)}`;
	const [traceBlock, receipts, block] = await Promise.all([
		rpcCall<TraceEntry[]>(rpcUrl, 'debug_traceBlockByNumber', [
			tag,
			{ tracer: 'callTracer', tracerConfig: { withLog: true, onlyTopCall: false } },
		]),
		rpcCall<RawReceipt[]>(rpcUrl, 'eth_getBlockReceipts', [tag]),
		rpcCall<RawBlock>(rpcUrl, 'eth_getBlockByNumber', [tag, true]),
	]);
	return { traceBlock, receipts, block };
}
