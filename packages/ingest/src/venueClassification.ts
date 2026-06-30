import type { VenueType } from './routeGraph.js';

const V3_FACTORY_TYPES: Record<string, VenueType> = {
	'0x33128a8fc17869897dce68ed026d694621f6fdfd': 'univ3',
	'0xc35dadb65012ec5796536bd9864ed8773abc74c4': 'sushiv3',
	'0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a': 'aerodrome_cl',
	'0xade65c38cd4849adba595a4323a8c7ddfe89716a': 'aerodrome_cl',
	'0x38015d05f4fec8afe15d7cc0386a126574e8077b': 'baseswapv3',
	'0x0a7e848aca42d879ef06507fca0e7b33a0a63c1e': 'maverickv2',
	'0xdf033790907c60c9b81ae355f76f74f52f92114a': 'maverickv2',
};

const KNOWN_VENUE_ADDRESS_TYPES: Record<string, VenueType> = {
	'0x4545410f7601b34a779edcebc641e529f465eeaa': 'curve_stableng',
	'0x77e44581399f96129a8a0041dbb4e1a7569b9969': 'curve_stableng',
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
