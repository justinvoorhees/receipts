/**
 * duneOracle.ts — minute-granular ETH/USD from Dune, as a second oracle for the
 * benchmark manipulation cross-check. Block-precise (≤ ~30s vs a 12s block),
 * unlike CoinGecko's hourly free history. Never throws — returns null on any
 * failure so the benchmark degrades to single-oracle.
 */
export type OffChainPrice = { price: number; asOfSecs: number } | null;
export type OffChainOracle = (unixSecs: number) => Promise<OffChainPrice>;

/** Dune query id returning columns `minute` (timestamptz) and `price` (eth/usd),
 *  parameterized by a `ts` (unix seconds) bind that selects the latest minute ≤ ts. */
export const DUNE_ETH_USD_QUERY_ID = 0; // TODO-OWNER: set to the saved Dune query id before enabling

export function parseDuneEthUsd(payload: unknown): OffChainPrice {
  const rows = (payload as { result?: { rows?: { price?: number; minute?: string }[] } })?.result?.rows;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows[0]!;
  if (typeof row.price !== 'number' || typeof row.minute !== 'string') return null;
  const asOfSecs = Math.floor(Date.parse(row.minute) / 1000);
  if (!Number.isFinite(asOfSecs)) return null;
  return { price: row.price, asOfSecs };
}

export function makeDuneEthUsdOracle(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): OffChainOracle {
  return async (unixSecs: number): Promise<OffChainPrice> => {
    try {
      const res = await fetchImpl(
        `https://api.dune.com/api/v1/query/${DUNE_ETH_USD_QUERY_ID}/results?limit=1`,
        { headers: { 'X-Dune-API-Key': apiKey, 'x-query-parameters': JSON.stringify({ ts: unixSecs }) } },
      );
      if (!res.ok) return null;
      return parseDuneEthUsd(await res.json());
    } catch {
      return null;
    }
  };
}
