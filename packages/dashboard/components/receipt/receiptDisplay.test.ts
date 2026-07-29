import { describe, it, expect } from 'vitest';
import { getAggregatorFeeLines } from './receiptDisplay';

const BASE = 'https://basescan.org/address/';

describe('getAggregatorFeeLines', () => {
	it('single named sink uses the verbatim name', () => {
		const lines = getAggregatorFeeLines({
			aggregator: 'Velora', aggFeeBps: 93.5, feeRecipient: '0x0847',
			feeSinks: [{ address: '0x0847', feeBps: 93.5, source: 'retained_balance', name: 'PoolFees' }],
		});
		expect(lines).toEqual([{ label: 'PoolFees', href: BASE + '0x0847', bps: 93.5 }]);
	});

	it('single unnamed sink falls back to generic [Aggregator] Fee', () => {
		const lines = getAggregatorFeeLines({
			aggregator: 'Nordstern', aggFeeBps: 19.02, feeRecipient: '0x3dbe',
			feeSinks: [{ address: '0x3dbe', feeBps: 19.02, source: 'retained_balance', name: null }],
		});
		expect(lines).toEqual([{ label: 'Nordstern Fee', href: BASE + '0x3dbe', bps: 19.02 }]);
	});

	it('multiple sinks: a named subsequent sink uses its name', () => {
		const lines = getAggregatorFeeLines({
			aggregator: 'Nordstern', aggFeeBps: 22,
			feeSinks: [
				{ address: '0x3dbe077e7986657e95e1cc50089f17a5a4af0aae', feeBps: 19.02, source: 'retained_balance', name: null },
				{ address: '0x5f6900000000000000000000000000000000d431', feeBps: 2.98, source: 'retained_balance', name: 'Vault' },
			],
		});
		expect(lines[0]!.label).toBe('Nordstern Fee');
		expect(lines[1]!.label).toBe('Vault');
		expect(lines[1]!.href).toBe(BASE + '0x5f6900000000000000000000000000000000d431');
	});

	it('multiple sinks: an UNNAMED subsequent sink stays a truncated address', () => {
		const lines = getAggregatorFeeLines({
			aggregator: 'Nordstern', aggFeeBps: 22,
			feeSinks: [
				{ address: '0x3dbe077e7986657e95e1cc50089f17a5a4af0aae', feeBps: 19.02, source: 'retained_balance', name: null },
				{ address: '0x3912760000000000000000000000000000d24600', feeBps: 2.98, source: 'retained_balance', name: null },
			],
		});
		expect(lines[0]!.label).toBe('Nordstern Fee');
		expect(lines[1]!.label).toBe('0x3912…4600'); // curation cue survives for genuinely unknown sinks
	});

	it('Clanker derivatives on receipt 371 render as three distinct labels', () => {
		const lines = getAggregatorFeeLines({
			aggregator: '0x', aggFeeBps: 10.901872046818054,
			feeSinks: [
				{ address: '0xad01c20d5886137e056775af56915de824c8fce5', feeBps: 5.001914524202447, source: 'retained_balance', name: null },
				{ address: '0xf3622742b1e446d92e45e22923ef11c2fcd55d68', feeBps: 4.916631268846352, source: 'retained_balance', name: 'ClankerFeeLocker' },
				{ address: '0xe85a59c628f7d27878aceb4bf3b35733630083a9', feeBps: 0.9833262537692553, source: 'retained_balance', name: 'Clanker' },
			],
		});
		expect(lines.map(l => l.label)).toEqual(['0x Fee', 'ClankerFeeLocker', 'Clanker']);
		expect(lines[1]!.href).toBe(BASE + '0xf3622742b1e446d92e45e22923ef11c2fcd55d68');
		expect(lines[2]!.href).toBe(BASE + '0xe85a59c628f7d27878aceb4bf3b35733630083a9');
	});

	it('fabric with a fee keeps the Integrator Fee label', () => {
		const lines = getAggregatorFeeLines({
			aggregator: 'fabric', aggFeeBps: 80.6, feeRecipient: '0x4035',
			feeSinks: [{ address: '0x4035', feeBps: 80.6, source: 'retained_balance', name: null }],
		});
		expect(lines[0]!.label).toBe('Integrator Fee');
	});

	it('legacy row (no feeSinks) falls back to feeRecipient link', () => {
		const lines = getAggregatorFeeLines({ aggregator: 'KyberSwap', aggFeeBps: 1.95, feeRecipient: '0x7d94' });
		expect(lines).toEqual([{ label: 'KyberSwap Fee', href: BASE + '0x7d94', bps: 1.95 }]);
	});

	it('returns [] when there is no fee', () => {
		expect(getAggregatorFeeLines({ aggregator: '0x', aggFeeBps: 0 })).toEqual([]);
		expect(getAggregatorFeeLines({ aggregator: '0x', aggFeeBps: null })).toEqual([]);
	});
});
