/**
 * Bespoke per-aggregator settlement-event signature registry.
 *
 * The founding-engineer process: for each aggregator, find the unique event
 * its settlement contract emits. That signature (a) confirms a tx really
 * routed through that aggregator and (b) is the seed for future automated
 * discovery. `eventTopics` starts empty and is filled in from a real sample
 * tx per aggregator. NOTE: these signatures verify a match and seed triage
 * hints — they never establish identity. Identity comes from `to`
 * (resolveAggregator).
 */
const WETH = '0x4200000000000000000000000000000000000006';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEPOSIT_TOPIC = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c';
const WITHDRAWAL_TOPIC = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
const NOISE_TOPICS = new Set([TRANSFER_TOPIC, DEPOSIT_TOPIC, WITHDRAWAL_TOPIC]);

export interface SettlementSignature {
	aggregator: string;
	settlementContract: string;
	/** Known settlement topics (lowercase). Empty = not yet discovered; router
	 *  mode then falls back to "any non-noise event from settlementContract". */
	eventTopics: readonly string[];
	eventName: string | null;
	/** 'router' (default): topic must come FROM settlementContract.
	 *  'event_anywhere': topic may come from any contract — for aggregators whose
	 *  settlement event lives on a per-route executor (Velora) or on a second
	 *  router not listed as settlementContract (Odos V3).
	 *  'none': this aggregator is not topic-detectable at all (0x — anonymous log).
	 *  NB: these modes govern VERIFICATION only. Identity always comes from
	 *  `to` via the resolver/curated tiers — see resolveAggregator.ts. */
	detectBy?: 'router' | 'event_anywhere' | 'none';
}

export const AGGREGATOR_SIGNATURES: Record<string, SettlementSignature> = {
	// Odos runs TWO live routers emitting different-arity events, so it needs
	// multiple topics AND event_anywhere (the V3 router is not settlementContract).
	// Topics derived from the DefiLlama adapter ABI, then confirmed on-chain:
	// 0x823eaf01 appears in receipts id 75/78; 0x69db20ca fired 272x from the V3
	// router in ~9000 blocks. Before this, eventTopics was empty and the router-mode
	// fallback accepted ANY non-noise event — settlement_event_seen was vacuous.
	odos: {
		aggregator: 'odos', settlementContract: '0x19ceead7105607cd444f5ad10dd51356436095a1',
		eventTopics: [
			'0x823eaf01002d7353fbcadb2ea3305cc46fa35d799cb0914846d185ac06f8ad05', // Swap v2
			'0x7d7fb03518253ae01913536628b78d6d82e63e19b943aab5f4948356021259be', // SwapMulti v2
			'0x69db20ca9e32403e6c56e5193b3e3b2827ae5c430ccfdea392ba950d2d1ab2bc', // Swap v3
			'0x2c96555a96d94780f3a97aeb724514e80e331842f3143742d85da5aa68df9d30', // SwapMulti v3
		],
		// eventName is null because four topics across two routers share this entry
		// (Swap + SwapMulti, v2 + v3) — no single name describes what fired.
		eventName: null, detectBy: 'event_anywhere',
	},
	// 0x Settler emits an ANONYMOUS log (topics: []), so no topic rule can ever
	// see it — `findSettlementEvents` skips zero-topic logs by construction.
	// Identity comes from the Deployer registry instead (configs/settlers.json).
	// settlementContract below is the RETIRED ExchangeProxy, kept for provenance
	// only; detectBy 'none' stops it producing a false SETTLEMENT_EVENT_MISSING.
	'0x': {
		aggregator: '0x', settlementContract: '0xdef1c0ded9bec7f1a1670819833240f027b25eff',
		eventTopics: [], eventName: null, detectBy: 'none',
	},
	// KyberSwap MetaAggregationRouterV2: keccak(Swapped(address,address,address,address,uint256,uint256))
	kyberswap: {
		aggregator: 'kyberswap', settlementContract: '0x6131b5fae19ea4f9d964eac0408e4408b66337b5',
		eventTopics: ['0xd6d4f5681c246c9f42c203e287975af1601f8df8035a9251f79aab5c8f09e2f8'], eventName: 'Swapped',
	},
	'1inch': {
		aggregator: '1inch', settlementContract: '0x111111125421ca6dc452d289314280a0f8842a65',
		eventTopics: [], eventName: null,
	}, // no sample tx in our dataset — deferred per the spec's stop rule
	// executor-emitted settlement event (per-route executor, not the Augustus router);
	// exact ABI name unidentified; observed in smoke-36 0x12adf9d1…
	velora: {
		aggregator: 'velora', settlementContract: '0x6a000f20005980200259b80c5102003040001068',
		eventTopics: ['0x8b3e96f2b889fa771c53c981b40daf005f63f637f1869f707052d15a3dd97140'],
		eventName: null, detectBy: 'event_anywhere',
	},
	fabric: {
		aggregator: 'fabric', settlementContract: '0x7c137a37742437d2212b7bd873ed135b5c4c61da',
		eventTopics: ['0xa17e8d88f61171e605d4e0dfc13de5f313c34d72184d9c5cbfc70e27be23fdc8'], eventName: null,
	}, // discovered: 0x9703bfa3…
	nordstern: {
		aggregator: 'nordstern', settlementContract: '0xc87de04e2ec1f4282dff2933a2d58199f688fc3d',
		eventTopics: ['0x97d8fe5395a5423bef64e2004851e9b3f60f7848835afa581b4a0a8e84bc662d'], eventName: null,
	}, // discovered: 0x0d4227d1…
	relay: {
		aggregator: 'relay', settlementContract: '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be',
		eventTopics: ['0xafbab204e8271965231d37baed9b1abca8725b7409c70314455f68bc89142b91'], eventName: null,
	}, // discovered: 0x8fa230b6…
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

/**
 * The settlement topic actually observed for this aggregator, or null. Returns
 * the MATCHED topic (not the expected one) so callers can record what really
 * fired — which is also how an unknown aggregator's topic gets discovered.
 */
export function matchSettlementEvent(
	logs: readonly { address: string; topics: readonly string[] }[],
	sig: SettlementSignature,
): string | null {
	if (sig.detectBy === 'none') return null;

	const want = sig.eventTopics.map((t) => t.toLowerCase());

	if (sig.detectBy === 'event_anywhere') {
		if (want.length === 0) return null;
		for (const l of logs) {
			const t = l.topics[0]?.toLowerCase();
			if (t && want.includes(t)) return t;
		}
		return null;
	}

	const events = findSettlementEvents(logs, sig.settlementContract);
	if (want.length === 0) return events[0]?.topic0 ?? null;
	for (const e of events) if (want.includes(e.topic0)) return e.topic0;
	return null;
}

/** True if the aggregator's distinctive settlement event is present.
 *  Thin wrapper over matchSettlementEvent — retained as the boolean predicate
 *  the design spec names, and as the seam the Odos multi-topic tests assert
 *  against. No production caller today: analyzeTransaction wants the matched
 *  topic, not a boolean. */
export function settlementEventPresent(
	logs: readonly { address: string; topics: readonly string[] }[],
	sig: SettlementSignature,
): boolean {
	return matchSettlementEvent(logs, sig) !== null;
}

/**
 * Slugs of aggregators whose settlement topic appears ANYWHERE in the logs.
 *
 * This is a TRIAGE HINT, never an identity. "unknown `to` + known inner topic"
 * cannot distinguish a known aggregator's new router from a novel
 * meta-aggregator routing THROUGH a known one — both look identical from logs.
 * So we surface the evidence for a human and label nothing. See Design
 * Decision 1.
 */
export function findAggregatorHints(
	logs: readonly { address: string; topics: readonly string[] }[],
): string[] {
	const seen = new Set<string>();
	for (const l of logs) {
		const t = l.topics[0]?.toLowerCase();
		if (t) seen.add(t);
	}
	const hits = new Set<string>();
	for (const [slug, sig] of Object.entries(AGGREGATOR_SIGNATURES)) {
		if (sig.detectBy === 'none') continue;
		if (sig.eventTopics.some((topic) => seen.has(topic.toLowerCase()))) hits.add(slug);
	}
	return [...hits].sort();
}

// (WETH constant exported for reuse by callers that filter wrap noise.)
export { WETH };
