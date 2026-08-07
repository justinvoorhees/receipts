'use client';
import type { Route } from 'next';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AnalyzeFailure } from '@fabric-tca/core';
import { FailureNotice } from './failureNotice';
import { resolveSearchSubmission } from '../lib/receiptUrl';

// Shown as greyed placeholder text in the empty search field.
const PLACEHOLDER_HASH = 'Transaction hash';

// The button's loading label draws a random word from this hat per search.
const LOADER_WORDS = [
	'Analyzing',
	'Coalescing',
	'Converging',
	'Deciphering',
	'Decoding',
	'Decomposing',
	'Deconstructing',
	'Deducing',
	'Disintegrating',
	'Dissecting',
	'Dissolving',
	'Distilling',
	'Elucidating',
	'Enhancing',
	'Examining',
	'Inquiring',
	'Inspecting',
	'Investigating',
	'Scrutinizing',
	'Unraveling',
] as const;

// Pick a random loader word, never repeating the previous one back-to-back.
function nextLoaderWord(prev: string | null): string {
	const pool = prev == null ? LOADER_WORDS : LOADER_WORDS.filter((w) => w !== prev);
	return pool[Math.floor(Math.random() * pool.length)] as string;
}

export function ReceiptSearch({ hash, failure }: { hash: string; failure?: AnalyzeFailure }) {
	const router = useRouter();
	const [value, setValue] = useState(hash);
	const [inputHovered, setInputHovered] = useState(false);
	const [inputFocused, setInputFocused] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [loaderWord, setLoaderWord] = useState<string>(LOADER_WORDS[0]);
	const lastLoaderWord = useRef<string | null>(null);
	// Client-side-only failure (a bad paste never reaches the server). Distinct
	// from the `failure` prop, which the server computes for a hash it already
	// tried to analyze — that one must keep working exactly as it does today.
	const [localFailure, setLocalFailure] = useState<AnalyzeFailure | undefined>(undefined);
	// A paste fires 'paste' (our onPaste → go()) and then, as the browser applies
	// the default insertion, 'input' (our onChange) — both from the SAME user
	// action. Without this flag, onChange's unconditional clear would erase the
	// invalid-paste failure that go() just set, moments after setting it.
	const suppressNextClear = useRef(false);

	useEffect(() => {
		setValue(hash);
	}, [hash]);

	// Compute + persist the receipt on the server (idempotent — a hash already
	// stored is returned without recompute), then navigate to render it. The
	// server page reads the now-persisted row; a miss is diagnosed and surfaces
	// as a FailureNotice via the `failure` prop.
	const go = async (raw: string) => {
		if (submitting) return;
		const submission = resolveSearchSubmission(raw);
		if (submission.kind === 'empty') return;
		if (submission.kind === 'invalid') {
			setLocalFailure({ reason: 'INVALID_HASH' });
			return;
		}
		setLocalFailure(undefined);
		const trimmed = raw.trim();
		const word = nextLoaderWord(lastLoaderWord.current);
		lastLoaderWord.current = word;
		setLoaderWord(word);
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
			router.push(submission.to as Route);
		}
	};

	const submit = () => {
		void go(value);
	};

	// Local failure wins: it reflects what the user just did, while the prop
	// reflects the hash the server last rendered for.
	const effectiveFailure = localFailure ?? failure;
	const hasError = effectiveFailure != null;
	const borderColor = hasError ? 'var(--color-red)' : 'var(--color-primary)';
	const textColor = hasError ? 'var(--color-red)' : 'var(--color-primary)';

	return (
		// gap-[10px]: Figma 628:234. Was 20px, which put this bar's error line at a
		// different distance from the one on /trades — the two are the same control
		// and must not disagree.
		<div className="flex flex-col gap-[10px] w-full">
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
					placeholder={PLACEHOLDER_HASH}
					autoFocus
					onChange={(e) => {
						setValue(e.target.value);
						if (suppressNextClear.current) {
							suppressNextClear.current = false;
						} else {
							setLocalFailure(undefined);
						}
					}}
					onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
					onClick={(e) => (e.currentTarget as HTMLInputElement).select()}
					onPaste={(e) => {
						const pasted = e.clipboardData.getData('text').trim();
						if (pasted) {
							suppressNextClear.current = true;
							void go(pasted);
						}
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
					{submitting ? `${loaderWord}…` : 'Create Receipt'}
				</button>
			</div>
			{effectiveFailure && <FailureNotice failure={effectiveFailure} />}
		</div>
	);
}
