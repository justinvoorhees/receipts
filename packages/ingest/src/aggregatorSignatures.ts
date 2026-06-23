/**
 * Bespoke per-aggregator settlement-event signature registry.
 *
 * The founding-engineer process: for each aggregator, find the unique event
 * its settlement contract emits. That signature (a) confirms a tx really
 * routed through that aggregator and (b) is the seed for future automated
 * discovery. `eventTopic0`/`eventName` start null and are filled in as we
 * inspect the first sample tx per aggregator (Checkpoint A).
 */
const WETH = '0x4200000000000000000000000000000000000006';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEPOSIT_TOPIC = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c';
const WITHDRAWAL_TOPIC = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
const NOISE_TOPICS = new Set([TRANSFER_TOPIC, DEPOSIT_TOPIC, WITHDRAWAL_TOPIC]);

export interface SettlementSignature {
	aggregator: string;
	settlementContract: string;
	eventTopic0: string | null;
	eventName: string | null;
}

// Router/settlement addresses (lowercase) from configs/routers.json.
export const AGGREGATOR_SIGNATURES: Record<string, SettlementSignature> = {
	odos:      { aggregator: 'odos',      settlementContract: '0x19ceead7105607cd444f5ad10dd51356436095a1', eventTopic0: null, eventName: null },
	'0x':      { aggregator: '0x',        settlementContract: '0xdef1c0ded9bec7f1a1670819833240f027b25eff', eventTopic0: null, eventName: null },
	kyberswap: { aggregator: 'kyberswap', settlementContract: '0x6131b5fae19ea4f9d964eac0408e4408b66337b5', eventTopic0: null, eventName: null },
	'1inch':   { aggregator: '1inch',     settlementContract: '0x111111125421ca6dc452d289314280a0f8842a65', eventTopic0: null, eventName: null },
	velora:    { aggregator: 'velora',    settlementContract: '0x6a000f20005980200259b80c5102003040001068', eventTopic0: null, eventName: null },
	fabric:    { aggregator: 'fabric',    settlementContract: '0x7c137a37742437d2212b7bd873ed135b5c4c61da', eventTopic0: null, eventName: null },
	nordstern: { aggregator: 'nordstern', settlementContract: '0xc87de04e2ec1f4282dff2933a2d58199f688fc3d', eventTopic0: null, eventName: null },
	relay:     { aggregator: 'relay',     settlementContract: '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be', eventTopic0: null, eventName: null },
};

export interface EmittedEvent { address: string; topic0: string; count: number }

/**
 * Distinct non-Transfer/non-wrap events emitted BY `settlementContract` in a
 * tx's logs, with counts. This is the inspection tool used to discover each
 * aggregator's unique settlement event.
 */
export function findSettlementEvents(
	logs: readonly { address: string; topics: readonly string[] }[],
	settlementContract: string,
): EmittedEvent[] {
	const target = settlementContract.toLowerCase();
	const counts = new Map<string, number>();
	for (const l of logs) {
		if (l.address.toLowerCase() !== target) continue;
		const topic0 = l.topics[0]?.toLowerCase();
		if (!topic0 || NOISE_TOPICS.has(topic0)) continue;
		counts.set(topic0, (counts.get(topic0) ?? 0) + 1);
	}
	return [...counts.entries()].map(([topic0, count]) => ({ address: target, topic0, count }));
}

// (WETH constant exported for reuse by callers that filter wrap noise.)
export { WETH };
