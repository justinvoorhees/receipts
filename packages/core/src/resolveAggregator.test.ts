import { describe, expect, it } from 'vitest';
import { resolveAggregator } from './resolveAggregator.js';
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
