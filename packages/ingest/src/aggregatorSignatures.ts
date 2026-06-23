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
// eventTopic0 filled in from Checkpoint A discovery (smoke-36, 1 tx/agg).
export const AGGREGATOR_SIGNATURES: Record<string, SettlementSignature> = {
	odos:      { aggregator: 'odos',      settlementContract: '0x19ceead7105607cd444f5ad10dd51356436095a1', eventTopic0: null, eventName: null }, // no smoke-36 data (odos no-routed)
	'0x':      { aggregator: '0x',        settlementContract: '0xdef1c0ded9bec7f1a1670819833240f027b25eff', eventTopic0: null, eventName: null }, // not present in smoke-36
	// KyberSwap MetaAggregationRouterV2 emits 3 distinct events in one swap; which
	// one is THE settlement marker is unresolved — left null (events.length>0 still
	// confirms presence). Candidates from 0x1ca5f7…: d6d4f568…, ddac4093…, 095e66fa….
	kyberswap: { aggregator: 'kyberswap', settlementContract: '0x6131b5fae19ea4f9d964eac0408e4408b66337b5', eventTopic0: null, eventName: null },
	'1inch':   { aggregator: '1inch',     settlementContract: '0x111111125421ca6dc452d289314280a0f8842a65', eventTopic0: null, eventName: null }, // not present in smoke-36
	// Velora: AugustusV6.2 is the tx.to but emits no event itself; the settlement
	// event is emitted by an executor contract (0x4545410f…7140 topic 0x8b3e96…) that
	// varies per route. Router-address detection does NOT work for Velora — needs a
	// bespoke executor-based rule (deferred to Checkpoint B). eventSeen=false for now.
	velora:    { aggregator: 'velora',    settlementContract: '0x6a000f20005980200259b80c5102003040001068', eventTopic0: null, eventName: null },
	fabric:    { aggregator: 'fabric',    settlementContract: '0x7c137a37742437d2212b7bd873ed135b5c4c61da', eventTopic0: '0xa17e8d88f61171e605d4e0dfc13de5f313c34d72184d9c5cbfc70e27be23fdc8', eventName: null }, // discovered: 0x9703bfa3…
	nordstern: { aggregator: 'nordstern', settlementContract: '0xc87de04e2ec1f4282dff2933a2d58199f688fc3d', eventTopic0: '0x97d8fe5395a5423bef64e2004851e9b3f60f7848835afa581b4a0a8e84bc662d', eventName: null }, // discovered: 0x0d4227d1…
	relay:     { aggregator: 'relay',     settlementContract: '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be', eventTopic0: '0xafbab204e8271965231d37baed9b1abca8725b7409c70314455f68bc89142b91', eventName: null }, // discovered: 0x8fa230b6…
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
