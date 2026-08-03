'use client';

import { useState } from 'react';

export function LoginForm({ next }: { next: string }) {
	const [password, setPassword] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		setSubmitting(true);
		setError(null);
		try {
			const res = await fetch('/api/login', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ password }),
			});
			if (res.ok) {
				// Full navigation, not a client-side push: the session cookie was just
				// set, and the destination is server-rendered behind the gate.
				window.location.assign(next);
				return;
			}
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			if (res.status === 429) {
				const retry = res.headers.get('retry-after');
				setError(retry ? `Too many attempts. Try again in ${retry}s.` : 'Too many attempts.');
			} else {
				setError(body.error ?? 'Login failed.');
			}
		} catch {
			setError('Network error.');
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<form onSubmit={onSubmit} className="mt-[20px] flex flex-col gap-[10px]">
			<input
				type="password"
				name="password"
				autoComplete="current-password"
				value={password}
				onChange={(e) => setPassword(e.target.value)}
				placeholder="Access password"
				aria-label="Access password"
				className="font-['Sohne_Mono'] text-[12px] leading-[20px] px-[10px] py-[8px] border border-[var(--color-border)] bg-transparent outline-none"
			/>
			<button
				type="submit"
				disabled={submitting || password === ''}
				className="font-['Sohne_Mono'] font-medium text-[12px] leading-[12px] uppercase px-[10px] py-[10px] border border-[var(--color-border)] disabled:opacity-40"
			>
				{submitting ? 'Checking…' : 'Enter'}
			</button>
			{error ? (
				<p role="alert" className="font-['Sohne_Mono'] text-[12px] leading-[20px] text-[var(--color-negative)]">
					{error}
				</p>
			) : null}
		</form>
	);
}
