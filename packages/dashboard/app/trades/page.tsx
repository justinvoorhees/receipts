import Link from 'next/link';
import { cookies } from 'next/headers';
import { LoginForm } from '../../components/loginForm';
import { SESSION_COOKIE, verifySession } from '../../lib/auth';
import {
	countReceipts,
	listReceipts,
	TRADES_SORT_COLUMNS,
	type SortDirection,
	type TradesSort,
	type TradesSortColumn,
} from '../../lib/queries';
import { TradesTable } from '../../components/tradesTable';
import { Divider } from '../../components/receipt/receiptRows';
import { clampPagination } from '../../lib/pagination';

/**
 * Never cached. This page reads the session cookie to decide whether to render
 * history or the signed-out state, so a cached copy is a correctness AND a
 * security problem: one visitor's rendered page could be served to another.
 * Replaces `revalidate = 30`, which asked for exactly that caching and was set
 * before this page read cookies at all.
 */
export const dynamic = 'force-dynamic';

const VALID_SORT_COLUMNS = new Set(Object.keys(TRADES_SORT_COLUMNS) as TradesSortColumn[]);
const DEFAULT_SORT: TradesSort = { column: 'block', direction: 'desc' };

export default async function TradesPage({
	searchParams,
}: {
	searchParams: Promise<{ sort?: string; dir?: string; page?: string; size?: string }>;
}) {
	const sp = await searchParams;

	// This page is its own gate. Middleware protects the API but lets /trades
	// through, because there is no separate login route to rewrite to — so the
	// session check MUST sit in front of the queries below. Rendering the
	// signed-out UI while still querying would show nothing, but would pull every
	// receipt into server memory on an anonymous request.
	const secret = process.env.APP_SESSION_SECRET;
	const token = (await cookies()).get(SESSION_COOKIE)?.value;
	// No secret configured ⇒ fail closed. An unset env var is not "no check needed".
	const signedIn = Boolean(secret) && (await verifySession(token, secret!));
	if (!signedIn) return <SignedOut />;

	const sort = parseSort(sp);
	const { limit, offset, page } = clampPagination(sp);
	// Receipts arrive newest-first (createdAt desc). The table applies the active
	// column sort client-side on top of this page's rows.
	const [rows, total] = await Promise.all([listReceipts({ limit, offset }), countReceipts()]);
	const lastPage = Math.max(1, Math.ceil(total / limit));

	return (
		<div className="pb-5">
			{/* The layout's <hr> was removed in the Figma v3 pass; /trades is not in
			    the frames, so it renders its own rule to keep today's appearance. */}
			<div className="mt-[40px]">
				<Divider />
			</div>
			<div className="flex items-end justify-between mt-[40px]">
				<h1
					className="font-['Sohne_Breit'] font-medium text-[20px] leading-[20px]"
					style={{ fontFeatureSettings: '"calt" 0' }}
				>
					History
				</h1>
				<div
					className="flex items-center gap-[10px] font-['Sohne_Mono'] font-medium text-[12px] leading-[12px] uppercase text-[var(--color-secondary)] text-center"
					style={{ fontFeatureSettings: '"calt" 0' }}
				>
					<span>
						{total.toLocaleString()} receipts
						{lastPage > 1 ? ` · page ${page} of ${lastPage.toLocaleString()}` : ''}
					</span>
				</div>
			</div>

			{rows.length === 0 ? (
				<EmptyState />
			) : (
				<>
					<TradesTable rows={rows} initialSort={sort} />
					<Pager page={page} lastPage={lastPage} sp={sp} />
				</>
			)}

			{/* Mirrors the top rule: the footer's border-t was removed in the Figma
			    v3 pass, so /trades renders its own rule above it to keep the same
			    separation the layout used to provide. */}
			<div className="mt-[40px]">
				<Divider />
			</div>
		</div>
	);
}

function parseSort(params: { sort?: string; dir?: string }): TradesSort {
	const column = (params.sort ?? '') as TradesSortColumn;
	if (!VALID_SORT_COLUMNS.has(column)) return DEFAULT_SORT;
	const direction: SortDirection = params.dir === 'asc' ? 'asc' : 'desc';
	return { column, direction };
}

/**
 * The signed-out state of this page (Figma 625:148 "/trades-auth", 628:234 for
 * the error). Rendered in place — the URL stays on /trades, so signing in
 * returns you here and a bookmark still points at the right thing.
 */
function SignedOut() {
	const configured = Boolean(process.env.APP_ACCESS_PASSWORD && process.env.APP_SESSION_SECRET);
	return (
		<div className="pb-5">
			<div className="mt-[40px]">
				{configured ? (
					<LoginForm next="/trades" />
				) : (
					<p
						className="font-['Sohne_Mono'] text-[12px] leading-[20px] text-[var(--color-secondary)]"
						style={{ fontFeatureSettings: '"calt" 0' }}
					>
						Access gate not configured — set <code>APP_ACCESS_PASSWORD</code> and{' '}
						<code>APP_SESSION_SECRET</code> on the server. The receipt tool is unaffected.
					</p>
				)}
			</div>
			{/* Mirrors the rule the signed-in view renders above the footer, so the
			    page keeps the same bottom edge in both states. */}
			<div className="mt-[40px]">
				<Divider />
			</div>
		</div>
	);
}

/**
 * Prev/next links. Rebuilds the query string from the params we recognise
 * rather than passing the incoming one through, so an arbitrary `?foo=` cannot
 * ride along into the rendered links.
 */
function Pager({
	page,
	lastPage,
	sp,
}: {
	page: number;
	lastPage: number;
	sp: { sort?: string; dir?: string; size?: string };
}) {
	if (lastPage <= 1) return null;
	const href = (p: number) => {
		const q = new URLSearchParams();
		if (sp.sort) q.set('sort', sp.sort);
		if (sp.dir) q.set('dir', sp.dir);
		if (sp.size) q.set('size', sp.size);
		if (p > 1) q.set('page', String(p));
		const s = q.toString();
		return (s ? `/trades?${s}` : '/trades') as never;
	};
	const cls =
		"font-['Sohne_Mono'] font-medium text-[12px] leading-[12px] uppercase text-[var(--color-secondary)]";
	return (
		<div className={`flex items-center gap-[20px] mt-[40px] ${cls}`}>
			{page > 1 ? <Link href={href(page - 1)}>← Newer</Link> : <span className="opacity-40">← Newer</span>}
			{page < lastPage ? (
				<Link href={href(page + 1)}>Older →</Link>
			) : (
				<span className="opacity-40">Older →</span>
			)}
		</div>
	);
}

function EmptyState() {
	return (
		<p className="font-['Sohne_Mono'] text-[12px] leading-[20px] text-[var(--color-secondary)] mt-[40px] max-w-[640px]">
			No receipts yet — paste a transaction hash on the Receipts tab.
		</p>
	);
}
