import { describe, it, expect } from 'vitest';
import { rankCandidatesByDepth, type PoolCandidate, type RankReaders } from './poolDiscovery.js';

const mk = (address: string, kind: PoolCandidate['kind']): PoolCandidate =>
  ({ address: address as `0x${string}`, kind });

const readers = (
  init: Record<string, boolean>,
  depth: Record<string, bigint>,
): RankReaders => ({
  isInitialized: async (c) => init[c.address] ?? false,
  readDepth: async (c) => depth[c.address] ?? 0n,
});

describe('rankCandidatesByDepth', () => {
  it('picks the deepest initialized pool by the uniform yardstick, across families', async () => {
    const v3 = mk('0xaaa', 'univ3');
    const basic = mk('0xbbb', 'aerodrome_basic');
    const best = await rankCandidatesByDepth([v3, basic],
      readers({ '0xaaa': true, '0xbbb': true }, { '0xaaa': 10n, '0xbbb': 999n }));
    expect(best?.pool.address).toBe('0xbbb');
    expect(best?.pool.kind).toBe('aerodrome_basic');
    expect(best?.depth).toBe(999n);
  });
  it('skips uninitialized candidates even when they would rank deepest', async () => {
    const v3 = mk('0xaaa', 'univ3');
    const basic = mk('0xbbb', 'aerodrome_basic');
    const best = await rankCandidatesByDepth([v3, basic],
      readers({ '0xaaa': true, '0xbbb': false }, { '0xaaa': 10n, '0xbbb': 999n }));
    expect(best?.pool.address).toBe('0xaaa');
  });
  it('returns null when no candidate is initialized', async () => {
    const best = await rankCandidatesByDepth([mk('0xaaa', 'univ3')],
      readers({ '0xaaa': false }, { '0xaaa': 10n }));
    expect(best).toBeNull();
  });
});
