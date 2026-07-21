/**
 * tradeFees — the pure fee steps of trade decomposition. Step 3 (aggregator-fee
 * sink detection) and Step 4b (route-purity detection). Split out of
 * decomposeTrade.ts (2026-07-21). Pure: no RPC. Each function returns its own
 * `flags` array for the orchestrator to concatenate in step order — never mutates
 * a shared array.
 */
import { USDC, WETH, DENYLIST, type RawTransfer } from './tradeEndpoints.js';

// Dust threshold in human USDC
export const DUST_USDC = 0.01;

// Threshold: if an address retains more than this fraction of notional, it's
// a counterparty / venue, not a fee sink. Fee sinks skim a small fraction.
const COUNTERPARTY_THRESHOLD = 0.10; // 10% of notional

export interface FeeSink {
	address: string;
	usdcRetained: number;
	wethRetained: number;
	totalUsdc: number;
	source: 'vault_map' | 'retained_balance';
}

// ─── Step 3: Agg fee (≥ 0) ───

export function computeAggFee(args: {
	transfers: RawTransfer[];
	addrDeltas: Map<string, { usdc: number; weth: number; nativeEth: number }>;
	isInfra: (addr: string) => boolean;
	knownVaults: Set<string>;
	dustUsdc: number;
	structuralFloor: number;
	realizedPrice: number;
	notionalUsdc: number;
}): { aggFeeBps: number; feeSinks: FeeSink[]; vaultMapFeeUsdc: number; flags: string[] } {
	const { transfers, addrDeltas, isInfra, knownVaults, dustUsdc, structuralFloor, realizedPrice, notionalUsdc } = args;
	const flags: string[] = [];

	// Build per-address third-token position: tracks whether an address moved
	// any token other than USDC/WETH. A fee-sink candidate that moved a third
	// token is a venue (e.g. USDC→USDT stableswap), not a fee collector.
	const addrThirdTokens = new Map<string, Set<string>>();
	for (const t of transfers) {
		const token = t.token.toLowerCase();
		if (token === USDC || token === WETH) continue;
		const fromLower = t.from.toLowerCase();
		const toLower = t.to.toLowerCase();
		if (!addrThirdTokens.has(fromLower)) addrThirdTokens.set(fromLower, new Set());
		if (!addrThirdTokens.has(toLower)) addrThirdTokens.set(toLower, new Set());
		addrThirdTokens.get(fromLower)!.add(token);
		addrThirdTokens.get(toLower)!.add(token);
	}

	const feeSinks: FeeSink[] = [];

	for (const [addr, delta] of addrDeltas) {
		if (isInfra(addr)) continue;
		if (addr === USDC || addr === WETH) continue;

		// Net retained value — combine USDC + WETH@realized + nativeETH@realized
		const usdcRetained = delta.usdc;
		const wethRetained = delta.weth + delta.nativeEth;
		const totalUsdc = usdcRetained + wethRetained * realizedPrice;

		if (Math.abs(totalUsdc) < dustUsdc && !knownVaults.has(addr)) continue;

		// Gate: if this address moved ANY third token (non-USDC/WETH), it is a
		// venue doing a swap (e.g. USDC→USDT stableswap), not a fee collector.
		// A true fee sink only retains USDC and/or WETH.
		const thirdTokensAtAddr = addrThirdTokens.get(addr);
		if (thirdTokensAtAddr && thirdTokensAtAddr.size > 0) {
			const tokenList = [...thirdTokensAtAddr].map(t => `${t.slice(0, 6)}...${t.slice(-4)}`).join(', ');
			flags.push(
				`VENUE (third-token gate): ${addr} moved ${tokenList} — reclassified as venue, not fee sink ` +
				`(USDC retained=${usdcRetained.toFixed(4)})`,
			);
			continue;
		}

		// Classify: known vault vs unclassified retained balance
		if (knownVaults.has(addr)) {
			feeSinks.push({
				address: addr,
				usdcRetained,
				wethRetained,
				totalUsdc,
				source: 'vault_map',
			});
		} else if (totalUsdc > dustUsdc) {
			// Check if this is a counterparty (retains the bulk of notional)
			// vs a fee sink (retains a small fraction). Counterparties are venues
			// that filled the trade — their retained value IS the trade, not a fee.
			const fractionOfNotional = totalUsdc / notionalUsdc;
			if (fractionOfNotional > COUNTERPARTY_THRESHOLD) {
				// Likely a counterparty / RFQ venue / solver — NOT a fee sink
				flags.push(
					`COUNTERPARTY: ${addr} retained ${totalUsdc.toFixed(4)} USDC ` +
					`(${(fractionOfNotional * 100).toFixed(1)}% of notional) — classified as venue, not fee sink`,
				);
			} else {
				// Small retained balance — potential fee sink, flag for review.
				// Apply a dust floor: only count toward aggFeeBps if the
				// retained value exceeds max($1.00, 1 bps of notional).
				// Below the floor, still surface the NEEDS REVIEW flag.
				if (totalUsdc >= structuralFloor) {
					flags.push(
						`NEEDS REVIEW: ${addr} retained ${totalUsdc.toFixed(4)} USDC ` +
						`(usdc=${usdcRetained.toFixed(4)}, weth_equiv=${(wethRetained * realizedPrice).toFixed(4)})`,
					);
					feeSinks.push({
						address: addr,
						usdcRetained,
						wethRetained,
						totalUsdc,
						source: 'retained_balance',
					});
				} else {
					// Below dust floor — flag for visibility but exclude
					// from the agg-fee total
					flags.push(
						`NEEDS REVIEW (dust, excluded from agg fee): ${addr} retained ` +
						`${totalUsdc.toFixed(4)} USDC ` +
						`(usdc=${usdcRetained.toFixed(4)}, weth_equiv=${(wethRetained * realizedPrice).toFixed(4)}, ` +
						`floor=${structuralFloor.toFixed(4)})`,
					);
				}
			}
		}
		// Negative retained (net payer) — not a fee sink, skip
	}

	const aggFeeUsdc = feeSinks.reduce((sum, s) => sum + s.totalUsdc, 0);
	// Separate known-vault vs structural (retained-balance) contributions so the
	// plausibility guard can preserve vault-map fees while discarding structural
	// mis-detections.
	const vaultMapFeeUsdc = feeSinks
		.filter(s => s.source === 'vault_map')
		.reduce((sum, s) => sum + s.totalUsdc, 0);
	const rawAggFeeBps = notionalUsdc > 0 ? (aggFeeUsdc / notionalUsdc) * 10_000 : 0;
	// Floor: agg fee is retained value and is definitionally >= 0.
	// A negative value means the fee-sink detector mis-fired (e.g. native-ETH
	// artifact counted as a fee sink). Clamp to 0.
	const aggFeeBps = Math.max(0, rawAggFeeBps);
	if (rawAggFeeBps < 0) {
		flags.push(
			`AGG_FEE_FLOORED: raw agg fee was ${rawAggFeeBps.toFixed(2)} bps — ` +
			`clamped to 0 (negative = mis-detection)`,
		);
	}

	return { aggFeeBps, feeSinks, vaultMapFeeUsdc, flags };
}

// ─── Step 4b: Route-purity detection ───
// A route is impure (LP/slippage not separable) only if a third token
// (non-USDC, non-WETH) is transiently held by a trade "hub" — one of
// the aggregator's DENYLIST router addresses that intermediates the
// trader's tokens.
//
// Hub addresses are DENYLIST entries (excluding token contracts USDC/WETH
// and pool addresses already in venueAddresses) that have nonzero USDC
// or WETH flow. A third token only moving among peripheral filler/MM
// addresses (not through any hub) is a co-settled batch leg → NOT impure.

export function detectRoutePurity(args: {
	transfers: RawTransfer[];
	venueAddresses: Set<string>;
	impureOnVenueThirdToken: boolean;
}): { isImpure: boolean; thirdTokens: Set<string>; thirdTokenHubs: Map<string, string> } {
	const { transfers, venueAddresses, impureOnVenueThirdToken } = args;

	// Step 4b-i: Identify ALL hub addresses — DENYLIST routers with USDC/WETH
	// gross flow (total inflow or outflow, not net — a pass-through router has
	// net zero but still intermediates the trade).
	const hubGrossFlow = new Map<string, number>(); // addr → gross USDC+WETH volume
	for (const t of transfers) {
		const token = t.token.toLowerCase();
		if (token !== USDC && token !== WETH) continue;
		const humanVal = token === USDC ? Number(t.value) / 1e6 : Number(t.value) / 1e18;
		const fromLower = t.from.toLowerCase();
		const toLower = t.to.toLowerCase();
		// Accumulate gross flow at each address
		hubGrossFlow.set(fromLower, (hubGrossFlow.get(fromLower) ?? 0) + humanVal);
		hubGrossFlow.set(toLower, (hubGrossFlow.get(toLower) ?? 0) + humanVal);
	}
	const hubAddresses = new Set<string>();
	for (const addr of DENYLIST) {
		if (addr === USDC || addr === WETH) continue;
		if (venueAddresses.has(addr)) continue; // pools, not routers
		const grossFlow = hubGrossFlow.get(addr) ?? 0;
		if (grossFlow > DUST_USDC) {
			hubAddresses.add(addr);
		}
	}

	// Build the impurity-trigger set: hub addresses plus (optionally) venue
	// addresses when impureOnVenueThirdToken is true. This makes third-token
	// flow through a pool (e.g. USDC→VIRTUAL→WETH via a VIRTUAL pool) trigger
	// impurity consistently regardless of fee magnitude.
	const impurityTriggerAddrs = new Set<string>(hubAddresses);
	if (impureOnVenueThirdToken) {
		for (const v of venueAddresses) impurityTriggerAddrs.add(v);
	}

	// Step 4b-ii: Check if any third token flows through ANY impurity-trigger address
	// A third token makes the route impure only if a trigger address received or sent it.
	const thirdTokens = new Set<string>();
	const thirdTokenHubs = new Map<string, string>(); // token → hub/venue address that held it

	for (const t of transfers) {
		const token = t.token.toLowerCase();
		if (token === USDC || token === WETH) continue;
		const fromLower = t.from.toLowerCase();
		const toLower = t.to.toLowerCase();
		// Check if either side of this transfer is an impurity-trigger address
		if (impurityTriggerAddrs.has(fromLower)) {
			thirdTokens.add(token);
			if (!thirdTokenHubs.has(token)) {
				const source = hubAddresses.has(fromLower) ? 'hub' : 'venue';
				thirdTokenHubs.set(token, `${source}:${fromLower}`);
			}
		}
		if (impurityTriggerAddrs.has(toLower)) {
			thirdTokens.add(token);
			if (!thirdTokenHubs.has(token)) {
				const source = hubAddresses.has(toLower) ? 'hub' : 'venue';
				thirdTokenHubs.set(token, `${source}:${toLower}`);
			}
		}
	}

	const isImpure = thirdTokens.size > 0;

	return { isImpure, thirdTokens, thirdTokenHubs };
}
