'use client';
import type { Route } from 'next';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AnalyzeFailure } from '@fabric-tca/core';
import { FailureNotice } from './failureNotice';

export function ReceiptSearch({ hash, failure }: { hash: string; failure?: AnalyzeFailure }) {
	const router = useRouter();
	const [value, setValue] = useState(hash);
	const [inputHovered, setInputHovered] = useState(false);
	const [inputFocused, setInputFocused] = useState(false);
	const [submitting, setSubmitting] = useState(false);

	useEffect(() => {
		setValue(hash);
	}, [hash]);

	// Compute + persist the receipt on the server (idempotent — a hash already
	// stored is returned without recompute), then navigate to render it. The
	// server page reads the now-persisted row; a miss is diagnosed and surfaces
	// as a FailureNotice via the `failure` prop.
	const go = async (raw: string) => {
		const trimmed = raw.trim();
		if (!trimmed || submitting) return;
		setSubmitting(true);
		try {
			await fetch('/api/receipts', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ hash: trimmed }),
			});
		} catch {
			// Network/compute failure still navigates; the server render shows the
			// not-found state rather than leaving the UI hung.
		} finally {
			setSubmitting(false);
			router.push(`/?tx=${encodeURIComponent(trimmed)}` as Route);
		}
	};

	const submit = () => {
		void go(value);
	};

	const hasError = failure != null;
	const borderColor = hasError ? 'var(--color-red)' : 'var(--color-primary)';
	const textColor = hasError ? 'var(--color-red)' : 'var(--color-primary)';
	const labelColor = hasError ? 'var(--color-red)' : 'var(--color-secondary)';

	return (
		<div className="flex flex-col gap-[10px] w-full">
			<span
				className="font-['Sohne_Breit'] text-[12px] leading-[12px]"
				style={{ color: labelColor }}
			>
				Transaction Hash
			</span>
			<div
				className="relative flex h-[40px] w-full items-stretch overflow-hidden rounded-[2px] border transition-colors"
				style={{
					borderColor,
					...(inputHovered || inputFocused ? { backgroundColor: 'var(--color-surface-low)' } : {}),
				}}
			>
				<input
					type="text"
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
					onClick={(e) => (e.currentTarget as HTMLInputElement).select()}
					onPaste={(e) => {
						const pasted = e.clipboardData.getData('text').trim();
						if (pasted) void go(pasted);
					}}
					onMouseEnter={() => setInputHovered(true)}
					onMouseLeave={() => setInputHovered(false)}
					onFocus={() => setInputFocused(true)}
					onBlur={() => setInputFocused(false)}
					spellCheck={false}
					className="h-full min-w-0 flex-1 pl-[12px] pr-[12px] font-['Sohne_Mono'] text-[12px] leading-[12px] bg-transparent outline-none"
					style={{
						color: textColor,
						fontFeatureSettings: '"calt" 0',
					}}
				/>
				<button
					type="button"
					onClick={submit}
					disabled={submitting}
					aria-label="Create receipt"
					className="flex h-full shrink-0 cursor-pointer items-center justify-center whitespace-nowrap px-[12px] font-['Sohne_Mono'] text-[12px] leading-[12px] text-[var(--color-surface-base)] hover:opacity-80 active:opacity-60 disabled:cursor-default disabled:opacity-70 transition-opacity"
					style={{
						backgroundColor: hasError ? 'var(--color-red)' : 'var(--color-primary)',
						fontFeatureSettings: '"calt" 0',
					}}
				>
					{submitting ? 'Analyzing…' : 'Create Receipt'}
				</button>
			</div>
			{failure && <FailureNotice failure={failure} />}
		</div>
	);
}
