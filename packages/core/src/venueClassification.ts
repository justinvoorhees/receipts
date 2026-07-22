import type { VenueType } from './routeGraph.js';

const V3_FACTORY_TYPES: Record<string, VenueType> = {
	'0x33128a8fc17869897dce68ed026d694621f6fdfd': 'univ3',
	'0xc35dadb65012ec5796536bd9864ed8773abc74c4': 'sushiv3',
	'0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a': 'aerodrome_cl',
	'0xade65c38cd4849adba595a4323a8c7ddfe89716a': 'aerodrome_cl',
	'0x38015d05f4fec8afe15d7cc0386a126574e8077b': 'baseswapv3',
	'0x0a7e848aca42d879ef06507fca0e7b33a0a63c1e': 'maverickv2',
	'0xdf033790907c60c9b81ae355f76f74f52f92114a': 'maverickv2',
	// Hydrex — an Algebra Integral deployment. Its pools expose factory() like a
	// v3 pool, but emit an Algebra-flavoured Swap event we do not scan for.
	'0x36077d39cdc65e1e3fb65810430e5b2c4d5fa29e': 'hydrex',
	// QuickSwap v4 — also Algebra Integral. Recognised by factory rather than the
	// Swap topic0, which is shared across every Algebra fork (Hydrex included) and
	// so cannot distinguish them; the factory can.
	'0xc5396866754799b9720125b104ae01d935ab9c7b': 'quickswapv4',
};

/**
 * Pools that neither expose a recognised factory() nor emit a swap event we
 * scan for. Curve pools used to live here one address at a time; they are now
 * recognised from their TokenExchange event, so this list should stay small.
 */
const KNOWN_VENUE_ADDRESS_TYPES: Record<string, VenueType> = {
	'0xdf033790907c60c9b81ae355f76f74f52f92114a': 'maverickv2',
};

export function classifyV3Factory(factory: string | null | undefined): VenueType {
	if (!factory) return 'univ3';
	return V3_FACTORY_TYPES[factory.toLowerCase()] ?? 'univ3';
}

export function classifyKnownVenueAddress(address: string | null | undefined): VenueType | null {
	if (!address) return null;
	return KNOWN_VENUE_ADDRESS_TYPES[address.toLowerCase()] ?? null;
}
