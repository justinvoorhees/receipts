'use client';
import type { Route } from 'next';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import type { Dataset } from '../lib/datasets';

const OPTIONS: { value: Dataset; label: string }[] = [
	{ value: 'funnel', label: 'Funnel' },
	{ value: 'smoke', label: 'Smoke test' },
];

export function DatasetToggle({ dataset }: { dataset: Dataset }) {
	const router = useRouter();
	const pathname = usePathname() ?? '/';
	const params = useSearchParams();
	const [pending, startTransition] = useTransition();

	const select = (value: Dataset) => {
		const next = new URLSearchParams(params?.toString() ?? '');
		if (value === 'funnel') next.delete('ds'); else next.set('ds', value);
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
