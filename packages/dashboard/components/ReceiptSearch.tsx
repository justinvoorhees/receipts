'use client';
import type { Route } from 'next';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export function ReceiptSearch({ hash, error }: { hash: string; error?: string }) {
	const router = useRouter();
	const [value, setValue] = useState(hash);

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
			<div className="relative flex h-[40px] w-full items-center">
				<input
					type="text"
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
					spellCheck={false}
					className="h-full w-full rounded-[2px] border pl-[12px] pr-[48px] font-['Sohne_Mono'] text-[12px] leading-[12px] bg-transparent outline-none"
					style={{
						borderColor,
						color: textColor,
						fontFeatureSettings: '"calt" 0',
					}}
				/>
				<button
					type="button"
					onClick={submit}
					aria-label="Search transaction"
					className="absolute right-[-1px] top-[-1px] flex h-[40px] w-[40px] items-center justify-center rounded-[2px] p-[8px]"
					style={{ backgroundColor: 'var(--color-primary)' }}
				>
					<svg
						width="24"
						height="24"
						viewBox="0 0 24 24"
						fill="none"
						aria-hidden="true"
						style={{ color: 'var(--color-surface-base)' }}
					>
						<path
							d="M5 12h14M13 6l6 6-6 6"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
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
