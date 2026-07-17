import { describe, it, expect } from 'vitest';
import { decodeUniswapXBeneficiary, FILL_TOPIC0, type LogLite } from './settlementDecoders.js';

const REACTOR = '0x1111111111111111111111111111111111111111';
const SWAPPER = '0x00000000000000000000000000000000000000aa';
const FILLER = '0x00000000000000000000000000000000000000bb';
const pad = (a: string) => ('0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0')) as string;
const fillLog = (emitter: string, swapper: string): LogLite => ({
	address: emitter,
	topics: [FILL_TOPIC0, pad('0xdead'), pad(FILLER), pad(swapper)],
});

describe('decodeUniswapXBeneficiary', () => {
	const reactors = new Set([REACTOR.toLowerCase()]);

	it('returns the swapper for a single Fill from a known reactor', () => {
		expect(decodeUniswapXBeneficiary([fillLog(REACTOR, SWAPPER)], reactors)).toBe(SWAPPER.toLowerCase());
	});
	it('ignores a Fill emitted by an unknown address', () => {
		expect(decodeUniswapXBeneficiary([fillLog('0x9999999999999999999999999999999999999999', SWAPPER)], reactors)).toBeNull();
	});
	it('returns null when no Fill log is present', () => {
		expect(decodeUniswapXBeneficiary([{ address: REACTOR, topics: ['0xabc'] }], reactors)).toBeNull();
	});
	it('returns null for a multi-order batch (more than one reactor Fill)', () => {
		expect(decodeUniswapXBeneficiary([fillLog(REACTOR, SWAPPER), fillLog(REACTOR, '0x00000000000000000000000000000000000000cc')], reactors)).toBeNull();
	});
});
