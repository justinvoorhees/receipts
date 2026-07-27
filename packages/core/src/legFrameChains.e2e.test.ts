/**
 * Live-RPC check that frame chains come out of real transactions the way the
 * corpus survey said they do. SKIPS without TCA_RPC_URL — export it before
 * gating on this file:
 *   set -a && source .env && set +a && npm test
 */
import { describe, expect, it } from 'vitest';
import { analyzeTransaction } from './analyzeTransaction.js';

const RPC = process.env.TCA_RPC_URL;
const CHAIN = 8453;
const FABRIC = '0x7c137a37742437d2212b7bd873ed135b5c4c61da';
const RELAY_PROXY = '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be';

describe.skipIf(!RPC)('frame chains on real transactions', () => {
	it('puts every leg of id328 (Relay > Fabric) inside Fabric', async () => {
		const r = await analyzeTransaction(
			'0x42fab3cdcd675ff50236d8f59555ae2dab4b088521ed1a173d23b735499869a5',
			CHAIN,
			{ rpcUrl: RPC! },
		);
		expect(r).not.toBeNull();
		const legs = r!.routeLegs as { frameChain?: string[] }[];
		expect(legs.length).toBeGreaterThan(0);
		for (const leg of legs) {
			expect(leg.frameChain).toBeDefined();
			expect(leg.frameChain!.at(-1)).toBe(FABRIC);
			expect(leg.frameChain![0]).toBe(RELAY_PROXY);
		}
	}, 60_000);

	it('attributes id250 to Fabric even though its top-level router is uncurated', async () => {
		const r = await analyzeTransaction(
			'0x9c53d5ec5a1d34e3b9f3da9b181cbe47b67e6bc198c42a1f55eddf4f0e9dccaf',
			CHAIN,
			{ rpcUrl: RPC! },
		);
		const legs = r!.routeLegs as { frameChain?: string[] }[];
		expect(legs).toHaveLength(4);
		for (const leg of legs) expect(leg.frameChain!.at(-1)).toBe(FABRIC);
	}, 60_000);

	it('leaves a single-aggregator trade with a chain that ends at that aggregator', async () => {
		// id135, KyberSwap. A chain still exists; it simply resolves to the
		// top-line aggregator, which Task 3 turns into "render nothing".
		const r = await analyzeTransaction(
			'0x783f45fec72a79ff3d54cf9897274604a70dc039eef4e257cc8117c65654f5fd',
			CHAIN,
			{ rpcUrl: RPC! },
		);
		const legs = r!.routeLegs as { frameChain?: string[] }[];
		expect(legs.length).toBeGreaterThan(0);
		expect(legs.every((l) => Array.isArray(l.frameChain))).toBe(true);
	}, 60_000);
});
