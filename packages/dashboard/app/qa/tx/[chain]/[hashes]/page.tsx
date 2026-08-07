import { notFound } from 'next/navigation';
import { resolveChainParam } from '../../../../../lib/chains';
import { HASH_RE } from '../../../../../lib/receiptUrl';
import { loadReceipt } from '../../../../../lib/loadReceipt';

export const dynamic = 'force-dynamic';

/**
 * This table exists to be read at a glance and compared across rows — full
 * float precision (e.g. `408.33041588254656`) defeats that. Two decimals for
 * bps and dollar figures, consistent with the rest of the app; '–' for null.
 */
function fmt2(value: number | null): string {
	return value == null ? '–' : value.toFixed(2);
}

/**
 * decodeURIComponent throws URIError on a malformed sequence (e.g. a lone
 * '%'). That must become the same notFound() a bad hash gets, not an
 * unhandled 500 — a malformed URL should cost one regex-equivalent, not a
 * crash.
 */
function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return notFound();
	}
}

/**
 * Side-by-side receipt comparison for QA. Replaces the /trades history table.
 *
 * DEV ONLY. The App Router cannot conditionally register a route file, so the
 * guard is the first statement below. It is the only thing between a public URL
 * and an unmetered n x 40 RPC call — this page has no rate limiting at all,
 * deliberately, because locally it runs against your own key.
 *
 * Stateless by design: the hashes live in the URL, so there is no corpus file to
 * curate and no state to keep. Paste whatever you are comparing.
 */
export default async function QaPage({
	params,
}: {
	params: Promise<{ chain: string; hashes: string }>;
}) {
	if (process.env.NODE_ENV === 'production') notFound();

	const { chain: chainParam, hashes: hashesParam } = await params;

	const resolved = resolveChainParam(chainParam);
	if (!resolved) notFound();

	// Validated before anything is spent — a malformed list costs one regex each.
	// decodeURIComponent is necessary, not redundant: verified against a live dev
	// server that Next 15's App Router re-encodes a literal ',' in this dynamic
	// segment into the literal string '%2C' by the time it reaches the page
	// (ordinary %XX sequences decode fine; the separator specifically does not),
	// so this is what recovers real commas to split the list on. Wrapped, not
	// bare: a malformed sequence like a lone '%' throws URIError, and that must
	// resolve to notFound(), not an unhandled 500.
	const hashes = safeDecode(hashesParam).split(',').map((h) => h.trim()).filter(Boolean);
	if (hashes.length === 0 || !hashes.every((h) => HASH_RE.test(h))) notFound();

	// Sequential, not Promise.all: ten hashes in parallel is ~400 simultaneous
	// RPC calls, which gets you rate-limited by the provider rather than fast.
	const rows: { hash: string; receipt: Awaited<ReturnType<typeof loadReceipt>> }[] = [];
	for (const hash of hashes) {
		// One unanalyzable hash must not cost the other nine.
		try {
			rows.push({ hash, receipt: await loadReceipt(resolved.chain, hash) });
		} catch {
			rows.push({ hash, receipt: null });
		}
	}

	return (
		<div className="mt-[40px] overflow-x-auto">
			<table className="w-full font-['Sohne_Mono'] text-[12px] leading-[18px]">
				<thead>
					<tr className="text-left">
						<th className="pr-[16px]">Tx</th>
						<th className="pr-[16px]">Pair</th>
						<th className="pr-[16px]">Aggregator</th>
						<th className="pr-[16px]">Notional</th>
						<th className="pr-[16px]">All-in bps</th>
						<th className="pr-[16px]">LP bps</th>
						<th className="pr-[16px]">Slippage bps</th>
						<th className="pr-[16px]">Tier</th>
					</tr>
				</thead>
				<tbody>
					{rows.map(({ hash, receipt }, i) => (
						// hash + index, not hash alone: pasting the same hash twice (a
						// plausible mistake in a tool built for pasting lists) would
						// otherwise collide and trigger React's duplicate-key warning.
						<tr key={`${hash}-${i}`}>
							<td className="pr-[16px]">{`${hash.slice(0, 10)}…`}</td>
							{receipt ? (
								<>
									<td className="pr-[16px]">{`${receipt.inputSymbol} → ${receipt.outputSymbol}`}</td>
									<td className="pr-[16px]">{receipt.aggregator}</td>
									<td className="pr-[16px]">{fmt2(receipt.notionalUsd)}</td>
									<td className="pr-[16px]">{fmt2(receipt.allInCostBps)}</td>
									<td className="pr-[16px]">{fmt2(receipt.lpFeeBps)}</td>
									<td className="pr-[16px]">{fmt2(receipt.slippageBps)}</td>
									<td className="pr-[16px]">{receipt.tier ?? '–'}</td>
								</>
							) : (
								<td colSpan={7}>no receipt</td>
							)}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
