import { LoginForm } from '../../components/loginForm';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
	searchParams,
}: {
	searchParams: Promise<{ next?: string }>;
}) {
	const sp = await searchParams;
	// Only ever a same-origin path. Anything that could be read as a scheme or a
	// protocol-relative URL is discarded, so `?next=//evil.com` cannot turn the
	// post-login redirect into an open redirect.
	const raw = sp.next ?? '/';
	const next = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';

	const configured = Boolean(process.env.APP_ACCESS_PASSWORD && process.env.APP_SESSION_SECRET);

	return (
		<div className="mt-[80px] max-w-[420px]">
			<h1
				className="font-['Sohne_Breit'] font-medium text-[20px] leading-[20px]"
				style={{ fontFeatureSettings: '"calt" 0' }}
			>
				Fabric TCA
			</h1>
			{configured ? (
				<>
					<p className="font-['Sohne_Mono'] text-[12px] leading-[20px] text-[var(--color-secondary)] mt-[20px]">
						This preview is private. Enter the access password to continue.
					</p>
					<LoginForm next={next} />
				</>
			) : (
				<p className="font-['Sohne_Mono'] text-[12px] leading-[20px] text-[var(--color-secondary)] mt-[20px]">
					Server misconfigured — <code>APP_ACCESS_PASSWORD</code> and <code>APP_SESSION_SECRET</code> must both
					be set. Until then nothing is served.
				</p>
			)}
		</div>
	);
}
