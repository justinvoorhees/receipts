import { describe, it, expect } from 'vitest';
import { computeAggFee, dropLpSideSinks, type FeeSink } from './tradeFees.js';

const sink = (address: string, totalUsdc: number): FeeSink => ({
	address,
	usdcRetained: totalUsdc,
	wethRetained: 0,
	totalUsdc,
	source: 'retained_balance',
});

// Receipt 173's real addresses and dollar amounts, verified on-chain 2026-08-01.
const AERO_POOL = '0xef6f90acda6e8102093f3f4e28d952b0276e4abb';
const POOL_FEES = '0x084717656fd5baa0dda654e7b91808a6c1471aa1'; // AERO_POOL.poolFees()
const CURVE_POOL = '0x4b0574ca7775a09d39ffed885e7230953805c795';
const RFQ_MAKER = '0x3dbe077e7986657e95e1cc50089f17a5a4af0aae';
const NOTIONAL = 705.82;

describe('dropLpSideSinks', () => {
	it('drops a pool that is itself a route leg (Curve keeps its fee in reserves)', () => {
		const r = dropLpSideSinks([sink(CURVE_POOL, 1.6403)], new Set([CURVE_POOL]), NOTIONAL);
		expect(r.kept).toEqual([]);
		expect(r.dropped).toHaveLength(1);
		expect(r.aggFeeBps).toBe(0);
	});

	it("drops an Aerodrome pool's separate poolFees() accumulator", () => {
		// The accumulator is NOT the leg venue, so matching on leg addresses alone
		// would miss it — that is the whole reason poolFeesReader exists.
		const r = dropLpSideSinks([sink(POOL_FEES, 4.9597)], new Set([AERO_POOL, POOL_FEES]), NOTIONAL);
		expect(r.kept).toEqual([]);
		expect(r.aggFeeBps).toBe(0);
		expect(r.flags[0]).toContain('LP_SIDE_SINK_DROPPED');
		expect(r.flags[0]).toContain('4.9597');
	});

	it('KEEPS an RFQ maker — a spread is real value kept by a third party', () => {
		const r = dropLpSideSinks([sink(RFQ_MAKER, 6.99)], new Set([AERO_POOL, POOL_FEES]), NOTIONAL);
		expect(r.kept).toHaveLength(1);
		expect(r.dropped).toEqual([]);
		expect(r.aggFeeBps).toBeCloseTo((6.99 / NOTIONAL) * 10_000, 9);
	});

	it('restates aggFeeBps on the survivors, not the original total', () => {
		const r = dropLpSideSinks(
			[sink(POOL_FEES, 4.9597), sink(CURVE_POOL, 1.6403), sink(RFQ_MAKER, 3.0)],
			new Set([AERO_POOL, POOL_FEES, CURVE_POOL]),
			NOTIONAL,
		);
		expect(r.kept.map((s) => s.address)).toEqual([RFQ_MAKER]);
		expect(r.dropped).toHaveLength(2);
		// 3.0 of the original 9.6 survives — NOT the 93.5bps the full set implied.
		expect(r.aggFeeBps).toBeCloseTo((3.0 / NOTIONAL) * 10_000, 9);
	});

	it('matches addresses case-insensitively', () => {
		const r = dropLpSideSinks([sink(POOL_FEES.toUpperCase(), 4.9597)], new Set([POOL_FEES]), NOTIONAL);
		expect(r.kept).toEqual([]);
	});

	it('is a no-op when nothing is LP-side', () => {
		const sinks = [sink(RFQ_MAKER, 6.99)];
		const r = dropLpSideSinks(sinks, new Set(), NOTIONAL);
		expect(r.kept).toEqual(sinks);
		expect(r.flags).toEqual([]);
	});

	it('yields 0 rather than NaN/Infinity on a zero notional', () => {
		const r = dropLpSideSinks([sink(RFQ_MAKER, 6.99)], new Set(), 0);
		expect(r.aggFeeBps).toBe(0);
	});
});

// ─── computeAggFee: the gas payer is not a fee sink ───
//
// In an ERC-4337 transaction the EntryPoint reimburses the BUNDLER in native
// ETH. The retained-balance branch saw a small native credit and booked it as a
// third-party fee, so the bundler's gas reimbursement was charged to the trader
// twice — once here and once in gasCostUsd. Numbers below are the real ones from
// Relay tx 0x30e83971… (10 EURC -> 11.528847 USDC).
describe('computeAggFee — gas payer exclusion', () => {
	const BUNDLER = '0x43370351c9a297bf8377ca1e46576401a9ac4bba';
	const RELAY_FEE_SINK = '0xf70da97812cb96acdf810712aa562db8dfa3dbef';
	const base = {
		transfers: [],
		isInfra: () => false,
		knownVaults: new Set<string>(),
		dustUsdc: 0.0001,
		structuralFloor: 0.001,
		realizedPrice: 1896,
		notionalUsdc: 11.528847,
	};
	const deltas = () =>
		new Map([
			[BUNDLER, { usdc: 0, weth: 0, nativeEth: 0.0000042755784 }], // gas reimbursement
			[RELAY_FEE_SINK, { usdc: 0.017275, weth: 0, nativeEth: 0 }], // real ~15bps fee
		]);

	it('books both sinks when no gas payer is given (unchanged behavior)', () => {
		const r = computeAggFee({ ...base, addrDeltas: deltas() });
		expect(r.feeSinks.map((s) => s.address).sort()).toEqual([BUNDLER, RELAY_FEE_SINK].sort());
		expect(r.aggFeeBps).toBeCloseTo(22.01, 1);
	});

	it('excludes the gas payer, leaving only the real fee sink', () => {
		const r = computeAggFee({ ...base, addrDeltas: deltas(), gasPayer: BUNDLER });
		expect(r.feeSinks.map((s) => s.address)).toEqual([RELAY_FEE_SINK]);
		expect(r.aggFeeBps).toBeCloseTo(14.98, 1);
	});

	it('excludes whichever address is named as the gas payer', () => {
		const r = computeAggFee({ ...base, addrDeltas: deltas(), gasPayer: RELAY_FEE_SINK });
		expect(r.feeSinks.map((s) => s.address)).toEqual([BUNDLER]);
	});
});
