/**
 * Bounds for the /trades listing.
 *
 * The page previously selected every row with no LIMIT, loaded them all into
 * memory and serialised them to the client — a query that degrades precisely
 * when the table is being spammed. Both the page size and the page number come
 * from the URL, so both are clamped here rather than trusted.
 */
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 500;
/** Guards the offset against absurd page numbers producing a nonsense query. */
const MAX_PAGE = 1_000_000;

function positiveInt(raw: string | undefined): number | null {
	if (raw === undefined || raw.trim() === '') return null;
	// Reject anything that is not plain digits: '1e9', '1.5', 'Infinity' and
	// 'NaN' all survive Number() in forms we do not want reaching a query.
	if (!/^\d+$/.test(raw.trim())) return null;
	const n = Number(raw);
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function clampPagination(params: { page?: string; size?: string }): {
	limit: number;
	offset: number;
	page: number;
} {
	const size = positiveInt(params.size);
	const limit = size === null ? DEFAULT_PAGE_SIZE : Math.min(size, MAX_PAGE_SIZE);
	const page = Math.min(positiveInt(params.page) ?? 1, MAX_PAGE);
	return { limit, offset: (page - 1) * limit, page };
}
