import { describe, expect, it } from 'vitest';
import { resolveAggregator, resolveAggregatorDeep, callTargetsByDepth } from './resolveAggregator.js';
import { AGGREGATOR_SIGNATURES } from './aggregatorSignatures.js';
import { loadRouterRegistry } from './routerRegistry.js';
import { loadSettlerRegistry } from './settlerRegistry.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SETTLER_CURRENT = '0x7747f8d2a76bd6345cc29622a946a929647f2359'; // feature 2, blk 44438102
const SETTLER_RETIRED = '0xdc5d8200a030798bc6227240f68b4dd9542686ef'; // feature 2, retired at 44438102
const KYBER_ROUTER = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';
const KYBER_TOPIC = AGGREGATOR_SIGNATURES['kyberswap']!.eventTopics[0]!;
const NORDSTERN_TOPIC = AGGREGATOR_SIGNATURES['nordstern']!.eventTopics[0]!;
const UNKNOWN = '0x1234567890123456789012345678901234567890';

describe('resolveAggregator — resolver tier', () => {
	it('resolves the current 0x Settler (receipt id 179 regression)', () => {
		const r = resolveAggregator(SETTLER_CURRENT, []);
		expect(r.label).toBe('0x');
		expect(r.slug).toBe('0x');
		expect(r.detectedVia).toBe('resolver');
	});

	it('resolves a RETIRED Settler — identity is a set, not a timeline', () => {
		const r = resolveAggregator(SETTLER_RETIRED, []);
		expect(r.label).toBe('0x');
		expect(r.detectedVia).toBe('resolver');
	});

	it('is case-insensitive', () => {
		expect(resolveAggregator(SETTLER_CURRENT.toUpperCase(), []).label).toBe('0x');
	});
});

describe('resolveAggregator — address tier', () => {
	it('resolves a curated router', () => {
		const r = resolveAggregator(KYBER_ROUTER, []);
		expect(r.label).toBe('KyberSwap');
		expect(r.slug).toBe('kyberswap');
		expect(r.detectedVia).toBe('address');
	});
});

describe('resolveAggregator — nesting guard (Design Decision 1)', () => {
	it('a known `to` WINS over a foreign inner topic', () => {
		// A Kyber trade that routes through Nordstern internally must stay Kyber.
		const logs = [{ address: '0xinner', topics: [NORDSTERN_TOPIC] }];
		const r = resolveAggregator(KYBER_ROUTER, logs);
		expect(r.label).toBe('KyberSwap');
		expect(r.detectedVia).toBe('address');
		expect(r.hints).toEqual([]);
	});

	it('a 0x Settler `to` WINS over an inner topic (trade 0xb02037…9e26 shape)', () => {
		const logs = [{ address: '0xinner', topics: [KYBER_TOPIC] }];
		expect(resolveAggregator(SETTLER_CURRENT, logs).label).toBe('0x');
	});

	it('does NOT auto-label an unknown `to` from an inner topic — it hints instead', () => {
		// Indistinguishable from "new meta-aggregator routing through Nordstern",
		// so we must not guess.
		const logs = [{ address: '0xinner', topics: [NORDSTERN_TOPIC] }];
		const r = resolveAggregator(UNKNOWN, logs);
		expect(r.label).toBe(UNKNOWN);
		expect(r.detectedVia).toBe('unknown');
		expect(r.hints).toEqual(['nordstern']);
	});
});

describe('resolveAggregator — unknown tier', () => {
	it('returns the raw address with no hints when nothing matches', () => {
		const r = resolveAggregator(UNKNOWN, [{ address: '0xx', topics: ['0xnope'] }]);
		expect(r.label).toBe(UNKNOWN);
		expect(r.detectedVia).toBe('unknown');
		expect(r.hints).toEqual([]);
	});

	it('handles a null `to` (contract creation)', () => {
		const r = resolveAggregator(null, []);
		expect(r.label).toBe('unknown');
		expect(r.detectedVia).toBe('unknown');
	});
});

describe('resolveAggregator — tier-2 regression guard', () => {
	it('every active router in configs/routers.json still resolves via the address tier', async () => {
		const configPath = path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			'../../../configs/routers.json',
		);
		const registry = await loadRouterRegistry(configPath);
		expect(registry.all.length).toBeGreaterThan(0);
		for (const router of registry.all) {
			const r = resolveAggregator(router.address, []);
			expect(r.detectedVia, `${router.name} ${router.version} (${router.address})`).toBe('address');
			expect(r.label, `${router.name} ${router.version}`).toBe(router.name);
			expect(r.hints).toEqual([]);
			expect(
				AGGREGATOR_SIGNATURES[r.slug],
				`router "${router.name}" resolves to slug "${r.slug}" with no AGGREGATOR_SIGNATURES entry — its trades would carry a permanent NO_SIGNATURE flag`,
			).toBeDefined();
		}
	});

	it('every aggregator in configs/settlers.json maps to a signature entry', async () => {
		const configPath = path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			'../../../configs/settlers.json',
		);
		const registry = await loadSettlerRegistry(configPath);
		expect(registry.all.length).toBeGreaterThan(0);
		const slugs = new Set(registry.all.map((s) => s.aggregator.toLowerCase()));
		for (const slug of slugs) {
			expect(AGGREGATOR_SIGNATURES[slug], `settlers.json aggregator "${slug}" has no signature entry`).toBeDefined();
		}
	});
});

// ─── Deep resolution: tx.to is not always the router ───
//
// When the transaction's entry point is the trader's OWN account (an EIP-7702
// delegated EOA self-calling `execute`) or an ERC-4337 EntryPoint, `tx.to` is
// not a router at all, and resolveAggregator labels the wallet/EntryPoint as the
// aggregator. Real cases: receipt id 543 (tx.to == trader, 7702 self-call, the
// real router is Fabric one frame down) and Relay tx 0x30e83971… (tx.to is
// EntryPoint v0.7, Relay's approval proxy sits at depth 5).
const FABRIC_ROUTER = '0x7c137a37742437d2212b7bd873ed135b5c4c61da';
const RELAY_PROXY = '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be';
const TRADER_7702 = '0x21145601706b95ccfeabd83953ca5eab68d6403f';
const ENTRYPOINT_V07 = '0x0000000071727de22e5e9d8baf0edac6f37da032';

const call = (to: string, calls: unknown[] = [], type = 'CALL') => ({ type, to, calls });

describe('callTargetsByDepth', () => {
	it('returns CALL targets shallowest-first, deduped', () => {
		const trace = call('0xaa', [call('0xbb', [call('0xdd')]), call('0xcc'), call('0xbb')]);
		expect(callTargetsByDepth(trace as never)).toEqual(['0xaa', '0xbb', '0xcc', '0xdd']);
	});

	it('skips DELEGATECALL/STATICCALL targets — an implementation is not a router', () => {
		const trace = call('0xaa', [
			call('0xbb', [], 'DELEGATECALL'),
			call('0xcc', [], 'STATICCALL'),
			call('0xdd'),
		]);
		expect(callTargetsByDepth(trace as never)).toEqual(['0xaa', '0xdd']);
	});
});

describe('resolveAggregatorDeep', () => {
	it('keeps the tx.to resolution and ignores deeper routers (additive guarantee)', () => {
		// Relay proxy is tx.to; Fabric's router is one frame down. Relay must win.
		const trace = call(RELAY_PROXY, [call(FABRIC_ROUTER)]);
		const r = resolveAggregatorDeep({ to: RELAY_PROXY, logs: [], trace: trace as never });
		expect(r.label).toBe('Relay');
		expect(r.detectedVia).toBe('address');
	});

	it('falls through a 7702 self-call to the router one frame down (id 543)', () => {
		const trace = call(TRADER_7702, [call('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'), call(FABRIC_ROUTER)]);
		const r = resolveAggregatorDeep({
			to: TRADER_7702, logs: [], trace: trace as never, notRouters: new Set([TRADER_7702]),
		});
		expect(r.label).toBe('Fabric');
		expect(r.detectedVia).toBe('address');
	});

	it('falls through an ERC-4337 EntryPoint to the shallowest registered router', () => {
		// Relay proxy (depth 2) sits above Fabric's router (depth 3) — Relay wins,
		// matching how the same trade resolves when submitted directly.
		const trace = call(ENTRYPOINT_V07, [call('0xdeadbeef', [call(RELAY_PROXY, [call(FABRIC_ROUTER)])])]);
		const r = resolveAggregatorDeep({
			to: ENTRYPOINT_V07, logs: [], trace: trace as never, notRouters: new Set([ENTRYPOINT_V07]),
		});
		expect(r.label).toBe('Relay');
	});

	it('skips excluded addresses', () => {
		const trace = call(TRADER_7702, [call(FABRIC_ROUTER)]);
		const r = resolveAggregatorDeep({
			to: TRADER_7702, logs: [], trace: trace as never,
			notRouters: new Set([TRADER_7702, FABRIC_ROUTER]),
		});
		expect(r.detectedVia).toBe('unknown');
	});

	it('preserves the original unknown resolution when nothing in the trace resolves', () => {
		const trace = call(UNKNOWN, [call('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')]);
		const r = resolveAggregatorDeep({ to: UNKNOWN, logs: [], trace: trace as never });
		expect(r.detectedVia).toBe('unknown');
		expect(r.label).toBe(UNKNOWN);
	});
});

describe('resolveAggregatorDeep — matchedAddress', () => {
	it('reports tx.to when tx.to resolved', () => {
		const trace = call(RELAY_PROXY, []);
		expect(resolveAggregatorDeep({ to: RELAY_PROXY, logs: [], trace: trace as never }).matchedAddress)
			.toBe(RELAY_PROXY);
	});

	it('reports the deeper router that actually matched', () => {
		const trace = call(TRADER_7702, [call(FABRIC_ROUTER)]);
		const r = resolveAggregatorDeep({
			to: TRADER_7702, logs: [], trace: trace as never, notRouters: new Set([TRADER_7702]),
		});
		expect(r.matchedAddress).toBe(FABRIC_ROUTER);
	});

	it('reports null when nothing resolved — never asserts the wallet was a router', () => {
		const trace = call(UNKNOWN, []);
		expect(resolveAggregatorDeep({ to: UNKNOWN, logs: [], trace: trace as never }).matchedAddress)
			.toBeNull();
	});
});

describe('resolveAggregatorDeep — never guesses past an unrecognized router', () => {
	// An unrecognized CONTRACT entry point may well be an uncurated aggregator
	// routing through Fabric/0x. Naming it by its downstream liquidity source
	// would misattribute the trade, which is precisely what the
	// AGGREGATOR_UNKNOWN_HINT triage flag exists to prevent. Only an entry point
	// that is PROVABLY not a router — the trader's own account, or an ERC-4337
	// EntryPoint — may be looked past. Real cases: receipts 250 / 487 / 488.
	const UNCURATED_ROUTER = '0x5f693aa785c5c8301f21ec9d204cde209514d431';

	it('stays unknown when the entry point is merely unrecognized', () => {
		const trace = call(UNCURATED_ROUTER, [call(FABRIC_ROUTER)]);
		const r = resolveAggregatorDeep({
			to: UNCURATED_ROUTER, logs: [], trace: trace as never,
			notRouters: new Set([TRADER_7702]), // entry point is NOT in the set
		});
		expect(r.detectedVia).toBe('unknown');
		expect(r.label).toBe(UNCURATED_ROUTER);
		expect(r.matchedAddress).toBeNull();
	});

	it('looks past the entry point only when it is provably not a router', () => {
		const trace = call(TRADER_7702, [call(FABRIC_ROUTER)]);
		const r = resolveAggregatorDeep({
			to: TRADER_7702, logs: [], trace: trace as never,
			notRouters: new Set([TRADER_7702]),
		});
		expect(r.label).toBe('Fabric');
	});
});
