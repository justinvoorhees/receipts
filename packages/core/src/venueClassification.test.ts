import { describe, expect, it } from 'vitest';
import { classifyKnownVenueAddress, classifyV3Factory } from './venueClassification.js';

describe('classifyV3Factory', () => {
	it('tags known v3-style factories by protocol', () => {
		expect(classifyV3Factory('0x33128a8fC17869897dcE68Ed026d694621f6FDfD')).toBe('univ3');
		expect(classifyV3Factory('0xc35DADB65012eC5796536bD9864eD8773aBc74C4')).toBe('sushiv3');
		expect(classifyV3Factory('0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A')).toBe('aerodrome_cl');
		expect(classifyV3Factory('0x38015D05f4fEC8AFe15D7cc0386a126574e8077B')).toBe('baseswapv3');
		expect(classifyV3Factory('0x36077D39cdC65E1e3FB65810430E5b2c4D5fA29E')).toBe('hydrex');
		// QuickSwap v4 (Algebra Integral) — recognised by its factory, like Hydrex,
		// because the Algebra Swap topic0 is shared across every Algebra fork.
		expect(classifyV3Factory('0xC5396866754799B9720125B104AE01d935Ab9C7b')).toBe('quickswapv4');
	});

	it('leaves unknown v3-style factories generic until explicitly tagged', () => {
		expect(classifyV3Factory('0x1111111111111111111111111111111111111111')).toBe('univ3');
	});
});

describe('classifyKnownVenueAddress', () => {
	it('tags manually verified pools that do not emit supported swap events', () => {
		expect(classifyKnownVenueAddress('0xdf033790907c60c9B81aE355F76F74f52F92114A')).toBe('maverickv2');
	});

	// Curve pools used to be listed here one address at a time. They are now
	// recognised from their `TokenExchange` event, which covers pools we have
	// never seen before, so the address list must not grow back.
	it('no longer needs per-address entries for Curve pools', () => {
		expect(classifyKnownVenueAddress('0x4545410f7601b34A779EDcEbC641e529f465eeaa')).toBeNull();
		expect(classifyKnownVenueAddress('0x77E44581399F96129a8a0041dBb4E1a7569B9969')).toBeNull();
	});
});
