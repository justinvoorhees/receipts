'use client';
import type { Route } from 'next';
import { useRouter, usePathname } from 'next/navigation';
import { useTransition } from 'react';

// Placeholder tab set for v2. Rename / extend during dashboard design — the
// shape (label + href + matches) carried over from v1 unchanged.
const TABS: { label: string; href: Route; matches: (path: string) => boolean }[] = [
	{ label: 'Dashboard', href: '/' as Route, matches: (p) => p === '/' },
	{
		label: 'Trades',
		href: '/trades' as Route,
		matches: (p) => p === '/trades' || p.startsWith('/trades/'),
	},
];

export function NavTabs() {
	const router = useRouter();
	const pathname = usePathname() ?? '/';
	// useTransition gives us immediate visual feedback on click while the
	// server re-renders the destination page. Without this, a slow server
	// render makes the tab click feel ignored.
	const [pending, startTransition] = useTransition();

	return (
		<nav className="flex gap-[40px] items-center">
			{TABS.map((tab) => {
				const selected = tab.matches(pathname);
				/*
				 * State styles (all share the `tab-underline` rules — offset, position,
				 * thickness, skip-ink — defined in globals.css):
				 *   enabled  → secondary, no underline
				 *   hover    → secondary, solid underline
				 *   pressed  → quaternary, solid underline (active mouse-down)
				 *   selected → primary, dotted underline (current route)
				 *   pending  → opacity 60% (in-flight navigation)
				 */
				const className = selected
					? 'text-[var(--color-primary)] underline decoration-dotted'
					: [
							'text-[var(--color-secondary)]',
							'hover:underline hover:decoration-solid',
							'active:text-[var(--color-quaternary)]',
						].join(' ');
				const onClick = (e: React.MouseEvent) => {
					if (selected) return; // no-op if already here
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
