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

/** Records the highest number of reader calls that were ever in flight at once. */
function concurrencyProbe() {
  let inFlight = 0;
  let peak = 0;
  const gate = async <T>(value: T): Promise<T> => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return value;
  };
  return { gate, peak: () => peak };
}

describe('rankCandidatesByDepth concurrency', () => {
  it('reads every candidate concurrently instead of one round-trip at a time', async () => {
    // Ranking is the hot loop of pool discovery: two RPC reads per candidate,
    // ~17 candidates per pair, against an endpoint where a serial call costs
    // ~85ms but 20 concurrent calls cost ~5ms each.
    const probe = concurrencyProbe();
    const candidates = ['0xa', '0xb', '0xc', '0xd', '0xe'].map((a) => mk(a, 'univ3'));

    await rankCandidatesByDepth(candidates, {
      isInitialized: () => probe.gate(true),
      readDepth: () => probe.gate(1n),
    });

    expect(probe.peak()).toBeGreaterThan(1);
  });

  it('keeps the earliest candidate on a depth tie, so selection stays order-deterministic', async () => {
    // Guards the `depth > best.depth` comparison: pool choice must not depend on
    // which read happens to resolve first once these run in parallel.
    const candidates = ['0xfirst', '0xsecond', '0xthird'].map((a) => mk(a, 'univ3'));
    const best = await rankCandidatesByDepth(candidates, {
      isInitialized: async () => true,
      // Deliberately resolve in reverse order of the candidate list.
      readDepth: async (c) => {
        await new Promise((r) => setTimeout(r, c.address === '0xfirst' ? 15 : 1));
        return 100n;
      },
    });
    expect(best?.pool.address).toBe('0xfirst');
  });

  it('still skips uninitialized candidates when reads are interleaved', async () => {
    const best = await rankCandidatesByDepth(['0xa', '0xb'].map((a) => mk(a, 'univ3')), {
      isInitialized: async (c) => c.address === '0xa',
      readDepth: async (c) => (c.address === '0xa' ? 1n : 999n),
    });
    expect(best?.pool.address).toBe('0xa');
  });
});

describe('getDeepestPoolWithDepth family fan-out', () => {
  it('scans all four pool families concurrently rather than family after family', async () => {
    const { getDeepestPoolWithDepth } = await import('./poolDiscovery.js');
    let inFlight = 0;
    let peak = 0;
    const client = {
      readContract: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 3));
        inFlight -= 1;
        // Every factory lookup misses, so the test measures discovery fan-out
        // alone and never reaches the ranking stage.
        return '0x0000000000000000000000000000000000000000';
      },
    };

    await getDeepestPoolWithDepth(client as never, '0xa', '0xb', 100n);

    // 4 families x 4/4/4/2 params = 14 lookups; serial would peak at 1.
    expect(peak).toBeGreaterThan(4);
  });
});
