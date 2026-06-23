import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, parseAbiParameters, toEventSelector, parseAbiItem, pad as viemPad, toHex } from 'viem';
import { decodeV4SwapFees } from './decompose-trade.js';

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
