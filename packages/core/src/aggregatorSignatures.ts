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
	// OpenOcean settles on the router itself, so plain 'router' mode works. Both
	// topics are required: Swapped is 88% of live traffic (506/574 logs in ~9000
	// blocks) but the discovery tx 0x7169fbb3… emits SimpleSwapped (68/574) — a
	// Swapped-only entry would match `to`, label the trade, then flag
	// SETTLEMENT_EVENT_MISSING on the very receipt that prompted the work.
	// Topics derived from the verified impl ABI (0x201263ce…), not guessed.
	openocean: {
		aggregator: 'openocean', settlementContract: '0x6352a56caadc4f1e25cd6c75970fa768a3304e64',
		eventTopics: [
			'0x76af224a143865a50b41496e1a73622698692c565c1214bc862f18e22d829c5e', // Swapped
			'0xab5ce61cc1108f6c770a3f1c268c5be3f795d9d805e8a5445a4b480323f5612f', // SimpleSwapped
		],
		// null because two distinct events share this entry — same reason as odos
		eventName: null,
	},
	// OKX runs two routers (DexRouter + the dormant DexRouterExactOut), so like
	// odos this needs event_anywhere: settlementContract can only name one, and a
	// DexRouterExactOut trade would otherwise miss. Topic from the verified
	// DexRouter ABI, observed 5445x over 5388 txs in ~9000 blocks (~1/tx).
	//
	// This entry also earns its keep on trades it CANNOT label: ~22% of sampled
	// OKX flow arrives via per-user TradingVault clones, where `to` is the user's
	// own smart account. Those stay `unknown` — correctly, since the vault is not
	// an aggregator — but findAggregatorHints surfaces 'okx' from this topic, so
	// they land triageable rather than opaque.
	okx: {
		aggregator: 'okx', settlementContract: '0xc8f6b8ba0dc0f175b568b99440b0867f69a29265',
		eventTopics: ['0x1bb43f2da90e35f7b0cf38521ca95a49e68eb42fac49924930a5bd73cdf7576c'],
		eventName: 'OrderRecord', detectBy: 'event_anywhere',
	},
	// UniswapV2Router02 emits NO events of its own — the settlement event lives on
	// the pair, as `Swap(address,uint256,uint256,uint256,uint256,address)` =
	// 0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822 (computed
	// from the ABI signature, not recalled). That topic is deliberately NOT listed
	// here, and this entry is 'none' rather than 'event_anywhere', for two reasons:
	//
	//   1. Router mode would look for a non-noise event FROM the router address and
	//      never find one, flagging SETTLEMENT_EVENT_MISSING on every Uniswap trade.
	//   2. The V2 Swap topic is shared by every V2 fork on Base (Aerodrome basic
	//      pools, PancakeSwap V2, Sushi, …). Under 'event_anywhere' it would make
	//      findAggregatorHints suggest 'uniswap' on any of their swaps. This repo
	//      has been bitten by treating topic0 as identity before — QuickSwap/Algebra
	//      had to be tagged by FACTORY for exactly this reason.
	//
	// Identity comes from `to` via resolveAggregator regardless, which is the tier
	// this router is registered under. Same posture as 0x: not topic-detectable.
	uniswap: {
		aggregator: 'uniswap', settlementContract: '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24',
		eventTopics: [], eventName: null, detectBy: 'none',
	},
	// Spire's Base-side L2Bridge. Unlike Uniswap above it DOES emit its own events
	// from its own address (the routers.json address is a minimal proxy, and
	// delegatecall preserves the emitting address, so the proxy is the right
	// settlementContract). Topics left empty: no sample tx in our dataset yet, so
	// router mode falls back to "first non-noise event from this contract" — which
	// is also how the real topic gets discovered, since matchSettlementEvent
	// returns what actually fired. Same deferral as 1inch.
	spire: {
		aggregator: 'spire', settlementContract: '0x3348ca6e00224043ec20089fdadfafec2f5dc314',
		eventTopics: [], eventName: null,
	},
	// ⚠️ Juicebox is NOT a swap router — see the _caveat on its routers.json entry.
	// JBMultiTerminal is one shared address across every Juicebox project; pay()
	// mints a project token and redeem() reclaims treasury surplus, neither of
	// which is market-priced the way a router swap is. This entry exists so the
	// tier-2 guard passes and so its events are recorded rather than flagged
	// missing; it does not assert that cost analysis is meaningful on these txs.
	// Topics empty for the same reason as spire — no sample tx yet.
	juicebox: {
		aggregator: 'juicebox', settlementContract: '0x2db6d704058e552defe415753465df8df0361846',
		eventTopics: [], eventName: null,
	},
	// fly.trade is Magpie's rebranded front-end (MagpieRouterV3_1); the
	// routers.json entry is a verified non-proxy contract, so it emits from its
	// own address and is its own settlementContract. Topics empty for the same
	// reason as spire and juicebox: no sample tx. Checked the 300-block Base Seed
	// archive (50842630-50842929) — fly.trade appears zero times, as tx_to and as
	// a log emitter, so router mode's "first non-noise event from this contract"
	// fallback is also what will discover the real topic when one shows up.
	'fly.trade': {
		aggregator: 'fly.trade', settlementContract: '0x5e766616aabfb588e23a8ea854e9dbd1042affd3',
		eventTopics: [], eventName: null,
	},
	// LI.FI's diamond settles down TWO paths, so it needs both topics: a same-chain
	// swap ends in LiFiGenericSwapCompleted, a bridge starts with LiFiTransferStarted.
	// Topics sourced from the 300-block Base Seed archive (50842630-50842929), where
	// the diamond is tx_to on 25 txs: 8 emit the swap event, 16 the bridge event, and
	// together they cover 24 of the 24 SUCCESSFUL routed txs (the 25th reverted and
	// correctly emits nothing). Both are emitted BY the diamond, so plain router mode
	// is right and no event_anywhere escape is needed.
	// AssetSwapped (0x7bfdfdb5…) is deliberately NOT here: it fires once per DEX leg
	// (291 logs across 161 txs), so it marks a hop, not a settlement.
	'li.fi': {
		aggregator: 'li.fi', settlementContract: '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae',
		eventTopics: [
			'0x38eee76fd911eabac79da7af16053e809be0e12c8637f156e77e1af309b99537', // LiFiGenericSwapCompleted
			'0xcba69f43792f9f399347222505213b55af8e0b0b54b893085c2e27ecbe1644f1', // LiFiTransferStarted
		],
		// Two events with different names share this entry, as with odos above.
		eventName: null,
	},
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
