'use client';
import type { Route } from 'next';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export function ReceiptSearch({ hash, error }: { hash: string; error?: string }) {
	const router = useRouter();
	const [value, setValue] = useState(hash);
	const [inputHovered, setInputHovered] = useState(false);
	const [inputFocused, setInputFocused] = useState(false);

	useEffect(() => {
		setValue(hash);
	}, [hash]);

	const submit = () => {
		const trimmed = value.trim();
		if (trimmed) router.push(`/receipts?tx=${encodeURIComponent(trimmed)}` as Route);
	};

	const hasError = error != null;
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
						if (pasted) router.push(`/receipts?tx=${encodeURIComponent(pasted)}` as Route);
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
					aria-label="Create receipt"
					className="flex h-full shrink-0 cursor-pointer items-center justify-center whitespace-nowrap px-[12px] font-['Sohne_Mono'] text-[12px] leading-[12px] text-[var(--color-surface-base)] hover:opacity-80 active:opacity-60 transition-opacity"
					style={{
						backgroundColor: hasError ? 'var(--color-red)' : 'var(--color-primary)',
						fontFeatureSettings: '"calt" 0',
					}}
				>
					Create Receipt
				</button>
			</div>
			{hasError && (
				<span
					className="font-['Sohne_Breit'] text-[12px] leading-[12px]"
					style={{ color: 'var(--color-red)' }}
				>
					{error}
				</span>
			)}
		</div>
	);
}
