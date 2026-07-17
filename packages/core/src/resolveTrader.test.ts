import { describe, it, expect } from 'vitest';
import { resolveTrader, anchorFlags } from './resolveTrader.js';
import { FILL_TOPIC0 } from './settlementDecoders.js';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (a: string) => ('0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0')) as string;
const word = (v: bigint) => ('0x' + v.toString(16).padStart(64, '0')) as string;
const xfer = (token: string, from: string, to: string, v: bigint) => ({ address: token, topics: [TRANSFER, pad(from), pad(to)], data: word(v) });
const fill = (reactor: string, swapper: string) => ({ address: reactor, topics: [FILL_TOPIC0, pad('0xdead'), pad('0xf1'), pad(swapper)] });

const TKA = '0xaa00000000000000000000000000000000000001';
const TKB = '0xbb00000000000000000000000000000000000002';
const TXFROM = '0x1111111111111111111111111111111111111111';
const SWAPPER = '0x2222222222222222222222222222222222222222';
const REACTOR = '0x3333333333333333333333333333333333333333';
const reactors = new Set([REACTOR.toLowerCase()]);
const alwaysEoa = async () => true;

describe('resolveTrader precedence', () => {
	it('tier 1 self: tx.from has a clean swap → anchor self, no re-anchor', async () => {
		const trace = { logs: [xfer(TKA, TXFROM, REACTOR, 100n), xfer(TKB, REACTOR, TXFROM, 90n)] };
		const r = await resolveTrader({ trace: trace as never, txFrom: TXFROM, logs: [], reactors, isEoa: alwaysEoa });
		expect(r).toEqual({ trader: TXFROM.toLowerCase(), anchor: { kind: 'self' } });
	});

	it('tier 2 uniswapx: tx.from has no flow, Fill names the swapper', async () => {
		const trace = { logs: [fill(REACTOR, SWAPPER)] };
		const r = await resolveTrader({ trace: trace as never, txFrom: TXFROM, logs: [fill(REACTOR, SWAPPER)], reactors, isEoa: alwaysEoa });
		expect(r).toEqual({ trader: SWAPPER.toLowerCase(), anchor: { kind: 'beneficiary', method: 'uniswapx' } });
	});

	it('tier 3 net-flow: no Fill, sole EOA beneficiary', async () => {
		const trace = { logs: [xfer(TKA, SWAPPER, REACTOR, 100n), xfer(TKB, REACTOR, SWAPPER, 90n)] };
		const isEoa = async (a: string) => a.toLowerCase() === SWAPPER.toLowerCase();
		const r = await resolveTrader({ trace: trace as never, txFrom: TXFROM, logs: [], reactors, isEoa });
		expect(r?.trader.toLowerCase()).toBe(SWAPPER.toLowerCase());
		expect(r?.anchor).toEqual({ kind: 'beneficiary', method: 'net-flow' });
	});

	it('returns null when nothing resolves (tx.from no flow, no Fill, no candidate)', async () => {
		const r = await resolveTrader({ trace: { logs: [] } as never, txFrom: TXFROM, logs: [], reactors, isEoa: alwaysEoa });
		expect(r).toBeNull();
	});
});

describe('anchorFlags', () => {
	it('self → no flags', () => { expect(anchorFlags({ kind: 'self' })).toEqual([]); });
	it('net-flow → BENEFICIARY_ANCHORED only', () => {
		expect(anchorFlags({ kind: 'beneficiary', method: 'net-flow' })).toEqual([expect.stringMatching(/^BENEFICIARY_ANCHORED/)]);
	});
	it('uniswapx → BENEFICIARY_ANCHORED + ANCHOR_VIA_UNISWAPX', () => {
		const f = anchorFlags({ kind: 'beneficiary', method: 'uniswapx' });
		expect(f[0]).toMatch(/^BENEFICIARY_ANCHORED/);
		expect(f[1]).toMatch(/^ANCHOR_VIA_UNISWAPX/);
	});
});
