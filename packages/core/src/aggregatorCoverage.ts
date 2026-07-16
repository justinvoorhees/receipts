/**
 * aggregatorCoverage.ts — which Base aggregators do we not cover?
 *
 * DefiLlama's aggregator list gives NAMES and VOLUME but no addresses (every
 * protocol returns `address: undefined`), so it can never tag anything. Its
 * only value is knowing what we don't know: a gap list ranked by volume.
 *
 * This is a REPORT. Per Design Decision 5, DefiLlama is third-party inference
 * and must never auto-label — it feeds the curated tier via human + on-chain
 * verification. Nothing here writes config.
 *
 * The gap list is a research queue, not addresses to paste: the wallet
 * front-ends (OKX, Bitget, Binance) plausibly route THROUGH other aggregators,
 * and CoWSwap (batch intents) / Bebop (RFQ) settle in shapes our decomposition
 * has never seen. Each is its own investigation.
 */

export interface LlamaProtocol {
	name: string;
	displayName?: string;
	module: string;
	total24h: number | null;
}

export interface CoverageGap {
	name: string;
	module: string;
	volumeUsd: number;
}

export interface CoverageReport {
	totalUsd: number;
	coveredUsd: number;
	missingUsd: number;
	liveCount: number;
	gaps: CoverageGap[];
}

/**
 * DefiLlama `module` → the label we resolve it to. 'zrx' counts as covered
 * because the Deployer resolver identifies 0x Settler. Relay and Fabric have no
 * entry: DefiLlama classifies Relay as a bridge and does not list Fabric, so
 * this list is NOT a superset of what we need.
 */
export const COVERED_MODULES: Record<string, string> = {
	kyberswap: 'KyberSwap',
	zrx: '0x',
	odos: 'Odos',
	'1inch-agg': '1inch',
	paraswap: 'Velora',
	'nordstern-finance': 'Nordstern',
	openocean: 'OpenOcean',
	okx: 'OKX',
};

export function computeCoverage(
	protocols: readonly LlamaProtocol[],
	coveredModules: Record<string, string>,
): CoverageReport {
	const live = protocols.filter((p) => (p.total24h ?? 0) > 0);
	let coveredUsd = 0;
	let missingUsd = 0;
	const gaps: CoverageGap[] = [];

	for (const p of live) {
		const vol = p.total24h ?? 0;
		if (coveredModules[p.module]) {
			coveredUsd += vol;
		} else {
			missingUsd += vol;
			gaps.push({ name: p.displayName ?? p.name, module: p.module, volumeUsd: vol });
		}
	}

	gaps.sort((a, b) => b.volumeUsd - a.volumeUsd);
	return { totalUsd: coveredUsd + missingUsd, coveredUsd, missingUsd, liveCount: live.length, gaps };
}
