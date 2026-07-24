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

	it('multiple sinks: first follows the flow, rest are truncated addresses', () => {
		const lines = getAggregatorFeeLines({
			aggregator: 'Nordstern', aggFeeBps: 22,
			feeSinks: [
				{ address: '0x3dbe077e7986657e95e1cc50089f17a5a4af0aae', feeBps: 19.02, source: 'retained_balance', name: null },
				{ address: '0x5f6900000000000000000000000000000000d431', feeBps: 2.98, source: 'retained_balance', name: 'Vault' },
			],
		});
		expect(lines[0]!.label).toBe('Nordstern Fee');
		expect(lines[1]!.label).toBe('0x5f69…d431'); // truncated, even though it has a name
		expect(lines[1]!.href).toBe(BASE + '0x5f6900000000000000000000000000000000d431');
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
