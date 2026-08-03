import { LoginForm } from '../../components/loginForm';
import { Divider } from '../../components/receipt/receiptRows';

export const dynamic = 'force-dynamic';

/**
 * The logged-out state of /trades (Figma 625:148, "/trades-auth").
 *
 * Reached two ways: directly at /login, or rewritten in place by middleware
 * when an anonymous visitor asks for a protected page — in which case the URL
 * stays on /trades and this renders as that page's signed-out state.
 *
 * The RECEIPTS wordmark and the 720px column come from the root layout, so this
 * only owns the bar itself and the 40px gap beneath the header.
 */
export default async function LoginPage({
	searchParams,
}: {
	searchParams: Promise<{ next?: string }>;
}) {
	const sp = await searchParams;
	// Same-origin paths only. Anything that could read as a scheme or a
	// protocol-relative URL is discarded, so `?next=//evil.com` cannot turn the
	// post-login navigation into an open redirect.
	const raw = sp.next ?? '/trades';
	const next = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/trades';

	const configured = Boolean(process.env.APP_ACCESS_PASSWORD && process.env.APP_SESSION_SECRET);

	return (
		<div className="pb-5">
			<div className="mt-[40px]">
				{configured ? (
					<LoginForm next={next} />
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
			{/* Mirrors the rule the signed-in /trades renders above its footer, so the
			    page keeps the same bottom edge in both states. */}
			<div className="mt-[40px]">
				<Divider />
			</div>
		</div>
	);
}
