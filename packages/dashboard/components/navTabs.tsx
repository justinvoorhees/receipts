'use client';
import type { Route } from 'next';
import { useRouter, usePathname } from 'next/navigation';
import { useTransition } from 'react';

const TABS: { label: string; href: Route; matches: (path: string) => boolean }[] = [
	{
		label: 'Receipts',
		href: '/' as Route,
		matches: (p) => p === '/',
	},
	{
		label: 'History',
		href: '/trades' as Route,
		matches: (p) => p === '/trades' || p.startsWith('/trades/'),
	},
];

export function NavTabs() {
	const router = useRouter();
	const pathname = usePathname() ?? '/';
	const [pending, startTransition] = useTransition();

	return (
		// Tabs are visually hidden but remain interactive (opacity-0 keeps pointer
		// events; `invisible`/`hidden` would strip clickability).
		<nav className="flex gap-[40px] items-center opacity-0">
			{TABS.map((tab) => {
				const selected = tab.matches(pathname);
				const className = selected
					? 'text-[var(--color-primary)] underline decoration-dotted'
					: [
							'text-[var(--color-secondary)]',
							'hover:underline hover:decoration-solid',
							'active:text-[var(--color-quaternary)]',
						].join(' ');
				const onClick = (e: React.MouseEvent) => {
					if (selected) return;
					e.preventDefault();
					startTransition(() => router.push(tab.href));
				};
				return (
					<a
						key={tab.href}
						href={tab.href}
						onClick={onClick}
						className={`tab-underline font-['Sohne_Breit'] text-[16px] leading-[16px] transition-opacity ${className} ${pending ? 'opacity-60' : ''}`}
					>
						{tab.label}
					</a>
				);
			})}
		</nav>
	);
}
