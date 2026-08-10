'use client';
import type { Route } from 'next';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AnalyzeFailure } from '@fabric-tca/core';
import { FailureNotice } from './failureNotice';
import { resolveSearchSubmission, shouldClearFailure } from '../lib/receiptUrl';

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

// The label while the SERVER is already analyzing (a hard navigation to a
// receipt URL). Fixed, not drawn from LOADER_WORDS: this render is a
// server-rendered Suspense fallback, and a random pick would differ between
// the server's HTML and the client's first render — a hydration mismatch.
// Client-side submissions still randomize, because they never SSR.
const DECODING_LABEL = 'Analyzing…';

export function ReceiptSearch({
	hash,
	isPending,
	startTransition,
	decoding = false,
	failure,
}: {
	hash: string;
	isPending: boolean;
	startTransition: (callback: () => void) => void;
	/** The server is analyzing this hash right now — see ReceiptView's prop doc. */
	decoding?: boolean;
	failure?: AnalyzeFailure;
}) {
	const router = useRouter();
	const [value, setValue] = useState(hash);
	const [inputHovered, setInputHovered] = useState(false);
	const [inputFocused, setInputFocused] = useState(false);
	const [loaderWord, setLoaderWord] = useState<string>(LOADER_WORDS[0]);
	const lastLoaderWord = useRef<string | null>(null);
	// Client-side-only failure (a bad paste never reaches the server). Distinct
	// from the `failure` prop, which the server computes for a hash it already
	// tried to analyze — that one must keep working exactly as it does today.
	const [localFailure, setLocalFailure] = useState<AnalyzeFailure | undefined>(undefined);
	// The text of the paste currently being applied, or null. A paste fires
	// 'paste' (our onPaste → go()) and then, as the browser applies the default
	// insertion, 'input' (our onChange) — both from the SAME user action, and
	// onChange's clear would otherwise erase the invalid-paste failure that go()
	// just set. The decision, and why this holds the text rather than a boolean,
	// is in shouldClearFailure.
	const pendingPaste = useRef<string | null>(null);

	useEffect(() => {
		setValue(hash);
	}, [hash]);

	// Navigate; the /tx route computes the receipt during its server render. The
	// button's loading state is the route transition itself, which is honest
	// about what is happening — the previous version reported "Analyzing" while
	// awaiting a POST whose only purpose was to write a row.
	// Either kind of work in flight disables submission: `isPending` is a client
	// transition this component started, `decoding` is a server render already
	// under way for the hash in the URL.
	const busy = isPending || decoding;

	const go = (raw: string) => {
		if (busy) return;
		const submission = resolveSearchSubmission(raw);
		if (submission.kind === 'empty') return;
		if (submission.kind === 'invalid') {
			setLocalFailure({ reason: 'INVALID_HASH' });
			return;
		}
		setLocalFailure(undefined);
		const word = nextLoaderWord(lastLoaderWord.current);
		lastLoaderWord.current = word;
		setLoaderWord(word);
		startTransition(() => {
			router.push(submission.to as Route);
		});
	};

	const submit = () => {
		go(value);
	};

	// Local failure wins: it reflects what the user just did, while the prop
	// reflects the hash the server last rendered for.
	const effectiveFailure = localFailure ?? failure;
	const hasError = effectiveFailure != null;
	const borderColor = hasError ? 'var(--color-red)' : 'var(--color-primary)';
	const textColor = hasError ? 'var(--color-red)' : 'var(--color-primary)';

	return (
		// gap-[10px]: Figma 628:234 — spacing between the search bar and its error
		// line below it.
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
						const next = e.target.value;
						setValue(next);
						// Read and reset together: the ref must not outlive the
						// input event it describes, or it goes stale.
						const paste = pendingPaste.current;
						pendingPaste.current = null;
						if (shouldClearFailure(next, paste)) setLocalFailure(undefined);
					}}
					onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
					onClick={(e) => (e.currentTarget as HTMLInputElement).select()}
					onPaste={(e) => {
						const pasted = e.clipboardData.getData('text').trim();
						if (pasted) {
							pendingPaste.current = pasted;
							go(pasted);
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
					disabled={busy}
					aria-label="Create receipt"
					className="flex h-full shrink-0 cursor-pointer items-center justify-center whitespace-nowrap px-[12px] font-['Sohne_Mono'] text-[12px] leading-[12px] text-[var(--color-surface-base)] hover:opacity-80 active:opacity-60 disabled:cursor-default disabled:opacity-70 transition-opacity"
					style={{
						backgroundColor: hasError ? 'var(--color-red)' : 'var(--color-primary)',
						fontFeatureSettings: '"calt" 0',
					}}
				>
					{isPending ? `${loaderWord}…` : decoding ? DECODING_LABEL : 'Create Receipt'}
				</button>
			</div>
			{effectiveFailure && <FailureNotice failure={effectiveFailure} />}
		</div>
	);
}
