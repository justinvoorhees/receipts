import { describe, it, expect } from 'vitest';
import { resolveTrader, anchorFlags } from './resolveTrader.js';
import { FILL_TOPIC0, USEROP_TOPIC0 } from './settlementDecoders.js';

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
		const r = await resolveTrader({ trace: trace as never, txFrom: TXFROM, logs: [], reactors, entryPoints: new Set(), isEoa: alwaysEoa });
		expect(r).toEqual({ trader: TXFROM.toLowerCase(), anchor: { kind: 'self' } });
	});

	it('tier 2 uniswapx: tx.from has no flow, Fill names the swapper', async () => {
		const trace = { logs: [fill(REACTOR, SWAPPER)] };
		const r = await resolveTrader({ trace: trace as never, txFrom: TXFROM, logs: [fill(REACTOR, SWAPPER)], reactors, entryPoints: new Set(), isEoa: alwaysEoa });
		expect(r).toEqual({ trader: SWAPPER.toLowerCase(), anchor: { kind: 'beneficiary', method: 'uniswapx' } });
	});

	it('tier 3 net-flow: no Fill, sole EOA beneficiary', async () => {
		const trace = { logs: [xfer(TKA, SWAPPER, REACTOR, 100n), xfer(TKB, REACTOR, SWAPPER, 90n)] };
		const isEoa = async (a: string) => a.toLowerCase() === SWAPPER.toLowerCase();
		const r = await resolveTrader({ trace: trace as never, txFrom: TXFROM, logs: [], reactors, entryPoints: new Set(), isEoa });
		expect(r?.trader.toLowerCase()).toBe(SWAPPER.toLowerCase());
		expect(r?.anchor).toEqual({ kind: 'beneficiary', method: 'net-flow' });
	});

	it('returns null when nothing resolves (tx.from no flow, no Fill, no candidate)', async () => {
		const r = await resolveTrader({ trace: { logs: [] } as never, txFrom: TXFROM, logs: [], reactors, entryPoints: new Set(), isEoa: alwaysEoa });
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

// ─── ERC-4337 ───
//
// The bundler submits the tx, so tx.from nets only a gas refund and tier 1
// cannot fire. The EntryPoint's UserOperationEvent names the smart account
// authoritatively — and the generic net-flow tier cannot rescue this case,
// because a smart account is a CONTRACT (so the "sole EOA" preference finds
// none) and every pool in the route is itself a clean 1-in/1-out candidate.
// Real case: Relay tx 0x30e83971….
const ENTRYPOINT = '0x0000000071727de22e5e9d8baf0edac6f37da032';
const SMART_ACCOUNT = '0x4444444444444444444444444444444444444444';
const entryPoints = new Set([ENTRYPOINT]);
const userOp = (emitter: string, sender: string) => ({
	address: emitter,
	topics: [USEROP_TOPIC0, pad('0xbeef'), pad(sender), pad('0x0')],
});

describe('resolveTrader ERC-4337 tier', () => {
	it('anchors on the UserOperation sender when tx.from is only the bundler', async () => {
		const logs = [userOp(ENTRYPOINT, SMART_ACCOUNT)];
		const trace = { logs };
		const r = await resolveTrader({
			trace: trace as never, txFrom: TXFROM, logs, reactors, entryPoints, isEoa: alwaysEoa,
		});
		expect(r).toEqual({
			trader: SMART_ACCOUNT.toLowerCase(),
			anchor: { kind: 'beneficiary', method: 'erc4337' },
		});
	});

	it('anchors a CONTRACT smart account that net-flow would reject as ambiguous', async () => {
		// Two clean 1-in/1-out addresses (the account and a pool), zero EOAs —
		// exactly the shape that makes tier net-flow fail closed.
		const POOL = '0x5555555555555555555555555555555555555555';
		const logs = [userOp(ENTRYPOINT, SMART_ACCOUNT)];
		const trace = { logs: [
			...logs,
			xfer(TKA, SMART_ACCOUNT, POOL, 100n),
			xfer(TKB, POOL, SMART_ACCOUNT, 90n),
		] };
		const neverEoa = async () => false;
		expect(await resolveTrader({
			trace: trace as never, txFrom: TXFROM, logs, reactors, entryPoints: new Set(), isEoa: neverEoa,
		})).toBeNull(); // without the tier, ambiguous → fail closed
		const r = await resolveTrader({
			trace: trace as never, txFrom: TXFROM, logs, reactors, entryPoints, isEoa: neverEoa,
		});
		expect(r?.trader).toBe(SMART_ACCOUNT.toLowerCase());
		expect(r?.anchor).toEqual({ kind: 'beneficiary', method: 'erc4337' });
	});

	it('ignores a UserOperationEvent from an unknown emitter', async () => {
		const logs = [userOp('0x9999999999999999999999999999999999999999', SMART_ACCOUNT)];
		const r = await resolveTrader({
			trace: { logs } as never, txFrom: TXFROM, logs, reactors, entryPoints, isEoa: alwaysEoa,
		});
		expect(r).toBeNull();
	});

	it('tier 1 self still wins over a UserOperationEvent', async () => {
		const logs = [userOp(ENTRYPOINT, SMART_ACCOUNT)];
		const trace = { logs: [...logs, xfer(TKA, TXFROM, REACTOR, 100n), xfer(TKB, REACTOR, TXFROM, 90n)] };
		const r = await resolveTrader({
			trace: trace as never, txFrom: TXFROM, logs, reactors, entryPoints, isEoa: alwaysEoa,
		});
		expect(r).toEqual({ trader: TXFROM.toLowerCase(), anchor: { kind: 'self' } });
	});
});

describe('anchorFlags erc4337', () => {
	it('erc4337 → BENEFICIARY_ANCHORED + ANCHOR_VIA_ERC4337', () => {
		const f = anchorFlags({ kind: 'beneficiary', method: 'erc4337' });
		expect(f[0]).toMatch(/^BENEFICIARY_ANCHORED/);
		expect(f[1]).toMatch(/^ANCHOR_VIA_ERC4337/);
	});
});
