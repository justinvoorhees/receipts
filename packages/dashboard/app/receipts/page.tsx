import { getReceiptByHash, type ReceiptRow, type TradeRow } from '../../lib/queries';
import { ReceiptView } from '../../components/ReceiptView';

export const dynamic = 'force-dynamic';

const DEFAULT_HASH = '0x9703bfa335528a8e01c6b63dd3046ccd6e13a66ba2e6954956aa2df39da269c1';

/**
 * Adapt a generalized `receipts` row into the USDC/WETH-shaped `TradeRow` that
 * `ReceiptView` renders today. For USDC/WETH swaps this is exact; other pairs
 * render imperfectly until Task 10 generalizes `ReceiptView`. `receipts` numeric
 * columns are already strings (Drizzle `numeric` select), matching `TradeRow`.
 */
function adaptReceipt(r: ReceiptRow): TradeRow {
	const isBuyWeth = r.direction === 'buy_weth';
	return {
		...r,
		usdcAmount: isBuyWeth ? r.inputAmount : r.outputAmount,
		wethAmount: isBuyWeth ? r.outputAmount : r.inputAmount,
		settledIn: isBuyWeth ? r.outputSymbol : r.inputSymbol,
	} as unknown as TradeRow;
}

export default async function ReceiptsPage({
	searchParams,
}: {
	searchParams: Promise<{ tx?: string }>;
}) {
	const sp = await searchParams;
	const hash = (sp.tx ?? DEFAULT_HASH).trim();
	const receipt = await getReceiptByHash(hash);
	const trade = receipt ? adaptReceipt(receipt) : null;

	return (
		<div className="mt-[40px]">
			<ReceiptView trade={trade} hash={hash} />
		</div>
	);
}
