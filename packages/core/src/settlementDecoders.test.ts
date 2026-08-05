import { describe, it, expect } from 'vitest';
import {
	decodeUniswapXBeneficiary,
	decodeErc4337Beneficiary,
	FILL_TOPIC0,
	USEROP_TOPIC0,
	parseReactors,
	parseEntryPoints,
	type LogLite,
} from './settlementDecoders.js';

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

describe('parseReactors', () => {
	it('lowercases and indexes reactor addresses', () => {
		const json = JSON.stringify({ _comment: 'x', generatedAt: 't', chainId: 8453, reactors: ['0xAbC0000000000000000000000000000000000001'] });
		const set = parseReactors(json);
		expect(set.has('0xabc0000000000000000000000000000000000001')).toBe(true);
		expect(set.size).toBe(1);
	});
	it('returns an empty set for a config with no reactors array', () => {
		expect(parseReactors(JSON.stringify({ chainId: 8453 })).size).toBe(0);
	});
});

const ENTRYPOINT = '0x0000000071727de22e5e9d8baf0edac6f37da032';
const ACCOUNT = '0x00000000000000000000000000000000000000dd';
const userOpLog = (emitter: string, sender: string): LogLite => ({
	address: emitter,
	// UserOperationEvent(bytes32 indexed userOpHash, address indexed sender,
	//                    address indexed paymaster, uint256, bool, uint256, uint256)
	topics: [USEROP_TOPIC0, pad('0xbeef'), pad(sender), pad('0x0')],
});

describe('decodeErc4337Beneficiary', () => {
	const entryPoints = new Set([ENTRYPOINT]);

	it('returns the sender for a single UserOperationEvent from a known EntryPoint', () => {
		expect(decodeErc4337Beneficiary([userOpLog(ENTRYPOINT, ACCOUNT)], entryPoints)).toBe(ACCOUNT.toLowerCase());
	});
	it('ignores a UserOperationEvent emitted by an unknown address', () => {
		expect(decodeErc4337Beneficiary([userOpLog('0x9999999999999999999999999999999999999999', ACCOUNT)], entryPoints)).toBeNull();
	});
	it('returns null when no UserOperationEvent is present', () => {
		expect(decodeErc4337Beneficiary([{ address: ENTRYPOINT, topics: ['0xabc'] }], entryPoints)).toBeNull();
	});
	it('returns null for a bundle carrying more than one UserOperation', () => {
		const two = [userOpLog(ENTRYPOINT, ACCOUNT), userOpLog(ENTRYPOINT, '0x00000000000000000000000000000000000000ee')];
		expect(decodeErc4337Beneficiary(two, entryPoints)).toBeNull();
	});
});

describe('parseEntryPoints', () => {
	it('lowercases and indexes entryPoint addresses', () => {
		const json = JSON.stringify({ chainId: 8453, entryPoints: ['0xAbC0000000000000000000000000000000000002'] });
		const set = parseEntryPoints(json);
		expect(set.has('0xabc0000000000000000000000000000000000002')).toBe(true);
		expect(set.size).toBe(1);
	});
	it('returns an empty set for a config with no entryPoints array', () => {
		expect(parseEntryPoints(JSON.stringify({ chainId: 8453 })).size).toBe(0);
	});
});
