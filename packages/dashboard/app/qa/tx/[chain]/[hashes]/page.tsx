import { notFound } from 'next/navigation';
import { resolveChainParam } from '../../../../../lib/chains';
import { HASH_RE } from '../../../../../lib/receiptUrl';
import { loadReceipt } from '../../../../../lib/loadReceipt';

export const dynamic = 'force-dynamic';

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
	const hashes = decodeURIComponent(hashesParam).split(',').map((h) => h.trim()).filter(Boolean);
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
					{rows.map(({ hash, receipt }) => (
						<tr key={hash}>
							<td className="pr-[16px]">{`${hash.slice(0, 10)}…`}</td>
							{receipt ? (
								<>
									<td className="pr-[16px]">{`${receipt.inputSymbol} → ${receipt.outputSymbol}`}</td>
									<td className="pr-[16px]">{receipt.aggregator}</td>
									<td className="pr-[16px]">{receipt.notionalUsd ?? '–'}</td>
									<td className="pr-[16px]">{receipt.allInCostBps ?? '–'}</td>
									<td className="pr-[16px]">{receipt.lpFeeBps ?? '–'}</td>
									<td className="pr-[16px]">{receipt.slippageBps ?? '–'}</td>
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
