'use client';

/**
 * Route-level error boundary.
 *
 * The App Router requires one: without it a client-side error has nowhere to
 * land, and Next reports "Missing required error components, refreshing…"
 * instead of the actual failure — which hides the real error from whoever is
 * looking at it.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
	return (
		<div className="mt-[40px] flex flex-col gap-[20px]">
			<span className="font-['Sohne_Breit'] text-[12px] leading-[12px]" style={{ color: 'var(--color-red)' }}>
				Something went wrong
			</span>
			<p
				className="font-['Sohne_Mono'] text-[12px] leading-[20px] text-[var(--color-secondary)]"
				style={{ fontFeatureSettings: '"calt" 0' }}
			>
				{/* `digest` is the only detail Next exposes in production; the message
				    itself is server-stripped there, so show whichever we have. */}
				{error.message || error.digest || 'Unknown error.'}
			</p>
			<button
				type="button"
				onClick={reset}
				className="self-start font-['Sohne_Mono'] text-[12px] leading-[12px] uppercase px-[12px] py-[14px] rounded-[2px] text-[var(--color-surface-base)] bg-[var(--color-primary)] hover:opacity-80 transition-opacity"
				style={{ fontFeatureSettings: '"calt" 0' }}
			>
				Try again
			</button>
		</div>
	);
}
