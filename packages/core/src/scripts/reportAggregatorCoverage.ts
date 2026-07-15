/**
 * Print the Base aggregator coverage gap, ranked by 24h volume.
 *
 * Run:  npm run aggregators:coverage
 *
 * Reports only — writes no config and labels nothing.
 */

import { computeCoverage, COVERED_MODULES, type LlamaProtocol } from '../aggregatorCoverage.js';

const API = 'https://api.llama.fi/overview/aggregators/base' +
	'?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true';

const usd = (n: number) => '$' + (n / 1e6).toFixed(1) + 'M';

async function main(): Promise<void> {
	const res = await fetch(API);
	if (!res.ok) throw new Error(`DefiLlama returned ${res.status}`);
	const body = (await res.json()) as { protocols?: LlamaProtocol[] };
	const report = computeCoverage(body.protocols ?? [], COVERED_MODULES);

	const pct = (n: number) => ((100 * n) / report.totalUsd).toFixed(0) + '%';
	console.log(`\nBase aggregator volume (24h): ${usd(report.totalUsd)} across ${report.liveCount} live aggregators\n`);
	console.log(`  COVERED  ${usd(report.coveredUsd).padStart(8)}  ${pct(report.coveredUsd)}`);
	console.log(`  MISSING  ${usd(report.missingUsd).padStart(8)}  ${pct(report.missingUsd)}\n`);
	console.log('Gaps by volume (a research queue, not addresses to paste):');
	for (const g of report.gaps.slice(0, 15)) {
		console.log(`  ${usd(g.volumeUsd).padStart(8)}  ${g.name}  (module: ${g.module})`);
	}
	console.log('');
}

main().catch((e: unknown) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
