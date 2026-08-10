import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, parseAbiParameters, toEventSelector, parseAbiItem } from 'viem';
import { decodeV4SwapFees, decodeV3LikeSwaps } from './tradeDecoders.js';

// V4 Swap event: event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)
const V4_SWAP_ABI = parseAbiItem(
	'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
);
const V4_SWAP_TOPIC0 = toEventSelector(V4_SWAP_ABI) as `0x${string}`;

const POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b';
const pad = (a: string) => ('0x' + a.slice(2).padStart(64, '0')) as `0x${string}`;

/** Build a synthetic V4 Swap log with the given fee. */
function buildV4SwapLog(fee: number, emitter: string = POOL_MANAGER): {
	address: `0x${string}`;
	data: `0x${string}`;
	topics: readonly `0x${string}`[];
} {
	// indexed: id (bytes32), sender (address)
	const id = pad('0x0000000000000000000000000000000000000000000000000000000000001234');
	const sender = pad('0x000000000000000000000000aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee');

	// non-indexed: amount0 int128, amount1 int128, sqrtPriceX96 uint160, liquidity uint128, tick int24, fee uint24
	const data = encodeAbiParameters(
		parseAbiParameters('int128, int128, uint160, uint128, int24, uint24'),
		[
			-500000n,                          // amount0 (int128)
			250000000000000n,                  // amount1 (int128)
			BigInt('3543191142285914205922034323214'), // sqrtPriceX96 (uint160)
			1000000000000000000n,              // liquidity (uint128)
			-200000,                           // tick (int24)
			fee,                               // fee (uint24)
		],
	);

	return {
		address: emitter as `0x${string}`,
		data,
		topics: [V4_SWAP_TOPIC0, id, sender],
	};
}

describe('decodeV4SwapFees', () => {
	it('returns [450] for a single V4 Swap event with fee=450', () => {
		const log = buildV4SwapLog(450);
		const result = decodeV4SwapFees([log]);
		expect(result).toEqual([450]);
	});

	it('returns [] when no V4 Swap events are present', () => {
		// empty
		expect(decodeV4SwapFees([])).toEqual([]);

		// unrelated log (a Transfer event)
		const transferLog = {
			address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as `0x${string}`,
			data: '0x0000000000000000000000000000000000000000000000000000000000000001' as `0x${string}`,
			topics: [
				'0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as `0x${string}`,
				pad('0x000000000000000000000000000000000000d00d'),
				pad('0x000000000000000000000000000000000000b00b'),
			] as readonly `0x${string}`[],
		};
		expect(decodeV4SwapFees([transferLog])).toEqual([]);
	});

	it('returns multiple fees for multiple V4 Swap events', () => {
		const log1 = buildV4SwapLog(450);
		const log2 = buildV4SwapLog(500, '0x1111111111111111111111111111111111111111');
		const result = decodeV4SwapFees([log1, log2]);
		expect(result).toEqual([450, 500]);
	});

	it('works when V4 Swap event is emitted by any address (not just PoolManager)', () => {
		const log = buildV4SwapLog(300, '0x9999999999999999999999999999999999999999');
		const result = decodeV4SwapFees([log]);
		expect(result).toEqual([300]);
	});

	it('returns [500] for fee=500 (5 bps)', () => {
		const log = buildV4SwapLog(500);
		const result = decodeV4SwapFees([log]);
		expect(result).toEqual([500]);
	});
});

// ─── decodeV3LikeSwaps tests ───

const UNI_V3_SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67' as `0x${string}`;
const PANCAKE_V3_SWAP_TOPIC = '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83' as `0x${string}`;

/** Build a synthetic Uniswap V3 Swap log. Non-indexed: amount0, amount1, sqrtPriceX96, liquidity, tick (5 fields). */
function buildUniV3SwapLog(
	pool: string,
	amount0: bigint,
	amount1: bigint,
): { address: `0x${string}`; data: `0x${string}`; topics: readonly `0x${string}`[] } {
	const sender = pad('0x000000000000000000000000aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee');
	const recipient = pad('0x000000000000000000000000111111112222222233333333444444445555555');
	const data = encodeAbiParameters(
		parseAbiParameters('int256, int256, uint160, uint128, int24'),
		[
			amount0,
			amount1,
			BigInt('3543191142285914205922034323214'), // sqrtPriceX96
			1000000000000000000n,                     // liquidity
			-200000,                                   // tick
		],
	);
	return {
		address: pool as `0x${string}`,
		data,
		topics: [UNI_V3_SWAP_TOPIC, sender, recipient],
	};
}

/** Build a synthetic PancakeSwap V3 Swap log. Non-indexed: amount0, amount1, sqrtPriceX96, liquidity, tick, protocolFeesToken0, protocolFeesToken1 (7 fields). */
function buildPancakeV3SwapLog(
	pool: string,
	amount0: bigint,
	amount1: bigint,
): { address: `0x${string}`; data: `0x${string}`; topics: readonly `0x${string}`[] } {
	const sender = pad('0x000000000000000000000000aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee');
	const recipient = pad('0x000000000000000000000000111111112222222233333333444444445555555');
	const data = encodeAbiParameters(
		parseAbiParameters('int256, int256, uint160, uint128, int24, uint128, uint128'),
		[
			amount0,
			amount1,
			BigInt('3543191142285914205922034323214'), // sqrtPriceX96
			1000000000000000000n,                     // liquidity
			-200000,                                   // tick
			0n,                                        // protocolFeesToken0
			0n,                                        // protocolFeesToken1
		],
	);
	return {
		address: pool as `0x${string}`,
		data,
		topics: [PANCAKE_V3_SWAP_TOPIC, sender, recipient],
	};
}

describe('decodeV3LikeSwaps', () => {
	it('decodes a Uniswap V3 Swap log with recognizeForks=false', () => {
		const log = buildUniV3SwapLog('0xd0b53d9277642d899df5c87a3966a349a798f224', -500000n, 250000000000000n);
		const result = decodeV3LikeSwaps([log], false);
		expect(result).toHaveLength(1);
		expect(result[0]!.pool).toBe('0xd0b53d9277642d899df5c87a3966a349a798f224');
		expect(result[0]!.amount0).toBe(-500000n);
		expect(result[0]!.amount1).toBe(250000000000000n);
	});

	it('returns PancakeSwap V3 Swap ONLY when recognizeForks=true', () => {
		const log = buildPancakeV3SwapLog('0xaaaa000000000000000000000000000000000001', -100000n, 50000000000000n);

		// recognizeForks=false → ignored
		expect(decodeV3LikeSwaps([log], false)).toHaveLength(0);

		// recognizeForks=true → decoded
		const result = decodeV3LikeSwaps([log], true);
		expect(result).toHaveLength(1);
		expect(result[0]!.pool).toBe('0xaaaa000000000000000000000000000000000001');
		expect(result[0]!.amount0).toBe(-100000n);
		expect(result[0]!.amount1).toBe(50000000000000n);
	});

	it('handles mixed Uniswap + PancakeSwap logs with recognizeForks=true', () => {
		const uniLog = buildUniV3SwapLog('0x1111111111111111111111111111111111111111', -500000n, 250000000000000n);
		const pancakeLog = buildPancakeV3SwapLog('0x2222222222222222222222222222222222222222', -100000n, 50000000000000n);
		const result = decodeV3LikeSwaps([uniLog, pancakeLog], true);
		expect(result).toHaveLength(2);
		expect(result[0]!.pool).toBe('0x1111111111111111111111111111111111111111');
		expect(result[1]!.pool).toBe('0x2222222222222222222222222222222222222222');
	});

	it('returns [] for empty logs and unrelated logs', () => {
		expect(decodeV3LikeSwaps([], false)).toEqual([]);
		expect(decodeV3LikeSwaps([], true)).toEqual([]);

		// Transfer log — not a Swap
		const transferLog = {
			address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as `0x${string}`,
			data: '0x0000000000000000000000000000000000000000000000000000000000000001' as `0x${string}`,
			topics: [
				'0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as `0x${string}`,
				pad('0x000000000000000000000000000000000000d00d'),
				pad('0x000000000000000000000000000000000000b00b'),
			] as readonly `0x${string}`[],
		};
		expect(decodeV3LikeSwaps([transferLog], true)).toEqual([]);
	});
});

describe('SINGLETON_DEX_CUSTODIANS', () => {
  it('lists every singleton custodian, not just Uniswap V4', async () => {
    const { SINGLETON_DEX_CUSTODIANS } = await import('./tradeDecoders.js');
    // Uniswap V4's PoolManager both custodies and emits; Pancake Infinity splits
    // the two, and it is the VAULT that holds tokens and therefore shows up in
    // address deltas as a "retained balance".
    expect(SINGLETON_DEX_CUSTODIANS.has('0x498581ff718922c3f8e6a244956af099b2652b2b')).toBe(true);
    expect(SINGLETON_DEX_CUSTODIANS.has('0x238a358808379702088667322f80ac48bad5e6c4')).toBe(true);
  });

  it('is lowercased, because every caller compares against lowercased addresses', async () => {
    const { SINGLETON_DEX_CUSTODIANS } = await import('./tradeDecoders.js');
    for (const a of SINGLETON_DEX_CUSTODIANS) expect(a).toBe(a.toLowerCase());
  });
});

describe('computeAggFee singleton custodians', () => {
  it('never books a singleton custodian as a fee sink', async () => {
    const { computeAggFee } = await import('./tradeFees.js');
    const VAULT = '0x238a358808379702088667322f80ac48bad5e6c4';
    const { SINGLETON_DEX_CUSTODIANS } = await import('./tradeDecoders.js');
    // Reproduces receipt id 408 (Nordstern, $12.07). The Vault is a
    // flash-accounting custodian: tokens go in and come back out, so it should
    // net to ~nothing. It does not, and the residual looks exactly like a fee —
    // it was booked as 2.810 bps of aggregator fee. Probing cannot fix this: a
    // custodian answers neither fee() nor getReserves(), so the only reliable
    // signal is knowing structurally that the address IS a singleton.
    const args = {
      transfers: [],
      addrDeltas: new Map([[VAULT, { usdc: 0.0034, weth: 0, nativeEth: 0 }]]),
      knownVaults: new Set<string>(),
      dustUsdc: 1e-6,
      structuralFloor: 0,
      realizedPrice: 1873,
      notionalUsdc: 12.07,
    };

    // Without the carve-out the custodian is booked as an aggregator fee.
    const naive = computeAggFee({ ...args, isInfra: () => false });
    expect(naive.feeSinks.map((s) => s.address)).toContain(VAULT);
    expect(naive.aggFeeBps).toBeCloseTo(2.82, 1);

    // With it, the vault contributes nothing at all — not merely a smaller share.
    const fixed = computeAggFee({ ...args, isInfra: (a) => SINGLETON_DEX_CUSTODIANS.has(a) });
    expect(fixed.feeSinks).toHaveLength(0);
    expect(fixed.aggFeeBps).toBe(0);
  });
});

// ── RPC-path coverage ────────────────────────────────────────────────────────
// decomposeTrade's RPC work had no coverage at all: every test above exercises
// a pure helper. These drive the real function against a local JSON-RPC server,
// which is the only way to observe how its per-address probes are issued.

import { createServer, type Server } from 'node:http';
import { decomposeTrade, type DecomposeTradeInput } from './decomposeTrade.js';
import { runInDecodeSession } from './rpcSession.js';

/** A JSON-RPC endpoint that answers every eth_call and records concurrency. */
async function fakeRpc(): Promise<{ url: string; peak: () => number; calls: () => number; close: () => Promise<void> }> {
	let inFlight = 0;
	let peak = 0;
	let calls = 0;
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (d: Buffer) => chunks.push(d));
		req.on('end', () => {
			const body = JSON.parse(Buffer.concat(chunks).toString());
			calls += 1;
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			setTimeout(() => {
				inFlight -= 1;
				res.writeHead(200, { 'content-type': 'application/json' });
				// A plausible uint24 fee / address / reserves word for any call.
				res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: `0x${'0'.repeat(63)}1` }));
			}, 10);
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const port = (server.address() as { port: number }).port;
	return {
		url: `http://127.0.0.1:${port}`,
		peak: () => peak,
		calls: () => calls,
		close: () => new Promise<void>((r) => server.close(() => r())),
	};
}

describe('decomposeTrade RPC probes', () => {
	const TRADER = '0x00000000000000000000000000000000000000a1';
	const POOL = '0x00000000000000000000000000000000000000b1';
	const XFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
	const USDC_ADDR = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
	const WETH_ADDR = '0x4200000000000000000000000000000000000006';
	const pad = (a: string) => `0x${a.slice(2).padStart(64, '0')}`;
	const word = (v: bigint) => `0x${v.toString(16).padStart(64, '0')}`;

	/** Five unclassified addresses each retaining USDC, so each gets probed. */
	const holders = ['0xc1', '0xc2', '0xc3', '0xc4', '0xc5'].map(
		(s) => `0x${s.slice(2).padEnd(40, '0')}`,
	);

	const trace = {
		type: 'CALL',
		from: TRADER,
		to: POOL,
		input: '0x',
		logs: [
			{ address: USDC_ADDR, data: word(1_000_000000n), topics: [XFER, pad(TRADER), pad(POOL)] },
			{ address: WETH_ADDR, data: word(500_000000000000000n), topics: [XFER, pad(POOL), pad(TRADER)] },
			...holders.map((h) => ({
				address: USDC_ADDR,
				data: word(50_000000n),
				topics: [XFER, pad(POOL), pad(h)],
			})),
		],
	};

	const input = (rpcUrl: string): DecomposeTradeInput => ({
		trace: trace as never,
		txHash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
		trader: TRADER,
		allInCostBps: 10,
		notionalUsdc: 1000,
		realizedPrice: 2000,
		gasCostUsd: 0,
		aggregator: 'Fabric',
		blockNumber: 47379575n,
		rpcUrl,
	});

	it('probes every unclassified address concurrently', async () => {
		const rpc = await fakeRpc();
		try {
			await runInDecodeSession(() => decomposeTrade(input(rpc.url)));
			expect(rpc.calls()).toBeGreaterThan(1);
			expect(rpc.peak()).toBeGreaterThan(1);
		} finally {
			await rpc.close();
		}
	});

	it('stops at fee() for an address that answers it, without also asking getReserves()', async () => {
		// The fee() probe short-circuits: spending a second call on an address
		// already identified as a V3 pool would undo the saving.
		const rpc = await fakeRpc();
		try {
			const before = rpc.calls();
			await runInDecodeSession(() => decomposeTrade(input(rpc.url)));
			// 5 holders, one fee() each — a getReserves() for any of them would
			// push this past 5 probe calls.
			expect(rpc.calls() - before).toBeLessThanOrEqual(10);
		} finally {
			await rpc.close();
		}
	});
});
