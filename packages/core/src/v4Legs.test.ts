import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeEventLog } from 'viem';
import { V4_SWAP_EVENT_ABI, collectV4Swaps } from './v4Legs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const swaps = JSON.parse(readFileSync(resolve(__dirname, '__fixtures__/v4-id56-swaps.json'), 'utf-8'));

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- documents the known-sold token for the human reading the console output below
const CLAWD = '0x9f86db9fc6f7c9408e8fda3ff8ce4e78ac7a6b07';

describe('v4 swap sign convention (id 56 fixture)', () => {
  it('every V4 swap has exactly one positive and one negative amount (one token in, one out)', () => {
    // This is the structural invariant the entire sign convention rests on:
    // in a single-pool V4 swap one token is paid IN (one sign) and the other is
    // paid OUT (opposite sign). If a decode bug or a degenerate swap violated
    // this, synthesizeV4Legs (Task 4) would produce a nonsense leg. Asserting it
    // here is a real regression guard, independent of WHICH sign means "in".
    expect(swaps.length).toBeGreaterThanOrEqual(2);
    for (const log of swaps) {
      const decoded = decodeEventLog({ abi: V4_SWAP_EVENT_ABI, data: log.data, topics: log.topics });
      const { id, amount0, amount1, sqrtPriceX96 } = decoded.args as {
        id: string; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint;
      };
      // Exactly one positive, one negative (both non-zero, opposite signs):
      expect(amount0).not.toBe(0n);
      expect(amount1).not.toBe(0n);
      expect(amount0 > 0n).not.toBe(amount1 > 0n);
      expect(sqrtPriceX96 > 0n).toBe(true);
      // Console line still drives the human's one-time convention pinning below;
      // the assertions above are the actual test.
      console.log('poolId', id, 'amount0', amount0.toString(), 'amount1', amount1.toString());
    }
  });
});

describe('collectV4Swaps', () => {
  it('returns one record per V4 Swap log with poolId, fee, amounts, price', () => {
    const out = collectV4Swaps(swaps);
    expect(out.length).toBe(swaps.length);
    for (const s of out) {
      expect(typeof s.poolId).toBe('string');
      expect(s.poolId.startsWith('0x')).toBe(true);
      expect(typeof s.fee).toBe('number');
      expect(s.sqrtPriceX96 > 0n).toBe(true);
    }
  });

  it('ignores non-V4 logs', () => {
    const noise = [{ address: '0xabc', topics: ['0xdeadbeef'], data: '0x' }];
    expect(collectV4Swaps(noise as never)).toEqual([]);
  });
});
