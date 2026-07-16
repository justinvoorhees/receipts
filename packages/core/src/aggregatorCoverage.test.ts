import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { computeCoverage, COVERED_MODULES, type LlamaProtocol } from './aggregatorCoverage.js';

// Read the fixture rather than `import ... with { type: 'json' }` — `tsc --build`
// compiles test files, and a JSON import would be emitted into dist for no gain.
const fixturePath = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'__fixtures__/defillama-base-aggregators.json',
);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { protocols: LlamaProtocol[] };

describe('computeCoverage', () => {
	const protocols = [
		{ name: 'KyberSwap Aggregator', displayName: 'KyberSwap', module: 'kyberswap', total24h: 100 },
		{ name: 'OKX Swap', displayName: 'OKX Swap', module: 'okx', total24h: 60 },
		{ name: 'fly.trade', displayName: 'fly.trade', module: 'magpie', total24h: 40 },
		{ name: 'Dead Agg', displayName: 'Dead Agg', module: 'dead', total24h: 0 },
		{ name: 'Null Agg', displayName: 'Null Agg', module: 'nullagg', total24h: null },
	];

	it('splits covered from missing by module', () => {
		const r = computeCoverage(protocols, { kyberswap: 'KyberSwap' });
		expect(r.coveredUsd).toBe(100);
		expect(r.missingUsd).toBe(100);
		expect(r.totalUsd).toBe(200);
	});

	it('excludes zero- and null-volume aggregators from the live set', () => {
		const r = computeCoverage(protocols, { kyberswap: 'KyberSwap' });
		expect(r.liveCount).toBe(3);
	});

	it('ranks gaps by volume, descending', () => {
		const r = computeCoverage(protocols, { kyberswap: 'KyberSwap' });
		expect(r.gaps.map((g) => g.module)).toEqual(['okx', 'magpie']);
	});

	it('reports no gaps when everything is covered', () => {
		const r = computeCoverage(protocols, { kyberswap: 'K', okx: 'O', magpie: 'M' });
		expect(r.gaps).toEqual([]);
		expect(r.missingUsd).toBe(0);
	});

	it('maps every covered module to an aggregator we actually label', () => {
		for (const slug of Object.keys(COVERED_MODULES)) {
			expect(typeof COVERED_MODULES[slug]).toBe('string');
		}
		expect(COVERED_MODULES['zrx']).toBe('0x');
	});

	it('finds a real gap in the recorded DefiLlama fixture', () => {
		const r = computeCoverage(fixture.protocols, COVERED_MODULES);
		expect(r.liveCount).toBeGreaterThan(20);
		expect(r.missingUsd).toBeGreaterThan(0);
		// magpie (fly.trade) is the top uncovered aggregator by volume. Expect this
		// to fail the day it's covered — that's the point: the example must be a
		// module we genuinely don't label, so swap it for the next real gap rather
		// than weaken the assertion.
		expect(r.gaps.map((g) => g.module)).toContain('magpie');
		// These must count as COVERED — zrx via the Deployer resolver, okx via its
		// curated DexRouter entry.
		expect(r.gaps.map((g) => g.module)).not.toContain('zrx');
		expect(r.gaps.map((g) => g.module)).not.toContain('okx');
	});
});
