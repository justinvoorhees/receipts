'use client';
import type { Route } from 'next';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import type { Dataset } from '../lib/datasets';

// Funnel is archived (see lib/datasets.ts) — intentionally omitted from the toggle.
const OPTIONS: { value: Dataset; label: string }[] = [
	{ value: 'smoke', label: 'Smoke 01' },
	{ value: 'smoke02', label: 'Smoke 02' },
	{ value: 'smoke03', label: 'Smoke 03' },
	{ value: 'smoke04', label: 'Smoke 04' },
	{ value: 'smoke05', label: 'Smoke 05' },
];

export function DatasetToggle({ dataset }: { dataset: Dataset }) {
	const router = useRouter();
	const pathname = usePathname() ?? '/';
	const params = useSearchParams();
	const [pending, startTransition] = useTransition();

	const select = (value: Dataset) => {
		const next = new URLSearchParams(params?.toString() ?? '');
		next.set('ds', value);
		const qs = next.toString();
		startTransition(() => router.push((qs ? `${pathname}?${qs}` : pathname) as Route));
	};

	return (
		<div className={`flex gap-[16px] font-['Sohne_Mono'] text-[12px] uppercase ${pending ? 'opacity-60' : ''}`}>
			{OPTIONS.map((o) => (
				<button
					key={o.value}
					type="button"
					onClick={() => select(o.value)}
					className={`underline decoration-dotted underline-offset-[2px] cursor-pointer ${dataset === o.value ? 'text-[var(--color-primary)]' : 'text-[var(--color-secondary)]'}`}
				>
					{o.label}
				</button>
			))}
		</div>
	);
}
