'use client';

import { useState } from 'react';

/**
 * Password bar for the logged-out state of /trades (Figma 625:148, "/trades-auth").
 *
 * Deliberately the same control as the Create Receipt bar in receiptSearch: one
 * bordered 40px row, input flex-1, dark button flush to the right edge with the
 * container clipping the corners. Same hover fill, same red-on-error treatment,
 * so the two primary inputs in the app read as one component rather than two
 * near-misses.
 */
/**
 * The error line beneath the bar (Figma 628:234).
 *
 * Same typography and token as FailureNotice's plain branch on the index, so
 * the two error states are identical rather than approximately alike.
 */
export function LoginErrorNotice({ message }: { message: string }) {
	return (
		<span
			role="alert"
			className="font-['Sohne_Breit'] text-[12px] leading-[12px]"
			style={{ color: 'var(--color-red)' }}
		>
			{message}
		</span>
	);
}

export function LoginForm({ next }: { next: string }) {
	const [password, setPassword] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [hovered, setHovered] = useState(false);
	const [focused, setFocused] = useState(false);

	const hasError = error != null;
	const accent = hasError ? 'var(--color-red)' : 'var(--color-primary)';

	const submit = async () => {
		if (!password || submitting) return;
		setSubmitting(true);
		setError(null);
		try {
			const res = await fetch('/api/login', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ password }),
			});
			if (res.ok) {
				// Full navigation rather than a client push: the session cookie was
				// just set, and the destination is server-rendered behind the gate.
				window.location.assign(next);
				return;
			}
			if (res.status === 429) {
				const retry = res.headers.get('retry-after');
				setError(retry ? `Too many attempts — try again in ${retry}s` : 'Too many attempts');
			} else if (res.status === 503) {
				setError('Access gate not configured');
			} else {
				setError('Incorrect password');
			}
		} catch {
			setError('Network error');
		} finally {
			setSubmitting(false);
		}
	};

	return (
		// gap-[10px]: Figma 628:234 puts the error line 10px under the bar.
		<div className="flex flex-col gap-[10px] w-full">
			<div
				className="relative flex h-[40px] w-full items-stretch overflow-hidden rounded-[2px] border transition-colors"
				style={{
					borderColor: accent,
					...(hovered || focused ? { backgroundColor: 'var(--color-surface-low)' } : {}),
				}}
			>
				<input
					type="password"
					name="password"
					autoComplete="current-password"
					autoFocus
					value={password}
					placeholder="Password"
					aria-label="Access password"
					{...(hasError ? { 'aria-invalid': true } : {})}
					onChange={(e) => setPassword(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter') void submit();
					}}
					onMouseEnter={() => setHovered(true)}
					onMouseLeave={() => setHovered(false)}
					onFocus={() => setFocused(true)}
					onBlur={() => setFocused(false)}
					spellCheck={false}
					// No placeholder: utility — the index bar sets none either, so both
					// inherit the browser's default muted rendering of the input colour.
					// Overriding it here made the two fields disagree.
					className="h-full min-w-0 flex-1 pl-[12px] pr-[12px] font-['Sohne_Mono'] text-[12px] leading-[12px] bg-transparent outline-none"
					style={{ color: accent, fontFeatureSettings: '"calt" 0' }}
				/>
				<button
					type="button"
					onClick={() => void submit()}
					// Only while submitting, matching the index bar. Disabling on an empty
					// field dimmed the button to opacity-70 on load, so it read as muted
					// rather than primary. `submit()` already no-ops on an empty password,
					// so an enabled-looking button is still safe to click.
					disabled={submitting}
					className="flex h-full shrink-0 cursor-pointer items-center justify-center whitespace-nowrap px-[12px] font-['Sohne_Mono'] text-[12px] leading-[12px] text-[var(--color-surface-base)] hover:opacity-80 active:opacity-60 disabled:cursor-default disabled:opacity-70 transition-opacity"
					style={{ backgroundColor: accent, fontFeatureSettings: '"calt" 0' }}
				>
					{submitting ? 'Checking…' : 'Sign In'}
				</button>
			</div>
			{hasError ? <LoginErrorNotice message={error} /> : null}
		</div>
	);
}
